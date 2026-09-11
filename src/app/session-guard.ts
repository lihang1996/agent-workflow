import type { Session } from '../core/session-manager.js';
import { isTaskOwner, type TaskOwner, type OperatorIdentity } from '../core/identity.js';
import type { AppRuntime } from './runtime.js';

export function flowMatchesSession(flow: { sessionId: string; sessionVersion?: number }, session?: Session): boolean {
  return !!session && session.id === flow.sessionId && session.status !== 'closed'
    && (session.version ?? 0) === (flow.sessionVersion ?? 0);
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
