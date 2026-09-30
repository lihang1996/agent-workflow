import type { CliAdapter, CliAttachment, CliPromptInput, CliEvent, CliRunStats } from './types.js';
import type { AppToolName } from '../core/app-tool-policy.js';
import type { ModelSelection } from '../core/model-selection.js';
import { assertModelSelectionSupported } from '../core/engine-capabilities.js';
import {
  CLARIFICATION_TOOL_NAME,
  PRODUCT_SPEC_TOOL_NAME,
  DISPATCH_TASK_TOOL_NAME,
  codexAppToolArgs,
} from './app-tools.js';

interface CodexEvent {
  type?: unknown;
  thread_id?: unknown;
  item?: unknown;
  usage?: unknown;
  error?: unknown;
  message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function shortText(value: unknown, maxLength = 72): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function firstChangedPath(item: Record<string, unknown>): string | undefined {
  if (typeof item.path === 'string') return shortText(item.path);
  if (!Array.isArray(item.changes)) return undefined;
  const change = item.changes.find(isRecord);
  return change ? shortText(change.path) : undefined;
}

function toolInfo(item: Record<string, unknown>): {
  toolName: string;
  label: string;
  detail?: string;
} | undefined {
  if (item.type === 'command_execution') {
    const detail = shortText(item.command);
    return { toolName: 'Bash', label: '运行命令', ...(detail ? { detail } : {}) };
  }
  if (item.type === 'file_change') {
    const detail = firstChangedPath(item);
    return { toolName: 'Edit', label: '修改文件', ...(detail ? { detail } : {}) };
  }
  if (item.type === 'web_search') {
    const detail = shortText(item.query);
    return { toolName: 'WebSearch', label: '搜索资料', ...(detail ? { detail } : {}) };
  }
  if (item.type === 'mcp_tool_call') {
    const server = typeof item.server === 'string' ? item.server : '';
    const tool = typeof item.tool === 'string' ? item.tool : '';
    const detail = shortText([server, tool].filter(Boolean).join('.'));
    return { toolName: 'MCP', label: '调用外部工具', ...(detail ? { detail } : {}) };
  }
  return undefined;
}

function parseStats(usage: unknown): CliRunStats | undefined {
  if (!isRecord(usage)) return undefined;
  const inputTokens = asNumber(usage.input_tokens);
  const outputTokens = asNumber(usage.output_tokens);
  const cacheReadTokens = asNumber(usage.cached_input_tokens);
  const totalTokens = inputTokens === undefined && outputTokens === undefined
    ? undefined
    : (inputTokens ?? 0) + (outputTokens ?? 0);
  const stats: CliRunStats = {
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
  };
  return Object.values(stats).some((value) => value !== undefined)
    ? stats
    : undefined;
}

function errorMessage(event: CodexEvent): string {
  if (typeof event.message === 'string') return event.message;
  if (isRecord(event.error) && typeof event.error.message === 'string') {
    return event.error.message;
  }
  return 'Codex 执行失败';
}

/** `codex exec` / `codex exec resume` 都支持 `-i <FILE>` 把图片直接送入多模态输入。 */
function codexImageArgs(attachments: readonly CliAttachment[] = []): string[] {
  return attachments
    .filter((attachment) => attachment.type === 'image')
    .flatMap((attachment) => ['-i', attachment.path]);
}

/**
 * -m/--model 来自 codex exec --help（0.150.1）；推理强度键名
 * model_reasoning_effort 在二进制源码字符串中核实，取值枚举本地不校验。
 */
function codexModelArgs(modelSelection?: ModelSelection | null): string[] {
  if (!modelSelection?.model && !modelSelection?.reasoningEffort) return [];
  assertModelSelectionSupported('codex', {
    model: modelSelection?.model ?? null,
    reasoningEffort: modelSelection?.reasoningEffort ?? null,
  });
  return [
    ...(modelSelection.model ? ['-m', modelSelection.model] : []),
    ...(modelSelection.reasoningEffort
      ? ['-c', `model_reasoning_effort="${modelSelection.reasoningEffort}"`]
      : []),
  ];
}

export class CodexAdapter implements CliAdapter {
  constructor(readonly appTools: readonly AppToolName[] = []) {}
  readonly id = 'codex' as const;
  readonly command = 'codex';
  readonly displayName = 'Codex';

  buildArgs(
    prompt: string,
    promptInput: CliPromptInput,
    attachments?: readonly CliAttachment[],
    modelSelection?: ModelSelection | null,
  ): string[] {
    const args = [
      ...codexAppToolArgs(this.appTools),
      'exec',
      ...codexModelArgs(modelSelection),
      '--json',
      '--skip-git-repo-check',
      ...codexImageArgs(attachments),
    ];
    // Windows 上沙箱功能不支持，必须完全禁用；approvals 也一并绕过。
    if (process.platform === 'win32') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('--yolo');
    }
    // 从 stdin 读取 prompt，规避 Windows 下 shell 参数转义问题。
    args.push(promptInput === 'stdin' ? '-' : prompt);
    return args;
  }

  buildResumeArgs(
    prompt: string,
    sessionId: string,
    promptInput: CliPromptInput,
    attachments?: readonly CliAttachment[],
    modelSelection?: ModelSelection | null,
  ): string[] {
    const args = [
      ...codexAppToolArgs(this.appTools),
      'exec',
      'resume',
      ...codexModelArgs(modelSelection),
      '--json',
      '--skip-git-repo-check',
      ...codexImageArgs(attachments),
      sessionId,
    ];
    // Windows 上沙箱功能不支持，必须完全禁用；approvals 也一并绕过。
    if (process.platform === 'win32') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('--yolo');
    }
    // 从 stdin 读取 prompt，规避 Windows 下 shell 参数转义问题。
    args.push(promptInput === 'stdin' ? '-' : prompt);
    return args;
  }

  buildCompactPlan(sessionId: string) {
    return {
      protocol: 'codex-app-server' as const,
      command: this.command,
      args: ['app-server', '--stdio'],
      sessionId,
    };
  }

  parseEvents(line: string): CliEvent[] {
    let event: CodexEvent;
    try {
      event = JSON.parse(line) as CodexEvent;
    } catch {
      return [];
    }

    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      return [{ type: 'session', sessionId: event.thread_id }];
    }
    if (event.type === 'error' || event.type === 'turn.failed') {
      return [{ type: 'error', message: errorMessage(event) }];
    }
    if (event.type === 'turn.completed') {
      const stats = parseStats(event.usage);
      if (!stats) return [];
      return [{ type: 'result', answer: '', stats }];
    }
    if (!isRecord(event.item)) return [];
    const item = event.item;
    if (
      event.type === 'item.completed'
      && item.type === 'agent_message'
      && typeof item.text === 'string'
    ) {
      return [{ type: 'result', answer: item.text }];
    }
    if (typeof item.id !== 'string') return [];
    const tool = toolInfo(item);
    if (!tool) return [];
    if (event.type === 'item.started') {
      const events: CliEvent[] = [{
        type: 'tool_start',
        toolUseId: item.id,
        ...tool,
      }];
      if (
        item.type === 'mcp_tool_call'
        && item.server === 'agent_os'
        && (
          item.tool === CLARIFICATION_TOOL_NAME
          || item.tool === PRODUCT_SPEC_TOOL_NAME
          || item.tool === DISPATCH_TASK_TOOL_NAME
        )
      ) {
        events.push({
          type: 'tool_call',
          toolUseId: item.id,
          toolName: item.tool,
          input: item.arguments ?? item.input,
        });
      }
      return events;
    }
    if (event.type === 'item.completed') {
      const exitCode = asNumber(item.exit_code);
      return [{
        type: 'tool_end',
        toolUseId: item.id,
        failed: item.status === 'failed' || (exitCode !== undefined && exitCode !== 0),
      }];
    }
    return [];
  }
}
