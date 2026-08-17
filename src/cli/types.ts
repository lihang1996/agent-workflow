export const CLI_IDS = ['claude', 'codex', 'cursor'] as const;
export type CliId = (typeof CLI_IDS)[number];
export type CliExecutionPolicy = 'standard' | 'read-only' | 'input-only' | 'approved' | 'evidence-write';

/**
 * 适配器在构建命令行时给出的能力预期。
 * `expected` 只是启动前预期，不代表下游 CLI 已实际授予该能力。
 */
export interface CliCapabilityExpectation {
  capability: 'local-network';
  requested: boolean;
  configApplied: boolean;
  expected: 'none' | 'loopback' | 'sandbox-provided' | 'adapter-managed';
  reason: string;
}

export interface CliBuildOptions {
  executionPolicy?: CliExecutionPolicy;
  approvedScope?: string;
  /** 质检步骤只允许写入该证据目录；Claude 用路径级 allow，Cursor 做不到。 */
  evidenceRoot?: string;
  /** 仅持久化交付流水线请求本机回环网络，用于项目服务、浏览器和测试库。 */
  localNetworkAccess?: boolean;
  /** 接收本次参数构建实际采用的能力预期，供 runner 记录日志并传递给子进程。 */
  onCapabilityExpectation?: (expectation: CliCapabilityExpectation) => void;
  /**
   * 注入内置提问 MCP 的任务上下文。Codex 会用 `-c mcp_servers.*.env` 覆盖 MCP 子进程环境，
   * 只靠 CLI 进程 env 传 AGENT_OS_WORKFLOW_ID 等字段到不了 ask-server。
   */
  mcpContextEnv?: Record<string, string>;
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
  /**
   * 覆盖 CLI 子进程 cwd。Cursor 仅输入分析必须进空 jail，
   * 不能停在用户仓库——`--workspace` 拦不住相对路径 Bash。
   */
  resolveSpawnCwd?(requestedCwd: string, policy: CliExecutionPolicy): string;
}

export interface CliRunResult {
  answer: string;
  sessionId?: string;
  stats?: CliRunStats;
}

/** 是否为受支持的 CLI 引擎 id。 */
export function isCliId(value: string): value is CliId {
  return (CLI_IDS as readonly string[]).includes(value);
}

/** `/engine claude 或 /engine codex 或 /engine cursor` */
export function formatEngineChoices(separator = ' 或 '): string {
  return CLI_IDS.map((id) => `/engine ${id}`).join(separator);
}

/** `claude|codex|cursor` */
export function formatEngineIds(separator = '|'): string {
  return CLI_IDS.join(separator);
}
