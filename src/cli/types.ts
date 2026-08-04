export type CliId = "claude" | "codex";
export type CliExecutionPolicy = 'standard' | 'read-only' | 'approved';

export interface CliBuildOptions {
  executionPolicy?: CliExecutionPolicy;
  approvedScope?: string;
}

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

export type CliEvent =
  | { type: "session"; sessionId: string }
  | { type: "assistant"; text: string; sessionId?: string }
  | {
      type: "tool_start";
      toolUseId: string;
      toolName: string;
      label: string;
      detail?: string;
      sessionId?: string;
    }
  | { type: "tool_end"; toolUseId: string; failed: boolean; sessionId?: string }
  | { type: "context"; usedTokens: number; sessionId?: string }
  /** @deprecated 兼容旧适配器；新代码请用 tool_start */
  | { type: "tool"; name: string; inputSummary?: string; sessionId?: string }
  | { type: "result"; answer: string; sessionId?: string; stats?: CliRunStats }
  | { type: "error"; message: string; sessionId?: string };

export interface CliAdapter {
  readonly id: CliId;
  readonly command: string;
  readonly displayName: string;
  buildArgs(prompt: string, options?: CliBuildOptions): string[];
  buildResumeArgs(prompt: string, sessionId: string, options?: CliBuildOptions): string[];
  /** 一行 stream-json 可能产出多个事件（如文本 + 工具调用）。 */
  parseEvents(line: string): CliEvent[];
}

export interface CliRunResult {
  answer: string;
  sessionId?: string;
  stats?: CliRunStats;
}

/** 是否为受支持的 CLI 引擎 id。 */
export function isCliId(value: string): value is CliId {
  return value === "claude" || value === "codex";
}
