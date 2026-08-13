import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { highRiskClasses } from '../core/risk.js';
import { pickAskMcpContextEnv } from '../mcp/config.js';
import type {
  CliAdapter,
  CliCapabilityExpectation,
  CliEvent,
  CliExecutionPolicy,
  CliRunResult,
} from './types.js';

/**
 * 长工作流策略：
 * - CLI_TIMEOUT_MS：从启动起的绝对上限（默认 6 小时），防止失控进程永挂
 * - CLI_IDLE_TIMEOUT_MS：无 stream 事件多久视为卡住（默认 20 分钟）；有输出就续命
 * 几小时的持续编码靠「有活动续命」，不要只把墙钟超时硬拉长。
 */
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
const MIN_ENV_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const MAX_STDERR_CHARS = 64 * 1024;
const MAX_EVENT_LINE_CHARS = 4 * 1024 * 1024;
const useProcessGroup = process.platform !== 'win32';

export interface RunCliOptions {
  adapter: CliAdapter;
  prompt: string;
  cwd: string;
  sessionId?: string;
  signal?: AbortSignal;
  /** 绝对上限（墙钟）；优先于 CLI_TIMEOUT_MS */
  timeoutMs?: number;
  /** 无事件空闲超时；优先于 CLI_IDLE_TIMEOUT_MS；设 0 关闭空闲检测 */
  idleTimeoutMs?: number;
  /** P1 修复：工具调用硬上限；超过后终止 CLI 并报错。默认 100。 */
  maxToolCount?: number;
  onEvent?: (event: CliEvent) => void;
  env?: NodeJS.ProcessEnv;
  executionPolicy?: CliExecutionPolicy;
  approvedScope?: string;
  localNetworkAccess?: boolean;
}

/**
 * 显式覆盖宿主可能残留的同名变量，让子进程能区分“调用方请求”“已追加参数”和“预计能力”。
 * 这些字段是启动前观测值，不宣称下游 CLI 已实际授予网络能力。
 */
export function buildLocalNetworkCapabilityEnv(
  requested: boolean,
  expectation?: CliCapabilityExpectation,
): Record<string, string> {
  return {
    AGENT_OS_LOCAL_NETWORK_REQUESTED: requested ? 'true' : 'false',
    AGENT_OS_LOCAL_NETWORK_CONFIG_APPLIED: expectation?.configApplied ? 'true' : 'false',
    AGENT_OS_LOCAL_NETWORK_EXPECTED: expectation?.expected ?? 'adapter-managed',
    AGENT_OS_LOCAL_NETWORK_REASON: expectation?.reason ?? 'adapter-does-not-report',
  };
}

/** 解析绝对超时：优先显式参数，其次 CLI_TIMEOUT_MS，否则默认 6 小时。 */
export function resolveCliTimeoutMs(
  explicit?: number,
  envValue = process.env.CLI_TIMEOUT_MS,
): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.min(Math.floor(explicit), MAX_TIMEOUT_MS);
  }
  const raw = envValue?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return clampEnvTimeoutMs(parsed);
    console.warn(`[配置] CLI_TIMEOUT_MS=${raw} 非法，回退到 ${DEFAULT_TIMEOUT_MS}ms`);
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * 解析空闲超时：优先显式参数（含 0=关闭），其次 CLI_IDLE_TIMEOUT_MS，否则默认 20 分钟。
 * 显式传入 0 表示关闭空闲检测（测试/特殊场景）。
 */
export function resolveCliIdleTimeoutMs(
  explicit?: number,
  envValue = process.env.CLI_IDLE_TIMEOUT_MS,
): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) {
    if (explicit === 0) return 0;
    return Math.min(Math.floor(explicit), MAX_TIMEOUT_MS);
  }
  const raw = envValue?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (parsed === 0) return 0;
    if (Number.isFinite(parsed) && parsed > 0) return clampEnvTimeoutMs(parsed);
    console.warn(`[配置] CLI_IDLE_TIMEOUT_MS=${raw} 非法，回退到 ${DEFAULT_IDLE_TIMEOUT_MS}ms`);
  }
  return DEFAULT_IDLE_TIMEOUT_MS;
}

function clampEnvTimeoutMs(value: number): number {
  if (value < MIN_ENV_TIMEOUT_MS) return MIN_ENV_TIMEOUT_MS;
  if (value > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return Math.floor(value);
}

/** 杀掉 CLI 进程组（含孙子进程）。 */
function killProcessTree(child: ChildProcess, sig: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (useProcessGroup) {
      process.kill(-pid, sig);
      return;
    }
  } catch {
    // 进程组不存在时回退杀自身
  }
  try {
    child.kill(sig);
  } catch {
    // 已退出
  }
}

/** 启动 CLI 子进程，解析 stream-json，支持取消/绝对超时/空闲超时。 */
export function runCli(options: RunCliOptions): Promise<CliRunResult> {
  const {
    adapter,
    prompt,
    cwd,
    sessionId,
    signal,
    onEvent,
    env,
    executionPolicy = 'standard',
    approvedScope,
    localNetworkAccess = false,
  } = options;
  const timeoutMs = resolveCliTimeoutMs(options.timeoutMs);
  const idleTimeoutMs = resolveCliIdleTimeoutMs(options.idleTimeoutMs);
  // “仅输入分析”必须是一次性上下文，不能从旧会话带入未提供的文件或消息。
  const effectiveSessionId = executionPolicy === 'input-only' ? undefined : sessionId;
  const capabilityExpectations: CliCapabilityExpectation[] = [];
  const buildOptions = {
    executionPolicy,
    approvedScope,
    localNetworkAccess,
    mcpContextEnv: pickAskMcpContextEnv(env),
    onCapabilityExpectation(expectation: CliCapabilityExpectation) {
      const previous = capabilityExpectations.findIndex(
        (candidate) => candidate.capability === expectation.capability,
      );
      if (previous >= 0) capabilityExpectations[previous] = expectation;
      else capabilityExpectations.push(expectation);
    },
  };
  const args = effectiveSessionId
    ? adapter.buildResumeArgs(prompt, effectiveSessionId, buildOptions)
    : adapter.buildArgs(prompt, buildOptions);
  const localNetworkExpectation = capabilityExpectations.find(
    (expectation) => expectation.capability === 'local-network',
  );
  const capabilityEnv = buildLocalNetworkCapabilityEnv(localNetworkAccess, localNetworkExpectation);
  console.info(
    `[CLI:${adapter.id}] local-network requested=${capabilityEnv.AGENT_OS_LOCAL_NETWORK_REQUESTED}`
    + ` configApplied=${capabilityEnv.AGENT_OS_LOCAL_NETWORK_CONFIG_APPLIED}`
    + ` expected=${capabilityEnv.AGENT_OS_LOCAL_NETWORK_EXPECTED}`
    + ` reason=${capabilityEnv.AGENT_OS_LOCAL_NETWORK_REASON}`,
  );

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error(`${adapter.displayName} 超时时间必须大于 0`));
  }
  if (signal?.aborted) {
    return Promise.reject(new Error(`${adapter.displayName} 执行已取消`));
  }

  return new Promise((resolve, reject) => {
    // detached 让子进程成为新进程组组长，便于连带杀掉孙子进程。
    const child = spawn(adapter.command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: useProcessGroup,
      env: {
        ...process.env,
        ...env,
        AGENT_OS_EXECUTION_POLICY: executionPolicy,
        // 只传不可伪造的类别集合，不把可能含敏感信息的完整审批文本复制到环境变量。
        // 显式覆盖宿主同名变量，避免陈旧环境配置扩大本轮授权。
        AGENT_OS_APPROVED_RISK_CLASSES: executionPolicy === 'approved'
          ? highRiskClasses(approvedScope ?? '').join(',')
          : '',
        ...capabilityEnv,
      },
    });
    const lines = createInterface({ input: child.stdout });
    let observedSessionId = effectiveSessionId;
    let finalResult: CliRunResult | undefined;
    let resultError: Error | undefined;
    let internalError: Error | undefined;
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timeoutReason: 'absolute' | 'idle' | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    // P1 修复：工具调用计数与预算
    const maxToolCount = options.maxToolCount ?? Number(process.env.CLI_MAX_TOOL_COUNT ?? 100);
    let toolCount = 0;

    const forceKillLater = () => {
      if (forceKillTimer) return;
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          killProcessTree(child, 'SIGKILL');
        }
      }, 2_000);
      forceKillTimer.unref();
    };

    const onAbort = () => {
      killProcessTree(child, 'SIGTERM');
      forceKillLater();
    };

    const tripTimeout = (reason: 'absolute' | 'idle') => {
      if (settled || timedOut) return;
      timedOut = true;
      timeoutReason = reason;
      const label = reason === 'idle'
        ? `空闲超过 ${Math.round(idleTimeoutMs / 1000)}s 无输出`
        : `达到绝对上限 ${Math.round(timeoutMs / 1000)}s`;
      console.warn(`[CLI:${adapter.id}] ${label}，正在终止进程`);
      killProcessTree(child, 'SIGTERM');
      forceKillLater();
    };

    const armIdleTimer = () => {
      if (idleTimeoutMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => tripTimeout('idle'), idleTimeoutMs);
      idleTimer.unref();
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    const absoluteTimer = setTimeout(() => tripTimeout('absolute'), timeoutMs);
    armIdleTimer();

    const finish = () => {
      clearTimeout(absoluteTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      finish();
      reject(error);
    };
    const timeoutError = () => new Error(
      timeoutReason === 'idle'
        ? `${adapter.displayName} 执行超时（超过 ${Math.round(idleTimeoutMs / 1000)}s 无输出，疑似卡住）`
        : `${adapter.displayName} 执行超时`,
    );

    lines.on('line', (line) => {
      if (internalError) return;
      // 任意 stdout 行都算活动：工具进度/旁白/结果都会续命，支撑数小时长任务。
      armIdleTimer();
      if (line.length > MAX_EVENT_LINE_CHARS) {
        internalError = new Error(`${adapter.displayName} 返回的单条事件过大`);
        onAbort();
        return;
      }
      let events: CliEvent[];
      try {
        events = adapter.parseEvents(line);
      } catch (error) {
        internalError = new Error(`${adapter.displayName} 事件解析失败: ${(error as Error).message}`);
        onAbort();
        return;
      }
      for (const event of events) {
        if (executionPolicy !== 'input-only' && 'sessionId' in event && event.sessionId) {
          observedSessionId = event.sessionId;
        }
        try {
          onEvent?.(event);
        } catch (error) {
          internalError = new Error(`${adapter.displayName} 事件处理失败: ${(error as Error).message}`);
          onAbort();
          return;
        }
        if (event.type === 'error') {
          resultError = new Error(event.message);
          continue;
        }
        // P1 修复：工具预算执行
        if (event.type === 'tool_start' || event.type === 'tool') {
          toolCount++;
          if (toolCount > maxToolCount) {
            internalError = new Error(
              `${adapter.displayName} 工具调用次数（${toolCount}）超过上限（${maxToolCount}），已终止。` +
              `请拆分任务或通过 CLI_MAX_TOOL_COUNT 环境变量调整上限。`,
            );
            onAbort();
            return;
          }
        }
        if (event.type === 'result') {
          const resultSessionId = executionPolicy === 'input-only'
            ? undefined
            : (event.sessionId ?? observedSessionId);
          finalResult = {
            answer: event.answer,
            ...(resultSessionId ? { sessionId: resultSessionId } : {}),
            ...(event.stats ? { stats: event.stats } : {}),
          };
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      // P1 修复：stderr 输出也算活动（编译警告/进度信息常走 stderr），应续命 idle timer。
      armIdleTimer();
      stderr = `${stderr}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
    });
    child.once('error', (error) => {
      if (timedOut) {
        fail(timeoutError());
        return;
      }
      if (signal?.aborted) {
        fail(new Error(`${adapter.displayName} 执行已取消`));
        return;
      }
      fail(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      if (internalError) return fail(internalError);
      if (timedOut) {
        return fail(timeoutError());
      }
      if (signal?.aborted) {
        return fail(new Error(`${adapter.displayName} 执行已取消`));
      }
      if (code !== 0) {
        return fail(new Error(
          resultError?.message
          || stderr.trim()
          || `${adapter.displayName} 退出，状态码 ${code}`,
        ));
      }
      if (resultError) return fail(resultError);
      if (finalResult) {
        settled = true;
        finish();
        resolve(finalResult);
        return;
      }
      return fail(new Error(`${adapter.displayName} 没有返回最终结果`));
    });
  });
}
