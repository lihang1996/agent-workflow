import { promptInputForPlatform } from './types.js';
import { createInterface } from 'node:readline';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { CliAdapter, CliAttachment, CliEvent, CliRunResult } from './types.js';
import type { ModelSelection } from '../core/model-selection.js';
import { assertAppToolAllowed, validateAppToolCalls } from '../core/app-tool-policy.js';
import {
  applyAdapterEnv,
  assertGroupFullyExited,
  assertTaskDiffClean,
  launchIsolated,
  terminateIsolatedChild,
  type IsolationSupplier,
  type PreparedIsolation,
} from '../core/isolation.js';

const DEFAULT_TIMEOUT_MS = 50 * 60 * 1000;

export interface RunCliOptions {
  launchLifecycle?: {
    beforeLaunch: () => Promise<void>;
    onSpawn: (pid: number | undefined) => void;
    onNotSpawned: (error: unknown) => void;
  };
  adapter: CliAdapter;
  prompt: string;
  cwd: string;
  sessionId?: string;
  /** topic 级任务键：scratch 命名与 sessionScratches 绑定使用（缺省自动生成）。 */
  taskId?: string;
  /**
   * T-021 已核验编码授权（119 号 P1-3）：id + 精确相对允许路径，随
   * IsolationPrepareInput 传入隔离层并绑定能力身份；缺省 = 零代码写任务。
   */
  authorization?: { id: string; allowedRelatives: readonly string[] };
  /**
   * T-022 强制入口契约：不可省略的隔离 supplier（IsolationContext 经
   * prepareIsolation 组装：能力核验/scratch/基线/fixture 预检）。缺省即抛错，
   * 无 bypass；生产默认实现见 core/isolation.ts（G-W6b-CANARY 未执行 ⇒ blocked）。
   */
  isolation: IsolationSupplier;
  /** resolveModel 产生的执行模型选择；矩阵外组合在入口已被拒绝。 */
  modelSelection?: ModelSelection | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: (event: CliEvent) => void;
  /** 原始 stdout 行回调（探测留证用），不影响执行链路。 */
  onRawLine?: (line: string) => void;
  attachments?: readonly CliAttachment[];
}

export function runCli(options: RunCliOptions): Promise<CliRunResult> {
  // W6b：cursor/zcode 的 MCP 注册不再写用户全局配置（修订版 §2.5「生产链
  // 禁写用户全局配置」）；任务级注入方式未验证前，这两个引擎的真实启动由
  // 能力核验处失败关闭。
  if (!options.isolation) {
    return Promise.reject(new Error('runCli 必须提供 isolation supplier（IsolationContext 强制入口契约，无 bypass）。'));
  }
  return executeRun(options);
}

async function executeRun(options: RunCliOptions): Promise<CliRunResult> {
  const {
    adapter,
    prompt,
    cwd,
    sessionId,
    modelSelection,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onEvent,
    onRawLine,
    attachments,
  } = options;
  const prepared = await options.isolation({
    taskId: options.taskId ?? `task-${sessionId ?? 'adhoc'}-${Date.now().toString(36)}`,
    purpose: 'task',
    cliMode: sessionId ? 'resume' : 'fresh',
    modelSelection,
    command: adapter.command,
    cwd,
    ...(options.authorization ? {
      authorizationId: options.authorization.id,
      allowedRelatives: options.authorization.allowedRelatives,
    } : {}),
  });
  // 149 号 P1-5：prepare 后**所有出口**（取消/构参异常/启动失败/执行失败/
  // 成功）都走同一后态基线终检——finalize 异常与任务外违例并入错误，不吞、
  // 不把取消当放宽。buildArgs 也移入 try：构参抛错同样要终检。
  const runPostStateCheck = async (): Promise<Error | undefined> => {
    try {
      assertTaskDiffClean(await prepared.finalize());
      return undefined;
    } catch (violation) {
      return violation as Error;
    }
  };
  const postStateCheck = async (): Promise<void> => {
    const violation = await runPostStateCheck();
    if (violation) throw violation;
  };
  const postStateCheckForError = async (originalError: Error): Promise<Error> => {
    const violation = await runPostStateCheck();
    return violation
      ? new Error(`${originalError.message}\n${violation.message}`)
      : originalError;
  };
  // 138 号 P1-5：prepare 是异步阶段——若期间（或之前）信号已取消，绝不再
  // launch；仍完成后态基线核验再失败关闭（不留下无法解释的中间态）。
  if (signal?.aborted) {
    throw await postStateCheckForError(new Error(`${adapter.displayName} 执行已取消（隔离准备阶段），未启动引擎。`));
  }
  let result: CliRunResult;
  try {
    // Windows 下 prompt 走 stdin（规避 cmd 转义/乱码），其他平台直接作为命令行参数。
    const promptInput = promptInputForPlatform(process.platform);
    const useStdin = promptInput === 'stdin';
    const args = sessionId
      ? adapter.buildResumeArgs(prompt, sessionId, promptInput, attachments, modelSelection)
      : adapter.buildArgs(prompt, promptInput, attachments, modelSelection);
    await options.launchLifecycle?.beforeLaunch();
    result = await runIsolatedChild({ adapter, args, prepared, sessionId, useStdin, prompt, signal, timeoutMs, onEvent, onRawLine, launchLifecycle: options.launchLifecycle });
  } catch (error) {
    throw await postStateCheckForError(error as Error);
  }
  // 成功路径的终检只在此时执行一次（finalize 幂等守卫不会被 catch 重放）。
  await postStateCheck();
  return result;
}

function runIsolatedChild(options: {
  adapter: CliAdapter;
  args: string[];
  prepared: PreparedIsolation;
  sessionId?: string;
  useStdin: boolean;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs: number;
  onEvent?: (event: CliEvent) => void;
  onRawLine?: (line: string) => void;
  launchLifecycle?: RunCliOptions['launchLifecycle'];
}): Promise<CliRunResult> {
  const { adapter, args, prepared, sessionId, useStdin, prompt, signal, timeoutMs, onEvent, onRawLine } = options;
  return new Promise((resolve, reject) => {
    // 固定用 `['pipe','pipe','pipe']`，让 stdin 始终可写（spawnCli 返回类型按字面量收窄）。
    applyAdapterEnv(prepared.env, adapter.buildEnv?.());
    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try { child = launchIsolated(prepared, args, { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { options.launchLifecycle?.onNotSpawned(error); reject(error); return; }
    // 取消/超时走进程组终止（119 号 P1-2 / 138 号 P1-3 / 149 号 P1-4）：
    // wrapper 退出 ≠ CLI/后端退出；AbortSignal 不进 spawn。终止结果由 close
    // 处理统一 await 核验后才 settle——abort 处理器只负责触发，且任务已
    // settle 后立即失效并被移除（旧 PGID 复用不再误伤无关进程）。
    let taskClosed = false;
    const abortHandler = () => {
      if (taskClosed) return;
      void terminateIsolatedChild(child).catch((error: Error) => {
        console.error(`[隔离] 取消触发的进程组终止异常（将由 close 路径核验）: ${error.message}`);
      });
    };
    signal?.addEventListener('abort', abortHandler, { once: true });
    const lines = createInterface({ input: child.stdout });
    let observedSessionId = sessionId;
    let observedAnswer: string | undefined;
    let observedStats: CliRunResult['stats'];
    const observedToolCalls = new Map<
      string,
      NonNullable<CliRunResult['toolCalls']>[number]
    >();
    let finalResult: CliRunResult | undefined;
    let resultError: Error | undefined;
    let appToolError: Error | undefined;
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // 超时只标记并触发终止；close 路径 await 核验后才失败关闭。
      terminateIsolatedChild(child).catch((error: Error) => {
        console.error(`[隔离] 超时触发的进程组终止异常（将由 close 路径核验）: ${error.message}`);
      });
    }, timeoutMs);

    // 149 号 P1-4：settle 即关闭——清 timer、移除 abort 监听并阻断后续终止
    // 调用（旧 PGID 可能已被系统复用，绝不能在任务结束后再发信号）。
    const finish = () => {
      taskClosed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
    };
    // 138 号 P1-3：唯一 settle 门——错误路径同样先 await 整组终止+核验再
    // reject（错误信息保留核验原因），不再 fire-and-forget 后台清理。
    const fail = (error: Error): Promise<void> => {
      if (settled) return Promise.resolve();
      settled = true;
      finish();
      return terminateIsolatedChild(child)
        .catch((terminateError: Error): { outcome: 'unverifiable'; reason: string } => ({
          outcome: 'unverifiable',
          reason: terminateError.message,
        }))
        .then((outcome) => {
          if (outcome.outcome === 'unverifiable') {
            reject(new Error(`${error.message}；且无法核验后代终止（${outcome.reason}），失败关闭`));
            return;
          }
          if (outcome.groupAliveAfter) {
            reject(new Error(`${error.message}；进程组仍有存活后代，失败关闭`));
            return;
          }
          reject(error);
        });
    };

    lines.on('line', (line) => {
      if (settled) return;
      try {
      onRawLine?.(line);
      for (const event of adapter.parseEvents(line)) {
        onEvent?.(event);
        if ('sessionId' in event && event.sessionId) {
          observedSessionId = event.sessionId;
        }
        if (event.type === 'error') {
          resultError = new Error(event.message);
          continue;
        }
        if (event.type === 'tool_call') {
          try {
            assertAppToolAllowed(adapter.appTools, event.toolName);
          } catch (error) {
            // Keep role violations even if the CLI later emits a failed tool result.
            appToolError = error as Error;
          }
          observedToolCalls.set(event.toolUseId, event);
          continue;
        }
        if (event.type === 'tool_end' && event.failed) {
          observedToolCalls.delete(event.toolUseId);
          continue;
        }
        if (event.type === 'result') {
          if (event.answer) observedAnswer = event.answer;
          if (event.stats) observedStats = event.stats;
          if (!observedAnswer) continue;
          finalResult = {
            answer: observedAnswer,
            sessionId: event.sessionId ?? observedSessionId,
            ...(observedStats ? { stats: observedStats } : {}),
          };
        }
      }
      } catch (error) { void fail(error as Error); }
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-262144);
    });
    child.once('error', (error) => {
      if (!child.pid) {
        try { options.launchLifecycle?.onNotSpawned(error); }
        catch (persistenceError) { void fail(persistenceError as Error); return; }
      }
      if (timedOut) {
        void fail(new Error(`${adapter.displayName} 执行超时`));
        return;
      }
      if (signal?.aborted) {
        void fail(new Error(`${adapter.displayName} 执行已取消`));
        return;
      }
      void fail(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      // 119 号 P1-2 / 129/138 号：wrapper 退出 ≠ CLI/后端退出。所有路径先
      // **await 整组终止/核验**，再唯一 settle；幸存者/无法核验 ⇒ 失败关闭。
      void (async () => {
        if (timedOut || signal?.aborted) {
          const outcome = await terminateIsolatedChild(child).catch(
            (error: Error): { outcome: 'unverifiable'; reason: string } => ({ outcome: 'unverifiable', reason: error.message }),
          );
          if (outcome.outcome === 'unverifiable') {
            return fail(new Error(`${adapter.displayName} ${timedOut ? '执行超时' : '执行已取消'}，且无法核验后代终止（${outcome.reason}），失败关闭`));
          }
          if (outcome.groupAliveAfter) {
            return fail(new Error(`${adapter.displayName} ${timedOut ? '执行超时' : '执行已取消'}，进程组仍有存活后代，失败关闭`));
          }
          if (timedOut) return fail(new Error(`${adapter.displayName} 执行超时`));
          return fail(new Error(`${adapter.displayName} 执行已取消`));
        }
        try {
          assertGroupFullyExited(child.pid);
        } catch (groupError) {
          return fail(new Error(`${(groupError as Error).message}`));
        }
        if (resultError) return fail(resultError);
        if (appToolError) return fail(appToolError);
        if (code !== 0) {
          return fail(new Error(
            stderr.trim() || `${adapter.displayName} 退出，状态码 ${code}`,
          ));
        }
        if (!finalResult) {
          return fail(new Error(`${adapter.displayName} 没有返回最终结果`));
        }
        if (observedToolCalls.size > 0) {
          finalResult.toolCalls = [...observedToolCalls.values()].map((call) => ({
            toolUseId: call.toolUseId,
            toolName: call.toolName,
            input: call.input,
          }));
        }
        try {
          validateAppToolCalls(adapter.appTools, finalResult.toolCalls);
        } catch (error) {
          return fail(error as Error);
        }
        settled = true;
        finish();
        resolve(finalResult);
      })();
    });
    // Install all error/close listeners before fallible bookkeeping or stdin writes.
    try {
      if (child.pid) options.launchLifecycle?.onSpawn(child.pid);
      if (signal?.aborted) abortHandler();
      if (child.stdin) {
        child.stdin.on('error', (error) => { if (!settled) void fail(error); });
        if (useStdin) child.stdin.end(prompt, 'utf8'); else child.stdin.end();
      }
    } catch (error) { void fail(error as Error); }
  });
}
