import type { CliRunResult } from '../cli/types.js';
import type { TaskOwner } from '../core/identity.js';
import { TaskExecutionStore } from '../core/task-execution.js';
import type { AppRuntime } from './runtime.js';
import { markSessionIdle } from './session-view.js';

export function executionStore(runtime: AppRuntime): TaskExecutionStore {
  return runtime.taskExecutions ??= new TaskExecutionStore();
}

export async function beginTask(runtime: AppRuntime, sessionId: string, owner: TaskOwner, version?: number): Promise<AbortController> {
  const session = runtime.sessions.get(sessionId);
  if (!session || runtime.activeRuns.has(sessionId) || (version !== undefined && (session.version ?? 0) !== version)) {
    throw new Error('会话正在执行或上下文已经切换');
  }
  owner = { ownerOpenId: owner.ownerOpenId, ownerUnionId: owner.ownerUnionId, ownerBotId: owner.ownerBotId };
  const controller = new AbortController();
  // transition changes the in-memory status synchronously, before its first await.
  const transition = runtime.sessions.transition(sessionId, 'active', owner);
  runtime.activeRuns.set(sessionId, { controller, ...owner });
  try { await transition; }
  catch (error) {
    if (runtime.activeRuns.get(sessionId)?.controller === controller) runtime.activeRuns.delete(sessionId);
    throw error;
  }
  return controller;
}

export async function releaseTask(runtime: AppRuntime, sessionId: string, controller: AbortController): Promise<void> {
  if (runtime.activeRuns.get(sessionId)?.controller !== controller) return;
  try { await markSessionIdle(runtime.sessions, sessionId); }
  finally { runtime.activeRuns.delete(sessionId); }
}

/** All three entry points use the same execution/result persistence boundary. */
export async function executeTask(options: {
  runtime: AppRuntime; id: string; sessionId: string; botId: string;
  execute: () => Promise<CliRunResult>;
}): Promise<CliRunResult> {
  const { runtime, id, sessionId, botId } = options;
  const store = executionStore(runtime);
  const previous = store.get(id);
  if (previous?.status === 'running' || previous?.status === 'interrupted') {
    throw new Error('任务执行结果不确定，请检查产物后发送新的指令；不会自动重复执行。');
  }
  let result = previous?.status === 'completed' ? previous.result : undefined;
  if (!result) {
    store.start(id, sessionId, botId);
    try { result = await options.execute(); }
    catch (error) { store.fail(id, error); throw error; }
    // A persistence error here leaves the record running, so a retry cannot repeat side effects.
    store.complete(id, result);
  }
  if (result.sessionId) await runtime.sessions.setCliSessionId(sessionId, result.sessionId);
  if (result.stats?.contextWindowTokens) runtime.contextWindows.set(sessionId, result.stats.contextWindowTokens);
  return result;
}
