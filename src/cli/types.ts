/**
 * CLI 适配器类型定义。
 *
 * 这个文件定义了所有 CLI 引擎（Claude/Codex/Cursor）的统一接口。
 * 三个引擎的调用方式和输出格式不同，但都抽象成 CliAdapter 接口，
 * 让 runner.ts 可以用同一套代码 spawn + 解析。
 *
 * 核心概念：
 * - CliId       → 引擎标识符（'claude' | 'codex' | 'cursor'）
 * - CliAdapter  → 引擎适配器（构建命令行参数 + 解析 stream-json 事件）
 * - CliEvent    → CLI 输出的流式事件（session/assistant/tool_start/tool_end/context/result/error）
 * - CliRunResult → CLI 执行完成后的最终结果
 */

// ─────────────────────────────────────────────────────────────
// 引擎 ID
// ─────────────────────────────────────────────────────────────

/** 受支持的 CLI 引擎 ID 列表 */
export const CLI_IDS = ['claude', 'codex', 'cursor'] as const;

/** 引擎 ID 类型 */
export type CliId = (typeof CLI_IDS)[number];

// ─────────────────────────────────────────────────────────────
// 执行策略
// ─────────────────────────────────────────────────────────────

/**
 * CLI 执行策略（决定写权限和沙箱配置）。
 *
 * - 'standard'      → 普通任务：可改产品代码（PM/开发用）
 * - 'read-only'     → 只读：独立 /review 用（Cursor 走 --mode ask）
 * - 'input-only'     → 仅输入分析：一次性会话，不恢复旧上下文，cwd 改到隔离目录
 * - 'approved'      → 已审批高风险任务：放行审批范围内的操作
 * - 'evidence-write' → 质检步骤：只允许写证据目录 .agent-os/evidence/**（Claude 用路径级 allow）
 */
export type CliExecutionPolicy = 'standard' | 'read-only' | 'input-only' | 'approved' | 'evidence-write';

// ─────────────────────────────────────────────────────────────
// 网络能力预期
// ─────────────────────────────────────────────────────────────

/**
 * 适配器在构建命令行时给出的能力预期。
 *
 * 这只是启动前的预期，不代表下游 CLI 已实际授予该能力。
 * 用于日志记录和子进程环境变量传递。
 *
 * 例如 Claude 的 --mcp-config 可能带来网络能力，
 * Codex 的 --sandbox workspace-write 会禁止本地绑定，
 * Cursor 的 --sandbox disabled 放行一切。
 */
export interface CliCapabilityExpectation {
  /** 能力名称，目前只有 'local-network' */
  capability: 'local-network';
  /** 是否请求了该能力 */
  requested: boolean;
  /** 配置是否已应用 */
  configApplied: boolean;
  /**
   * 预期能力级别：
   * - 'none'             → 没有能力
   * - 'loopback'         → 只有回环地址
   * - 'sandbox-provided' → 沙箱提供
   * - 'adapter-managed'  → 适配器自行管理（默认）
   */
  expected: 'none' | 'loopback' | 'sandbox-provided' | 'adapter-managed';
  /** 说明原因 */
  reason: string;
}

// ─────────────────────────────────────────────────────────────
// 命令行构建选项
// ─────────────────────────────────────────────────────────────

/**
 * 适配器构建命令行参数时的选项。
 * 传入 buildArgs() / buildResumeArgs()。
 */
export interface CliBuildOptions {
  /** 执行策略（决定写权限/沙箱/只读） */
  executionPolicy?: CliExecutionPolicy;
  /** 已审批任务的风险范围（executionPolicy='approved' 时使用） */
  approvedScope?: string;
  /**
   * 质检步骤只允许写入该证据目录。
   * Claude 用路径级 allow（Write/Edit(.agent-os/evidence/**)）；
   * Cursor 做不到路径级写权限。
   */
  evidenceRoot?: string;
  /**
   * 是否需要本机回环网络访问。
   * 只有持久化交付流水线（workflowId 存在）才传 true，
   * 用于项目服务、浏览器和测试库。
   * 普通聊天默认 false。
   */
  localNetworkAccess?: boolean;
  /**
   * 接收本次参数构建实际采用的能力预期。
   * runner.ts 用它记录日志并传递给子进程环境变量。
   */
  onCapabilityExpectation?: (expectation: CliCapabilityExpectation) => void;
  /**
   * 注入内置提问 MCP 的任务上下文。
   *
   * Codex 用 `-c mcp_servers.*.env` 覆盖 MCP 子进程环境，
   * 只靠 CLI 进程 env 传 AGENT_OS_WORKFLOW_ID 等字段到不了 ask-server。
   * 这里传入 { AGENT_OS_WORKFLOW_ID: '...', AGENT_OS_ROOT: '...' } 等。
   */
  mcpContextEnv?: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────
// 运行统计
// ─────────────────────────────────────────────────────────────

/**
 * CLI 运行结束后的统计信息。
 * 从 stream-json 的 result 事件中提取。
 */
export interface CliRunStats {
  /** 总耗时（毫秒） */
  durationMs?: number;
  /** 对话轮次数 */
  turns?: number;
  /** 总 token 数 */
  totalTokens?: number;
  /** 输入 token 数 */
  inputTokens?: number;
  /** 输出 token 数 */
  outputTokens?: number;
  /** 缓存读取 token 数 */
  cacheReadTokens?: number;
  /** 缓存创建 token 数 */
  cacheCreationTokens?: number;
  /** 实际使用的上下文 token 数 */
  contextUsedTokens?: number;
  /** 上下文窗口总 token 数（用于进度显示） */
  contextWindowTokens?: number;
}

// ─────────────────────────────────────────────────────────────
// 流式事件（CliEvent 联合类型）
// ─────────────────────────────────────────────────────────────

/**
 * CLI 输出的流式事件。
 *
 * 每个引擎的 stream-json 每行可能产出多个事件。
 * parseEvents(line) 返回 CliEvent[]，runner 逐个处理。
 *
 * 事件类型说明：
 * - 'session'    → CLI 创建了新会话，记录 sessionId 用于后续 resume
 * - 'assistant'  → AI 的文本输出（旁白），用于日志
 * - 'tool_start' → 工具调用开始（如 Read/Edit/Bash），更新进度卡片
 * - 'tool_end'   → 工具调用结束，标记成功/失败
 * - 'context'    → 上下文窗口 token 数变化
 * - 'tool'       → （已废弃）旧适配器兼容，合成 start/end 对
 * - 'result'     → CLI 最终结果（包含 answer + stats）
 * - 'error'      → 流错误
 */
export type CliEvent =
  // 新会话创建
  | { type: "session"; sessionId: string }
  // AI 文本输出
  | { type: "assistant"; text: string; sessionId?: string }
  // 工具调用开始
  | {
      type: "tool_start";
      toolUseId: string;    // 唯一标识，用于匹配 start/end 对
      toolName: string;     // 如 "Read" / "Edit" / "Bash"
      label: string;        // 显示名，如 "读取 src/index.ts"
      detail?: string;      // 工具输入摘要
      sessionId?: string;
    }
  // 工具调用结束
  | { type: "tool_end"; toolUseId: string; failed: boolean; sessionId?: string }
  // 上下文窗口 token 数
  | { type: "context"; usedTokens: number; sessionId?: string }
  /** @deprecated 兼容旧适配器；新代码请用 tool_start */
  | { type: "tool"; name: string; inputSummary?: string; sessionId?: string }
  // 最终结果
  | { type: "result"; answer: string; sessionId?: string; stats?: CliRunStats }
  // 错误
  | { type: "error"; message: string; sessionId?: string };

// ─────────────────────────────────────────────────────────────
// CLI 适配器接口
// ─────────────────────────────────────────────────────────────

/**
 * CLI 引擎适配器接口。
 *
 * 每个引擎（Claude/Codex/Cursor）实现此接口：
 * - id          → 引擎标识符
 * - command     → 可执行文件名（如 'claude' / 'codex' / 'agent'）
 * - displayName → 展示名（如 'Claude Code'）
 * - buildArgs   → 构建首次执行的命令行参数
 * - buildResumeArgs → 构建恢复会话的命令行参数（带 --resume 等）
 * - parseEvents → 解析 stream-json 的一行输出为 CliEvent[]
 * - resolveSpawnCwd → 可选：覆盖子进程 cwd（Cursor 仅输入分析改到隔离目录）
 */
export interface CliAdapter {
  readonly id: CliId;
  readonly command: string;
  readonly displayName: string;

  /**
   * 构建首次执行的命令行参数。
   * @param prompt  - 用户输入/流水线 prompt
   * @param options - 执行策略、证据目录、MCP 上下文等
   * @returns 参数数组，如 ['--print', '--output-format', 'stream-json', ...]
   */
  buildArgs(prompt: string, options?: CliBuildOptions): string[];

  /**
   * 构建恢复会话的命令行参数（带 --resume / --continue 等）。
   * @param prompt    - 续接 prompt
   * @param sessionId - 上次 CLI 返回的会话 ID
   * @param options   - 同上
   */
  buildResumeArgs(prompt: string, sessionId: string, options?: CliBuildOptions): string[];

  /**
   * 解析 stream-json 的一行输出为事件数组。
   *
   * 一行可能产出多个事件（如文本 + 工具调用）。
   * 解析失败会抛异常，runner 会中止 CLI。
   */
  parseEvents(line: string): CliEvent[];

  /**
   * 可选：覆盖 CLI 子进程 cwd。
   *
   * Cursor 仅输入分析（executionPolicy='input-only'）时，
   * 必须改 cwd 到仓库外空隔离目录，
   * 因为 --workspace 拦不住相对路径 Bash。
   */
  resolveSpawnCwd?(requestedCwd: string, policy: CliExecutionPolicy): string;
}

// ─────────────────────────────────────────────────────────────
// 运行结果
// ─────────────────────────────────────────────────────────────

/**
 * CLI 执行完成后的最终结果。
 * runner.ts 返回此对象给 cli-task.ts。
 */
export interface CliRunResult {
  /** AI 的最终回答文本 */
  answer: string;
  /** 会话 ID（用于后续 resume） */
  sessionId?: string;
  /** 运行统计 */
  stats?: CliRunStats;
}

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────

/**
 * 类型守卫：判断字符串是否为受支持的 CLI 引擎 ID。
 * 用于解析 /engine 命令和 DEFAULT_CLI 环境变量。
 *
 * @example
 * isCliId('claude') // true
 * isCliId('gemini') // false
 */
export function isCliId(value: string): value is CliId {
  return (CLI_IDS as readonly string[]).includes(value);
}

/**
 * 生成引擎选择提示文本。
 * @example formatEngineChoices() → '/engine claude 或 /engine codex 或 /engine cursor'
 */
export function formatEngineChoices(separator = ' 或 '): string {
  return CLI_IDS.map((id) => `/engine ${id}`).join(separator);
}

/**
 * 生成引擎 ID 列表文本。
 * @example formatEngineIds() → 'claude|codex|cursor'
 */
export function formatEngineIds(separator = '|'): string {
  return CLI_IDS.join(separator);
}
