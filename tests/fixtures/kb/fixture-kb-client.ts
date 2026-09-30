import { randomUUID } from 'node:crypto';
import type {
  KbMcpToolName,
  KbMcpToolResponse,
  KbMcpClient,
} from '../../../src/core/kb-prefetch.js';

/**
 * 本地 fixture：按真实 kb-mcp（leon_knowledge/tools/kb-mcp/src/index.ts）的
 * **生产契约形状**模拟 MCP stdio 服务的工具帧响应。
 *
 * 只在测试进程内以构造注入方式使用；不连接真实 kb-mcp、不读取 KB_CONFIG/
 * KB_CALLER/凭据，也没有任何环境变量开关（13 号 B4）。行为对齐真实服务：
 * - 一切响应是 `{content:[{type:'text',text}]}`，text 为 contract_version=1 信封；
 * - 错误信封 `status='error'` + 帧 `isError:true`（scope_not_available/
 *   scope_denied/invalid_argument/seeds_not_available/internal_error）；
 * - search_knowledge：mode=catalog|search、page/page_size 分页、query 为空只许
 *   catalog、撤回对象不进结果也不进任何计数（无撤回计数字段可减出隐藏数）；
 * - analyze_change_impact：必填 change_intent；空种子 → invalid_argument；
 * - build_prd_context：mode=build 必填 requirement；种子缺失/已撤回 →
 *   seeds_not_available 且不产生制品；回参只有 context_ref 等摘要字段；
 * - get_knowledge(resource=context)：从固定快照重建载荷（不看存储自报值），
 *   tamper 模拟读回不一致 → scope_denied（与真实 CONTEXT_VERIFY_FAILED 同口径）；
 *   种子被撤回 → 整个 context 拒绝，不返回片段；
 * - 参数中出现 caller/KB_CALLER → invalid_argument（真实 AC-17）；
 * - **生产无受保护 current 锚**：默认一切 usable_as_current=false 并携带
 *   trusted_anchor_unconfigured 警示；仅当显式 simulateTrustedCurrentAnchor
 *   （等价真实仓库测试注入 TrustedCurrentAnchor 的 fixture 通道）时，标记
 *   usable_as_current=true 的对象才返回 true。正式运行路径没有任何开关。
 */
export const FIXTURE_ANCHOR_WARNING = 'trusted_anchor_unconfigured：current 结果未经独立信任锚验证（active registry→release→build-record→快照 链未锚定），全部为历史/待确认资料，不得作为当前线上事实';
export const FIXTURE_CONTEXT_VERIFY_FAILED_MSG = '该 context 无法通过固定快照严格复核，请重新构建';

export interface FixtureKbObject {
  id: string;
  revision: number;
  kind: string;
  name: string;
  summary: string;
  publication_status: 'published' | 'draft' | 'offline';
  verification_status?: string;
  /**
   * 仅在 simulateTrustedCurrentAnchor=true 且 publication_status=published 且
   * verification_status=verified 且未撤回时生效（模拟受保护锚已配置的核验
   * 通道）；默认 false —— 与生产「current 恒不可用」一致。真实 evaluator 不
   * 允许 draft/offline/unverified 出现 usable_as_current=true，fixture 同样
   * 拒绝这种不可能组合。
   */
  usable_as_current?: boolean;
  availability_reason?: string;
}

export interface FixtureKbSystem {
  systemId: string;
  /** null/缺省 = 无激活快照（新项目形态，catalog/search 报 scope_not_available）。 */
  activeSnapshot?: string | null;
  objects?: FixtureKbObject[];
  /** 注入已有项目 KB 故障：'all' 或指定工具返回 internal_error 错误信封。 */
  failTool?: 'all' | KbMcpToolName;
  /** 强制小页宽以触发分页（真实分页由服务端 page_size_default 决定）。 */
  pageSize?: number;
  /** search 信封 truncated（模拟 response_budget_exceeded）。 */
  searchTruncated?: boolean;
  /** impact 信封 truncated（模拟遍历限额）。 */
  impactTruncated?: boolean;
  /**
   * 协议破坏注入（指定 corruptTool 的帧返回不合法内容，验证客户端失败关闭）：
   * bad-json / wrong-contract-version / ok-status-missing / wrong-system /
   * wrong-snapshot / error-envelope-malformed（错误信封缺 request_id/错误码）。
   */
  corrupt?: 'bad-json' | 'wrong-contract-version' | 'ok-status-missing' | 'wrong-system' | 'wrong-snapshot' | 'error-envelope-malformed';
  corruptTool?: KbMcpToolName;
  /** build 成功存储后立即撤回全部种子 → 读回整个 context 被拒（撤回不泄漏）。 */
  withdrawSeedsAfterBuild?: boolean;
  /** build 存储的 context 标记为被篡改 → 读回 scope_denied（复核失败口径）。 */
  tamperContexts?: boolean;
  /** 读回载荷的 recheck.verified_against_snapshot=false → 客户端不得当可信上下文。 */
  recheckUnverified?: boolean;
  /**
   * 固定 context_ref：真实 ArtifactStore 内容寻址 ref 可被不同任务复用
   * （store.save = sha256:canonicalJson），用于跨任务复用负例。
   */
  fixedContextRef?: string;
  /** build 成功、读回时 availability 重评全部降为不可用（真实 get_knowledge 语义）。 */
  readBackDropsCurrent?: boolean;
}

export interface FixtureKbOptions {
  systems: FixtureKbSystem[];
  /** caller ACL 白名单（真实 consumer.yaml callers[].allowed_systems 语义）。 */
  allowedSystems?: string[];
  /** 测试注入：模拟受保护 current 锚已配置（生产恒 false，不得绕开）。 */
  simulateTrustedCurrentAnchor?: boolean;
  onCall?: (tool: KbMcpToolName, args: unknown) => void;
}

export interface FixtureCallLogEntry {
  tool: KbMcpToolName;
  args: unknown;
}

interface StoredContext {
  ref: string;
  systemId: string;
  snapshotRef: string;
  requestedSeedIds: string[];
  requirement: string;
  tampered: boolean;
}

function requestId(): string {
  return `req_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export class FixtureKbMcpServer implements KbMcpClient {
  private readonly systems = new Map<string, FixtureKbSystem>();
  private readonly withdrawn = new Set<string>();
  private readonly contexts = new Map<string, StoredContext>();
  /** 实例级唯一前缀：真实制品 ref 全局唯一，fixture 模拟该语义避免跨实例撞号。 */
  private readonly instanceId = randomUUID().slice(0, 8);
  private contextCounter = 0;
  readonly calls: FixtureCallLogEntry[] = [];

  constructor(private readonly options: FixtureKbOptions) {
    for (const system of options.systems) this.systems.set(system.systemId, system);
  }

  /** 登记撤回（权威登记重建生效集，同真实 loadAuthoritativeWithdrawalOverlay 语义）。 */
  withdraw(objectId: string): void {
    this.withdrawn.add(objectId);
  }

  private systemOf(systemId: string): FixtureKbSystem {
    return this.systems.get(systemId) ?? { systemId, activeSnapshot: null, objects: [] };
  }

  private anchorConfigured(): boolean {
    return this.options.simulateTrustedCurrentAnchor === true;
  }

  private usableAsCurrent(object: FixtureKbObject): boolean {
    // 生产口径：无受保护锚时 usable_as_current 恒 false（真实 39 号 P0-1 硬不变量）。
    // 真实 evaluator 还要求 published + verification 满足：不可能的组合一律 false。
    if (object.publication_status !== 'published') return false;
    if ((object.verification_status ?? 'unverified') !== 'verified') return false;
    return this.anchorConfigured() && object.usable_as_current === true && !this.withdrawn.has(object.id);
  }

  private availabilityOf(object: FixtureKbObject): { status: string; usable_as_current: boolean; reason: string } {
    if (this.withdrawn.has(object.id)) {
      return { status: 'withdrawn', usable_as_current: false, reason: '对象已撤回，读取被阻断' };
    }
    const usable = this.usableAsCurrent(object);
    return {
      status: usable ? 'current' : (object.availability_reason ? 'not_current' : 'stale_vs_deployment'),
      usable_as_current: usable,
      reason: usable
        ? ''
        : (object.availability_reason ?? FIXTURE_ANCHOR_WARNING),
    };
  }

  /** 构建真实形状的信封帧：system_id/snapshot_ref 只在信封顶层（result 内不放，与真实 handler 一致）。 */
  private frame(systemId: string, snapshotRef: string | null, result: unknown, extra?: { warnings?: string[]; missing_evidence?: string[]; truncated?: boolean; truncation_reasons?: string[] }): KbMcpToolResponse {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          contract_version: 1,
          request_id: requestId(),
          status: 'ok',
          system_id: systemId,
          snapshot_ref: snapshotRef,
          availability_checked_at: new Date().toISOString(),
          examined_scope: {},
          missing_evidence: extra?.missing_evidence ?? [],
          truncated: extra?.truncated ?? false,
          truncation_reasons: extra?.truncation_reasons ?? [],
          warnings: extra?.warnings ?? [],
          result,
        }, null, 2),
      }],
    };
  }

  private errorFrame(systemId: string, code: string, message: string): KbMcpToolResponse {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          contract_version: 1,
          request_id: requestId(),
          status: 'error',
          system_id: systemId,
          snapshot_ref: null,
          error: { code, message, retryable: false },
        }, null, 2),
      }],
      isError: true,
    };
  }

  /** 协议破坏：返回不满足契约的帧（客户端必须失败关闭）。 */
  private corruptFrame(mode: NonNullable<FixtureKbSystem['corrupt']>, systemId: string): KbMcpToolResponse {
    switch (mode) {
      case 'bad-json':
        return { content: [{ type: 'text', text: 'not-json {{' }] };
      case 'wrong-contract-version':
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              contract_version: 2, request_id: requestId(), status: 'ok', system_id: systemId,
              snapshot_ref: null, examined_scope: {}, missing_evidence: [], truncated: false,
              truncation_reasons: [], warnings: [], result: {},
            }),
          }],
        };
      case 'ok-status-missing':
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              contract_version: 1, request_id: requestId(), system_id: systemId,
              snapshot_ref: null, result: {},
            }),
          }],
        };
      case 'wrong-system':
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              contract_version: 1, request_id: requestId(), status: 'ok', system_id: 'other-system',
              snapshot_ref: null, examined_scope: {}, missing_evidence: [], truncated: false,
              truncation_reasons: [], warnings: [], result: {},
            }),
          }],
        };
      case 'wrong-snapshot':
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              contract_version: 1, request_id: requestId(), status: 'ok', system_id: systemId,
              snapshot_ref: 'snap-not-the-fixed-one', examined_scope: {}, missing_evidence: [],
              truncated: false, truncation_reasons: [], warnings: [], result: {},
            }),
          }],
        };
      case 'error-envelope-malformed':
        // 错误信封缺 request_id 且 error.code 非字符串：不得被误判成任何业务错误。
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              contract_version: 1, status: 'error', system_id: systemId,
              snapshot_ref: null, error: { code: 123, message: 'malformed' },
            }),
          }],
          isError: true,
        };
    }
  }

  async call(tool: KbMcpToolName, args: Record<string, unknown>): Promise<KbMcpToolResponse> {
    this.calls.push({ tool, args });
    this.options.onCall?.(tool, args);
    // 真实 AC-17：caller 身份不接受工具参数自报。
    if ('caller' in args || 'KB_CALLER' in args) {
      return this.errorFrame(String(args.system_id ?? ''), 'invalid_argument', '工具参数中不允许包含 caller 字段');
    }
    const systemId = typeof args.system_id === 'string' ? args.system_id : '';
    const system = systemId ? this.systemOf(systemId) : undefined;

    if (tool === 'search_knowledge' && system) {
      if (this.options.allowedSystems && !this.options.allowedSystems.includes(systemId)) {
        return this.errorFrame(systemId, 'scope_denied', `caller 无权访问系统 ${systemId}`);
      }
      if (this.shouldFail(system, tool)) {
        return this.errorFrame(systemId, 'internal_error', `fixture 注入的 KB 故障: ${systemId}/${tool}`);
      }
      if (this.shouldCorrupt(system, tool, args)) {
        return this.corruptFrame(system.corrupt!, systemId);
      }
      if (!system.activeSnapshot) {
        return this.errorFrame(systemId, 'scope_not_available', `系统 ${systemId} 当前没有已激活知识（active-registry 缺少该系统或文件不存在）`);
      }
      const purpose = String(args.purpose ?? '');
      if (!['prd', 'dev', 'qa'].includes(purpose)) {
        return this.errorFrame(systemId, 'invalid_argument', 'purpose 必须是 prd|dev|qa');
      }
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      const mode = typeof args.mode === 'string' ? args.mode : (query ? 'search' : 'catalog');
      if (!query && mode !== 'catalog') return this.errorFrame(systemId, 'invalid_argument', 'query 为空时只允许 mode=catalog');
      if (query && mode === 'catalog') return this.errorFrame(systemId, 'invalid_argument', 'mode=catalog 时不接受 query');
      const objects = (system.objects ?? []).filter((object) => !this.withdrawn.has(object.id));
      const warnings: string[] = [];
      if (!this.anchorConfigured()) warnings.push(FIXTURE_ANCHOR_WARNING);

      if (mode === 'catalog') {
        const modules = new Map<string, { module_id: string; module_name: string; object_count: number; rule_count: number; process_count: number }>();
        for (const object of objects) {
          const moduleId = `mod-${object.kind}`;
          const module = modules.get(moduleId) ?? { module_id: moduleId, module_name: moduleId, object_count: 0, rule_count: 0, process_count: 0 };
          module.object_count += 1;
          if (object.kind === 'rule') module.rule_count += 1;
          if (object.kind === 'process') module.process_count += 1;
          modules.set(moduleId, module);
        }
        return this.frame(systemId, system.activeSnapshot, {
          mode: 'catalog',
          modules: [...modules.values()].sort((a, b) => (a.module_id < b.module_id ? -1 : 1)),
          object_count: objects.length,
          counts_by_publication_status: countBy(objects),
        });
      }

      // search：候选选择与真实服务同语义——postings 词命中 ∪ 精确 ID ∪ 名称
      // 子串；词法为拉丁词元 + CJK 二元组（近似真实 tokenize 的候选选择）。
      const queryLower = query.toLowerCase();
      const tokens = tokenizeQuery(query);
      const matched = objects
        .map((object) => {
          const searchable = `${object.id} ${object.name} ${object.summary}`.toLowerCase();
          if (object.id === query) return { object, matched_reason: 'exact_id', score: 1000 };
          if (object.name.toLowerCase().includes(queryLower)) return { object, matched_reason: 'name_substring', score: 250 };
          if (tokens.some((token) => searchable.includes(token))) return { object, matched_reason: 'postings', score: 1 };
          return undefined;
        })
        .filter((entry): entry is { object: FixtureKbObject; matched_reason: string; score: number } => entry !== undefined);
      const hits = matched.map(({ object, matched_reason, score }) => ({
        id: object.id,
        kind: object.kind,
        name: object.name,
        revision: object.revision,
        module_ref: { id: `mod-${object.kind}` },
        matched_reason,
        score,
        publication_status: object.publication_status,
        verification_status: object.verification_status ?? 'unverified',
        availability: this.availabilityOf(object),
        fields: { summary: object.summary },
      }));
      const nonPublished = hits.filter((hit) => hit.publication_status !== 'published').length;
      if (nonPublished > 0) warnings.push(`${nonPublished} 个结果对象非 published 状态，不能作为当前线上事实（逐条见 publication_status/availability）`);
      const pageSize = Math.max(1, Math.floor(system.pageSize ?? 50));
      const page = Math.max(1, Math.floor(typeof args.page === 'number' ? args.page : 1));
      const total = hits.length;
      const paged = hits.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
      return this.frame(systemId, system.activeSnapshot, {
        mode: 'search',
        query,
        results: paged,
        total,
        page,
        page_size: pageSize,
        total_pages: Math.ceil(total / pageSize),
        counts_by_publication_status: countBy(objects),
      }, {
        warnings,
        truncated: system.searchTruncated === true,
        truncation_reasons: system.searchTruncated === true ? ['response_budget_exceeded'] : [],
      });
    }

    if (tool === 'analyze_change_impact' && system) {
      if (this.options.allowedSystems && !this.options.allowedSystems.includes(systemId)) {
        return this.errorFrame(systemId, 'scope_denied', `caller 无权访问系统 ${systemId}`);
      }
      if (this.shouldFail(system, tool)) {
        return this.errorFrame(systemId, 'internal_error', `fixture 注入的 KB 故障: ${systemId}/${tool}`);
      }
      if (this.shouldCorrupt(system, tool, args)) {
        return this.corruptFrame(system.corrupt!, systemId);
      }
      const seeds = Array.isArray(args.seeds) ? args.seeds : [];
      if (seeds.length === 0) return this.errorFrame(systemId, 'invalid_argument', '至少需要一个种子对象');
      if (typeof args.change_intent !== 'string' || !['add', 'modify', 'delete', 'fix'].includes(args.change_intent)) {
        return this.errorFrame(systemId, 'invalid_argument', 'change_intent 必须是 add|modify|delete|fix');
      }
      const known = new Map((system.objects ?? []).map((object) => [object.id, object]));
      const missingEvidence = seeds
        .filter((seed: { id?: unknown }) => !known.has(String((seed as { id?: string }).id)) || this.withdrawn.has(String((seed as { id?: string }).id)))
        .map((seed: { id?: string }) => `seed 对象 ${seed.id} 不存在于当前快照或已撤回`);
      const liveSeeds = seeds.filter((seed: { id?: unknown }) => {
        const id = String((seed as { id?: string }).id);
        return known.has(id) && !this.withdrawn.has(id);
      });
      return this.frame(systemId, system.activeSnapshot ?? null, {
        seeds: liveSeeds.map((seed: { id?: string; revision?: number }) => ({ id: seed.id, revision: seed.revision ?? known.get(String(seed.id))?.revision ?? null, kind: known.get(String(seed.id))?.kind ?? 'unknown', name: known.get(String(seed.id))?.name ?? seed.id, exists: true, availability: this.availabilityOf(known.get(String(seed.id))!) })),
        change_intent: args.change_intent,
        paths: [],
        candidate_associations: [],
        affected_object_ids: liveSeeds.map((seed: { id?: string }) => String(seed.id)),
        constraint_object_ids: [],
      }, {
        missing_evidence: missingEvidence,
        warnings: this.anchorConfigured() ? [] : [FIXTURE_ANCHOR_WARNING],
        truncated: system.impactTruncated === true,
        truncation_reasons: system.impactTruncated === true ? ['max_nodes_exceeded'] : [],
      });
    }

    if (tool === 'build_prd_context' && system) {
      if (this.options.allowedSystems && !this.options.allowedSystems.includes(systemId)) {
        return this.errorFrame(systemId, 'scope_denied', `caller 无权访问系统 ${systemId}`);
      }
      if (this.shouldFail(system, tool)) {
        return this.errorFrame(systemId, 'internal_error', `fixture 注入的 KB 故障: ${systemId}/${tool}`);
      }
      if (this.shouldCorrupt(system, tool, args)) {
        return this.corruptFrame(system.corrupt!, systemId);
      }
      if (args.mode !== 'build') {
        return this.errorFrame(systemId, 'invalid_argument', 'fixture 只实现 mode=build');
      }
      if (typeof args.requirement !== 'string' || !args.requirement) {
        return this.errorFrame(systemId, 'invalid_argument', 'build 模式需要 requirement');
      }
      const seeds = Array.isArray(args.seeds) ? args.seeds : [];
      const known = new Map((system.objects ?? []).map((object) => [object.id, object]));
      const unavailable = seeds
        .map((seed: { id?: string }) => String(seed.id))
        .filter((id) => !known.has(id) || this.withdrawn.has(id));
      if (unavailable.length > 0) {
        return this.errorFrame(systemId, 'seeds_not_available', `以下请求种子不存在于当前快照或已撤回: ${unavailable.join(', ')}；请修正种子后重试（未生成 context）`);
      }
      this.contextCounter += 1;
      // 内容寻址语义：默认每次内容不同生成不同 ref；fixedContextRef 模拟完全
      // 相同内容（相同 canonical JSON）被两个任务复用出同一个 ref。
      const ref = system.fixedContextRef ?? `ctx-fixture-${this.instanceId}-${systemId}-${this.contextCounter}`;
      const requestedSeedIds = seeds.map((seed: { id?: string }) => String(seed.id));
      this.contexts.set(ref, {
        ref,
        systemId,
        snapshotRef: system.activeSnapshot ?? '',
        requestedSeedIds,
        requirement: args.requirement,
        tampered: system.tamperContexts === true,
      });
      if (system.withdrawSeedsAfterBuild) {
        for (const id of requestedSeedIds) this.withdrawn.add(id);
      }
      return this.frame(systemId, system.activeSnapshot ?? null, {
        context_ref: ref,
        snapshot_ref: system.activeSnapshot,
        object_count: requestedSeedIds.length,
        seed_object_count: requestedSeedIds.length,
        closure_object_count: 0,
        requirement_digest: `sha256:${randomUUID().replaceAll('-', '')}`,
        relation_path_count: 0,
        candidate_association_count: 0,
      }, { warnings: this.anchorConfigured() ? [] : [FIXTURE_ANCHOR_WARNING] });
    }

    if (tool === 'get_knowledge') {
      // 真实口径：错误信封的 system_id 取 args.system_id（context 读未传 → ''）。
      const contextRef = typeof args.context_ref === 'string' ? args.context_ref : '';
      if (args.resource !== 'context' || !contextRef) {
        return this.errorFrame(systemId, 'invalid_argument', 'fixture 只实现 resource=context 且需要 context_ref');
      }
      const stored = this.contexts.get(contextRef);
      if (!stored) {
        // 越权/不存在/损坏同错，不泄露该 ref 的存在性。
        return this.errorFrame(systemId, 'scope_denied', '无权访问该引用或引用不存在');
      }
      const system = this.systemOf(stored.systemId);
      if (this.shouldFail(system, tool)) {
        return this.errorFrame(systemId, 'internal_error', `fixture 注入的 KB 故障: ${stored.systemId}/${tool}`);
      }
      if (this.shouldCorrupt(system, tool, args)) {
        return this.corruptFrame(system.corrupt!, systemId);
      }
      if (stored.tampered) {
        return this.errorFrame(systemId, 'scope_denied', FIXTURE_CONTEXT_VERIFY_FAILED_MSG);
      }
      const known = new Map((system.objects ?? []).map((object) => [object.id, object]));
      const readBackAvailability = (object: FixtureKbObject) => (system.readBackDropsCurrent === true
        ? { status: 'stale_vs_deployment', usable_as_current: false, reason: '读回时重新评估可用性：无受保护部署事实/current 锚，降为不可作为现行事实' }
        : this.availabilityOf(object));
      const entries = stored.requestedSeedIds.map((id) => {
        const object = known.get(id)!;
        return {
          id,
          revision: object.revision,
          kind: object.kind,
          name: object.name,
          origin: 'seed' as const,
          summary: object.summary,
          fields: null,
          source_refs: [] as string[],
          applicability: null,
          availability: readBackAvailability(object),
        };
      });
      // 种子被撤回：整个 context 不可证明安全 → 拒绝，不返回任何片段。
      if (entries.some((entry) => this.withdrawn.has(entry.id))) {
        return this.errorFrame(systemId, 'scope_denied', '无权访问该引用或引用不存在');
      }
      // 请求种子缺失于固定快照（构建后被删）→ 复核失败关闭。
      if (entries.some((entry) => !known.has(entry.id))) {
        return this.errorFrame(systemId, 'scope_denied', FIXTURE_CONTEXT_VERIFY_FAILED_MSG);
      }
      const rebuilt = {
        context_schema_version: 1,
        system_id: stored.systemId,
        snapshot_ref: stored.snapshotRef,
        objects: entries,
        relation_paths: [],
        relation_seed_ids: stored.requestedSeedIds,
        requested_seed_ids: stored.requestedSeedIds,
        closure_object_ids: [],
        candidate_associations: [],
        sources: {},
        coverage_digest: `sha256:${randomUUID().replaceAll('-', '')}`,
        coverage_gaps: {
          missing_seed_ids: [],
          non_current_object_ids: entries.filter((entry) => !entry.availability.usable_as_current).map((entry) => entry.id),
          closure_object_ids: [],
          candidate_relation_count: 0,
          notes: entries.some((entry) => !entry.availability.usable_as_current)
            ? ['存在不可作为当前事实的对象（历史/待确认），PRD 引用时必须标注其可用性状态']
            : [],
        },
        artifact_metadata: { verified: false, note: 'built_at/built_by_caller/requirement_digest 为制品自报且同用户可改，未经验证不外发' },
      };
      return this.frame(stored.systemId, stored.snapshotRef, {
        context: rebuilt,
        recheck: {
          checked_at: new Date().toISOString(),
          per_object: entries.map((entry) => ({ id: entry.id, current_availability: entry.availability.status, usable_as_current: entry.availability.usable_as_current })),
          withdrawn_now: [],
          verified_against_snapshot: system.recheckUnverified !== true,
          rebuilt_payload: true,
        },
      }, {
        warnings: this.anchorConfigured() ? [] : [FIXTURE_ANCHOR_WARNING],
      });
    }

    return this.errorFrame(systemId, 'invalid_argument', `未知工具: ${tool}`);
  }

  private shouldFail(system: FixtureKbSystem, tool: KbMcpToolName): boolean {
    return system.failTool === 'all' || system.failTool === tool;
  }

  /**
   * 协议破坏只针对具体调用形态：search_knowledge 的 catalog/search 是同一工具，
   * 破坏注入默认只作用于 mode=search（否则 catalog 阶段就中断，测不出快照
   * 一致性校验）。
   */
  private shouldCorrupt(system: FixtureKbSystem, tool: KbMcpToolName, args: Record<string, unknown>): boolean {
    if (system.corruptTool !== tool || !system.corrupt) return false;
    if (tool === 'search_knowledge') return args.mode === 'search';
    return true;
  }
}

function countBy(objects: FixtureKbObject[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const object of objects) counts[object.publication_status] = (counts[object.publication_status] ?? 0) + 1;
  return counts;
}

/**
 * 近似真实 tokenize 的查询词法：拉丁/数字词元 + CJK 连续段的二元组
 * （一字符段保留单字）。只用于 fixture 的候选选择，不声称与真实分词逐字节一致。
 */
export function tokenizeQuery(query: string): string[] {
  const tokens: string[] = [];
  for (const segment of query.match(/[A-Za-z0-9]+|[\u3400-\u9fff]+/g) ?? []) {
    if (/^[A-Za-z0-9]+$/.test(segment)) {
      tokens.push(segment.toLowerCase());
      continue;
    }
    if (segment.length === 1) {
      tokens.push(segment);
      continue;
    }
    for (let index = 0; index + 1 < segment.length; index += 1) {
      tokens.push(segment.slice(index, index + 2));
    }
  }
  return [...new Set(tokens)];
}

/**
 * 样例 fixture：商城系统。生产口径下（默认不开 simulateTrustedCurrentAnchor）
 * 即使 published 对象 usable_as_current 也恒为 false——这是预期结果，不是缺陷。
 */
export function sampleShopSystem(): FixtureKbSystem {
  return {
    systemId: 'shop',
    activeSnapshot: 'snap-shop-2026-09-28',
    objects: [
      {
        id: 'shop.rule.checkout',
        revision: 3,
        kind: 'rule',
        name: '下单规则',
        publication_status: 'published',
        verification_status: 'verified',
        summary: '订单创建需校验库存与收货地址，金额按会员价计算。',
        usable_as_current: true,
      },
      {
        id: 'shop.rule.refund',
        revision: 2,
        kind: 'rule',
        name: '退款规则',
        publication_status: 'published',
        verification_status: 'verified',
        summary: '7 天内可退款，跨境订单走人工审核。',
        usable_as_current: true,
      },
      {
        id: 'shop.module.order',
        revision: 1,
        kind: 'module',
        name: '订单模块',
        publication_status: 'published',
        verification_status: 'verified',
        summary: '订单创建、支付回调与状态机。',
        usable_as_current: true,
      },
      {
        id: 'shop.rule.coupon-draft',
        revision: 1,
        kind: 'rule',
        name: '优惠券规则（草稿）',
        publication_status: 'draft',
        verification_status: 'unverified',
        summary: '草稿：满减券叠加策略，尚未业务确认。',
      },
      {
        id: 'shop.rule.legacy-offline',
        revision: 4,
        kind: 'rule',
        name: '旧版支付规则（已下线）',
        publication_status: 'offline',
        verification_status: 'verified',
        summary: '已下线的历史规则，仅供追溯。',
      },
    ],
  };
}
