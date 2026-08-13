import { codexMcpFlags } from '../mcp/config.js';
import {
  codexRuntimePlan,
  instructionsForExecutionPolicy,
  promptForExecutionPolicy,
} from './execution-policy.js';
import type {
  CliAdapter,
  CliBuildOptions,
  CliEvent,
  CliExecutionPolicy,
  CliRunStats,
} from './types.js';

interface CodexItem {
  type?: unknown;
  item_type?: unknown;
  id?: unknown;
  text?: unknown;
  command?: unknown;
  server?: unknown;
  tool?: unknown;
  query?: unknown;
  status?: unknown;
  exit_code?: unknown;
}

interface CodexEvent {
  type?: unknown;
  thread_id?: unknown;
  message?: unknown;
  error?: {
    message?: unknown;
  };
  item?: CodexItem;
  usage?: unknown;
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

function codexStats(usage: unknown): CliRunStats | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const row = usage as Record<string, unknown>;
  const number = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const inputTokens = number(row.input_tokens);
  const cacheReadTokens = number(row.cached_input_tokens);
  const outputTokens = number(row.output_tokens);
  const totalTokens = number(row.total_tokens)
    ?? [inputTokens, outputTokens].filter((value): value is number => value !== undefined)
      .reduce((sum, value) => sum + value, 0);
  const stats: CliRunStats = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens: totalTokens || undefined,
  };
  return Object.values(stats).some((value) => value !== undefined) ? stats : undefined;
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

  /** 新开 Codex 会话。 */
  buildArgs(prompt: string, options: CliBuildOptions = {}): string[] {
    const policy = options.executionPolicy ?? 'standard';
    const runtime = codexRuntimePlan(policy, options.localNetworkAccess === true);
    options.onCapabilityExpectation?.(runtime.expectation);
    return [
      '--ask-for-approval',
      codexApprovalPolicyFor(policy),
      '-c',
      `developer_instructions=${JSON.stringify(instructionsForExecutionPolicy(
        policy,
        options.approvedScope,
        runtime.expectation,
      ))}`,
      ...runtime.prefixArgs,
      'exec',
      '--skip-git-repo-check',
      '--json',
      ...sandboxFlagArgs(runtime.sandboxFlag),
      ...mcpFlagsFor(policy, options.mcpContextEnv),
      promptForExecutionPolicy(prompt, policy, options.approvedScope, runtime.expectation),
    ];
  }

  /** 恢复会话；若仍使用旧 `--sandbox`，必须挂在 exec 上。 */
  buildResumeArgs(prompt: string, sessionId: string, options: CliBuildOptions = {}): string[] {
    const policy = options.executionPolicy ?? 'standard';
    const runtime = codexRuntimePlan(policy, options.localNetworkAccess === true);
    options.onCapabilityExpectation?.(runtime.expectation);
    return [
      '--ask-for-approval',
      codexApprovalPolicyFor(policy),
      '-c',
      `developer_instructions=${JSON.stringify(instructionsForExecutionPolicy(
        policy,
        options.approvedScope,
        runtime.expectation,
      ))}`,
      ...runtime.prefixArgs,
      'exec',
      '--skip-git-repo-check',
      ...sandboxFlagArgs(runtime.sandboxFlag),
      ...mcpFlagsFor(policy, options.mcpContextEnv),
      'resume',
      '--json',
      sessionId,
      promptForExecutionPolicy(prompt, policy, options.approvedScope, runtime.expectation),
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
      // Codex CLI 有内置重连机制；"Reconnecting..." 消息表示正在重试，不是最终失败。
      // 只有在明确不可恢复时才返回 error 事件，否则让重连机制完成其工作。
      if (message.includes('Reconnecting')) {
        console.warn(`[Codex] ${message}（等待自动重连）`);
        return [];
      }
      return [{
        type: 'error',
        message,
        ...(sessionId ? { sessionId } : {}),
      }];
    }

    if (event.type === 'turn.completed') {
      if (!this.lastAgentText) return [];
      const stats = codexStats(event.usage);
      return [{
        type: 'result',
        answer: this.lastAgentText,
        ...(sessionId ? { sessionId } : {}),
        ...(stats ? { stats } : {}),
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
        failed: item?.status === 'failed'
          || (typeof item?.exit_code === 'number' && item.exit_code !== 0),
        ...(sessionId ? { sessionId } : {}),
      }];
    }

    return [];
  }
}

function sandboxFlagArgs(sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'): string[] {
  return sandbox ? ['--sandbox', sandbox] : [];
}

function mcpFlagsFor(policy: CliExecutionPolicy, contextEnv?: Record<string, string>): string[] {
  if (policy === 'input-only') {
    return ['--ignore-user-config', '--ignore-rules', '--ephemeral', '-c', 'mcp_servers={}'];
  }
  if (policy === 'read-only') {
    return ['--ignore-user-config', '-c', 'mcp_servers={}'];
  }
  return codexMcpFlags(contextEnv);
}

function codexApprovalPolicyFor(policy: CliExecutionPolicy): 'untrusted' | 'never' {
  // 普通任务遇到 Codex 判定为不可信的命令时必须失败并回到飞书审批门；
  // 已审批任务由持久化审批记录限定范围，其它只读策略依赖沙箱直接拒绝写入。
  return policy === 'standard' ? 'untrusted' : 'never';
}
