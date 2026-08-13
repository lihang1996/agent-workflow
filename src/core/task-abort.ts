import { canControlOwnedResource } from './access.js';
import type { IdentityInput, IdentityRegistry } from './identity-registry.js';

export interface AbortableRun {
  controller: AbortController;
  ownerOpenId: string;
  cancelMode?: "stop" | "close";
}

export type AbortTaskOutcome =
  | "stopped"
  | "already_stopping"
  | "not_found"
  | "forbidden";

/** 任务发起人或白名单授权用户可停止；返回结果给飞书 toast。 */
export function requestTaskAbort(
  activeRuns: Map<string, AbortableRun>,
  sessionId: string,
  operator: IdentityInput,
  identities?: IdentityRegistry,
): AbortTaskOutcome {
  const active = activeRuns.get(sessionId);
  if (!active) return "not_found";
  if (!canControlOwnedResource(active.ownerOpenId, operator, identities)) return "forbidden";
  if (active.controller.signal.aborted) return "already_stopping";
  active.cancelMode = "stop";
  active.controller.abort();
  return "stopped";
}
