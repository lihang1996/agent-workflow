import type { AppToolName } from '../core/app-tool-policy.js';
import type { ModelSelection } from '../core/model-selection.js';
import { assertModelSelectionSupported } from '../core/engine-capabilities.js';
import type { CliAdapter, CliAttachment, CliEvent, CliPromptInput } from './types.js';
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

const NATIVE_TOOLS: Record<string, { toolName: string; label: string }> = {
  readToolCall: { toolName: 'Read', label: '读取文件' },
  writeToolCall: { toolName: 'Write', label: '写入文件' },
  editToolCall: { toolName: 'Edit', label: '修改文件' },
  grepToolCall: { toolName: 'Grep', label: '搜索代码' },
  globToolCall: { toolName: 'Glob', label: '查找文件' },
  shellToolCall: { toolName: 'Bash', label: '运行命令' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function shortText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
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

function appToolName(name: string): AppToolName | undefined {
  if (APP_TOOL_NAMES.has(name)) return name as AppToolName;
  const stripped = name.startsWith('mcp__agent_os__')
    ? name.slice('mcp__agent_os__'.length)
    : name;
  return APP_TOOL_NAMES.has(stripped) ? stripped as AppToolName : undefined;
}

function toolCallEntry(toolCall: Record<string, unknown>): {
  key: string;
  payload: Record<string, unknown>;
} | undefined {
  if (isRecord(toolCall.mcpToolCall)) {
    return { key: 'mcpToolCall', payload: toolCall.mcpToolCall };
  }
  if (isRecord(toolCall.function)) {
    return { key: 'function', payload: toolCall.function };
  }
  const key = Object.keys(toolCall)[0];
  if (!key || !isRecord(toolCall[key])) return undefined;
  return { key, payload: toolCall[key] };
}

function businessTool(entry: { key: string; payload: Record<string, unknown> }): {
  name: AppToolName;
  input: unknown;
} | undefined {
  if (entry.key === 'mcpToolCall') {
    const args = isRecord(entry.payload.args) ? entry.payload.args : undefined;
    if (!args || args.providerIdentifier !== 'agent_os' || typeof args.toolName !== 'string') {
      return undefined;
    }
    const name = appToolName(args.toolName);
    return name ? { name, input: parseInput(args.args) } : undefined;
  }
  if (entry.key === 'function' && typeof entry.payload.name === 'string') {
    const name = appToolName(entry.payload.name);
    return name
      ? {
          name,
          input: parseInput(entry.payload.arguments ?? entry.payload.args ?? entry.payload.input),
        }
      : undefined;
  }
  return undefined;
}

function nestedSuccessError(result: Record<string, unknown>): boolean {
  return isRecord(result.success) && result.success.isError === true;
}

function toolFailed(event: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  if (event.is_error === true) return true;
  const result = payload.result;
  if (!isRecord(result)) return false;
  return result.isError === true
    || nestedSuccessError(result)
    || 'error' in result
    || 'failure' in result
    || result.success === false;
}

function toolSucceeded(payload: Record<string, unknown>): boolean {
  const result = payload.result;
  if (!isRecord(result)) return false;
  if (toolFailed({}, payload)) return false;
  return 'success' in result
    || result.isError === false
    || Array.isArray(result.content);
}

function toolDetail(payload: Record<string, unknown>): string | undefined {
  const args = isRecord(payload.args) ? payload.args : payload;
  return shortPath(args.path)
    ?? shortPath(args.file_path)
    ?? shortText(args.command)
    ?? shortText(args.pattern)
    ?? shortText(args.query);
}

function outputArgs(
  prompt: string,
  promptInput: CliPromptInput,
  sessionId?: string,
  modelSelection?: ModelSelection | null,
): string[] {
  // 执行级模型声明优先；未声明时沿用用户全局 CURSOR_CLI_MODEL（历史行为）。
  const declared = modelSelection?.model?.trim();
  const model = declared ?? process.env.CURSOR_CLI_MODEL?.trim();
  return [
    '-p',
    '--force',
    ...(model ? ['--model', model] : []),
    '--output-format',
    'stream-json',
    ...(sessionId ? ['--resume', sessionId] : []),
    ...(promptInput === 'argument' ? [prompt] : []),
  ];
}

/** cursor 无独立推理强度参数（--model 来自 agent --help，2026.08.11），显式配置即拒绝。 */
function cursorModelArgs(modelSelection?: ModelSelection | null): void {
  if (!modelSelection?.model && !modelSelection?.reasoningEffort) return;
  assertModelSelectionSupported('cursor', {
    model: modelSelection?.model ?? null,
    reasoningEffort: modelSelection?.reasoningEffort ?? null,
  });
}

export class CursorAdapter implements CliAdapter {
  constructor(readonly appTools: readonly AppToolName[] = []) {}
  readonly id = 'cursor' as const;
  readonly command = process.env.CURSOR_CLI_COMMAND?.trim() || 'agent';
  readonly displayName = 'Cursor';
  private readonly emittedBusinessCalls = new Set<string>();

  buildArgs(
    prompt: string,
    promptInput: CliPromptInput,
    _attachments?: readonly CliAttachment[],
    modelSelection?: ModelSelection | null,
  ): string[] {
    cursorModelArgs(modelSelection);
    return outputArgs(prompt, promptInput, undefined, modelSelection);
  }

  buildResumeArgs(
    prompt: string,
    sessionId: string,
    promptInput: CliPromptInput,
    _attachments?: readonly CliAttachment[],
    modelSelection?: ModelSelection | null,
  ): string[] {
    cursorModelArgs(modelSelection);
    return outputArgs(prompt, promptInput, sessionId, modelSelection);
  }

  buildEnv(): Record<string, string> {
    return { AGENT_OS_ALLOWED_TOOLS: this.appTools.join(',') };
  }

  parseEvents(line: string): CliEvent[] {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }

    const sessionId = typeof event.session_id === 'string' ? event.session_id : undefined;
    if (event.type === 'system' && event.subtype === 'init' && sessionId) {
      return [{ type: 'session', sessionId }];
    }
    if (event.type === 'assistant') return [];
    if (event.type === 'tool_call' && typeof event.call_id === 'string' && isRecord(event.tool_call)) {
      const entry = toolCallEntry(event.tool_call);
      if (!entry) return [];
      const business = businessTool(entry);
      const native = NATIVE_TOOLS[entry.key];
      const toolName = business?.name
        ?? native?.toolName
        ?? (typeof entry.payload.name === 'string' ? entry.payload.name : entry.key);
      const label = native?.label ?? `调用 ${toolName}`;
      const detail = toolDetail(entry.payload);
      if (event.subtype === 'started') {
        return [{
          type: 'tool_start',
          toolUseId: event.call_id,
          toolName,
          label,
          ...(detail ? { detail } : {}),
        }];
      }
      if (event.subtype !== 'completed') return [];
      const failed = toolFailed(event, entry.payload);
      const events: CliEvent[] = [];
      if (
        business
        && !failed
        && toolSucceeded(entry.payload)
        && !this.emittedBusinessCalls.has(event.call_id)
      ) {
        this.emittedBusinessCalls.add(event.call_id);
        events.push({
          type: 'tool_call',
          toolUseId: event.call_id,
          toolName: business.name,
          input: business.input,
        });
      }
      events.push({
        type: 'tool_end',
        toolUseId: event.call_id,
        failed,
      });
      return events;
    }
    if (event.type !== 'result') return [];
    if (event.subtype === 'success' && event.is_error === false && typeof event.result === 'string') {
      const durationMs = asNumber(event.duration_ms);
      return [{
        type: 'result',
        answer: event.result,
        ...(sessionId ? { sessionId } : {}),
        ...(durationMs === undefined ? {} : { stats: { durationMs } }),
      }];
    }
    if (event.is_error === true) {
      return [{
        type: 'error',
        message: typeof event.result === 'string' ? event.result : 'Cursor 执行失败',
        ...(sessionId ? { sessionId } : {}),
      }];
    }
    return [];
  }
}
