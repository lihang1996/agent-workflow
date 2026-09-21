import type { AppToolName } from '../core/app-tool-policy.js';
import type {
  CliAdapter,
  CliAttachment,
  CliPromptInput,
  CliEvent,
  CliRunStats,
} from './types.js';
import {
  CLARIFICATION_TOOL_NAME,
  PRODUCT_SPEC_TOOL_NAME,
  DISPATCH_TASK_TOOL_NAME,
} from './app-tools.js';

const APP_TOOL_NAMES = new Set<string>([
  CLARIFICATION_TOOL_NAME,
  PRODUCT_SPEC_TOOL_NAME,
  DISPATCH_TASK_TOOL_NAME,
]);

/** ZCode 用 `mcp__<server>__<tool>` 命名 MCP 工具；只认 agent_os 来源的业务调用。 */
const AGENT_OS_TOOL_PREFIX = 'mcp__agent_os__';

const TOOL_LABELS: Record<string, string> = {
  Bash: '运行命令',
  Edit: '修改文件',
  Glob: '查找文件',
  Grep: '搜索代码',
  Read: '读取文件',
  WebSearch: '搜索资料',
  Write: '写入文件',
};

interface ZcodeEvent {
  type?: unknown;
  sessionId?: unknown;
  response?: unknown;
  payload?: unknown;
  usage?: unknown;
  projection?: unknown;
}

interface PendingTool {
  name: string;
  input?: unknown;
  inputOmitted: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 本轮 usage 才是本轮用量；projection.totalTokenCount 是会话累计，不能拿来冒充。 */
function parseStats(event: ZcodeEvent): CliRunStats | undefined {
  const usage = isRecord(event.usage) ? event.usage : undefined;
  const projection = isRecord(event.projection) ? event.projection : undefined;
  const details = usage && isRecord(usage.inputTokenDetails)
    ? usage.inputTokenDetails
    : undefined;
  const stats: CliRunStats = {
    totalTokens: asNumber(usage?.totalTokens),
    inputTokens: asNumber(usage?.inputTokens),
    outputTokens: asNumber(usage?.outputTokens),
    cacheReadTokens: asNumber(usage?.cacheReadTokens)
      ?? asNumber(usage?.cachedInputTokens)
      ?? asNumber(details?.cacheReadTokens),
    turns: asNumber(projection?.turnCount),
    contextUsedTokens: asNumber(projection?.contextUsed),
    contextWindowTokens: asNumber(projection?.contextWindow),
  };
  return Object.values(stats).some((value) => value !== undefined)
    ? stats
    : undefined;
}

function carriesSessionId(event: CliEvent, sessionId: string): boolean {
  return event.type === 'session' || ('sessionId' in event && event.sessionId === sessionId);
}

function withSession(events: CliEvent[], sessionId?: string): CliEvent[] {
  if (!sessionId || events.some((event) => carriesSessionId(event, sessionId))) {
    return events;
  }
  return [{ type: 'session', sessionId }, ...events];
}

function shortText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function shortPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.slice(normalized.startsWith('/') ? -2 : -3).join('/');
}

function parseInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toolDetail(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  return shortPath(input.path)
    ?? shortPath(input.file_path)
    ?? shortText(input.command)
    ?? shortText(input.pattern)
    ?? shortText(input.query);
}

/** 业务调用候选：仅识别 `mcp__agent_os__<tool>` 且工具名在三个业务工具内。 */
function businessToolCall(name: string | undefined, input: unknown): {
  name: AppToolName;
  input: unknown;
} | undefined {
  if (!name || !name.startsWith(AGENT_OS_TOOL_PREFIX)) return undefined;
  const tool = name.slice(AGENT_OS_TOOL_PREFIX.length);
  return APP_TOOL_NAMES.has(tool)
    ? { name: tool as AppToolName, input: parseInput(input) }
    : undefined;
}

function toolResultFailed(result: unknown, isBusinessTool: boolean): boolean {
  if (!isRecord(result)) return false;
  return result.isError === true
    || result.success === false
    || 'error' in result
    || 'failure' in result
    // CLI 0.16.9 会把 MCP 业务错误包装为执行器成功；仅对已识别的业务工具检查。
    || (isBusinessTool && result.success === true
      && typeof result.content === 'string'
      && result.content.startsWith('MCP tool returned an error:'));
}

/** 不能只因 `kind=result` 就提交业务动作：必须有明确的成功信号。 */
function toolResultSucceeded(result: unknown, isBusinessTool: boolean): boolean {
  if (!isRecord(result)) return false;
  if (toolResultFailed(result, isBusinessTool)) return false;
  return result.success === true
    || result.isError === false
    || Array.isArray(result.content);
}

function zcodeAttachArgs(attachments: readonly CliAttachment[] = []): string[] {
  return attachments.flatMap((attachment) => ['--attach', attachment.path]);
}

function outputArgs(prompt: string, sessionId?: string): string[] {
  return [
    '--prompt',
    prompt,
    ...(sessionId ? ['--resume', sessionId] : []),
    '--mode',
    'yolo',
    '--output-format',
    'stream-json',
  ];
}

/**
 * ZCode Adapter。事件映射依据官方 CLI 0.16.9 的序列化实现（见
 * docs/zcode-cli-integration-plan.md 第 3 节）。turn.failed 已有失败样本；
 * 顶层 result 的 usage/projection 字段来自源码序列化，待成功 stdout 样本复核。
 *
 * 关联记录（scheduled 暂存的名称/输入）与业务去重状态仅属于本次执行：
 * ZcodeAdapter 不进入共享单例，评论等空权限执行也各自创建实例。
 */
export class ZcodeAdapter implements CliAdapter {
  constructor(readonly appTools: readonly AppToolName[] = []) {}
  readonly id = 'zcode' as const;
  readonly command = process.env.ZCODE_CLI_COMMAND?.trim() || 'zcode';
  readonly displayName = 'ZCode';
  private readonly pendingTools = new Map<string, PendingTool>();
  private readonly emittedBusinessCalls = new Set<string>();

  buildArgs(
    prompt: string,
    promptInput: CliPromptInput,
    attachments?: readonly CliAttachment[],
  ): string[] {
    this.assertArgumentPrompt(promptInput);
    return [...outputArgs(prompt), ...zcodeAttachArgs(attachments)];
  }

  buildResumeArgs(
    prompt: string,
    sessionId: string,
    promptInput: CliPromptInput,
    attachments?: readonly CliAttachment[],
  ): string[] {
    this.assertArgumentPrompt(promptInput);
    return [...outputArgs(prompt, sessionId), ...zcodeAttachArgs(attachments)];
  }

  buildEnv(): Record<string, string> {
    return { AGENT_OS_ALLOWED_TOOLS: this.appTools.join(',') };
  }

  parseEvents(line: string): CliEvent[] {
    let event: ZcodeEvent;
    try {
      event = JSON.parse(line) as ZcodeEvent;
    } catch {
      return [];
    }
    if (!isRecord(event) || typeof event.type !== 'string') return [];
    const sessionId = typeof event.sessionId === 'string' && event.sessionId
      ? event.sessionId
      : undefined;

    if (event.type === 'session.created' || event.type === 'session.resumed') {
      return sessionId ? [{ type: 'session', sessionId }] : [];
    }

    if (event.type === 'turn.failed') {
      const error = isRecord(event.payload) && isRecord(event.payload.error)
        ? event.payload.error
        : {};
      const message = typeof error.message === 'string' && error.message.trim()
        ? error.message
        : typeof error.detail === 'string' && error.detail.trim()
          ? error.detail
          : 'ZCode 执行失败';
      return withSession(
        [{ type: 'error', message, ...(sessionId ? { sessionId } : {}) }],
        sessionId,
      );
    }

    if (event.type === 'result') {
      if (typeof event.response !== 'string') return withSession([], sessionId);
      const stats = parseStats(event);
      return withSession([{
        type: 'result',
        answer: event.response,
        ...(sessionId ? { sessionId } : {}),
        ...(stats ? { stats } : {}),
      }], sessionId);
    }

    if (event.type === 'tool.updated') {
      return withSession(this.parseToolUpdated(event.payload), sessionId);
    }
    return withSession([], sessionId);
  }

  private parseToolUpdated(payload: unknown): CliEvent[] {
    if (!isRecord(payload)) return [];
    const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : '';
    if (!toolCallId) return [];

    if (payload.kind === 'scheduled') {
      const name = typeof payload.toolName === 'string' ? payload.toolName : '';
      if (name) {
        this.pendingTools.set(toolCallId, {
          name,
          input: payload.input,
          inputOmitted: payload.inputOmitted === true,
        });
      }
      return [];
    }

    if (payload.kind === 'started') {
      const pending = this.pendingTools.get(toolCallId);
      const rawName = typeof payload.toolName === 'string' && payload.toolName
        ? payload.toolName
        : pending?.name;
      if (!rawName) return [];
      const business = businessToolCall(rawName, undefined);
      const toolName = business?.name ?? rawName;
      const detail = toolDetail(payload.input ?? pending?.input);
      return [{
        type: 'tool_start',
        toolUseId: toolCallId,
        toolName,
        label: TOOL_LABELS[toolName] ?? `调用 ${toolName}`,
        ...(detail ? { detail } : {}),
      }];
    }

    if (payload.kind === 'result') {
      const pending = this.pendingTools.get(toolCallId);
      this.pendingTools.delete(toolCallId);
      const business = businessToolCall(pending?.name, pending?.input);
      const failed = toolResultFailed(payload.result, business !== undefined);
      const events: CliEvent[] = [];
      if (
        !failed
        && business
        && pending
        && !pending.inputOmitted
        && !this.emittedBusinessCalls.has(toolCallId)
        && toolResultSucceeded(payload.result, true)
      ) {
        this.emittedBusinessCalls.add(toolCallId);
        events.push({
          type: 'tool_call',
          toolUseId: toolCallId,
          toolName: business.name,
          input: business.input,
        });
      }
      events.push({ type: 'tool_end', toolUseId: toolCallId, failed });
      return events;
    }

    if (payload.kind === 'error') {
      // 工具出错：结束该调用并丢弃业务提交候选，不猜测结果。
      this.pendingTools.delete(toolCallId);
      return [{ type: 'tool_end', toolUseId: toolCallId, failed: true }];
    }

    return [];
  }

  private assertArgumentPrompt(promptInput: CliPromptInput): void {
    if (promptInput !== 'stdin') return;
    // ZCode 的 prompt 入口只读取 --prompt 参数（源码已核对），stdin 不会自动变成
    // prompt；首版仅按 macOS 验收，Windows 支持留待后续输入方式声明。
    throw new Error('ZCode 当前只支持参数方式传入任务（首版仅按 macOS 验收）');
  }
}
