import { randomUUID } from 'node:crypto';
import type { KnowledgeRef, KnowledgeUsageState } from './product-spec.js';

/**
 * T-016：可信主进程知识预取（13 号 C1 选定的 C 方案；W5 首轮返修重写）。
 *
 * 本模块按真实 kb-mcp（leon_knowledge/tools/kb-mcp/src/index.ts）的**生产契约
 * 形状**实现客户端解码与编排，不再自造扁平接口：
 * - 工具只有 search_knowledge(mode=catalog|search) / get_knowledge(resource=
 *   object|context) / analyze_change_impact(需 change_intent，空种子拒绝) /
 *   build_prd_context(mode=build 先持久化返回 context_ref，内容须经
 *   get_knowledge(resource=context) 读回，读回为服务端重建载荷)；
 * - 一切响应都是 MCP 工具帧 `{content:[{type:'text',text}],isError?}`，text 内
 *   是 contract_version=1 的信封 `{status,system_id,snapshot_ref,examined_scope,
 *   missing_evidence,truncated,truncation_reasons,warnings,result}`；错误信封
 *   `status='error'` 且帧带 isError=true；
 * - 生产无受保护 current 锚/独立部署核验（outputs/23 §5），因此
 *   usable_as_current 恒为 false 是**预期结果**：只有
 *   `publication_status==='published' && availability.usable_as_current===true`
 *   才列入现行事实；offline/draft/published 不可用一律按历史/待核实排除。
 *
 * 身份：system 来自服务端 BotConfig.kbSystems 白名单，role 来自服务端 BotConfig；
 * tenant 没有受信任来源，显式记为 blocked 维度，绝不取自需求正文或 CLI 自报。
 * KB_CALLER 仅为审计标签。
 *
 * 运行态门禁：多系统知识消费在 W6 读取隔离 canary 与生产受保护信任通道具备前
 * 保持 blocked；本模块只在测试进程内经 fixture 验收（13 号 B4：测试注入不得
 * 进入正式运行路径），fixture 成功不构成 ACL/撤回保密已生效的证据。
 */
export const KNOWLEDGE_RUNTIME_GATE = {
  status: 'blocked' as const,
  reasons: [
    'W6 真实 CLI 工具链读取隔离 canary 未通过：同用户 CLI 仍可直读 KB 私有文件/凭据或自行拉起 kb-mcp 伪造 KB_CALLER（13 号 C1/C3）',
    '生产受保护信任通道未配置：独立部署核验器、current 锚、对象全集基线均未落地，production current 恒不可用（outputs/23 §5；W7 本地撤回保密修复已通过本地协议负例，但不构成生产验收）',
  ],
};

export function assertKnowledgeRuntimeConsumptionAllowed(): never {
  throw new Error(
    `多系统知识运行态接入保持 blocked：${KNOWLEDGE_RUNTIME_GATE.reasons.join('；')}`,
  );
}

/** 真实 kb-mcp 的四个 MCP 工具名（无独立 catalog/buildPrunedContext 扁平接口）。 */
export type KbMcpToolName = 'search_knowledge' | 'get_knowledge' | 'analyze_change_impact' | 'build_prd_context';

/** MCP CallToolResult 帧形状（@modelcontextprotocol/sdk 的 text 内容 + isError）。 */
export interface KbMcpToolResponse {
  isError?: boolean;
  content: ReadonlyArray<{ type: string; text?: string }>;
}

/** MCP 帧级客户端接口：生产为可信主进程持有的 stdio 连接；测试注入 fixture。 */
export interface KbMcpClient {
  call(tool: KbMcpToolName, args: Record<string, unknown>): Promise<KbMcpToolResponse>;
}

export type KbCallErrorKind =
  | 'kb_unavailable'       // 服务进程不可起/握手失败/调用失败
  | 'kb_protocol_error'    // 帧不合法：坏 JSON/错 contract_version/缺 status/错 system/错 snapshot/结果形状不符
  | 'scope_not_available'  // 该 system 无激活快照（新项目形态之一）
  | 'scope_denied'         // 调用方不在许可范围（含 context 严格复核失败、撤回整体拒绝）
  | 'seeds_not_available'  // build 种子缺失/已撤回（KB 状态中途漂移）
  | 'kb_error';            // 服务端其他显式错误码

export class KbCallError extends Error {
  constructor(
    readonly tool: KbMcpToolName,
    readonly kind: KbCallErrorKind,
    message?: string,
    readonly serverCode?: string,
  ) {
    super(message ?? `KB 调用失败: ${tool}/${kind}`);
    this.name = 'KbCallError';
  }
}

// ---- 信封严格解码 ---------------------------------------------------------

/** 信封级证据缺口：必须向下传递，不得声称覆盖完整。 */
export interface KbEnvelopeExtras {
  missing_evidence: string[];
  truncated: boolean;
  truncation_reasons: string[];
  warnings: string[];
}

interface KbOkEnvelope extends KbEnvelopeExtras {
  contract_version: 1;
  request_id: string;
  status: 'ok';
  system_id: string;
  snapshot_ref: string | null;
  result: Record<string, unknown>;
}

function protocolError(tool: KbMcpToolName, detail: string): KbCallError {
  return new KbCallError(tool, 'kb_protocol_error', `KB 响应不满足契约（失败关闭）: ${detail}`);
}

function stringArray(value: unknown, tool: KbMcpToolName, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw protocolError(tool, `${field} 必须是字符串数组`);
  }
  return value as string[];
}

/**
 * 解码 MCP 工具帧 → 信封（严格失败关闭）：
 * - 文本必须可解析为 JSON 对象；
 * - 错误信封（isError=true）：contract_version=1、request_id、system_id、
 *   snapshot_ref=null、error.code/message 形状全字段校验，且 system_id 必须与
 *   请求绑定的 system 一致（真实服务回显 args.system_id；get_knowledge
 *   resource=context 未传 system_id 时为 ''）——畸形或错 system 不得被误判成
 *   scope_not_available 等业务分支；
 * - 成功信封：contract_version=1、status='ok'、request_id/system_id 非空，且
 *   availability_checked_at/examined_scope/missing_evidence/truncated/
 *   truncation_reasons/warnings 必须存在且类型正确——缺失即拒绝，不得默认
 *   空/false 虚报完整。
 */
export function decodeKbEnvelope(
  tool: KbMcpToolName,
  frame: KbMcpToolResponse,
  boundSystemId?: string,
): KbOkEnvelope {
  const textItem = frame?.content?.find((item) => item?.type === 'text');
  if (!textItem || typeof textItem.text !== 'string') {
    throw protocolError(tool, '缺少 text 内容');
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(textItem.text);
  } catch {
    throw protocolError(tool, 'text 不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw protocolError(tool, 'text 不是 JSON 对象');
  }
  if (parsed.contract_version !== 1) throw protocolError(tool, 'contract_version != 1');
  if (typeof parsed.request_id !== 'string' || !parsed.request_id) {
    throw protocolError(tool, 'request_id 缺失');
  }
  if (typeof parsed.system_id !== 'string') {
    throw protocolError(tool, 'system_id 缺失或非字符串');
  }
  if (frame.isError === true) {
    if (parsed.status !== 'error') throw protocolError(tool, 'isError=true 但 status 非 error');
    if (parsed.snapshot_ref !== null) throw protocolError(tool, '错误信封 snapshot_ref 必须为 null');
    const error = parsed.error as { code?: unknown; message?: unknown } | undefined;
    if (!error || typeof error !== 'object' || typeof error.code !== 'string' || typeof (error as { message?: unknown }).message !== 'string') {
      throw protocolError(tool, '错误信封 error 形状不符（code/message）');
    }
    if (boundSystemId !== undefined && parsed.system_id !== boundSystemId) {
      throw protocolError(tool, `错误信封 system_id=${parsed.system_id} 与请求绑定的 ${boundSystemId} 不一致`);
    }
    const message = error.message || '(无消息)';
    const kind: KbCallErrorKind = error.code === 'scope_not_available'
      ? 'scope_not_available'
      : error.code === 'scope_denied'
        ? 'scope_denied'
        : error.code === 'seeds_not_available'
          ? 'seeds_not_available'
          : 'kb_error';
    throw new KbCallError(tool, kind, `KB ${tool} 失败（${error.code}）: ${message}`, error.code);
  }
  if (parsed.status !== 'ok') throw protocolError(tool, `status=${String(parsed.status)} 非 ok`);
  if (!parsed.system_id) throw protocolError(tool, 'system_id 为空');
  // 成功信封的缺口字段必须存在且类型正确：缺失即协议错误，不默认空/false。
  if (typeof parsed.availability_checked_at !== 'string' || !parsed.availability_checked_at) {
    throw protocolError(tool, 'availability_checked_at 缺失');
  }
  if (parsed.examined_scope === undefined || parsed.examined_scope === null
    || typeof parsed.examined_scope !== 'object' || Array.isArray(parsed.examined_scope)) {
    throw protocolError(tool, 'examined_scope 缺失或形状不符');
  }
  if (typeof parsed.truncated !== 'boolean') throw protocolError(tool, 'truncated 缺失或非布尔');
  const requirePresentStringArray = (value: unknown, field: string): string[] => {
    if (value === undefined || value === null) throw protocolError(tool, `${field} 缺失（不得默认空以虚报完整）`);
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw protocolError(tool, `${field} 必须是字符串数组`);
    }
    return value as string[];
  };
  return {
    contract_version: 1,
    request_id: parsed.request_id,
    status: 'ok',
    system_id: parsed.system_id,
    snapshot_ref: typeof parsed.snapshot_ref === 'string' ? parsed.snapshot_ref : null,
    missing_evidence: requirePresentStringArray(parsed.missing_evidence, 'missing_evidence'),
    truncated: parsed.truncated,
    truncation_reasons: requirePresentStringArray(parsed.truncation_reasons, 'truncation_reasons'),
    warnings: requirePresentStringArray(parsed.warnings, 'warnings'),
    result: (parsed.result ?? {}) as Record<string, unknown>,
  };
}

// ---- 结果形状（与真实 handler 输出一一对应） ------------------------------

export interface KbCatalogResult {
  system_id: string;
  snapshot_ref: string;
  modules: Array<{ module_id: string; module_name: string; object_count: number }>;
}

export interface KbSearchHit {
  id: string;
  revision: number;
  kind: string;
  name: string;
  publication_status: string;
  verification_status: string;
  availability: { status: string; usable_as_current: boolean; reason: string };
}

export interface KbSearchPage {
  results: KbSearchHit[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface KbImpactResult {
  seeds: Array<{ id: string }>;
  change_intent: string;
  affected_object_ids: string[];
  constraint_object_ids: string[];
}

export interface KbContextBuildResult {
  context_ref: string;
  snapshot_ref: string;
  object_count: number;
  seed_object_count: number;
  closure_object_count: number;
}

export interface KbContextObjectEntry {
  id: string;
  revision: number;
  kind: string;
  name: string;
  origin: 'seed' | 'closure';
  summary: string | null;
  availability: { status: string; usable_as_current: boolean; reason: string };
}

export interface KbContextReadResult {
  context: {
    system_id: string;
    snapshot_ref: string;
    objects: KbContextObjectEntry[];
    relation_seed_ids: string[];
    requested_seed_ids: string[];
    closure_object_ids: string[];
    coverage_gaps: { non_current_object_ids: string[]; notes: string[] };
  };
}

function requireString(value: unknown, tool: KbMcpToolName, field: string): string {
  if (typeof value !== 'string' || !value) throw protocolError(tool, `${field} 缺失或非字符串`);
  return value;
}

function requireNumber(value: unknown, tool: KbMcpToolName, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw protocolError(tool, `${field} 缺失或非数字`);
  return value;
}

function requireAvailability(value: unknown, tool: KbMcpToolName): KbSearchHit['availability'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw protocolError(tool, 'availability 缺失');
  }
  const availability = value as { status?: unknown; usable_as_current?: unknown; reason?: unknown };
  if (typeof availability.status !== 'string' || typeof availability.usable_as_current !== 'boolean'
    || typeof availability.reason !== 'string') {
    throw protocolError(tool, 'availability 形状不符（status/usable_as_current/reason）');
  }
  return { status: availability.status, usable_as_current: availability.usable_as_current, reason: availability.reason };
}

/** typed 协议调用的统一返回：结果 + 信封级缺口（供审计透传）。 */
interface KbToolOutcome<T> { result: T; extras: KbEnvelopeExtras }

// ---- 协议客户端：typed 方法 + system/snapshot 一致性 ------------------------

export class KbProtocolClient {
  constructor(private readonly mcp: KbMcpClient) {}

  async catalog(args: { system_id: string }): Promise<KbToolOutcome<KbCatalogResult>> {
    const envelope = decodeKbEnvelope('search_knowledge', await this.mcp.call('search_knowledge', { system_id: args.system_id, purpose: 'prd', mode: 'catalog' }), args.system_id);
    this.assertSystem(envelope, 'search_knowledge', args.system_id);
    if (!envelope.snapshot_ref) throw protocolError('search_knowledge', 'catalog 未返回 snapshot_ref');
    if (envelope.result.mode !== 'catalog' || !Array.isArray(envelope.result.modules)) {
      throw protocolError('search_knowledge', 'catalog result 形状不符');
    }
    return {
      extras: pickExtras(envelope),
      result: {
        system_id: envelope.system_id,
        snapshot_ref: envelope.snapshot_ref,
        modules: envelope.result.modules as KbCatalogResult['modules'],
      },
    };
  }

  async searchPage(args: {
    system_id: string; snapshot_ref: string; query: string; purpose: 'prd' | 'dev' | 'qa'; page: number;
  }): Promise<KbToolOutcome<KbSearchPage>> {
    const envelope = decodeKbEnvelope('search_knowledge', await this.mcp.call('search_knowledge', {
      system_id: args.system_id,
      snapshot_ref: args.snapshot_ref,
      query: args.query,
      purpose: args.purpose,
      mode: 'search',
      page: args.page,
    }), args.system_id);
    this.assertSystem(envelope, 'search_knowledge', args.system_id);
    this.assertSnapshot(envelope, 'search_knowledge', args.snapshot_ref);
    const result = envelope.result;
    if (result.mode !== 'search' || !Array.isArray(result.results)) {
      throw protocolError('search_knowledge', 'search result 形状不符');
    }
    const hits: KbSearchHit[] = result.results.map((raw) => {
      const hit = raw as Record<string, unknown>;
      if (typeof hit.id !== 'string' || typeof hit.revision !== 'number' || typeof hit.kind !== 'string'
        || typeof hit.name !== 'string' || typeof hit.publication_status !== 'string'
        || typeof hit.verification_status !== 'string') {
        throw protocolError('search_knowledge', 'search 命中对象形状不符');
      }
      return {
        id: hit.id,
        revision: hit.revision,
        kind: hit.kind,
        name: hit.name,
        publication_status: hit.publication_status,
        verification_status: hit.verification_status,
        availability: requireAvailability(hit.availability, 'search_knowledge'),
      };
    });
    return {
      extras: pickExtras(envelope),
      result: {
        results: hits,
        total: requireNumber(result.total, 'search_knowledge', 'total'),
        page: requireNumber(result.page, 'search_knowledge', 'page'),
        page_size: requireNumber(result.page_size, 'search_knowledge', 'page_size'),
        total_pages: requireNumber(result.total_pages, 'search_knowledge', 'total_pages'),
      },
    };
  }

  async impact(args: {
    system_id: string; snapshot_ref: string; seeds: Array<{ id: string; revision: number }>; change_intent: 'add' | 'modify' | 'delete' | 'fix';
  }): Promise<KbToolOutcome<KbImpactResult>> {
    const envelope = decodeKbEnvelope('analyze_change_impact', await this.mcp.call('analyze_change_impact', {
      system_id: args.system_id,
      snapshot_ref: args.snapshot_ref,
      seeds: args.seeds.map((seed) => ({ id: seed.id, revision: seed.revision })),
      change_intent: args.change_intent,
    }), args.system_id);
    this.assertSystem(envelope, 'analyze_change_impact', args.system_id);
    this.assertSnapshot(envelope, 'analyze_change_impact', args.snapshot_ref);
    const result = envelope.result;
    if (!Array.isArray(result.seeds) || !Array.isArray(result.affected_object_ids) || !Array.isArray(result.constraint_object_ids)) {
      throw protocolError('analyze_change_impact', 'impact result 形状不符');
    }
    for (const seed of result.seeds as Array<Record<string, unknown>>) {
      if (typeof seed?.id !== 'string') throw protocolError('analyze_change_impact', 'impact seeds 形状不符');
    }
    return {
      extras: pickExtras(envelope),
      result: {
        seeds: result.seeds as KbImpactResult['seeds'],
        change_intent: requireString(result.change_intent, 'analyze_change_impact', 'change_intent'),
        affected_object_ids: result.affected_object_ids as string[],
        constraint_object_ids: result.constraint_object_ids as string[],
      },
    };
  }

  async buildContext(args: {
    system_id: string; snapshot_ref: string; requirement: string; seeds: Array<{ id: string; revision: number }>;
  }): Promise<KbToolOutcome<KbContextBuildResult>> {
    const envelope = decodeKbEnvelope('build_prd_context', await this.mcp.call('build_prd_context', {
      mode: 'build',
      system_id: args.system_id,
      snapshot_ref: args.snapshot_ref,
      requirement: args.requirement,
      seeds: args.seeds.map((seed) => ({ id: seed.id, revision: seed.revision })),
    }), args.system_id);
    this.assertSystem(envelope, 'build_prd_context', args.system_id);
    this.assertSnapshot(envelope, 'build_prd_context', args.snapshot_ref);
    const result = envelope.result;
    const context_ref = requireString(result.context_ref, 'build_prd_context', 'context_ref');
    const snapshot = requireString(result.snapshot_ref, 'build_prd_context', 'snapshot_ref');
    if (snapshot !== args.snapshot_ref) {
      throw protocolError('build_prd_context', `build 快照 ${snapshot} 与固定快照不一致`);
    }
    return {
      extras: pickExtras(envelope),
      result: {
        context_ref,
        snapshot_ref: snapshot,
        object_count: requireNumber(result.object_count, 'build_prd_context', 'object_count'),
        seed_object_count: requireNumber(result.seed_object_count, 'build_prd_context', 'seed_object_count'),
        closure_object_count: requireNumber(result.closure_object_count, 'build_prd_context', 'closure_object_count'),
      },
    };
  }

  async readContext(args: { system_id: string; snapshot_ref: string; context_ref: string }): Promise<KbToolOutcome<KbContextReadResult>> {
    const envelope = decodeKbEnvelope('get_knowledge', await this.mcp.call('get_knowledge', { resource: 'context', context_ref: args.context_ref }), '');
    this.assertSystem(envelope, 'get_knowledge', args.system_id);
    this.assertSnapshot(envelope, 'get_knowledge', args.snapshot_ref);
    // 读回有效性：recheck 必须显式证明已按固定快照复核并重建载荷，否则不得
    // 当可信上下文（无法证明读回已校验 → 失败关闭）。
    const recheck = envelope.result.recheck as Record<string, unknown> | undefined;
    if (!recheck || typeof recheck !== 'object'
      || recheck.verified_against_snapshot !== true
      || recheck.rebuilt_payload !== true
      || !Array.isArray(recheck.per_object)) {
      throw protocolError('get_knowledge', '读回 recheck 未证明已按固定快照复核（verified_against_snapshot/rebuilt_payload/per_object），不得当可信上下文');
    }
    const context = envelope.result.context as Record<string, unknown> | undefined;
    if (!context || typeof context !== 'object') throw protocolError('get_knowledge', 'context 载荷缺失');
    if (requireString(context.system_id, 'get_knowledge', 'context.system_id') !== args.system_id
      || requireString(context.snapshot_ref, 'get_knowledge', 'context.snapshot_ref') !== args.snapshot_ref) {
      throw protocolError('get_knowledge', 'context 的 system/snapshot 与请求不一致');
    }
    if (!Array.isArray(context.objects) || !Array.isArray(context.relation_seed_ids)
      || !Array.isArray(context.requested_seed_ids) || !Array.isArray(context.closure_object_ids)) {
      throw protocolError('get_knowledge', 'context 数组字段形状不符');
    }
    const objects = (context.objects as Array<Record<string, unknown>>).map((entry) => {
      if (typeof entry?.id !== 'string' || typeof entry.revision !== 'number' || typeof entry.kind !== 'string'
        || typeof entry.name !== 'string' || (entry.origin !== 'seed' && entry.origin !== 'closure')) {
        throw protocolError('get_knowledge', 'context 对象条目形状不符');
      }
      return {
        id: entry.id,
        revision: entry.revision,
        kind: entry.kind,
        name: entry.name,
        origin: entry.origin as 'seed' | 'closure',
        summary: typeof entry.summary === 'string' ? entry.summary : null,
        availability: requireAvailability(entry.availability, 'get_knowledge'),
      };
    });
    const gaps = (context.coverage_gaps ?? {}) as { non_current_object_ids?: unknown; notes?: unknown };
    return {
      extras: pickExtras(envelope),
      result: {
        context: {
          system_id: context.system_id as string,
          snapshot_ref: context.snapshot_ref as string,
          objects,
          relation_seed_ids: context.relation_seed_ids as string[],
          requested_seed_ids: context.requested_seed_ids as string[],
          closure_object_ids: context.closure_object_ids as string[],
          coverage_gaps: {
            non_current_object_ids: stringArray(gaps.non_current_object_ids, 'get_knowledge', 'coverage_gaps.non_current_object_ids'),
            notes: stringArray(gaps.notes, 'get_knowledge', 'coverage_gaps.notes'),
          },
        },
      },
    };
  }

  private assertSystem(envelope: KbOkEnvelope, tool: KbMcpToolName, expected: string): void {
    if (envelope.system_id !== expected) {
      throw protocolError(tool, `信封 system_id=${envelope.system_id} 与请求 ${expected} 不一致`);
    }
  }

  private assertSnapshot(envelope: KbOkEnvelope, tool: KbMcpToolName, expected: string): void {
    if (envelope.snapshot_ref !== expected) {
      throw protocolError(tool, `信封 snapshot_ref=${envelope.snapshot_ref} 与固定快照 ${expected} 不一致`);
    }
  }
}

function pickExtras(envelope: KbEnvelopeExtras): KbEnvelopeExtras {
  return {
    missing_evidence: [...envelope.missing_evidence],
    truncated: envelope.truncated,
    truncation_reasons: [...envelope.truncation_reasons],
    warnings: [...envelope.warnings],
  };
}

// ---- 可信身份 ---------------------------------------------------------------

/** agent-os 没有受信任的租户来源：该维度显式 blocked，绝不取自请求自报。 */
export const KB_BLOCKED_IDENTITY_DIMENSIONS = ['tenant'] as const;

export interface PrefetchIdentity {
  callerBotId: string;
  /** 服务端配置的角色（BotConfig.role）；kb-mcp 侧的裁剪以它为准。 */
  role: string;
  kbSystems: readonly string[];
  /** 无受信任来源的维度：恒 null，不得伪造。 */
  tenant: null;
  blockedDimensions: typeof KB_BLOCKED_IDENTITY_DIMENSIONS;
}

/**
 * 服务端身份派生：只接受服务端持有的 BotConfig 字段。role 缺失（没有可信角色
 * 来源）→ 显式 blocked；kbSystems 缺省为空（一切 system 越权）。
 */
export function resolvePrefetchIdentity(config: {
  id: string;
  role?: string;
  kbSystems?: readonly string[];
}): { ok: true; identity: PrefetchIdentity } | { ok: false; reason: string } {
  const role = config.role?.trim();
  if (!role) {
    return { ok: false, reason: `bot ${config.id} 缺少服务端角色配置（role），无可信身份来源，知识预取显式 blocked` };
  }
  return {
    ok: true,
    identity: {
      callerBotId: config.id,
      role,
      kbSystems: config.kbSystems ?? [],
      tenant: null,
      blockedDimensions: KB_BLOCKED_IDENTITY_DIMENSIONS,
    },
  };
}

// ---- 预取记录 ---------------------------------------------------------------

export type PrefetchOutcome = 'ok' | 'new_project_no_baseline' | 'degraded';

export interface PrefetchCallAudit {
  tool: KbMcpToolName;
  input: unknown;
  outcome: 'ok' | 'failed';
  failure_kind?: KbCallErrorKind;
  snapshot_ref?: string | null;
  at: string;
}

/** 可作为现行事实引用的对象（read-back 时仍 usable_as_current=true）。 */
export interface KbCurrentObjectRef {
  object_id: string;
  revision: number;
  kind: string;
  name: string;
  summary: string;
  availability_status: string;
  origin: 'seed' | 'closure';
}

/** 命中过但不得作为现行事实的对象，附完整排除原因（历史/待核实）。 */
export interface KbExcludedObjectRef {
  object_id: string;
  revision: number;
  publication_status: string;
  availability: { status: string; usable_as_current: boolean; reason: string };
  exclusion_reason: string;
}

export interface PrefetchRecord {
  prefetch_id: string;
  system_id: string;
  /** 服务端裁剪作用域（role 绑定），审计用。 */
  scope: string;
  caller: string;
  tenant: null;
  blocked_identity_dimensions: readonly string[];
  task_id: string;
  session_id: string;
  outcome: PrefetchOutcome;
  snapshot_ref: string | null;
  context_ref: string | null;
  requirement: string;
  requested_seed_ids: string[];
  current_objects: KbCurrentObjectRef[];
  excluded_objects: KbExcludedObjectRef[];
  truncated: boolean;
  truncation_reasons: string[];
  /** 信封 warnings 逐条透传（如 trusted_anchor_unconfigured）。 */
  warnings: string[];
  missing_evidence: string[];
  /** 证据缺口：no_current_objects（生产预期）/ trusted_anchor_unconfigured 等。 */
  evidence_gaps: string[];
  audit: PrefetchCallAudit[];
}

const SEED_LIMIT = 8;
const MAX_SEARCH_PAGES = 50;

function classifyExclusion(hit: { publication_status: string; availability: { usable_as_current: boolean; reason: string; status: string } }): string {
  if (hit.publication_status !== 'published') {
    return `publication_status=${hit.publication_status}（非 published，历史/草稿，不得作为现行事实）`;
  }
  if (!hit.availability.usable_as_current) {
    return `published 但 availability.usable_as_current=false（${hit.availability.reason || hit.availability.status}），按历史/待核实处理`;
  }
  return 'availability 缺失，按待核实处理';
}

/**
 * 固定快照执行 catalog→search（分页读完）→impact（需 change_intent）→build→
 * get_knowledge(context) 读回。四分支（T-017 验收口径）：
 * - 越权：system 不在可信作用域 → 抛 KbCallError(scope_denied)，零调用痕迹；
 * - 新项目无基准：catalog 报 scope_not_available → new_project_no_baseline；
 * - 已有项目 KB 故障：任一调用失败/协议不合法/读回不一致 → degraded；
 * - 证据缺口/截断：零现行种子不调 impact/build（真实服务拒绝空种子），
 *   missing_evidence/truncation_reasons/warnings 全部向下传递。
 */
export async function prefetchKnowledgeContext(options: {
  client: KbMcpClient;
  identity: PrefetchIdentity;
  systemId: string;
  requirement: string;
  taskId: string;
  sessionId: string;
  now?: () => Date;
}): Promise<PrefetchRecord> {
  const { client, identity, systemId, requirement, taskId, sessionId } = options;
  const now = options.now ?? (() => new Date());
  if (!identity.kbSystems.includes(systemId)) {
    throw new KbCallError(
      'search_knowledge',
      'scope_denied',
      `system ${systemId} 不在 bot ${identity.callerBotId} 的可信知识作用域内`,
    );
  }
  const protocol = new KbProtocolClient(client);
  const audit: PrefetchCallAudit[] = [];
  const record: PrefetchRecord = {
    prefetch_id: `kbp_${randomUUID().replaceAll('-', '')}`,
    system_id: systemId,
    scope: `role:${identity.role}`,
    caller: `agent-os:${identity.callerBotId}`,
    tenant: null,
    blocked_identity_dimensions: identity.blockedDimensions,
    task_id: taskId,
    session_id: sessionId,
    outcome: 'ok',
    snapshot_ref: null,
    context_ref: null,
    requirement,
    requested_seed_ids: [],
    current_objects: [],
    excluded_objects: [],
    truncated: false,
    truncation_reasons: [],
    warnings: [],
    missing_evidence: [],
    evidence_gaps: [],
    audit,
  };
  const absorb = (extras: KbEnvelopeExtras): void => {
    for (const item of extras.missing_evidence) if (!record.missing_evidence.includes(item)) record.missing_evidence.push(item);
    if (extras.truncated) record.truncated = true;
    for (const reason of extras.truncation_reasons) if (!record.truncation_reasons.includes(reason)) record.truncation_reasons.push(reason);
    for (const warning of extras.warnings) {
      if (!record.warnings.includes(warning)) record.warnings.push(warning);
      if (warning.startsWith('trusted_anchor_unconfigured') && !record.evidence_gaps.includes('trusted_anchor_unconfigured')) {
        record.evidence_gaps.push('trusted_anchor_unconfigured');
      }
    }
  };
  const call = async <T>(tool: KbMcpToolName, input: unknown, execute: () => Promise<KbToolOutcome<T>>): Promise<KbToolOutcome<T>> => {
    const entry: PrefetchCallAudit = { tool, input, outcome: 'ok', snapshot_ref: record.snapshot_ref, at: now().toISOString() };
    audit.push(entry);
    try {
      const outcome = await execute();
      entry.snapshot_ref = record.snapshot_ref;
      return outcome;
    } catch (error) {
      entry.outcome = 'failed';
      entry.failure_kind = error instanceof KbCallError ? error.kind : 'kb_unavailable';
      throw error;
    }
  };
  const degrade = (reason: string): PrefetchRecord => {
    record.outcome = 'degraded';
    record.context_ref = null;
    if (reason && !record.missing_evidence.includes(reason)) record.missing_evidence.push(reason);
    return record;
  };

  let catalog: KbCatalogResult;
  try {
    const outcome = await call('search_knowledge', { system_id: systemId, mode: 'catalog', purpose: 'prd' }, async () => {
      const result = await protocol.catalog({ system_id: systemId });
      // 在审计条目收口前固定本次快照：catalog 发现的 ref 随该条调用留痕。
      record.snapshot_ref = result.result.snapshot_ref;
      return result;
    });
    absorb(outcome.extras);
    catalog = outcome.result;
  } catch (error) {
    if (error instanceof KbCallError && error.kind === 'scope_not_available') {
      record.outcome = 'new_project_no_baseline';
      return record;
    }
    return degrade(error instanceof Error ? error.message : String(error));
  }
  record.snapshot_ref = catalog.snapshot_ref;

  // search：分页读完（total_pages 循环 + 安全上限）；页内命中逐条严格分类。
  const hits: KbSearchHit[] = [];
  try {
    let page = 1;
    for (; page <= MAX_SEARCH_PAGES; page += 1) {
      const outcome = await call('search_knowledge', { system_id: systemId, snapshot_ref: record.snapshot_ref, query: requirement, purpose: 'prd', mode: 'search', page }, () =>
        protocol.searchPage({ system_id: systemId, snapshot_ref: record.snapshot_ref!, query: requirement, purpose: 'prd', page }));
      absorb(outcome.extras);
      hits.push(...outcome.result.results);
      if (page >= outcome.result.total_pages) break;
    }
    if (page > MAX_SEARCH_PAGES) {
      record.truncated = true;
      if (!record.truncation_reasons.includes('search_pages_capped')) record.truncation_reasons.push('search_pages_capped');
    }
  } catch (error) {
    return degrade(error instanceof Error ? error.message : String(error));
  }

  const seen = new Set<string>();
  const seedHits: KbSearchHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    if (hit.publication_status === 'published' && hit.availability.usable_as_current === true) {
      seedHits.push(hit);
    } else {
      record.excluded_objects.push({
        object_id: hit.id,
        revision: hit.revision,
        publication_status: hit.publication_status,
        availability: hit.availability,
        exclusion_reason: classifyExclusion(hit),
      });
    }
  }

  const seeds = seedHits.slice(0, SEED_LIMIT).map((hit) => ({ id: hit.id, revision: hit.revision }));
  if (seedHits.length > seeds.length) {
    record.truncated = true;
    if (!record.truncation_reasons.includes('seed_limit_exceeded')) record.truncation_reasons.push('seed_limit_exceeded');
  }

  // 零现行种子：真实 impact 拒绝空种子，不发起调用；build 亦无意义。记录缺口。
  if (seeds.length === 0) {
    if (!record.evidence_gaps.includes('no_current_objects')) record.evidence_gaps.push('no_current_objects');
    return record;
  }

  try {
    const outcome = await call('analyze_change_impact', { system_id: systemId, snapshot_ref: record.snapshot_ref, seeds, change_intent: 'modify' }, () =>
      protocol.impact({ system_id: systemId, snapshot_ref: record.snapshot_ref!, seeds, change_intent: 'modify' }));
    absorb(outcome.extras);
  } catch (error) {
    return degrade(error instanceof Error ? error.message : String(error));
  }

  let build: KbContextBuildResult;
  try {
    const outcome = await call('build_prd_context', { mode: 'build', system_id: systemId, snapshot_ref: record.snapshot_ref, requirement, seeds }, () =>
      protocol.buildContext({ system_id: systemId, snapshot_ref: record.snapshot_ref!, requirement, seeds }));
    absorb(outcome.extras);
    build = outcome.result;
  } catch (error) {
    return degrade(error instanceof Error ? error.message : String(error));
  }
  record.context_ref = build.context_ref;

  // 读回：服务端重建载荷是引用与现行性的最终事实来源（不采信 build 回参自述）。
  let context: KbContextReadResult['context'];
  try {
    const outcome = await call('get_knowledge', { resource: 'context', context_ref: build.context_ref }, () =>
      protocol.readContext({ system_id: systemId, snapshot_ref: record.snapshot_ref!, context_ref: build.context_ref }));
    absorb(outcome.extras);
    context = outcome.result.context;
  } catch (error) {
    return degrade(error instanceof Error ? error.message : String(error));
  }
  const seedIds = new Set(seeds.map((seed) => seed.id));
  const missingSeeds = [...seedIds].filter((id) => !context.objects.some((entry) => entry.id === id));
  if (missingSeeds.length > 0) {
    return degrade(`context 读回缺少请求种子: ${missingSeeds.join(', ')}`);
  }
  record.requested_seed_ids = [...context.requested_seed_ids];
  for (const entry of context.objects) {
    if (entry.availability.usable_as_current === true) {
      record.current_objects.push({
        object_id: entry.id,
        revision: entry.revision,
        kind: entry.kind,
        name: entry.name,
        summary: entry.summary ?? '',
        availability_status: entry.availability.status,
        origin: entry.origin,
      });
    } else if (seedIds.has(entry.id)) {
      record.excluded_objects.push({
        object_id: entry.id,
        revision: entry.revision,
        publication_status: 'published',
        availability: entry.availability,
        exclusion_reason: `读回时可用性判定不可作为现行事实（${entry.availability.reason || entry.availability.status}）`,
      });
    }
  }
  for (const note of context.coverage_gaps.notes) {
    if (!record.warnings.includes(note)) record.warnings.push(note);
  }
  if (record.current_objects.length === 0
    && !record.evidence_gaps.includes('no_current_objects')) {
    record.evidence_gaps.push('no_current_objects');
  }
  return record;
}

// ---- 裁剪副本 / 引用 / 标注 --------------------------------------------------

/** 交付给不可信 CLI 的裁剪上下文副本：只有 read-back 仍可作现行事实的对象。 */
export interface PrunedKnowledgeContext {
  system_id: string;
  snapshot_ref: string;
  context_ref: string;
  objects: Array<{ object_id: string; revision: number; kind: string; name: string; summary: string }>;
  usage_rules: string[];
  excluded_object_count: number;
  truncated: boolean;
  coverage_note: string;
}

export function buildPrunedContext(record: PrefetchRecord): PrunedKnowledgeContext {
  if (record.outcome !== 'ok' || !record.context_ref || !record.snapshot_ref || record.current_objects.length === 0) {
    throw new Error('只有完整成功且读到现行对象的预取才能生成裁剪副本（新项目/降级/读回后无现行对象场景用 knowledgeUsageNotice 显式标注）');
  }
  const notes: string[] = [];
  if (record.truncated) notes.push('检索/影响分析或上下文被截断，本副本不覆盖全部相关逻辑，PRD 必须列 truncated/missing_evidence');
  if (record.excluded_objects.length > 0) {
    notes.push(`另有 ${record.excluded_objects.length} 个对象不可作为现行事实（draft/offline/published 不可用），只能按历史/待确认标注`);
  }
  if (record.warnings.length > 0) notes.push(`服务端警示：${record.warnings.join('；')}`);
  return {
    system_id: record.system_id,
    snapshot_ref: record.snapshot_ref,
    context_ref: record.context_ref,
    objects: record.current_objects.map((object) => ({
      object_id: object.object_id,
      revision: object.revision,
      kind: object.kind,
      name: object.name,
      summary: object.summary,
    })),
    usage_rules: [
      '现行事实引用只能使用本副本中的对象（对象 ID + revision + snapshot_ref），并逐条可反查服务端台账。',
      '副本之外的内容、draft/offline/published 不可用对象一律不得写成现行事实；引用不可解析时标注，不得编造。',
      '本副本不含也不得尝试访问知识库凭据、私有路径或其他系统的制品。',
    ],
    excluded_object_count: record.excluded_objects.length,
    truncated: record.truncated,
    coverage_note: notes.join('；') || '检索、影响分析与上下文构建均完整，无已知截断。',
  };
}

/**
 * 服务端持有的知识引用清单：每项绑定单一 system 的固定快照与读回上下文。
 * 读回后现行对象清空（availability 重评全部降级）是合法结果：此时**不产出
 * 任何引用**（KnowledgeRefSchema 要求 object_ids 至少 1 项，空 ref 不可持久
 * 化），以证据缺口 no_current_objects + knowledgeUsageNotice 表达——不暗示
 * 兼容性已验证。
 */
export function knowledgeRefsFromRecord(record: PrefetchRecord): KnowledgeRef[] {
  if (record.outcome !== 'ok' || !record.context_ref || !record.snapshot_ref) return [];
  if (record.current_objects.length === 0) return [];
  const object_revisions: Record<string, number> = {};
  for (const object of record.current_objects) object_revisions[object.object_id] = object.revision;
  return [{
    system_id: record.system_id,
    scope: record.scope,
    snapshot_ref: record.snapshot_ref,
    context_ref: record.context_ref,
    object_ids: record.current_objects.map((object) => object.object_id),
    object_revisions,
    requested_seed_ids: [...record.requested_seed_ids],
  }];
}

/** 新项目/降级/无现行对象场景的显式标注文案（进 PRD 模板与审批提示，不静默）。 */
export function knowledgeUsageNotice(record: PrefetchRecord): string {
  if (record.outcome === 'new_project_no_baseline') {
    return '新项目、无既有基准：知识库中没有该系统的激活快照。PRD 不得引用任何“现行事实”，相关章节按新项目标注。';
  }
  if (record.outcome === 'degraded') {
    return '知识基准不可用（degraded）：该系统在授权范围内但本次检索失败，兼容性分析标记 incomplete。审批前需要用户明确确认例外。';
  }
  if (record.evidence_gaps.includes('no_current_objects')) {
    return '本次固定快照内没有可作为现行事实的知识对象（生产环境预期：受保护 current 锚与独立部署核验未配置）。PRD 不得引用任何现行事实，相关结论按历史/待确认标注。';
  }
  if (record.truncated) {
    return '知识检索存在截断：PRD 必须显式列出 truncated/missing_evidence，不得声称已覆盖全部相关逻辑。';
  }
  return '知识基准完整：按裁剪副本中的对象引用现行事实（对象 ID + revision + snapshot_ref）。';
}

// ---- 可信编排入口（本地接线形状；生产运行态仍 blocked） ----------------------

export interface TrustedPrefetchBundle {
  record: PrefetchRecord;
  pruned: PrunedKnowledgeContext | null;
  refs: KnowledgeRef[];
  knowledgeState: KnowledgeUsageState;
}

/**
 * 预取→裁剪副本→服务端持有 refs 的可信编排入口。身份维度全部来自服务端配置；
 * 无可信来源的维度（tenant）显式 blocked。生产不注入 client（runtime 门禁），
 * 该入口经本地 fixture 验收调用链形状。
 */
export async function runTrustedKnowledgePrefetch(options: {
  client: KbMcpClient;
  bot: { id: string; role?: string; kbSystems?: readonly string[] };
  systemId: string;
  requirement: string;
  taskId: string;
  sessionId: string;
  now?: () => Date;
}): Promise<TrustedPrefetchBundle> {
  const identityResult = resolvePrefetchIdentity(options.bot);
  if (!identityResult.ok) {
    throw new KbCallError('search_knowledge', 'scope_denied', identityResult.reason);
  }
  const record = await prefetchKnowledgeContext({
    client: options.client,
    identity: identityResult.identity,
    systemId: options.systemId,
    requirement: options.requirement,
    taskId: options.taskId,
    sessionId: options.sessionId,
    now: options.now,
  });
  const refs = knowledgeRefsFromRecord(record);
  // 已有项目且无任何现行对象 ⇒ 独立可持久化状态（W5 四轮 P1）：不与「完整
  // 可用」（ok）或「新项目无基准」混同；G1 与确认卡据此阻止普通审批。
  const knowledgeState: KnowledgeUsageState = record.outcome === 'ok'
    && record.evidence_gaps.includes('no_current_objects')
    ? 'no_current_objects'
    : record.outcome;
  return {
    record,
    pruned: record.outcome === 'ok' && record.context_ref && record.current_objects.length > 0
      ? buildPrunedContext(record)
      : null,
    refs,
    knowledgeState,
  };
}

// ---- 服务端台账与引用核验 -----------------------------------------------------

/**
 * 服务端预取台账：记录绑定任务/会话/作用域；引用逐项对照 scope、固定快照、
 * 上下文、种子、对象 ID+revision 与当前可用性。模型自报引用一律失败关闭。
 */
export class KnowledgePrefetchLedger {
  /**
   * 存储键 = context_ref + taskId + sessionId：真实 ArtifactStore 的 ref 是
   * 内容寻址（leon_knowledge packages/agent-knowledge/src/artifacts/store.ts
   * save()：`sha256:canonicalJson`，且显式支持内容复用），同一 context_ref
   * 可被多个任务得到——单用 context_ref 作键会跨任务覆盖。
   */
  private readonly records = new Map<string, PrefetchRecord>();

  /** 无歧义 tuple 编码：JSON 数组消除分隔符碰撞（('a b','c') vs ('a','b c')）。 */
  private keyOf(contextRef: string, taskId: string, sessionId: string): string {
    return JSON.stringify([contextRef, taskId, sessionId]);
  }

  record(record: PrefetchRecord): void {
    if (record.outcome !== 'ok' || !record.context_ref) return;
    this.records.set(this.keyOf(record.context_ref, record.task_id, record.session_id), structuredClone(record));
  }

  /** 精确取一条记录（context_ref 绑定任务/会话；未绑定返回 undefined）。 */
  get(contextRef: string, binding: { taskId: string; sessionId: string }): PrefetchRecord | undefined {
    const found = this.records.get(this.keyOf(contextRef, binding.taskId, binding.sessionId));
    return found ? structuredClone(found) : undefined;
  }

  /** 同一 context_ref 的全部记录（内容寻址 ref 可能被多任务复用）。 */
  byContextRef(contextRef: string): PrefetchRecord[] {
    return [...this.records.values()]
      .filter((record) => record.context_ref === contextRef)
      .map((record) => structuredClone(record));
  }

  bySnapshotRef(snapshotRef: string, systemId?: string): PrefetchRecord[] {
    return [...this.records.values()]
      .filter((record) => record.snapshot_ref === snapshotRef
        && (systemId === undefined || record.system_id === systemId))
      .map((record) => structuredClone(record));
  }

  verifyReferences(
    refs: readonly KnowledgeRef[],
    binding: { taskId: string; sessionId: string },
  ): { ok: true } | { ok: false; reason: string } {
    if (refs.length === 0) return { ok: true };
    const seenContextRefs = new Set<string>();
    for (const ref of refs) {
      if (seenContextRefs.has(ref.context_ref)) {
        return { ok: false, reason: `知识引用出现重复的 context_ref（${ref.context_ref}），拒绝核验` };
      }
      seenContextRefs.add(ref.context_ref);
      // 检索键 = context_ref + 任务/会话：同 ref 的其他任务记录不会被误用，
      // 跨任务串用（context_ref 命中但绑定不符）也在此拒绝。
      const record = this.records.get(this.keyOf(ref.context_ref, binding.taskId, binding.sessionId));
      if (
        !record
        || record.system_id !== ref.system_id
        || record.snapshot_ref !== ref.snapshot_ref
      ) {
        return {
          ok: false,
          reason: `引用 ${ref.system_id}/${ref.context_ref} 不在当前任务/会话绑定的服务端预取台账内（内容寻址 context_ref 可能被多任务复用，跨任务串用被拒绝），不得采用模型自报引用`,
        };
      }
      // 键命中后仍显式复核记录绑定字段（纵深防御：键编码缺陷不致静默串用）。
      if (record.task_id !== binding.taskId || record.session_id !== binding.sessionId) {
        return {
          ok: false,
          reason: `台账记录绑定字段与检索键不一致（${record.task_id}/${record.session_id} vs ${binding.taskId}/${binding.sessionId}），拒绝核验`,
        };
      }
      if (record.scope !== ref.scope) {
        return {
          ok: false,
          reason: `引用 ${ref.system_id} 的作用域 ${ref.scope} 与服务端预取作用域 ${record.scope} 不一致（身份裁剪不匹配）`,
        };
      }
      // 完整字段强制（W5 二轮）：object_revisions 与 requested_seed_ids 是服务端
      // 生成 ref 的必备字段——缺失（旧记录/被删减）不能声称完整绑定，一律拒绝。
      if (!ref.object_revisions) {
        return { ok: false, reason: `引用 ${ref.system_id}/${ref.context_ref} 缺少对象 revision 绑定（object_revisions），不能声称完整绑定，拒绝核验` };
      }
      if (!ref.requested_seed_ids) {
        return { ok: false, reason: `引用 ${ref.system_id}/${ref.context_ref} 缺少种子清单绑定（requested_seed_ids），不能声称完整绑定，拒绝核验` };
      }
      const declaredIds = new Set(ref.object_ids);
      for (const [id] of Object.entries(ref.object_revisions)) {
        if (!declaredIds.has(id)) {
          return { ok: false, reason: `引用声明了未引用对象的 revision（${id}），拒绝核验` };
        }
      }
      if (ref.requested_seed_ids.length !== record.requested_seed_ids.length
        || ref.requested_seed_ids.some((id, index) => id !== record.requested_seed_ids[index])) {
        return { ok: false, reason: `引用 ${ref.system_id} 声明的种子与预取记录不一致` };
      }
      const currentById = new Map(record.current_objects.map((object) => [object.object_id, object]));
      for (const objectId of ref.object_ids) {
        const excluded = record.excluded_objects.find((object) => object.object_id === objectId);
        if (excluded) {
          return { ok: false, reason: `对象 ${objectId} 不可作为现行事实（${excluded.exclusion_reason}），引用被拒绝` };
        }
        const current = currentById.get(objectId);
        if (!current) {
          return { ok: false, reason: `对象 ${objectId} 不在本次固定快照的现行对象集中` };
        }
        const declaredRevision = ref.object_revisions[objectId];
        if (declaredRevision === undefined) {
          return { ok: false, reason: `引用未绑定对象 ${objectId} 的 revision，拒绝核验` };
        }
        if (declaredRevision !== current.revision) {
          return { ok: false, reason: `对象 ${objectId} 引用 revision=${declaredRevision} 与台账 revision=${current.revision} 不一致` };
        }
      }
    }
    return { ok: true };
  }
}

// ---- 交付引用核验（正文反查，不采信自报） -----------------------------------

export type CitationStatus = 'verified' | 'not_current_rejected' | 'revision_mismatch' | 'unknown_object' | 'snapshot_mismatch';

export interface KnowledgeCitation {
  system_id?: string;
  object_id: string;
  revision?: number;
  snapshot_ref: string;
}

export interface CitationCheck {
  citation: KnowledgeCitation;
  status: CitationStatus;
  note: string;
}

/**
 * 制品正文中的结构化引用令牌：`[[kb:<system>|<object>@<revision>|<snapshot>]]`。
 * 服务端从固定本地制品读取正文后按此格式解析，与台账逐项对照。
 */
export const KNOWLEDGE_CITATION_TOKEN_RE
  = /\[\[kb:([a-z0-9][a-z0-9._-]{0,63})\|([a-z0-9][a-z0-9._-]{0,199})@(\d{1,10})\|([A-Za-z0-9][A-Za-z0-9._:-]{0,199})\]\]/g;

export function formatKnowledgeCitationToken(citation: {
  system_id: string; object_id: string; revision: number; snapshot_ref: string;
}): string {
  return `[[kb:${citation.system_id}|${citation.object_id}@${citation.revision}|${citation.snapshot_ref}]]`;
}

/** 正文包含 `[[kb:` 候选但不是完整合法令牌（畸形/未闭合/超限/语法错误）。 */
export class KnowledgeCitationParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeCitationParseError';
  }
}

export function extractKnowledgeCitations(text: string): KnowledgeCitation[] {
  const citations: KnowledgeCitation[] = [];
  const seen = new Set<string>();
  const validStarts = new Set<number>();
  for (const match of text.matchAll(KNOWLEDGE_CITATION_TOKEN_RE)) {
    validStarts.add(match.index!);
    const [, systemId, objectId, revision, snapshotRef] = match;
    const key = `${systemId}|${objectId}@${revision}|${snapshotRef}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ system_id: systemId, object_id: objectId, revision: Number(revision), snapshot_ref: snapshotRef });
  }
  // 严格扫描：每个 [[kb: 候选都必须是某个完整合法令牌的起点。畸形候选
  // （如 @x 非数字 revision、未闭合、段落超限）不得被静默忽略。
  for (const candidate of text.matchAll(/\[\[kb:/g)) {
    if (!validStarts.has(candidate.index!)) {
      throw new KnowledgeCitationParseError(
        `位置 ${candidate.index} 的 [[kb: 令牌不合法：必须是 [[kb:<system>|<object>@<revision>|<snapshot>]] 且各段符合语法（revision 为数字、段落不超限、令牌闭合）`,
      );
    }
  }
  return citations;
}

/**
 * T-017 交付校验：PRD 正文引用逐条反查台账。只有「台账内固定快照 + 现行对象 +
 * revision 一致 + 绑定匹配」才 verified；其余一律明确拒绝并标注，不编造。
 */
export function verifyDeliverableCitations(
  citations: readonly KnowledgeCitation[],
  ledger: KnowledgePrefetchLedger,
  binding?: { taskId: string; sessionId: string },
): CitationCheck[] {
  return citations.map((citation) => {
    let matches = ledger.bySnapshotRef(citation.snapshot_ref, citation.system_id);
    if (binding) {
      matches = matches.filter((record) => record.task_id === binding.taskId && record.session_id === binding.sessionId);
    }
    if (matches.length === 0) {
      return {
        citation,
        status: 'snapshot_mismatch' as const,
        note: `snapshot ${citation.snapshot_ref} 不在${binding ? '该任务/会话绑定的' : ''}服务端预取台账内：引用不可解析，需标注而非编造`,
      };
    }
    for (const record of matches) {
      const excluded = record.excluded_objects.find((object) => object.object_id === citation.object_id);
      if (excluded) {
        return {
          citation,
          status: 'not_current_rejected' as const,
          note: `对象 ${citation.object_id} 不可作为现行事实（${excluded.exclusion_reason}），被拒绝引用（PRD 中只能以待确认项列出）`,
        };
      }
      const current = record.current_objects.find((object) => object.object_id === citation.object_id);
      if (current) {
        if (citation.revision !== undefined && citation.revision !== current.revision) {
          return {
            citation,
            status: 'revision_mismatch' as const,
            note: `对象 ${citation.object_id} 引用 revision=${citation.revision} 与台账 revision=${current.revision} 不一致`,
          };
        }
        return { citation, status: 'verified' as const, note: `已核验：${record.system_id}@${record.snapshot_ref} 现行对象` };
      }
    }
    return {
      citation,
      status: 'unknown_object' as const,
      note: `对象 ${citation.object_id} 不在该固定快照的现行对象集中：引用不可解析，需标注而非编造`,
    };
  });
}

/**
 * 制品级引用核验：从固定本地制品文本解析实际引用，与 flow 声明的服务端 refs
 * 做**同一 context/snapshot/object/revision 的双向对照**（W5 二轮收紧）：
 * - 正文令牌畸形 → 失败关闭（不静默忽略）；
 * - 每条正文引用必须命中声明的某条 ref 的同一 system+snapshot 且对象在该 ref
 *   内，revision 与该 ref 的 object_revisions 一致——同任务/会话/系统下台账里
 *   存在另一快照的同名对象也**不允许混搭**；
 * - 声明的每个对象必须以同一 tuple 出现在正文中，否则视为绑定与内容不一致；
 * - 声明 refs 先经台账绑定核验（scope/任务/会话/完整字段），失败即拒绝。
 */
export function verifyArtifactCitations(options: {
  artifactTexts: readonly string[];
  declaredRefs: readonly KnowledgeRef[];
  ledger: KnowledgePrefetchLedger;
  binding: { taskId: string; sessionId: string };
}): { ok: true; citations: KnowledgeCitation[]; checks: CitationCheck[] } | { ok: false; reason: string; citations: KnowledgeCitation[]; checks: CitationCheck[] } {
  const { ledger, binding } = options;
  const citations: KnowledgeCitation[] = [];
  const seen = new Set<string>();
  for (const text of options.artifactTexts) {
    let parsed: KnowledgeCitation[];
    try {
      parsed = extractKnowledgeCitations(text);
    } catch (error) {
      return { ok: false, reason: `制品正文包含畸形的知识引用令牌：${(error as Error).message}`, citations, checks: [] };
    }
    for (const citation of parsed) {
      const key = `${citation.system_id}|${citation.object_id}@${citation.revision}|${citation.snapshot_ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push(citation);
    }
  }

  const refCheck = ledger.verifyReferences(options.declaredRefs, binding);
  if (!refCheck.ok) return { ok: false, reason: refCheck.reason, citations, checks: [] };

  // 正文引用 → 声明 refs 的同一 tuple 绑定（不允许不同快照混搭）。
  for (const citation of citations) {
    const candidates = options.declaredRefs.filter((ref) =>
      ref.system_id === citation.system_id
      && ref.snapshot_ref === citation.snapshot_ref
      && ref.object_ids.includes(citation.object_id));
    if (candidates.length === 0) {
      return {
        ok: false,
        reason: `正文引用 ${citation.system_id}/${citation.object_id}@${citation.snapshot_ref} 未在声明的引用绑定内（快照或对象不匹配），确认被拒绝`,
        citations,
        checks: [],
      };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        reason: `声明的引用中存在多条同 system/snapshot 的记录包含 ${citation.object_id}，正文令牌无法唯一对应，确认被拒绝`,
        citations,
        checks: [],
      };
    }
    const declaredRevision = candidates[0].object_revisions?.[citation.object_id];
    if (declaredRevision !== undefined && citation.revision !== undefined && citation.revision !== declaredRevision) {
      return {
        ok: false,
        reason: `正文引用 ${citation.object_id} 的 revision=${citation.revision} 与声明绑定的 revision=${declaredRevision} 不一致，确认被拒绝`,
        citations,
        checks: [],
      };
    }
  }

  // 声明 refs → 正文覆盖：每个对象都以同一 tuple（含 revision）出现在正文中。
  for (const ref of options.declaredRefs) {
    for (const objectId of ref.object_ids) {
      const declaredRevision = ref.object_revisions?.[objectId];
      const cited = citations.some((citation) =>
        citation.system_id === ref.system_id
        && citation.snapshot_ref === ref.snapshot_ref
        && citation.object_id === objectId
        && (declaredRevision === undefined || citation.revision === undefined || citation.revision === declaredRevision));
      if (!cited) {
        return {
          ok: false,
          reason: `声明的知识引用（${ref.system_id}:${objectId}@${ref.snapshot_ref}）未出现在制品正文中：绑定与实际内容不一致，确认被拒绝`,
          citations,
          checks: [],
        };
      }
    }
  }
  return { ok: true, citations, checks: verifyDeliverableCitations(citations, ledger, binding) };
}
