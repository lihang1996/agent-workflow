export type CliId = "claude" | "codex";

export type CliEvent =
  | { type: "session"; sessionId: string }
  | { type: "assistant"; text: string; sessionId?: string }
  | { type: "tool"; name: string; inputSummary?: string; sessionId?: string }
  | { type: "result"; answer: string; sessionId?: string }
  | { type: "error"; message: string; sessionId?: string };

export interface CliAdapter {
  readonly id: CliId;
  readonly command: string;
  readonly displayName: string;
  buildArgs(prompt: string): string[];
  buildResumeArgs(prompt: string, sessionId: string): string[];
  /** 一行 stream-json 可能产出多个事件（如文本 + 工具调用）。 */
  parseEvents(line: string): CliEvent[];
}

export interface CliRunResult {
  answer: string;
  sessionId?: string;
}

export function isCliId(value: string): value is CliId {
  return value === "claude" || value === "codex";
}
