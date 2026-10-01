import type { AppRuntime } from './runtime.js';
import type { ProductSpecFlow, KnowledgeRef } from '../core/product-spec.js';
/** Revalidate original PRD identity even when an architecture inherits its references. */
export async function verifySourceFlowCitations(runtime: AppRuntime, flow: ProductSpecFlow, texts: readonly string[], refs: readonly KnowledgeRef[]) {
    const original = flow.artifact_kind === 'architecture' && flow.upstream ? runtime.productSpecFlows.get(flow.upstream.prdToken) : flow;
    if (!original || !runtime.sourceContexts)
        return { ok: false as const, reason: 'Trusted source grant missing (restart requires prefetch/regenerate)' };
    const session = runtime.sessions.get(original.sessionId), config = runtime.teamRegistry.get(original.botId);
    if (!session || !config || (session.version ?? 0) !== (original.sessionVersion ?? 0))
        return { ok: false as const, reason: 'Source context session revoked/changed' };
    return runtime.sourceContexts.verifyCitations(texts, refs, { taskId: original.taskId, sessionId: original.sessionId,
        sessionVersion: session.version ?? 0, botId: original.botId, principalId: original.ownerUnionId ?? original.ownerOpenId,
        role: config.role, workspaceRealpath: session.workspaceDir }, flow.artifact_kind !== 'architecture');
}
