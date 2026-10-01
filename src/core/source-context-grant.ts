/** Trusted host only. Source facts are read-only inputs, never deployment facts or coding authority. */
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { decodeKbEnvelope, extractKnowledgeCitations, type KbMcpClient } from './kb-prefetch.js';
import type { KnowledgeRef } from './product-spec.js';
export interface SourceContextBinding {
    taskId: string;
    sessionId: string;
    sessionVersion: number;
    botId: string;
    principalId: string;
    role: string;
    systemId: string;
    workspaceRealpath: string;
}
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const stateSchema = z.object({ status: z.literal('current'), fact_kind: z.literal('source-current'),
    checked_at: z.string().datetime(), expires_at: z.string().datetime(), epoch_digest: digest,
    evidence_digest: digest, repo_commits: z.record(z.string(), z.string().regex(/^[a-f0-9]{40}$/)),
    trust_scope: z.enum(['source', 'local-dev']), reason: z.string() }).strict();
const objectSchema = z.object({ id: z.string().min(1), revision: z.number().int().positive(),
    // The MCP context projection omits publication metadata. Its current source
    // proof comes from the signed collection of published, verified objects;
    // search seeds separately require both explicit status fields below.
    source_state: stateSchema }).passthrough();
function canonical(value: unknown): unknown {
    if (Array.isArray(value))
        return value.map(canonical);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
    return value;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function normalize(binding: SourceContextBinding): SourceContextBinding {
    if (!binding.taskId || !binding.sessionId || !binding.botId || !binding.principalId || !binding.role || !binding.systemId
        || !Number.isSafeInteger(binding.sessionVersion) || binding.sessionVersion < 0)
        throw new Error('Invalid source context binding');
    return { ...binding, workspaceRealpath: realpathSync(binding.workspaceRealpath) };
}
interface Grant {
    id: string;
    binding: SourceContextBinding;
    contextRef: string;
    epoch: string;
    contentHash: string;
    expiresAt: number;
    text: string;
    ref: KnowledgeRef;
}
export class SourceContextGrantStore {
    private readonly grants = new Map<string, Grant>();
    constructor(private readonly host: {
        client: KbMcpClient;
        systems: ReadonlySet<string>;
        authorize: (binding: SourceContextBinding) => boolean;
        audience: 'source' | 'local-dev';
        now?: () => number;
    }) { }
    private authorize(binding: SourceContextBinding) {
        if (!this.host.systems.has(binding.systemId) || !this.host.authorize(structuredClone(binding)))
            throw new Error('Source context principal/scope revoked');
    }
    private validate(objects: unknown): {
        objects: z.infer<typeof objectSchema>[];
        epoch: string;
        expiresAt: number;
    } {
        const parsed = z.array(objectSchema).min(1).parse(objects), now = this.host.now?.() ?? Date.now();
        const epoch = parsed[0].source_state.epoch_digest;
        const expiresAt = Math.min(...parsed.map(object => Date.parse(object.source_state.expires_at)));
        if (parsed.some(object => object.source_state.trust_scope !== this.host.audience || object.source_state.epoch_digest !== epoch
            || Date.parse(object.source_state.checked_at) > now + 60000 || Date.parse(object.source_state.checked_at) < now - 86400000)
            || expiresAt <= now || expiresAt > now + 86400000)
            throw new Error('Source context proof expired, changed, or wrong audience');
        if (new Set(parsed.map(object => object.id)).size !== parsed.length)
            throw new Error('Duplicate source context object');
        return { objects: parsed, epoch, expiresAt };
    }
    async issue(bindingInput: SourceContextBinding, requirement: string): Promise<{
        grantId: string;
        text: string;
        factKind: 'source-current';
        codingAuthority: false;
    }> {
        const binding = normalize(bindingInput);
        this.authorize(binding);
        const searched = decodeKbEnvelope('search_knowledge', await this.host.client.call('search_knowledge', {
            mode: 'search', purpose: binding.role === 'developer' ? 'dev' : 'prd', system_id: binding.systemId, query: requirement, page_size: 50,
        }), binding.systemId);
        const seeds = z.array(z.object({ id: z.string(), revision: z.number(), source_state: z.unknown().optional() }).passthrough()).parse(searched.result.results)
            .filter(item => item.publication_status === 'published' && item.verification_status === 'verified' && stateSchema.safeParse(item.source_state).success).map(item => ({ id: item.id, revision: item.revision }));
        if (!seeds.length)
            throw new Error('No current source knowledge in authorized scope');
        const built = decodeKbEnvelope('build_prd_context', await this.host.client.call('build_prd_context', {
            mode: 'build', system_id: binding.systemId, requirement, seeds,
        }), binding.systemId);
        const contextRef = z.string().min(1).parse(built.result.context_ref);
        const read = decodeKbEnvelope('get_knowledge', await this.host.client.call('get_knowledge', { resource: 'context', context_ref: contextRef }), binding.systemId);
        const context = z.record(z.string(), z.unknown()).parse(read.result.context);
        const checked = this.validate(context.objects);
        this.authorize(binding);
        const ref: KnowledgeRef = { fact_kind: 'source-current', system_id: binding.systemId, scope: `source:${binding.role}`, snapshot_ref: z.string().min(1).parse(read.snapshot_ref), context_ref: contextRef,
            object_ids: checked.objects.map(o => o.id), object_revisions: Object.fromEntries(checked.objects.map(o => [o.id, o.revision])), requested_seed_ids: seeds.map(s => s.id) };
        const text = '[可信主进程提供的主分支业务资料：source-current；不证明已上线，不授予编码写权限；PRD 应使用 [[kb:system|object@revision|snapshot]] 引用并标注 source-current]\n'
            + JSON.stringify({ knowledge_ref: ref, context_ref: contextRef, system_id: binding.systemId, objects: checked.objects,
                relation_paths: context.relation_paths, sources: context.sources, gaps: read.missing_evidence, warnings: read.warnings, truncated: read.truncated });
        if (Buffer.byteLength(text) > 131072)
            throw new Error('Source context exceeds host budget');
        const grant: Grant = { id: randomUUID(), binding, contextRef, epoch: checked.epoch, expiresAt: checked.expiresAt, contentHash: hash({ objects: checked.objects, relations: context.relation_paths, sources: context.sources }), text, ref };
        for (const [id, item] of this.grants)
            if (item.expiresAt <= (this.host.now?.() ?? Date.now()))
                this.grants.delete(id);
        // A fresh issue replaces the same flow/system. Stale proof is never retained as an alternate grant.
        for (const [id, item] of this.grants)
            if (item.binding.taskId === binding.taskId && item.binding.sessionId === binding.sessionId && item.binding.systemId === binding.systemId)
                this.grants.delete(id);
        if (this.grants.size >= 1000)
            throw new Error('Source context host grant capacity reached');
        this.grants.set(grant.id, grant);
        return { grantId: grant.id, text, factKind: 'source-current', codingAuthority: false };
    }
    async read(grantId: string, bindingInput: SourceContextBinding): Promise<string> {
        const binding = normalize(bindingInput), grant = this.grants.get(grantId);
        this.authorize(binding);
        if (!grant || hash(binding) !== hash(grant.binding) || grant.expiresAt <= (this.host.now?.() ?? Date.now()))
            throw new Error('Source context grant missing, expired or binding mismatch');
        const read = decodeKbEnvelope('get_knowledge', await this.host.client.call('get_knowledge', { resource: 'context', context_ref: grant.contextRef }), binding.systemId);
        const context = z.record(z.string(), z.unknown()).parse(read.result.context);
        const checked = this.validate(context.objects);
        this.authorize(binding);
        if (checked.epoch !== grant.epoch || hash({ objects: checked.objects, relations: context.relation_paths, sources: context.sources }) !== grant.contentHash)
            throw new Error('Source context grant proof/content changed; prefetch again');
        return grant.text;
    }
    references(binding: {
        taskId: string;
        sessionId: string;
    }): KnowledgeRef[] {
        return [...this.grants.values()].filter(g => g.binding.taskId === binding.taskId && g.binding.sessionId === binding.sessionId).map(g => structuredClone(g.ref));
    }
    async verifyReferences(refs: readonly KnowledgeRef[], binding: Omit<SourceContextBinding, 'systemId'>): Promise<void> {
        for (const ref of refs) {
            const found = [...this.grants.values()].find(g => g.contextRef === ref.context_ref && hash(g.ref) === hash(ref)
                && g.binding.taskId === binding.taskId && g.binding.sessionId === binding.sessionId);
            if (!found || ref.fact_kind !== 'source-current')
                throw new Error('Source reference not issued for this flow');
            await this.read(found.id, { ...binding, systemId: ref.system_id });
        }
    }
    async verifyCitations(texts: readonly string[], refs: readonly KnowledgeRef[], binding: Omit<SourceContextBinding, 'systemId'>, requireAll = true): Promise<{
        ok: true;
    } | {
        ok: false;
        reason: string;
    }> {
        try {
            await this.verifyReferences(refs, binding);
            const citations = texts.flatMap(text => extractKnowledgeCitations(text));
            if (citations.some(c => !refs.some(r => r.system_id === c.system_id && r.snapshot_ref === c.snapshot_ref && r.object_ids.includes(c.object_id)
                && r.object_revisions?.[c.object_id] === c.revision)))
                throw new Error('Source citation outside host grant/revision');
            if (requireAll && refs.some(r => r.object_ids.some(id => !citations.some(c => c.system_id === r.system_id && c.snapshot_ref === r.snapshot_ref && c.object_id === id && c.revision === r.object_revisions?.[id]))))
                throw new Error('Declared source facts missing from PRD citations');
            return { ok: true };
        }
        catch (error) {
            return { ok: false, reason: (error as Error).message };
        }
    }
}
