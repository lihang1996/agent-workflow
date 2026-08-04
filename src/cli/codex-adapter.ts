import type { CliAdapter, CliEvent } from './types.js';

interface CodexItem {
  type?: unknown;
  item_type?: unknown;
  id?: unknown;
  text?: unknown;
  command?: unknown;
  server?: unknown;
  tool?: unknown;
  query?: unknown;
}

interface CodexEvent {
  type?: unknown;
  thread_id?: unknown;
  message?: unknown;
  error?: {
    message?: unknown;
  };
  item?: CodexItem;
}

const TOOL_LABELS: Record<string, string> = {
  Bash: '运行命令',
  FileChange: '修改文件',
  WebSearch: '搜索资料',
  MCP: '调用 MCP',
};

/** 读取 Codex item 类型字段。 */
function itemKind(item: CodexItem | undefined): string | undefined {
  if (!item) return undefined;
  if (typeof item.type === 'string') return item.type;
  if (typeof item.item_type === 'string') return item.item_type;
  return undefined;
}

/** 截断过长文本。 */
function truncate(text: string, max = 72): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function toolUseId(item: CodexItem | undefined, fallback: string): string {
  return typeof item?.id === 'string' && item.id ? item.id : fallback;
}

/**
 * Codex 适配器：按单次 run 实例化，缓存 thread_id / 最后 agent 消息，
 * 在 turn.completed 时再产出最终 result。
 */
export class CodexAdapter implements CliAdapter {
  readonly id = 'codex' as const;
  readonly command = 'codex';
  readonly displayName = 'Codex';

  private threadId?: string;
  private lastAgentText?: string;
  private toolSeq = 0;
  private readonly openTools = new Map<string, string>();

  constructor(
    private readonly sandbox = process.env.CODEX_SANDBOX ?? 'workspace-write',
  ) {}

  /** 新开 Codex 会话。 */
  buildArgs(prompt: string): string[] {
    return ['exec', '--json', '--sandbox', this.sandbox, prompt];
  }

  /** 恢复会话；--sandbox 必须挂在 exec 上。 */
  buildResumeArgs(prompt: string, sessionId: string): string[] {
    return [
      'exec',
      '--sandbox',
      this.sandbox,
      'resume',
      '--json',
      sessionId,
      prompt,
    ];
  }

  /** 解析 Codex JSONL 事件行。 */
  parseEvents(line: string): CliEvent[] {
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      return [];
    }

    if (typeof event.thread_id === 'string') {
      this.threadId = event.thread_id;
    }
    const sessionId = this.threadId;

    if (event.type === 'thread.started' && sessionId) {
      return [{ type: 'session', sessionId }];
    }

    if (event.type === 'error' || event.type === 'turn.failed') {
      const message =
        (typeof event.error?.message === 'string' && event.error.message)
        || (typeof event.message === 'string' && event.message)
        || 'Codex 执行失败';
      return [{
        type: 'error',
        message,
        ...(sessionId ? { sessionId } : {}),
      }];
    }

    if (event.type === 'turn.completed') {
      if (!this.lastAgentText) return [];
      return [{
        type: 'result',
        answer: this.lastAgentText,
        ...(sessionId ? { sessionId } : {}),
      }];
    }

    if (event.type === 'item.started') {
      return this.parseToolStart(event.item, sessionId);
    }

    if (event.type === 'item.completed') {
      return this.parseItemCompleted(event.item, sessionId);
    }

    return [];
  }

  /** item.started → tool_start。 */
  private parseToolStart(item: CodexItem | undefined, sessionId?: string): CliEvent[] {
    const kind = itemKind(item);
    if (!kind) return [];

    this.toolSeq += 1;
    const id = toolUseId(item, `codex-tool-${this.toolSeq}`);

    if (kind === 'command_execution') {
      const command = typeof item?.command === 'string' ? item.command : undefined;
      this.openTools.set(id, 'Bash');
      return [{
        type: 'tool_start',
        toolUseId: id,
        toolName: 'Bash',
        label: TOOL_LABELS.Bash,
        ...(command ? { detail: truncate(command) } : {}),
        ...(sessionId ? { sessionId } : {}),
      }];
    }

    if (kind === 'file_change') {
      this.openTools.set(id, 'FileChange');
      return [{
        type: 'tool_start',
        toolUseId: id,
        toolName: 'FileChange',
        label: TOOL_LABELS.FileChange,
        ...(sessionId ? { sessionId } : {}),
      }];
    }

    if (kind === 'mcp_tool_call') {
      const server = typeof item?.server === 'string' ? item.server : undefined;
      const tool = typeof item?.tool === 'string' ? item.tool : undefined;
      const name = [server, tool].filter(Boolean).join('/') || 'MCP';
      this.openTools.set(id, name);
      return [{
        type: 'tool_start',
        toolUseId: id,
        toolName: name,
        label: TOOL_LABELS.MCP,
        ...(sessionId ? { sessionId } : {}),
      }];
    }

    if (kind === 'web_search') {
      const query = typeof item?.query === 'string' ? item.query : undefined;
      this.openTools.set(id, 'WebSearch');
      return [{
        type: 'tool_start',
        toolUseId: id,
        toolName: 'WebSearch',
        label: TOOL_LABELS.WebSearch,
        ...(query ? { detail: truncate(query) } : {}),
        ...(sessionId ? { sessionId } : {}),
      }];
    }

    return [];
  }

  /** item.completed → tool_end 或缓存助手正文。 */
  private parseItemCompleted(item: CodexItem | undefined, sessionId?: string): CliEvent[] {
    const kind = itemKind(item);
    if (kind === 'agent_message' || kind === 'assistant_message') {
      if (typeof item?.text !== 'string' || !item.text.trim()) return [];
      const text = item.text.trim();
      this.lastAgentText = text;
      return [{
        type: 'assistant',
        text,
        ...(sessionId ? { sessionId } : {}),
      }];
    }

    // 成对关闭工具（若 started 时记下了 id）
    if (kind === 'command_execution' || kind === 'file_change' || kind === 'mcp_tool_call' || kind === 'web_search') {
      const id = toolUseId(item, '');
      const knownId = id && this.openTools.has(id)
        ? id
        : [...this.openTools.keys()].at(-1);
      if (!knownId) return [];
      this.openTools.delete(knownId);
      return [{
        type: 'tool_end',
        toolUseId: knownId,
        failed: false,
        ...(sessionId ? { sessionId } : {}),
      }];
    }

    return [];
  }
}
