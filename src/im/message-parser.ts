export interface Mention {
  key: string; // '@_user_1'
  name: string; // 显示名，如 'MyBot'
  openId: string; // 'ou_xxx'
}

export interface MessageResource {
  type: 'image' | 'file';
  key: string;
  fileName?: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** 飞书消息内容不可信；格式异常时返回空对象，不让一条坏消息打断长连接。 */
export function parseMessageContent(content: string): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 从事件的 mentions 数组中提取结构化提及信息。 */
export function parseMentions(raw: unknown): Mention[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): Mention[] => {
    if (!isRecord(item)) return [];
    const key = stringValue(item.key);
    if (!key) return [];
    const id = isRecord(item.id) ? item.id : {};
    return [{
      key,
      name: stringValue(item.name) ?? '',
      openId: stringValue(id.open_id) ?? '',
    }];
  });
}

/** 把 @_user_N 占位符替换成 @显示名；长 key 优先，避免 @_user_1 破坏 @_user_10。 */
export function resolveMentions(text: string, mentions: Mention[]): string {
  let resolved = typeof text === 'string' ? text : '';
  const ordered = [...mentions]
    .filter((mention) => mention.key)
    .sort((a, b) => b.key.length - a.key.length);
  for (const mention of ordered) {
    const label = mention.name || mention.openId || '用户';
    resolved = resolved.replaceAll(mention.key, `@${label}`);
  }
  return resolved.trim();
}

interface PostElement {
  tag?: unknown;
  text?: unknown;
  user_id?: unknown;
  image_key?: unknown;
}

function postPayload(parsed: JsonRecord): JsonRecord {
  if (Array.isArray(parsed.content)) return parsed;
  const localized = Object.values(parsed).find((value) =>
    isRecord(value) && Array.isArray(value.content));
  return localized && isRecord(localized) ? localized : parsed;
}

function postParagraphs(parsed: JsonRecord): PostElement[][] {
  const content = postPayload(parsed).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(Array.isArray)
    .map((paragraph) => paragraph.filter(isRecord));
}

function renderPostElement(element: PostElement): string {
  if (element.tag === 'at') return stringValue(element.user_id) ?? '';
  if (element.tag === 'br') return '\n';
  if (['text', 'a', 'code', 'code_block', 'md'].includes(String(element.tag ?? ''))) {
    return typeof element.text === 'string' ? element.text : '';
  }
  return '';
}

/** 从飞书消息 content 提取可读文本。 */
export function extractMessageText(messageType: string, content: string): string {
  const parsed = parseMessageContent(content);
  if (messageType === 'text') return typeof parsed.text === 'string' ? parsed.text : '';
  if (messageType !== 'post') return '';

  const payload = postPayload(parsed);
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const body = postParagraphs(parsed)
    .map((paragraph) => paragraph.map(renderPostElement).join(''))
    .filter(Boolean)
    .join('\n')
    .trim();
  return [title, body].filter(Boolean).join('\n');
}

/** 从消息 content 中提取资源 key（图片使用 image，文件/音频/视频使用 file）。 */
export function extractResourceKeys(messageType: string, content: string): MessageResource[] {
  const parsed = parseMessageContent(content);
  const resources: MessageResource[] = [];
  const add = (type: MessageResource['type'], keyValue: unknown, fileNameValue?: unknown) => {
    const key = stringValue(keyValue);
    if (!key || key.length > 1_024) return;
    const fileName = stringValue(fileNameValue);
    resources.push({ type, key, ...(fileName ? { fileName } : {}) });
  };

  if (messageType === 'image') add('image', parsed.image_key);
  if (messageType === 'file' || messageType === 'audio' || messageType === 'media') {
    add('file', parsed.file_key, parsed.file_name);
  }
  if (messageType === 'post') {
    for (const element of postParagraphs(parsed).flat()) {
      if (element.tag === 'img') add('image', element.image_key);
    }
  }

  const seen = new Set<string>();
  return resources.filter((resource) => {
    const id = `${resource.type}:${resource.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
