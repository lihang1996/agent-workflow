import type { CliEvent } from './types.js';

/** 单次 CLI 工具调用硬上限。长交付会读改很多文件，不是死循环。 */
export const DEFAULT_CLI_MAX_TOOL_COUNT = 500;
const MAX_CLI_MAX_TOOL_COUNT = 5_000;

/**
 * 连续同目标熔断阈值。对齐 super-agent 生产口径（演示是 8/10，生产常 20/30），
 * 编码任务更常见连续重试，默认 15。
 */
export const DEFAULT_TOOL_LOOP_STREAK = 15;

/** 滑动窗口内同参重复 / 乒乓：对齐 super-agent 生产建议 10 警告、20 熔断。 */
export const DEFAULT_REPEAT_WARN = 10;
export const DEFAULT_REPEAT_CRITICAL = 20;
export const DEFAULT_LOOP_HISTORY = 30;

export type ToolLoopDetector = 'consecutive' | 'generic_repeat' | 'ping_pong';

export interface ToolLoopLimits {
  consecutiveWarn: number;
  consecutiveCritical: number;
  repeatWarn: number;
  repeatCritical: number;
  pingPongWarn: number;
  pingPongCritical: number;
  historySize: number;
}

/** 解析工具调用上限：优先显式参数，其次 CLI_MAX_TOOL_COUNT，否则 500。 */
export function resolveCliMaxToolCount(
  explicit?: number,
  envValue = process.env.CLI_MAX_TOOL_COUNT,
): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.min(Math.floor(explicit), MAX_CLI_MAX_TOOL_COUNT);
  }
  const raw = envValue?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(Math.floor(parsed), MAX_CLI_MAX_TOOL_COUNT);
    }
    console.warn(`[配置] CLI_MAX_TOOL_COUNT=${raw} 非法，回退到 ${DEFAULT_CLI_MAX_TOOL_COUNT}`);
  }
  return DEFAULT_CLI_MAX_TOOL_COUNT;
}

/** 解析连续同目标熔断阈值：优先显式参数（含 0=关闭），其次 CLI_TOOL_LOOP_STREAK。 */
export function resolveCliToolLoopStreak(
  explicit?: number,
  envValue = process.env.CLI_TOOL_LOOP_STREAK,
): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) {
    return Math.floor(explicit);
  }
  const raw = envValue?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (parsed === 0) return 0;
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
    console.warn(`[配置] CLI_TOOL_LOOP_STREAK=${raw} 非法，回退到 ${DEFAULT_TOOL_LOOP_STREAK}`);
  }
  return DEFAULT_TOOL_LOOP_STREAK;
}

export function limitsFromStreak(streak: number): ToolLoopLimits | undefined {
  if (streak <= 0) return undefined;
  return {
    consecutiveWarn: Math.max(2, Math.min(8, Math.ceil(streak / 2))),
    consecutiveCritical: streak,
    repeatWarn: DEFAULT_REPEAT_WARN,
    repeatCritical: DEFAULT_REPEAT_CRITICAL,
    pingPongWarn: DEFAULT_REPEAT_WARN,
    pingPongCritical: DEFAULT_REPEAT_CRITICAL,
    historySize: DEFAULT_LOOP_HISTORY,
  };
}

/** 有明确目标才参与死循环判断；缺 detail 的连续 Read 不算。 */
export function toolCallSignature(event: CliEvent): string | undefined {
  if (event.type === 'tool_start') {
    const target = event.detail?.trim();
    if (!target) return undefined;
    return `${event.toolName}:${target}`;
  }
  if (event.type === 'tool') {
    const target = event.inputSummary?.trim();
    if (!target) return undefined;
    return `${event.name}:${target}`;
  }
  return undefined;
}

function toolNameOf(signature: string): string {
  const index = signature.indexOf(':');
  return index === -1 ? signature : signature.slice(0, index);
}

export interface ToolLoopObservation {
  looped: boolean;
  warn: boolean;
  streak: number;
  count: number;
  signature?: string;
  detector?: ToolLoopDetector;
  message?: string;
}

/**
 * 按次 CLI 实例（避免 super-agent 模块级 history 并发串线）。
 * 检测顺序对齐 super-agent：无进展（连续同目标）→ 乒乓 → 窗口同参重复。
 * 乒乓只认同一工具的两个目标来回；Read↔Edit 是正常编码，不算。
 */
export class ToolLoopWatch {
  private readonly history: string[] = [];
  private last = '';
  private streak = 0;
  private readonly warned = new Set<string>();
  private readonly limits: ToolLoopLimits | undefined;

  constructor(streakOrLimits: number | ToolLoopLimits) {
    this.limits = typeof streakOrLimits === 'number'
      ? limitsFromStreak(streakOrLimits)
      : streakOrLimits;
  }

  observe(event: CliEvent): ToolLoopObservation {
    if (event.type !== 'tool_start' && event.type !== 'tool') {
      return { looped: false, warn: false, streak: this.streak, count: 0 };
    }
    const signature = toolCallSignature(event);
    if (!signature || !this.limits) {
      this.last = '';
      this.streak = 0;
      return { looped: false, warn: false, streak: 0, count: 0 };
    }

    if (signature === this.last) this.streak += 1;
    else {
      this.last = signature;
      this.streak = 1;
    }

    const detected = this.detect(signature);
    this.history.push(signature);
    if (this.history.length > this.limits.historySize) this.history.shift();

    if (!detected) return { looped: false, warn: false, streak: this.streak, count: 1, signature };
    const key = `${detected.detector}:${signature}`;
    const warn = detected.level === 'warning' && !this.warned.has(key);
    if (warn) this.warned.add(key);
    return {
      looped: detected.level === 'critical',
      warn,
      streak: this.streak,
      count: detected.count,
      signature,
      detector: detected.detector,
      message: detected.message,
    };
  }

  private detect(signature: string): {
    level: 'warning' | 'critical';
    detector: ToolLoopDetector;
    count: number;
    message: string;
  } | undefined {
    const limits = this.limits;
    if (!limits) return undefined;

    if (this.streak >= limits.consecutiveCritical) {
      return {
        level: 'critical',
        detector: 'consecutive',
        count: this.streak,
        message: `连续 ${this.streak} 次调用同一目标（${signature}）`,
      };
    }
    if (this.streak >= limits.consecutiveWarn) {
      return {
        level: 'warning',
        detector: 'consecutive',
        count: this.streak,
        message: `连续 ${this.streak} 次调用同一目标（${signature}）`,
      };
    }

    const pingPong = pingPongCount(this.history, signature);
    if (pingPong >= limits.pingPongCritical) {
      return {
        level: 'critical',
        detector: 'ping_pong',
        count: pingPong,
        message: `同一工具在两个目标间乒乓 ${pingPong} 次（${signature}）`,
      };
    }
    if (pingPong >= limits.pingPongWarn) {
      return {
        level: 'warning',
        detector: 'ping_pong',
        count: pingPong,
        message: `同一工具在两个目标间乒乓 ${pingPong} 次（${signature}）`,
      };
    }

    const repeats = this.history.filter((item) => item === signature).length + 1;
    if (repeats >= limits.repeatCritical) {
      return {
        level: 'critical',
        detector: 'generic_repeat',
        count: repeats,
        message: `最近 ${limits.historySize} 次里相同目标已出现 ${repeats} 次（${signature}）`,
      };
    }
    if (repeats >= limits.repeatWarn) {
      return {
        level: 'warning',
        detector: 'generic_repeat',
        count: repeats,
        message: `最近 ${limits.historySize} 次里相同目标已出现 ${repeats} 次（${signature}）`,
      };
    }
    return undefined;
  }
}

function pingPongCount(history: string[], current: string): number {
  if (history.length < 2) return 0;
  const last = history[history.length - 1];
  if (!last || current === last) return 0;
  if (toolNameOf(last) !== toolNameOf(current)) return 0;

  let other: string | undefined;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i] !== last) {
      other = history[i];
      break;
    }
  }
  if (!other || other === last) return 0;
  if (toolNameOf(other) !== toolNameOf(current)) return 0;
  if (current !== other) return 0;

  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const expected = count % 2 === 0 ? last : other;
    if (history[i] !== expected) break;
    count++;
  }
  return count >= 2 ? count + 1 : 0;
}
