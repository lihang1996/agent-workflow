/**
 * 飞书接入：WS 长连接收消息 + REST 回消息。
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { BotConfig } from '../core/bot-config.js';
import { parseMentions, type Mention } from './message-parser.js';
import type { CardJson } from './card.js';

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
  createDocumentComment: (documentId: string, content: string) => Promise<string | undefined>;
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

interface PostElement {
  tag?: string;
  text?: string;
  user_id?: string;
}

/** 将富文本元素转成纯文本片段。 */
function renderPostElement(element: PostElement): string {
  if (element.tag === 'at') return element.user_id ?? '';
  if (element.tag === 'br') return '\n';
  if (['text', 'a', 'code', 'code_block', 'md'].includes(element.tag ?? '')) {
    return element.text ?? '';
  }
  return '';
}

/** 从飞书消息 content 提取可读文本。 */
export function extractMessageText(messageType: string, content: string): string {
  const parsed = JSON.parse(content);
  if (messageType === 'text') {
    return parsed.text ?? '';
  }
  if (messageType === 'post') {
    const paragraphs: PostElement[][] = parsed.content ?? [];
    return paragraphs
      .map((paragraph) => paragraph.map(renderPostElement).join(''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
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
  try {
    const res = await client.request({
      url: '/open-apis/bot/v3/info',
      method: 'GET',
    }) as { bot?: { open_id?: string }; data?: { bot?: { open_id?: string } } };
    return res.bot?.open_id
      ?? res.data?.bot?.open_id
      ?? '';
  } catch (error) {
    console.warn('[飞书] 获取 bot open_id 失败:', (error as Error).message);
    return '';
  }
}

/** 启动单个飞书 Bot（WS 收消息 + REST 回复）。 */
export async function startBot(opts: BotOptions): Promise<Bot> {
  const { config, onMessage, onCardAction } = opts;
  const { appId, appSecret } = config;

  const client = new Lark.Client({ appId, appSecret });
  const openId = await fetchBotOpenId(client);

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
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      return res.data?.message_id;
    },

    /** 主动往指定会话发送文本（供定时任务等没有新用户消息的场景）。 */
    async sendText(chatId, text) {
      const res = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      return res.data?.message_id;
    },

    /** 回复交互卡片，返回卡片 message_id。 */
    async replyCard(messageId, card, replyInThread = false) {
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      return res.data?.message_id;
    },

    /** 原地更新已发出的卡片。 */
    async updateCard(messageId, card) {
      await client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
    },

    /** 创建飞书云文档，并把 Markdown 转换为文档块写入根节点。 */
    async createDocument(title, markdown) {
      const created = await client.request({
        url: '/open-apis/docx/v1/documents',
        method: 'POST',
        data: { title },
      }) as any;
      const document = created?.data?.document ?? created?.document ?? created?.data ?? {};
      const documentId = document.document_id ?? document.documentId;
      if (typeof documentId !== 'string' || !documentId) {
        throw new Error('飞书云文档创建成功但未返回 document_id');
      }

      if (markdown.trim()) {
        const converted = await client.request({
          url: '/open-apis/docx/v1/documents/blocks/convert',
          method: 'POST',
          data: { content_type: 'markdown', content: markdown },
        }) as any;
        const blocks = converted?.data?.blocks ?? converted?.blocks ?? [];
        if (!Array.isArray(blocks) || blocks.length === 0) {
          throw new Error('飞书云文档内容转换失败，未返回文档块');
        }
        await client.request({
          url: `/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
          method: 'POST',
          data: { children: blocks },
        });
      }
      const url = typeof document.url === 'string' && document.url
        ? document.url
        : `https://feishu.cn/docx/${documentId}`;
      return { documentId, url };
    },

    /** 在云文档中添加全文评论，供产品评审与后续追踪使用。 */
    async createDocumentComment(documentId, content) {
      const res = await client.drive.fileComment.create({
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
      });
      return res.data?.comment_id;
    },

    /** 下载消息中的图片/文件到本地。 */
    async downloadResource(messageId, fileKey, type, saveDir, fileName) {
      const res = await client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      });
      const contentType = getHeader(res.headers, 'content-type');
      const extension = resourceExtension(type, fileName, contentType);
      const savePath = join(saveDir, `${fileKey}.${extension}`);
      await mkdir(saveDir, { recursive: true });
      await res.writeFile(savePath);
      return savePath;
    },
  };

  const dispatcher = new Lark.EventDispatcher({}).register({
    'card.action.trigger': async (data: any) => {
      const value = data?.action?.value;
      console.log(
        `[卡片] bot=${bot.id} 收到 card.action.trigger`,
        `operator=${data?.operator?.open_id ?? '(无)'}`,
        `value=${JSON.stringify(value ?? null)}`,
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
        console.error(`[卡片] bot=${bot.id} 处理按钮回调失败:`, (error as Error).message);
        return {
          toast: { type: 'error', content: '停止失败，请稍后重试。' },
        };
      }
    },
    'im.message.receive_v1': async (data) => {
      const m = data.message;
      const msg: IncomingMessage = {
        messageId: m.message_id,
        chatId: m.chat_id,
        chatType: m.chat_type,
        messageType: m.message_type,
        text: extractMessageText(m.message_type, m.content),
        rootId: m.root_id ?? '',
        threadId: m.thread_id ?? '',
        senderOpenId: data.sender.sender_id?.open_id ?? '',
        senderType: data.sender.sender_type ?? '',
        mentions: parseMentions(m.mentions),
        rawContent: m.content,
      };
      await onMessage(msg, bot);
    },
  });

  const wsClient = new Lark.WSClient({ appId, appSecret });
  wsClient.start({ eventDispatcher: dispatcher });

  return bot;
}
