import { cursorMcpFlags, ensureCursorInputOnlyWorkspace } from '../mcp/config.js';
import { promptForExecutionPolicy } from './execution-policy.js';
import type {
  CliAdapter,
  CliBuildOptions,
  CliCapabilityExpectation,
  CliEvent,
  CliExecutionPolicy,
  CliRunStats,
} from './types.js';

interface CursorEvent {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  session_id?: unknown;
  duration_ms?: unknown;
  call_id?: unknown;
  tool_call?: unknown;
  message?: unknown;
}

interface CursorContentBlock {
  type?: unknown;
  text?: unknown;
}

const TOOL_LABELS: Record<string, string> = {
  Read: '读取文件',
  Write: '写入文件',
  Edit: '修改文件',
  Delete: '删除文件',
  Glob: '查找文件',
  Grep: '搜索代码',
  Bash: '运行命令',
  WebFetch: '读取网页',
  WebSearch: '搜索资料',
  MCP: '调用 MCP',
};

const TOOL_KEY_MAP: Record<string, string> = {
  readToolCall: 'Read',
  writeToolCall: 'Write',
  editToolCall: 'Edit',
  applyPatchToolCall: 'Edit',
  searchReplaceToolCall: 'Edit',
  deleteToolCall: 'Delete',
  grepToolCall: 'Grep',
  globToolCall: 'Glob',
  globFileSearchToolCall: 'Glob',
  shellToolCall: 'Bash',
  runTerminalCommandToolCall: 'Bash',
  terminalToolCall: 'Bash',
  webSearchToolCall: 'WebSearch',
  webFetchToolCall: 'WebFetch',
};

let warnedSandbox = false;
let warnedAutoModel = false;

export const DEFAULT_CURSOR_MODEL = 'cursor-grok-4.6-high';
const ALLOWED_CURSOR_MODELS = [DEFAULT_CURSOR_MODEL] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function shortPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.slice(normalized.startsWith('/') ? -2 : -3).join('/');
}

function shortText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function cursorCommand(): string {
  return process.env.CURSOR_CLI?.trim() || 'agent';
}

/** 只允许精确的 cursor-grok-4.6-high；auto / 其它模型一律回退，避免各角色悄悄换引擎。 */
export function isAllowedCursorModel(value: string): boolean {
  return ALLOWED_CURSOR_MODELS.includes(value.trim() as any);
}

function cursorModelFlags(): string[] {
  const configured = process.env.CURSOR_MODEL?.trim();
  if (!configured) return ['--model', DEFAULT_CURSOR_MODEL];
  if (isAllowedCursorModel(configured)) return ['--model', configured];
  if (!warnedAutoModel) {
    warnedAutoModel = true;
    console.warn(`[配置] CURSOR_MODEL=${configured} 已忽略，固定使用 ${DEFAULT_CURSOR_MODEL}`);
  }
  return ['--model', DEFAULT_CURSOR_MODEL];
}

function cursorSandbox(policy: CliExecutionPolicy, requestedNetwork = false): 'enabled' | 'disabled' {
  if (policy === 'read-only' || policy === 'input-only') return 'enabled';
  if (policy === 'evidence-write' && !requestedNetwork) return 'enabled';
  const configured = process.env.CURSOR_SANDBOX?.trim().toLowerCase();
  if (configured === 'enabled' || configured === 'disabled') return configured;
  if (configured && !warnedSandbox) {
    warnedSandbox = true;
    console.warn(`[配置] CURSOR_SANDBOX=${configured} 非法，回退到 disabled`);
  }
  return 'disabled';
}

function networkExpectation(
  policy: CliExecutionPolicy,
  sandbox: 'enabled' | 'disabled',
  requested: boolean,
): CliCapabilityExpectation {
  if (policy === 'read-only' || policy === 'input-only') {
    return {
      capability: 'local-network',
      requested,
      configApplied: false,
      expected: 'none',
      reason: 'policy-forbids-network',
    };
  }
  if (sandbox === 'enabled') {
    return {
      capability: 'local-network',
      requested,
      configApplied: false,
      expected: 'none',
      reason: 'sandbox-read-only',
    };
  }
  return {
    capability: 'local-network',
    requested,
    configApplied: true,
    expected: 'sandbox-provided',
    reason: 'sandbox-provides-network',
  };
}

function mcpFlagsFor(policy: CliExecutionPolicy, contextEnv?: Record<string, string>): string[] {
  if (policy === 'read-only' || policy === 'input-only') return [];
  return cursorMcpFlags(contextEnv);
}

function permissionFlags(policy: CliExecutionPolicy, sandbox: 'enabled' | 'disabled'): string[] {
  // Cursor 无头没有 Claude dontAsk / PreToolUse。要落盘必须 --force（否则只提案）；
  // --force 等于 YOLO，高风险命令不会被 CLI 拦截。绝不传 --auto-review。
  const flags = ['--trust', '--sandbox', sandbox];
  if (policy === 'read-only' || policy === 'input-only') {
    flags.unshift('--mode', 'ask');
    return flags;
  }
  flags.unshift('--force');
  return flags;
}

function isolationFlags(policy: CliExecutionPolicy): string[] {
  if (policy !== 'input-only') return [];
  return ['--workspace', ensureCursorInputOnlyWorkspace()];
}

function cursorPolicySuffix(policy: CliExecutionPolicy): string {
  if (policy === 'input-only') {
    return [
      '[Cursor 隔离说明]',
      '本次进程 cwd 与 --workspace 都指向空隔离目录，禁止读取用户项目文件，也不得调用任何 MCP。只分析提示中已经提供的数据。',
    ].join('\n');
  }
  if (policy === 'read-only') {
    return [
      '[Cursor 权限说明]',
      '本次为 --mode ask，只读分析；不得修改文件、运行有副作用的命令，也不得调用 MCP。',
    ].join('\n');
  }
  if (policy === 'evidence-write') {
    return [
      '[Cursor 权限说明]',
      '本次为证据写入。Cursor 无头 --force 做不到路径级写权限，不能在 OS 层禁止改 src/。',
      '只允许写 evidenceRoot 下本步 artifact；禁止改产品代码、测试或质量阈值。',
      '生产质检隔离优先 Claude。需要本机网络探测时可能关闭 sandbox，写隔离仍只靠本说明。',
    ].join('\n');
  }
  return [
    '[Cursor 权限说明]',
    '无头运行使用 --force，Cursor CLI 不会拦截高风险 Bash/MCP；这不是 Claude dontAsk，也没有 PreToolUse 闸门。',
    '生产变更、强制推送、不可逆删除、提权、密钥变更必须立即停止，让用户通过 /approval 重新发起。',
    '只允许调用 agent-os-ask 的 propose_questions 与 get_questionnaire；禁止使用工作区其它 MCP，禁止调用 record_answers。',
  ].join('\n');
}

function outputArgs(prompt: string, options: CliBuildOptions = {}): string[] {
  const policy = options.executionPolicy ?? 'standard';
  const sandbox = cursorSandbox(policy, options.localNetworkAccess === true);
  const expectation = networkExpectation(policy, sandbox, options.localNetworkAccess === true);
  options.onCapabilityExpectation?.(expectation);
  const task = promptForExecutionPolicy(prompt, policy, options.approvedScope, expectation);
  return [
    '-p',
    '--output-format',
    'stream-json',
    ...cursorModelFlags(),
    ...permissionFlags(policy, sandbox),
    ...isolationFlags(policy),
    ...mcpFlagsFor(policy, options.mcpContextEnv),
    `${cursorPolicySuffix(policy)}\n\n${task}`,
  ];
}

function messageBlocks(message: unknown): CursorContentBlock[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

function parseStats(event: CursorEvent): CliRunStats | undefined {
  const stats: CliRunStats = {
    durationMs: asNumber(event.duration_ms),
  };
  return stats.durationMs === undefined ? undefined : stats;
}

function toolInfo(toolCall: unknown): { name: string; detail?: string; failed: boolean } {
  if (!isRecord(toolCall)) return { name: 'unknown', failed: false };
  const [key, value] = Object.entries(toolCall)[0] ?? [];
  if (!key) return { name: 'unknown', failed: false };

  if (key === 'function' && isRecord(value)) {
    const name = typeof value.name === 'string' && value.name ? value.name : 'function';
    const args = typeof value.arguments === 'string' ? value.arguments : undefined;
    const result = isRecord(value.result) ? value.result : undefined;
    return {
      name,
      ...(args ? { detail: shortText(args) } : {}),
      failed: toolFailed(result),
    };
  }

  const name = TOOL_KEY_MAP[key] ?? key.replace(/ToolCall$/, '') ?? key;
  const payload = isRecord(value) ? value : {};
  const args = isRecord(payload.args) ? payload.args : {};
  const detail = shortPath(args.path)
    ?? shortText(args.command)
    ?? shortText(args.query)
    ?? shortText(args.pattern);
  return {
    name,
    ...(detail ? { detail } : {}),
    failed: toolFailed(payload.result),
  };
}

function toolFailed(result: unknown): boolean {
  if (!isRecord(result)) return false;
  if ('error' in result || 'failure' in result) return true;
  if ('success' in result) return false;
  return false;
}

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? (name.startsWith('mcp') || name.includes('/') ? TOOL_LABELS.MCP : `调用 ${name}`);
}

/**
 * Cursor Agent CLI 适配器。
 * 无头调用本机 `agent`（可用 CURSOR_CLI 覆盖），解析 stream-json。
 * 官方终态 `result` 会把多段 assistant 文本无换行粘在一起，破坏行首 [RESULT]/[APPROVED]；
 * 因此按 Codex 同样策略缓存各段完整消息，用空行拼接后再交给流水线协议。
 */
export class CursorAdapter implements CliAdapter {
  readonly id = 'cursor' as const;
  readonly displayName = 'Cursor Agent';
  private readonly assistantTexts: string[] = [];
  private toolSeq = 0;

  get command(): string {
    return cursorCommand();
  }

  buildArgs(prompt: string, options: CliBuildOptions = {}): string[] {
    return outputArgs(prompt, options);
  }

  buildResumeArgs(prompt: string, sessionId: string, options: CliBuildOptions = {}): string[] {
    return ['--resume', sessionId, ...outputArgs(prompt, options)];
  }

  resolveSpawnCwd(requestedCwd: string, policy: CliExecutionPolicy): string {
    return policy === 'input-only' ? ensureCursorInputOnlyWorkspace() : requestedCwd;
  }

  parseEvents(line: string): CliEvent[] {
    let event: CursorEvent;
    try {
      event = JSON.parse(line) as CursorEvent;
    } catch {
      return [];
    }

    const sessionId = typeof event.session_id === 'string' ? event.session_id : undefined;
    if (event.type === 'system' && event.subtype === 'init' && sessionId) {
      return [{ type: 'session', sessionId }];
    }

    if (event.type === 'assistant') {
      return messageBlocks(event.message).flatMap((block): CliEvent[] => {
        if (block.type !== 'text' || typeof block.text !== 'string') return [];
        const text = block.text.trim();
        if (!text) return [];
        this.assistantTexts.push(text);
        return [{ type: 'assistant', text, ...(sessionId ? { sessionId } : {}) }];
      });
    }

    if (event.type === 'tool_call') {
      const id = typeof event.call_id === 'string' && event.call_id
        ? event.call_id
        : `cursor-tool-${++this.toolSeq}`;
      const info = toolInfo(event.tool_call);
      if (event.subtype === 'started') {
        return [{
          type: 'tool_start',
          toolUseId: id,
          toolName: info.name,
          label: toolLabel(info.name),
          ...(info.detail ? { detail: info.detail } : {}),
          ...(sessionId ? { sessionId } : {}),
        }];
      }
      if (event.subtype === 'completed') {
        return [{
          type: 'tool_end',
          toolUseId: id,
          failed: info.failed,
          ...(sessionId ? { sessionId } : {}),
        }];
      }
      return [];
    }

    if (event.type !== 'result') return [];
    if (event.is_error) {
      return [{
        type: 'error',
        message: typeof event.result === 'string' ? event.result : 'Cursor Agent 执行失败',
        ...(sessionId ? { sessionId } : {}),
      }];
    }
    if (typeof event.result !== 'string' && this.assistantTexts.length === 0) return [];
    const stats = parseStats(event);
    const answer = this.assistantTexts.length > 0
      ? this.assistantTexts.join('\n\n')
      : event.result as string;
    return [{
      type: 'result',
      answer,
      ...(sessionId ? { sessionId } : {}),
      ...(stats ? { stats } : {}),
    }];
  }
}
