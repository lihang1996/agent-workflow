import { isTaskOwner } from './identity.js';

export interface ActiveRun {
  controller: AbortController;
  ownerOpenId: string;
  ownerUnionId?: string;
  ownerBotId?: string;
  cancelMode?: 'stop' | 'close';
}

export type AbortTaskOutcome =
  | 'stopped'
  | 'already_stopping'
  | 'not_found'
  | 'forbidden';

export function requestTaskAbort(
  activeRuns: Map<string, ActiveRun>,
  sessionId: string,
  operatorOpenId: string,
  operatorUnionId?: string,
  operatorBotId?: string,
): AbortTaskOutcome {
  const active = activeRuns.get(sessionId);
  if (!active) return 'not_found';
  if (!isTaskOwner(active, { operatorOpenId, operatorUnionId, operatorBotId })) return 'forbidden';
  if (active.controller.signal.aborted) return 'already_stopping';
  active.cancelMode = 'stop';
  active.controller.abort();
  return 'stopped';
}
