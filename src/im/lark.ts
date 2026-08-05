/**
 * 飞书接入：WS 长连接收消息 + REST 回消息。
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { BotConfig } from '../core/bot-config.js';
import { sanitizeForLog } from '../core/log-inspection.js';
import {
  extractMessageText,
  parseMentions,
  type Mention,
} from './message-parser.js';
import type { CardJson } from './card.js';

export { extractMessageText } from './message-parser.js';

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  messageType: string;
  text: string;
  rootId: string;
  threadId: string;
  senderOpenId: string;
  senderType: string;
  mentions: Mention[];
  rawContent: string;
}

export interface BotOptions {
  config: BotConfig;
  onMessage: (msg: IncomingMessage, bot: Bot) => Promise<void>;
  /** 卡片按钮回调（如停止任务）。 */
  onCardAction?: (action: CardAction) => Promise<CardActionResponse | undefined>;
  /** 飞书云文档新增评论/回复回调。 */
  onDocumentComment?: (event: DocumentCommentEvent, bot: Bot) => Promise<void>;
}

export interface CardAction {
  operatorOpenId: string;
  messageId: string;
  value: Record<string, unknown>;
  formValue: Record<string, unknown>;
}

export interface CardActionResponse {
  toast?: { type: 'success' | 'info' | 'warning' | 'error'; content: string };
  card?: { type: 'raw'; data: CardJson };
}

export interface DocumentCommentEvent {
  documentId: string;
  commentId: string;
  replyId?: string;
  authorOpenId: string;
  noticeType: 'add_comment' | 'add_reply';
}

export interface DocumentComment {
  id: string;
  commentId: string;
  replyId?: string;
  authorOpenId: string;
  content: string;
  resolved: boolean;
}

/** 文档实体已创建、但正文写入失败；调用方应保存 documentId 并在重试时覆盖该文档。 */
export class CreatedDocumentWriteError extends Error {
  constructor(
    readonly documentId: string,
    readonly url: string,
    cause: unknown,
  ) {
    super(`飞书云文档 ${documentId} 已创建，但正文写入失败`, { cause });
    this.name = 'CreatedDocumentWriteError';
  }
}

/** 解析飞书 card.action.trigger 事件。 */
export function parseCardAction(data: any): CardAction {
  const value = data?.action?.value;
  return {
    operatorOpenId: data?.operator?.open_id ?? data?.operator_id?.open_id ?? '',
    messageId: data?.context?.open_message_id ?? data?.open_message_id ?? '',
    value: value && typeof value === 'object' ? value as Record<string, unknown> : {},
    formValue: data?.action?.form_value && typeof data.action.form_value === 'object'
      ? data.action.form_value as Record<string, unknown>
      : {},
  };
}

export interface Bot {
  id: string;
  role: string;
  name: string;
  appId: string;
  openId: string;
  /** Bot 默认工作目录（可选） */
  workdir?: string;
  client: Lark.Client;
  reply: (messageId: string, text: string, replyInThread?: boolean) => Promise<string | undefined>;
  sendText: (chatId: string, text: string) => Promise<string | undefined>;
  replyCard: (messageId: string, card: CardJson, replyInThread?: boolean) => Promise<string | undefined>;
  updateCard: (messageId: string, card: CardJson) => Promise<void>;
  createDocument: (title: string, markdown: string) => Promise<{ documentId: string; url: string }>;
  updateDocument: (documentId: string, markdown: string) => Promise<void>;
  createDocumentComment: (documentId: string, content: string) => Promise<string | undefined>;
  listDocumentComments: (documentId: string) => Promise<DocumentComment[]>;
  getDocumentComment: (documentId: string, commentId: string, replyId?: string) => Promise<DocumentComment | undefined>;
  resolveDocumentComment: (documentId: string, commentId: string) => Promise<void>;
  downloadResource: (
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    saveDir: string,
    fileName?: string,
  ) => Promise<string>;
}

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
};

const DOCX_BATCH_LIMIT = 1_000;
const FEISHU_RETRY_DELAYS_MS = [300, 900, 2_100];

interface ConvertedBlock {
  block_id?: string;
  children?: string[];
  block_type: number;
  table?: Record<string, unknown> & { merge_info?: unknown };
  [key: string]: unknown;
}

interface ConvertedBatch {
  childrenIds: string[];
  blocks: ConvertedBlock[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiCode(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

function apiStatus(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown; data?: { code?: unknown } };
  };
  const status = candidate.status ?? candidate.statusCode ?? candidate.response?.status;
  return typeof status === 'number' ? status : undefined;
}

function isRateLimited(value: unknown): boolean {
  const directCode = apiCode(value);
  const responseCode = value && typeof value === 'object'
    ? apiCode((value as { response?: { data?: unknown } }).response?.data)
    : undefined;
  return apiStatus(value) === 429 || directCode === 99991400 || responseCode === 99991400;
}

async function withFeishuRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= FEISHU_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const result = await operation();
      const code = apiCode(result);
      if (code !== undefined && code !== 0) {
        const response = result as unknown as { msg?: unknown };
        const message = result && typeof result === 'object' && typeof response.msg === 'string'
          ? response.msg
          : '未知错误';
        const error = Object.assign(new Error(`${label}失败（${code}）：${message}`), { code });
        throw error;
      }
      return result;
    } catch (error) {
      lastError = error;
      if (!isRateLimited(error) || attempt === FEISHU_RETRY_DELAYS_MS.length) throw error;
      await sleep(FEISHU_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

/** 云文档转换不支持直接复用远程图片块；保留为普通链接，避免发布出空图片。 */
export function normalizeDocumentMarkdown(markdown: string): string {
  return markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string, target: string) =>
    `[${alt.trim() || '图片'}](${target})`);
}

/** 移除转换接口返回的只读表格合并信息。 */
export function sanitizeConvertedBlocks(blocks: ConvertedBlock[]): ConvertedBlock[] {
  return blocks.map((block) => {
    if (!block.table || !Object.prototype.hasOwnProperty.call(block.table, 'merge_info')) return block;
    const table = { ...block.table };
    delete table.merge_info;
    return { ...block, table };
  });
}

/** 按一级块的完整子树分批，确保一次嵌套块请求不超过飞书 1000 块限制。 */
export function partitionConvertedBlocks(
  firstLevelBlockIds: string[],
  sourceBlocks: ConvertedBlock[],
  limit = DOCX_BATCH_LIMIT,
): ConvertedBatch[] {
  if (limit < 1) throw new Error('云文档分批上限必须大于 0');
  const blocks = sanitizeConvertedBlocks(sourceBlocks);
  if (blocks.some((block) => !block.block_id)) {
    throw new Error('飞书转换结果包含缺少 block_id 的文档块，已停止发布以避免内容缺失。');
  }
  const byId = new Map(blocks.flatMap((block) => block.block_id ? [[block.block_id, block] as const] : []));
  const seen = new Set<string>();

  const subtree = (rootId: string): ConvertedBlock[] => {
    const result: ConvertedBlock[] = [];
    const visit = (id: string) => {
      if (seen.has(id)) return;
      const block = byId.get(id);
      if (!block) throw new Error(`飞书转换结果缺少文档块：${id}`);
      seen.add(id);
      result.push(block);
      for (const childId of block.children ?? []) visit(childId);
    };
    visit(rootId);
    return result;
  };

  const batches: ConvertedBatch[] = [];
  let current: ConvertedBatch = { childrenIds: [], blocks: [] };
  for (const rootId of firstLevelBlockIds) {
    const tree = subtree(rootId);
    if (tree.length > limit) {
      throw new Error(`单个云文档一级块包含 ${tree.length} 个子块，超过飞书单次 ${limit} 块限制，请拆分 Spec 内容。`);
    }
    if (current.blocks.length > 0 && current.blocks.length + tree.length > limit) {
      batches.push(current);
      current = { childrenIds: [], blocks: [] };
    }
    current.childrenIds.push(rootId);
    current.blocks.push(...tree);
  }
  if (current.blocks.length > 0) batches.push(current);
  if (seen.size !== byId.size) {
    throw new Error('飞书转换结果包含无法从一级块访问的孤立块，已停止发布以避免文档残缺。');
  }
  return batches;
}

function renderCommentContent(elements: Array<{
  type: 'text_run' | 'docs_link' | 'person';
  text_run?: { text: string };
  docs_link?: { url: string };
  person?: { user_id: string };
}>): string {
  return elements.map((element) =>
    element.text_run?.text ?? element.docs_link?.url ?? element.person?.user_id ?? '').join('').trim();
}

function parseDocumentCommentItem(item: any, replyId?: string): DocumentComment | undefined {
  const commentId = typeof item?.comment_id === 'string' ? item.comment_id : '';
  if (!commentId) return undefined;
  const replies = Array.isArray(item?.reply_list?.replies) ? item.reply_list.replies : [];
  const reply = replyId
    ? replies.find((candidate: any) => candidate?.reply_id === replyId)
    : replies[0];
  if (!reply) return undefined;
  const elements = Array.isArray(reply?.content?.elements) ? reply.content.elements : [];
  const content = renderCommentContent(elements);
  if (!content) return undefined;
  return {
    id: replyId ? `${commentId}:${replyId}` : commentId,
    commentId,
    ...(replyId ? { replyId } : {}),
    authorOpenId: typeof reply.user_id === 'string' && reply.user_id
      ? reply.user_id
      : typeof item.user_id === 'string' ? item.user_id : '',
    content,
    resolved: item.is_solved === true,
  };
}

async function convertDocumentMarkdown(client: Lark.Client, markdown: string): Promise<ConvertedBatch[]> {
  const converted = await withFeishuRetry('转换飞书云文档内容', () => client.docx.v1.document.convert({
    data: { content_type: 'markdown', content: normalizeDocumentMarkdown(markdown) },
  }));
  const firstLevelBlockIds = converted.data?.first_level_block_ids ?? [];
  const blocks = (converted.data?.blocks ?? []) as ConvertedBlock[];
  if (firstLevelBlockIds.length === 0 || blocks.length === 0) {
    throw new Error('飞书云文档内容转换失败，未返回完整文档块');
  }
  return partitionConvertedBlocks(firstLevelBlockIds, blocks);
}

async function documentRootChildCount(client: Lark.Client, documentId: string): Promise<number> {
  let pageToken: string | undefined;
  let total = 0;
  do {
    const response = await withFeishuRetry('读取飞书云文档目录', () => client.docx.v1.documentBlockChildren.get({
      path: { document_id: documentId, block_id: documentId },
      params: { page_size: 500, ...(pageToken ? { page_token: pageToken } : {}) },
    }));
    total += response.data?.items?.length ?? 0;
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return total;
}

async function insertDocumentBatches(
  client: Lark.Client,
  documentId: string,
  batches: ConvertedBatch[],
  startIndex: number,
  operationToken: string,
): Promise<void> {
  let index = startIndex;
  for (const [batchIndex, batch] of batches.entries()) {
    await withFeishuRetry('写入飞书云文档内容', () => client.docx.v1.documentBlockDescendant.create({
      path: { document_id: documentId, block_id: documentId },
      params: { client_token: documentClientToken(operationToken, `insert:${batchIndex}`) },
      data: {
        children_id: batch.childrenIds,
        descendants: batch.blocks as any,
        index,
      },
    }));
    index += batch.childrenIds.length;
  }
}

/** 先追加新内容再删除旧内容，写入失败时不会把原文档清空。 */
async function replaceDocumentMarkdown(client: Lark.Client, documentId: string, markdown: string): Promise<void> {
  if (!markdown.trim()) throw new Error('飞书云文档内容不能为空');
  const operationToken = randomUUID();
  const batches = await convertDocumentMarkdown(client, markdown);
  const oldChildCount = await documentRootChildCount(client, documentId);
  await insertDocumentBatches(client, documentId, batches, oldChildCount, operationToken);
  if (oldChildCount > 0) {
    await withFeishuRetry('移除飞书云文档旧版本', () => client.docx.v1.documentBlockChildren.batchDelete({
      path: { document_id: documentId, block_id: documentId },
      params: { client_token: documentClientToken(operationToken, 'delete-old') },
      data: { start_index: 0, end_index: oldChildCount },
    }));
  }
}

function documentClientToken(operationToken: string, step: string): string {
  return createHash('sha256').update(`${operationToken}\0${step}`).digest('hex');
}

/** 兼容 Headers / 普通对象取响应头。 */
function getHeader(headers: any, name: string): string {
  const value = typeof headers?.get === 'function'
    ? headers.get(name)
    : headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** 根据文件名或 Content-Type 推断扩展名。 */
function resourceExtension(type: 'image' | 'file', fileName: string | undefined, contentType: string): string {
  const original = fileName ? extname(fileName).slice(1).toLowerCase() : '';
  if (/^[a-z0-9]{1,10}$/.test(original)) return original;

  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  return CONTENT_TYPE_EXTENSIONS[mime] ?? (type === 'image' ? 'img' : 'bin');
}

/** 资源 key 不直接进入文件名，避免异常 key 造成目录穿越或跨消息覆盖。 */
export function resourceLocalName(
  fileKey: string,
  type: 'image' | 'file',
  fileName: string | undefined,
  contentType: string,
): string {
  const digest = createHash('sha256').update(`${type}\0${fileKey}`).digest('hex').slice(0, 32);
  return `${type}-${digest}.${resourceExtension(type, fileName, contentType)}`;
}

/** 群聊需 @ 到自己；单聊直接受理。 */
export function isAddressedToBot(msg: IncomingMessage, bot: Bot): boolean {
  if (msg.chatType === 'p2p') return true;
  if (bot.openId && msg.mentions.some((m) => m.openId === bot.openId)) return true;
  // open_id 拉取失败时，退化为按显示名匹配
  const name = bot.name.trim().toLowerCase();
  if (!name) return false;
  return msg.mentions.some((m) => m.name.trim().toLowerCase() === name);
}

/** 拉取本应用 open_id，用于群聊 @ 匹配。 */
async function fetchBotOpenId(client: Lark.Client): Promise<string> {
  const res = await withFeishuRetry('获取 Bot 信息', () => client.request({
    url: '/open-apis/bot/v3/info',
    method: 'GET',
  })) as { bot?: { open_id?: string }; data?: { bot?: { open_id?: string } } };
  const openId = res.bot?.open_id ?? res.data?.bot?.open_id ?? '';
  if (!openId) throw new Error('飞书 Bot 信息缺少 open_id，请检查应用是否已启用机器人能力。');
  return openId;
}

/** 启动单个飞书 Bot（WS 收消息 + REST 回复）。 */
export async function startBot(opts: BotOptions): Promise<Bot> {
  const { config, onMessage, onCardAction, onDocumentComment } = opts;
  const { appId, appSecret } = config;

  const client = new Lark.Client({ appId, appSecret });
  const openId = await fetchBotOpenId(client);
  const handledMessageIds = new Set<string>();
  const rememberMessage = (messageId: string): boolean => {
    if (handledMessageIds.has(messageId)) return false;
    handledMessageIds.add(messageId);
    if (handledMessageIds.size > 2_000) {
      const oldest = handledMessageIds.values().next().value;
      if (typeof oldest === 'string') handledMessageIds.delete(oldest);
    }
    return true;
  };

  const bot: Bot = {
    id: config.id,
    role: config.role,
    name: config.name,
    appId,
    openId,
    ...(config.workdir ? { workdir: config.workdir } : {}),
    client,

    /** 回复文本消息。 */
    async reply(messageId, text, replyInThread = false) {
      const res = await withFeishuRetry('回复飞书消息', () => client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      }));
      return res.data?.message_id;
    },

    /** 主动往指定会话发送文本（供定时任务等没有新用户消息的场景）。 */
    async sendText(chatId, text) {
      const res = await withFeishuRetry('发送飞书消息', () => client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      }));
      return res.data?.message_id;
    },

    /** 回复交互卡片，返回卡片 message_id。 */
    async replyCard(messageId, card, replyInThread = false) {
      const res = await withFeishuRetry('回复飞书卡片', () => client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      }));
      return res.data?.message_id;
    },

    /** 原地更新已发出的卡片。 */
    async updateCard(messageId, card) {
      await withFeishuRetry('更新飞书卡片', () => client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      }));
    },

    /** 创建飞书云文档，并把 Markdown 转换为文档块写入根节点。 */
    async createDocument(title, markdown) {
      if (!markdown.trim()) throw new Error('飞书云文档内容不能为空');
      const batches = await convertDocumentMarkdown(client, markdown);
      const created = await withFeishuRetry('创建飞书云文档', () => client.docx.v1.document.create({
        data: { title },
      }));
      const documentId = created.data?.document?.document_id;
      if (typeof documentId !== 'string' || !documentId) {
        throw new Error('飞书云文档创建成功但未返回 document_id');
      }
      const url = `https://feishu.cn/docx/${documentId}`;
      try {
        await insertDocumentBatches(client, documentId, batches, 0, `${documentId}:initial`);
      } catch (error) {
        throw new CreatedDocumentWriteError(documentId, url, error);
      }
      return { documentId, url };
    },

    /** 修订时覆盖同一份云文档，保持评审链接不变。 */
    async updateDocument(documentId, markdown) {
      await replaceDocumentMarkdown(client, documentId, markdown);
    },

    /** 在云文档中添加全文评论，供产品评审与后续追踪使用。 */
    async createDocumentComment(documentId, content) {
      const res = await withFeishuRetry('创建飞书云文档评论', () => client.drive.fileComment.create({
        params: { file_type: 'docx', user_id_type: 'open_id' },
        path: { file_token: documentId },
        data: {
          reply_list: {
            replies: [{
              content: {
                elements: [{ type: 'text_run', text_run: { text: content } }],
              },
            }],
          },
        },
      }));
      return res.data?.comment_id;
    },

    /** 获取全部未解决评论，供重启补偿和事件漏收时同步。 */
    async listDocumentComments(documentId) {
      const comments: DocumentComment[] = [];
      let pageToken: string | undefined;
      do {
        const res = await withFeishuRetry('读取飞书云文档评论', () => client.drive.fileComment.list({
          params: {
            file_type: 'docx',
            user_id_type: 'open_id',
            is_solved: false,
            page_size: 50,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
          path: { file_token: documentId },
        }));
        for (const item of res.data?.items ?? []) {
          const comment = parseDocumentCommentItem(item);
          if (comment) comments.push(comment);
          const replies = item.reply_list?.replies ?? [];
          for (const reply of replies.slice(1)) {
            if (!reply.reply_id) continue;
            const parsed = parseDocumentCommentItem(item, reply.reply_id);
            if (parsed) comments.push(parsed);
          }
        }
        pageToken = res.data?.has_more ? res.data.page_token : undefined;
      } while (pageToken);
      return comments;
    },

    async getDocumentComment(documentId, commentId, replyId) {
      const res = await withFeishuRetry('读取飞书云文档评论', () => client.drive.fileComment.get({
        params: { file_type: 'docx', user_id_type: 'open_id' },
        path: { file_token: documentId, comment_id: commentId },
      }));
      return parseDocumentCommentItem(res.data, replyId);
    },

    async resolveDocumentComment(documentId, commentId) {
      await withFeishuRetry('解决飞书云文档评论', () => client.drive.fileComment.patch({
        params: { file_type: 'docx' },
        path: { file_token: documentId, comment_id: commentId },
        data: { is_solved: true },
      }));
    },

    /** 下载消息中的图片/文件到本地。 */
    async downloadResource(messageId, fileKey, type, saveDir, fileName) {
      const res = await withFeishuRetry('下载飞书消息资源', () => client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      }));
      const contentType = getHeader(res.headers, 'content-type');
      const savePath = join(saveDir, resourceLocalName(fileKey, type, fileName, contentType));
      await mkdir(saveDir, { recursive: true });
      await res.writeFile(savePath);
      return savePath;
    },
  };

  const dispatcher = new Lark.EventDispatcher({}).register({
    'drive.notice.comment_add_v1': async (data) => {
      if (!onDocumentComment || data.notice_meta?.file_type !== 'docx') return {};
      const documentId = data.notice_meta.file_token ?? '';
      const commentId = data.comment_id ?? '';
      const noticeType = data.notice_meta.notice_type;
      if (!documentId || !commentId || (noticeType !== 'add_comment' && noticeType !== 'add_reply')) return {};
      await onDocumentComment({
        documentId,
        commentId,
        ...(data.reply_id ? { replyId: data.reply_id } : {}),
        authorOpenId: data.notice_meta.from_user_id?.open_id ?? '',
        noticeType,
      }, bot);
      return {};
    },
    'card.action.trigger': async (data: any) => {
      const value = data?.action?.value;
      console.log(
        `[卡片] bot=${bot.id} 收到 card.action.trigger`,
        `operator=${data?.operator?.open_id ?? '(无)'}`,
        `value=${sanitizeForLog(JSON.stringify(value ?? null), 1_000)}`,
      );
      if (!onCardAction) {
        console.warn(`[卡片] bot=${bot.id} 未注册 onCardAction，忽略按钮回调`);
        return {};
      }
      try {
        const response = await onCardAction(parseCardAction(data));
        // 必须返回对象；undefined 时飞书客户端可能当成交互失败。
        return response ?? {};
      } catch (error) {
        console.error(`[卡片] bot=${bot.id} 处理按钮回调失败:`, sanitizeForLog((error as Error).message, 2_000));
        return {
          toast: { type: 'error', content: '操作失败，请稍后重试。' },
        };
      }
    },
    'im.message.receive_v1': async (data) => {
      const m = data.message;
      if (!m?.message_id || !m.chat_id) {
        console.warn(`[飞书] bot=${bot.id} 忽略缺少 message_id/chat_id 的消息事件`);
        return {};
      }
      if (!rememberMessage(m.message_id)) {
        console.log(`[飞书] bot=${bot.id} 忽略重复消息 message_id=${m.message_id}`);
        return {};
      }
      const rawContent = typeof m.content === 'string' ? m.content : '{}';
      const msg: IncomingMessage = {
        messageId: m.message_id,
        chatId: m.chat_id,
        chatType: m.chat_type ?? '',
        messageType: m.message_type ?? '',
        text: extractMessageText(m.message_type ?? '', rawContent),
        rootId: m.root_id ?? '',
        threadId: m.thread_id ?? '',
        senderOpenId: data.sender?.sender_id?.open_id ?? '',
        senderType: data.sender?.sender_type ?? '',
        mentions: parseMentions(m.mentions),
        rawContent,
      };
      try {
        await onMessage(msg, bot);
      } catch (error) {
        handledMessageIds.delete(m.message_id);
        throw error;
      }
      return {};
    },
  });

  const wsClient = new Lark.WSClient({ appId, appSecret });
  wsClient.start({ eventDispatcher: dispatcher });

  return bot;
}
