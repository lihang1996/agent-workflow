import type { AppToolName } from '../core/app-tool-policy.js';

export type CliId = 'claude' | 'codex';

export type CliPromptInput = 'argument' | 'stdin';

/** Windows 上 prompt 必须走 stdin（避免 cmd 对命令行参数转义/乱码），其他平台直接走参数。 */
export function promptInputForPlatform(platform: NodeJS.Platform): CliPromptInput {
  return platform === 'win32' ? 'stdin' : 'argument';
}

export type CliCompactPlan =
  | {
      protocol: 'claude-stream-json';
      command: string;
      args: string[];
      prompt: string;
    }
  | {
      protocol: 'codex-app-server';
      command: string;
      args: string[];
      sessionId: string;
    };

export interface CliRunStats {
  durationMs?: number;
  turns?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
}

export interface CliSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export type CliEvent =
  | { type: 'session'; sessionId: string }
  | {
      type: 'tool_start';
      toolUseId: string;
      toolName: string;
      label: string;
      detail?: string;
    }
  | { type: 'tool_end'; toolUseId: string; failed: boolean }
  | { type: 'context'; usedTokens: number }
  | {
      type: 'tool_call';
      toolUseId: string;
      toolName: string;
      input: unknown;
    }
  | { type: 'result'; answer: string; sessionId?: string; stats?: CliRunStats }
  | { type: 'error'; message: string; sessionId?: string };

/** 随飞书消息一起到达、已保存到本机的图片或文件。path 为绝对路径。 */
export interface CliAttachment {
  path: string;
  type: 'image' | 'file';
  fileName?: string;
}

export interface CliAdapter {
  readonly appTools: readonly AppToolName[];
  readonly id: CliId;
  readonly command: string;
  readonly displayName: string;
  /**
   * 附件路径已经写进 prompt，任何能读本地文件的 CLI 都能处理；
   * 适配器可以额外把图片交给原生多模态入口（如 Codex 的 `-i`）。
   */
  buildArgs(
    prompt: string,
    promptInput: CliPromptInput,
    attachments?: readonly CliAttachment[],
  ): string[];
  buildResumeArgs(
    prompt: string,
    sessionId: string,
    promptInput: CliPromptInput,
    attachments?: readonly CliAttachment[],
  ): string[];
  buildCompactPlan(sessionId: string, instructions?: string): CliCompactPlan;
  parseEvents(line: string): CliEvent[];
}

export interface CliRunResult {
  answer: string;
  sessionId?: string;
  stats?: CliRunStats;
  toolCalls?: Array<{
    toolUseId: string;
    toolName: string;
    input: unknown;
  }>;
}
