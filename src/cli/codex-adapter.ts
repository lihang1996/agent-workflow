import type { CliAdapter, CliEvent } from './types.js';

interface CodexItem {
  type?: unknown;
  item_type?: unknown;
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

function itemKind(item: CodexItem | undefined): string | undefined {
  if (!item) return undefined;
  if (typeof item.type === 'string') return item.type;
  if (typeof item.item_type === 'string') return item.item_type;
  return undefined;
}

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Codex 适配器按「单次 run」实例化：会缓存 thread_id / 最后一条 agent 消息，
 * 在 turn.completed 时再产出最终 result，避免中间旁白被当成答案。
 */
export class CodexAdapter implements CliAdapter {
  readonly id = 'codex' as const;
  readonly command = 'codex';
  readonly displayName = 'Codex';

  private threadId?: string;
  private lastAgentText?: string;

  constructor(
    private readonly sandbox = process.env.CODEX_SANDBOX ?? 'workspace-write',
  ) {}

  private commonFlags(): string[] {
    return ['--json', '--sandbox', this.sandbox];
  }

  buildArgs(prompt: string): string[] {
    return ['exec', ...this.commonFlags(), prompt];
  }

  buildResumeArgs(prompt: string, sessionId: string): string[] {
    return ['exec', 'resume', sessionId, ...this.commonFlags(), prompt];
  }

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

  private parseToolStart(item: CodexItem | undefined, sessionId?: string): CliEvent[] {
    const kind = itemKind(item);
    if (!kind) return [];

    if (kind === 'command_execution') {
      const command = typeof item?.command === 'string' ? item.command : undefined;
      return [{
        type: 'tool',
        name: 'Bash',
        ...(command ? { inputSummary: truncate(command) } : {}),
        ...(sessionId ? { sessionId } : {}),
      }];
    }

    if (kind === 'file_change') {
      return [{
        type: 'tool',
        name: 'FileChange',
        ...(sessionId ? { sessionId } : {}),
      }];
    }

    if (kind === 'mcp_tool_call') {
      const server = typeof item?.server === 'string' ? item.server : undefined;
      const tool = typeof item?.tool === 'string' ? item.tool : undefined;
      const name = [server, tool].filter(Boolean).join('/') || 'MCP';
      return [{
        type: 'tool',
        name,
        ...(sessionId ? { sessionId } : {}),
      }];
    }

    if (kind === 'web_search') {
      const query = typeof item?.query === 'string' ? item.query : undefined;
      return [{
        type: 'tool',
        name: 'WebSearch',
        ...(query ? { inputSummary: truncate(query) } : {}),
        ...(sessionId ? { sessionId } : {}),
      }];
    }

    return [];
  }

  private parseItemCompleted(item: CodexItem | undefined, sessionId?: string): CliEvent[] {
    const kind = itemKind(item);
    if (kind !== 'agent_message' && kind !== 'assistant_message') return [];
    if (typeof item?.text !== 'string' || !item.text.trim()) return [];

    const text = item.text.trim();
    this.lastAgentText = text;
    return [{
      type: 'assistant',
      text,
      ...(sessionId ? { sessionId } : {}),
    }];
  }
}
