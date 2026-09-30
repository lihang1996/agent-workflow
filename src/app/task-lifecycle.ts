import type { CliRunResult } from '../cli/types.js';
import type { TaskOwner } from '../core/identity.js';
import type { ModelSelection } from '../core/model-selection.js';
import { TaskExecutionStore } from '../core/task-execution.js';
import type { AppRuntime } from './runtime.js';
import { markSessionIdle } from './session-view.js';

export function executionStore(runtime: AppRuntime): TaskExecutionStore {
  return runtime.taskExecutions ??= new TaskExecutionStore();
}

export async function beginTask(runtime: AppRuntime, sessionId: string, owner: TaskOwner, version?: number): Promise<AbortController> {
  const session = runtime.sessions.get(sessionId);
  if (!session || runtime.activeRuns.has(sessionId) || runtime.sessionMutations?.has(sessionId) || (version !== undefined && (session.version ?? 0) !== version)) {
    throw new Error('会话正在执行或上下文已经切换');
  }
  owner = { ownerOpenId: owner.ownerOpenId, ownerUnionId: owner.ownerUnionId, ownerBotId: owner.ownerBotId };
  const controller = new AbortController();
  runtime.activeRuns.set(sessionId, { controller, ...owner });
  const transition = runtime.sessions.transition(sessionId, 'active', owner, { expectedVersion: version });
  try { await transition; }
  catch (error) {
    if (runtime.activeRuns.get(sessionId)?.controller === controller) runtime.activeRuns.delete(sessionId);
    throw error;
  }
  return controller;
}

export async function releaseTask(
  runtime: AppRuntime,
  sessionId: string,
  controller: AbortController,
  log: (message: string) => void = console.log,
): Promise<void> {
  if (runtime.activeRuns.get(sessionId)?.controller !== controller) return;
  try { await markSessionIdle(runtime.sessions, sessionId, log); }
  finally { runtime.activeRuns.delete(sessionId); }
}

/** All three entry points use the same execution/result persistence boundary. */
export async function executeTask(options: {
  runtime: AppRuntime; id: string; sessionId: string; botId: string;
  execute: () => Promise<CliRunResult>;
  /**
   * 本次执行的实际模型选择；undefined = 调用方未接入模型决策（保持旧行为）。
   * 惰性读取（getter 允许）：模型决策可能发生在 execute 闭包内部。
   */
  modelSelection?: ModelSelection | null;
  /** 本次是否新开了原生会话（未续接旧 id）；配合缺失的 sessionId 判定绑定事实不明。 */
  freshNativeSession?: boolean;
}): Promise<CliRunResult> {
  const { runtime, id, sessionId, botId } = options;
  const store = executionStore(runtime);
  const previous = store.get(id);
  if (previous?.status === 'running' || previous?.status === 'interrupted') {
    throw new Error('任务执行结果不确定，请检查产物后发送新的指令；不会自动重复执行。');
  }
  let result = previous?.status === 'completed' ? previous.result : undefined;
  // 缓存重放只补投结果：不得把历史执行的 native session/model 贴到当前
  // 会话绑定上（当前会话可能已切到别的原生会话）。绑定只随真实执行更新。
  const replayed = !!result;
  if (!result) {
    store.start(id, sessionId, botId, options.modelSelection);
    try { result = await options.execute(); }
    catch (error) { store.fail(id, error); throw error; }
    // A persistence error here leaves the record running, so a retry cannot repeat side effects.
    store.complete(id, result, options.modelSelection);
  }
  if (!replayed) {
    if (result.sessionId) {
      await runtime.sessions.setCliSessionId(sessionId, result.sessionId, options.modelSelection);
    } else if (options.modelSelection !== undefined && options.freshNativeSession) {
      // 新开的原生会话没有回报 session id：绑定事实不明，失败关闭——丢弃旧
      // 绑定，避免下次误续接已不代表当前上下文的会话。续接执行（未换会话）
      // 未回报 id 时不动绑定。
      await runtime.sessions.resetCliBinding(sessionId);
    }
    if (result.stats?.contextWindowTokens) runtime.contextWindows.set(sessionId, result.stats.contextWindowTokens);
  }
  return result;
}
