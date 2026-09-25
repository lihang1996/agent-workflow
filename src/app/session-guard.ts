import { randomUUID } from 'node:crypto';
import type { Session } from '../core/session-manager.js';
import { isTaskOwner, type TaskOwner, type OperatorIdentity } from '../core/identity.js';
import type { AppRuntime } from './runtime.js';

export function flowMatchesSession(flow: { sessionId: string; sessionVersion?: number }, session?: Session): boolean {
  return !!session && session.id === flow.sessionId && session.status !== 'closed'
    && (session.version ?? 0) === (flow.sessionVersion ?? 0);
}

function sessionMutationLocks(runtime: AppRuntime): Map<string, string> {
  return runtime.sessionMutations ??= new Map();
}

export function isSessionBusy(runtime: AppRuntime, sessionId: string): boolean {
  return runtime.activeRuns.has(sessionId) || sessionMutationLocks(runtime).has(sessionId);
}

export async function withSessionMutation<T>(
  runtime: AppRuntime,
  sessionId: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const locks = sessionMutationLocks(runtime);
  if (runtime.activeRuns.has(sessionId)) throw new Error('会话正在执行，请等待本次任务收尾后再修改。');
  if (locks.has(sessionId)) throw new Error('会话正在被另一项修改占用，请稍后重试。');

  const token = randomUUID();
  locks.set(sessionId, token);
  try {
    return await mutate();
  } finally {
    if (locks.get(sessionId) === token) locks.delete(sessionId);
  }
}

export function canManageSession(runtime: AppRuntime, sessionId: string, operator: OperatorIdentity): boolean {
  const session = runtime.sessions.get(sessionId);
  if (!session) return false;
  const owners: TaskOwner[] = [
    runtime.activeRuns.get(sessionId),
    ...runtime.clarificationFlows.forSession(sessionId).filter((f) => flowMatchesSession(f, session)),
    ...runtime.productSpecFlows.forSession(sessionId).filter((f) => flowMatchesSession(f, session)),
  ].filter((owner) => owner !== undefined);
  // Existing sessions without an owner remain usable until a new task establishes ownership.
  if (!owners.length && session.owner) owners.push(session.owner);
  return owners.every((owner) => isTaskOwner(owner, operator));
}
