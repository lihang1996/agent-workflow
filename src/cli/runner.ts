import { Buffer } from 'node:buffer';
import { promptInputForPlatform } from './types.js';
import { createInterface } from 'node:readline';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { CliAdapter, CliAttachment, CliEvent, CliRunResult } from './types.js';
import type { ModelSelection } from '../core/model-selection.js';
import { assertAppToolAllowed, validateAppToolCalls } from '../core/app-tool-policy.js';
import {
  applyAdapterEnv,
  assertTaskDiffClean,
  launchIsolated,
  settleGroupAfterExit,
  terminateIsolatedChild,
  type IsolationSupplier,
  type PreparedIsolation,
} from '../core/isolation.js';

const DEFAULT_TIMEOUT_MS = 50 * 60 * 1000;

/** 212：started 候选——只有匹配的明确成功 tool_end 才能转正为业务调用。 */
interface ToolCallCandidate {
  toolUseId: string;
  toolName: string;
  input: unknown;
  inputKey: string;
}

/**
 * 216：重复 started 的一致性检测用无歧义稳定序列化——primitive（含字符串）
 * 一律 JSON.stringify 编码（undefined 用裸 token，区别于 JSON string）、object
 * 键排序、数组保序；禁止 tag+String 裸拼接（会碰撞）。超限抛固定错误（不携带
 * 原始输入/秘密），由调用处失败关闭。
 */
export const TOOL_INPUT_KEY_MAX_DEPTH = 32;
export const TOOL_INPUT_KEY_MAX_NODES = 10000;
export const TOOL_INPUT_KEY_MAX_BYTES = 262144;

function toolInputKey(value: unknown): string {
  let nodes = 0;
  let bytes = 0;
  const parts: string[] = [];
  // 增量预算：每个输出片段按 UTF-8 字节计入，超限即失败关闭（不回显输入）。
  const push = (part: string): void => {
    bytes += Buffer.byteLength(part, 'utf8');
    if (bytes > TOOL_INPUT_KEY_MAX_BYTES) {
      throw new Error('业务工具参数比较键超限（字节），失败关闭');
    }
    parts.push(part);
  };
  // 大字符串/大 key 先按字节预检再 JSON.stringify，避免无界构造。
  const encodeString = (text: string): string => {
    if (bytes + Buffer.byteLength(text, 'utf8') + 2 > TOOL_INPUT_KEY_MAX_BYTES) {
      throw new Error('业务工具参数比较键超限（字节），失败关闭');
    }
    return JSON.stringify(text);
  };
  const walk = (node: unknown, depth: number): void => {
    // 每次 visit 顶端计数并检查深度/节点数——object/array 同样算节点，
    // 空 object/array 深度嵌套或超量都会在此失败关闭。
    if (++nodes > TOOL_INPUT_KEY_MAX_NODES) {
      throw new Error('业务工具参数比较键超限（节点数），失败关闭');
    }
    if (depth > TOOL_INPUT_KEY_MAX_DEPTH) {
      throw new Error('业务工具参数比较键超限（深度），失败关闭');
    }
    // undefined 用裸 token（不是 JSON string），字符串一律带引号编码，互不碰撞。
    if (node === undefined) { push('undefined'); return; }
    if (node === null) { push(JSON.stringify(node)); return; }
    if (typeof node === 'string') { push(encodeString(node)); return; }
    if (typeof node === 'boolean') { push(JSON.stringify(node)); return; }
    if (typeof node === 'number') {
      // JSON 不支持非有限数值，直接固定错误，不做伪 string 转换。
      if (!Number.isFinite(node)) {
        throw new Error('业务工具参数包含不支持的比较类型（number），失败关闭');
      }
      push(JSON.stringify(node));
      return;
    }
    // bigint/symbol/function 等 JSON 输入不支持的类型同样固定错误。
    if (typeof node !== 'object') {
      throw new Error('业务工具参数包含不支持的比较类型（' + typeof node + '），失败关闭');
    }
    if (Array.isArray(node)) {
      push('[');
      for (let index = 0; index < node.length; index += 1) {
        if (index > 0) push(',');
        walk(node[index], depth + 1);
      }
      push(']');
      return;
    }
    const record = node as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    push('{');
    for (let index = 0; index < keys.length; index += 1) {
      if (index > 0) push(',');
      push(encodeString(keys[index]));
      push(':');
      walk(record[keys[index]], depth + 1);
    }
    push('}');
  };
  walk(value, 0);
  return parts.join('');
}

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
    // 212：tool_call 只存候选；必须收到对应明确 tool_end.failed===false 才收下。
    const pendingToolCalls = new Map<string, ToolCallCandidate>();
    const confirmedToolCalls = new Map<string, ToolCallCandidate>();
    // 216：失败终止墓碑——本 run 内该 toolUseId 永久不能转正为业务调用。
    const failedToolCallIds = new Set<string>();
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
          if (failedToolCallIds.has(event.toolUseId)) {
            // 已失败终止的 id 不得重启转正；上方权限检查已完成并保留。
            throw new Error('Agent OS 协议错误：toolUseId 已失败终止，不得重新 started（' + event.toolUseId + '）。');
          }
          const seen = pendingToolCalls.get(event.toolUseId)
            ?? confirmedToolCalls.get(event.toolUseId);
          if (seen) {
            // 重复 started 至多一份；同 id 不同工具名/参数属协议违例，失败关闭。
            if (seen.toolName !== event.toolName || seen.inputKey !== toolInputKey(event.input)) {
              throw new Error('Agent OS 协议错误：同一 toolUseId 重复 started 且工具名或参数不一致（' + event.toolUseId + '）。');
            }
          } else {
            pendingToolCalls.set(event.toolUseId, {
              toolUseId: event.toolUseId,
              toolName: event.toolName,
              input: event.input,
              inputKey: toolInputKey(event.input),
            });
          }
          continue;
        }
        if (event.type === 'tool_end') {
          // 无候选的结束（native 工具或未匹配的早到结束）不生成业务调用，
          // 也不替后续 started 预先签成功。
          if (event.failed) {
            // 216：失败优先——同时删候选与已确认调用，并记失败终止墓碑；
            // 不能因「已经成功」忽略失败。
            pendingToolCalls.delete(event.toolUseId);
            confirmedToolCalls.delete(event.toolUseId);
            failedToolCallIds.add(event.toolUseId);
            continue;
          }
          const candidate = pendingToolCalls.get(event.toolUseId);
          if (candidate) {
            pendingToolCalls.delete(event.toolUseId);
            confirmedToolCalls.set(event.toolUseId, candidate);
          }
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
        // 正常退出路径：辅助进程（MCP server 等）可能滞后于主进程有序退出，
        // 给有界宽限再升级终止（见 settleGroupAfterExit 注释），避免把已拿到
        // 结果的任务误判失败；幸存者/无法核验仍失败关闭。
        const groupOutcome = await settleGroupAfterExit(child.pid).catch(
          (error: Error): { outcome: 'unverifiable'; reason: string } => ({ outcome: 'unverifiable', reason: error.message }),
        );
        if (groupOutcome.outcome === 'unverifiable') {
          return fail(new Error(`无法核验隔离进程组（${groupOutcome.reason}），失败关闭。`));
        }
        if (groupOutcome.outcome === 'survivors') {
          return fail(new Error(`隔离进程组仍有存活后代（${groupOutcome.detail}），wrapper 退出不代表 CLI/后端退出，任务判失败。`));
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
        if (pendingToolCalls.size > 0) {
          // 212：未收到明确成功结束的候选不收下，也不返回审批/派发动作。
          const pending = [...pendingToolCalls.values()]
            .map((call) => call.toolName + '(' + call.toolUseId + ')')
            .join('、');
          return fail(new Error(
            '业务工具未完成：' + pending + ' 缺成功结果（未收到明确的成功 tool_end），不收下 started 候选、不返回审批/派发动作',
          ));
        }
        const confirmedCalls = [...confirmedToolCalls.values()];
        if (confirmedCalls.length > 0) {
          finalResult.toolCalls = confirmedCalls.map((call) => ({
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
