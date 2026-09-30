import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { readJsonState, writeJsonState } from './json-state.js';
import { z } from 'zod';
import { isTaskOwner, type OperatorIdentity } from './identity.js';
import { assertArtifactStillMatchesApproval } from './artifact-digest.js';
import type { ProductSpecFlow, ProductSpecFlowStore } from './product-spec.js';

/**
 * T-021 首批（W6a）：CodingAuthorization 本地模型与门禁。
 *
 * 边界（work/76）：本批只交付**数据模型与显式授权入口**。T-022 每引擎真实
 * CLI 读写隔离 canary、T-023 进行中任务中断、飞书 U-3、生产事件 outbox/监测
 * 调度、ZCode 模型锁定均未通过——`active` **不接入任何真实开发派发**，只作为
 * 可校验状态存在；`assertAuthorizationUsable` 是模型级使用门禁（编码入口
 * 即时复核摘要），不是执行层写隔离。
 *
 * 状态机：`draft`（首次显式操作创建的授权草稿，须二次确认）→ `active`
 * （二次确认后生效）→ `expired`（超过 expires_at，惰性判定 + sweep 落盘）/
 * `revoked`（owner 显式撤销）；`invalidated`（上游 PRD/架构失效级联）。
 * 一切终态不可复活；非法迁移失败关闭。
 */

export type CodingAuthorizationStatus =
  | 'draft'
  | 'active'
  | 'expired'
  | 'revoked'
  | 'invalidated';

export interface CodingAuthorizationRecord {
  /** ca_<32hex>，服务端生成。 */
  id: string;
  status: CodingAuthorizationStatus;
  /** requester = 被授权制品的 owner（发起人本人；授权入口校验 operator 一致）。 */
  requesterOpenId: string;
  requesterUnionId?: string;
  prdFlowToken: string;
  prdDigest: string;
  architectureFlowToken?: string;
  architectureDigest?: string;
  /** 架构制品绑定的上游 PRD token；架构授权时必须与 prdFlowToken 一致。 */
  architectureUpstreamPrdToken?: string;
  /** realpath 归一化后的工作区绝对路径。 */
  workspaceRealpath: string;
  /** 规范化 workspace 相对 POSIX 路径（'.' = 整个工作区）；realpath 别名已折叠。 */
  allowedPaths: string[];
  /** 二次确认的操作者 open_id（确认前为空）。 */
  grantedBy?: string;
  grantedAt?: string;
  expiresAt: string;
  createdAt: string;
  statusReason?: string;
  /**
   * 允许路径含尚未存在的叶子：现存父链已在授权时核验（realpath 包含），
   * 但叶子创建前无法排除事后符号链接替换——**使用前必须复核**。
   */
  pendingPathRecheck?: boolean;
}

/** 默认有效期 24h；服务端上限 72h（客户端不可自行放大）。 */
export const DEFAULT_AUTHORIZATION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_AUTHORIZATION_TTL_MS = 72 * 60 * 60 * 1000;

const PATH_SEGMENT_LIMIT = 64;
const PATH_TOTAL_LENGTH_LIMIT = 512;

// ---- 路径授权：抗别名 / `..` / 符号链接 / 缺失叶子父链逃逸 -------------------

function normalizeRelativePath(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('允许路径不能为空');
  if (value.length > PATH_TOTAL_LENGTH_LIMIT) throw new Error(`允许路径过长: ${raw}`);
  if (isAbsolute(value) || value.includes('\\') || value.includes('\0') || /^[a-z]:/i.test(value)) {
    throw new Error(`允许路径必须是工作区内的相对路径（拒绝绝对路径/反斜杠/盘符）: ${raw}`);
  }
  const segments = value.split('/');
  if (segments.length > PATH_SEGMENT_LIMIT) throw new Error(`允许路径层级过深: ${raw}`);
  if (segments.some((segment) => segment === '..' || segment === '')) {
    throw new Error(`允许路径不得包含 .. 或空段: ${raw}`);
  }
  const normalized = segments.filter((segment) => segment !== '.').join('/');
  return normalized || '.';
}

/** 路径段感知的包含判断：'.' = 全工作区；'a/b' 覆盖 'a/b/c'，不覆盖 'a/bb'。 */
export function isWithinAllowedPaths(
  allowedPaths: readonly string[],
  candidateRelative: string,
): boolean {
  const candidate = candidateRelative.trim();
  if (!candidate || isAbsolute(candidate) || candidate.includes('\\') || candidate.includes('\0')) {
    return false;
  }
  const segments = candidate.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) return false;
  const normalizedCandidate = segments.filter((segment) => segment !== '.').join('/') || '.';
  return allowedPaths.some((allowed) => {
    const root = normalizeRelativePath(allowed);
    if (root === '.') return true;
    return normalizedCandidate === root || normalizedCandidate.startsWith(`${root}/`);
  });
}

/** workspace realpath 包含检查（段感知 relative，绝不用字符串前缀）。 */
function assertInsideWorkspace(workspaceRealpath: string, absoluteRealpath: string, label: string): string {
  const rel = relative(workspaceRealpath, absoluteRealpath);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} 解析后越出了工作区（realpath ${absoluteRealpath} 不在 ${workspaceRealpath} 内），拒绝授权`);
  }
  return rel.split(sep).join('/') || '.';
}

/**
 * 授权时的允许路径解析：
 * - 工作区必须存在并取 realpath 作为授权根；
 * - 每条路径规范化（拒绝绝对路径/`..`/反斜杠/盘符/空段）；
 * - 已存在部分经 realpath 解析必须仍在工作区内：符号链接指向内部的别名被
 *   **折叠为真实相对路径**授权（不能靠别名绕过范围）；指向外部（含祖先链
 *   中途被替换为外部符号链接）⇒ 拒绝；
 * - 尚不存在的叶子：核验现存最近祖先的 realpath 包含，缺失尾巴拼到真实
 *   祖先之下，并标记 pendingPathRecheck（使用前必须复核）。
 */
export async function resolveAuthorizedPaths(options: {
  workspaceDir: string;
  allowedPaths: readonly string[];
}): Promise<{ workspaceRealpath: string; paths: string[]; pendingRecheck: boolean }> {
  const workspaceRealpath = await realpath(options.workspaceDir).catch(() => {
    throw new Error(`授权工作区不存在或无法解析 realpath: ${options.workspaceDir}`);
  });
  if (options.allowedPaths.length === 0) throw new Error('至少需要一条允许路径');
  const resolved: string[] = [];
  let pendingRecheck = false;
  for (const raw of options.allowedPaths) {
    const normalized = normalizeRelativePath(raw);
    if (normalized === '.') {
      if (!resolved.includes('.')) resolved.push('.');
      continue;
    }
    const candidate = resolve(workspaceRealpath, normalized);
    // 找到最近的**存在**祖先（candidate 自身或其父链），对存在部分做 realpath 核验。
    // 只有明确 ENOENT 才算“尚不存在”：EACCES/ELOOP/EIO 等读取错误一律失败关闭，
    // 不得沿父链上溯把不可核验的路径当“未来叶子”授权（84 号 P1-3）。
    let existing = candidate;
    for (;;) {
      const info = await lstat(existing).catch((error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT') return null;
        throw new Error(`允许路径核验失败（${existing}: ${error?.message ?? '未知读取错误'}），失败关闭`);
      });
      if (info !== null) break;
      const parent = resolve(existing, '..');
      if (parent === existing) break;
      existing = parent;
    }
    const existingReal = await realpath(existing);
    const realRelative = assertInsideWorkspace(workspaceRealpath, existingReal, `允许路径 ${normalized}`);
    let authorizedPath = realRelative;
    if (existing !== candidate) {
      // 叶子（或末端若干级）尚不存在：缺失尾段 = **原始现存祖先 → 原始候选**
      // 的相对路径（94 号 P1-1：不能用真实目标的段数去切原始输入——别名目标
      // 深度与字面深度无必然关系，切错会把授权范围扩大到目标父目录）。
      pendingRecheck = true;
      const missingTail = relative(existing, candidate).split(sep).join('/');
      authorizedPath = realRelative === '.' ? missingTail : `${realRelative}/${missingTail}`;
    }
    if (!resolved.includes(authorizedPath)) resolved.push(authorizedPath);
  }
  if (resolved.length === 0) throw new Error('允许路径解析结果为空');
  if (resolved.includes('.')) return { workspaceRealpath, paths: ['.'], pendingRecheck };
  return { workspaceRealpath, paths: resolved, pendingRecheck };
}

// ---- 持久化 schema -----------------------------------------------------------

const CodingAuthorizationRecordSchema = z.object({
  id: z.string().regex(/^ca_[a-f0-9]{32}$/),
  status: z.enum(['draft', 'active', 'expired', 'revoked', 'invalidated']),
  requesterOpenId: z.string().min(1),
  requesterUnionId: z.string().min(1).optional(),
  prdFlowToken: z.string().min(1).max(128),
  prdDigest: z.string().regex(/^[0-9a-f]{64}$/),
  architectureFlowToken: z.string().min(1).max(128).optional(),
  architectureDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  architectureUpstreamPrdToken: z.string().min(1).max(128).optional(),
  workspaceRealpath: z.string().min(1),
  allowedPaths: z.array(z.string().min(1)).min(1),
  grantedBy: z.string().min(1).optional(),
  grantedAt: z.iso.datetime().optional(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  statusReason: z.string().min(1).max(300).optional(),
  pendingPathRecheck: z.boolean().optional(),
}).strict().superRefine((record, ctx) => {
  // active 必须携带授权人/时间（否则是无法追溯的半成品记录）；draft 必须没有
  // （防绕过二次确认伪造生效痕迹）。违反任一 ⇒ 加载失败关闭（84 号 P1-2）。
  if (record.status === 'active' && (!record.grantedBy || !record.grantedAt)) {
    ctx.addIssue({
      code: 'custom',
      message: 'active 授权缺少授权人/授权时间（半成品或损坏记录），失败关闭',
      path: [record.grantedBy ? 'grantedAt' : 'grantedBy'],
    });
  }
  if (record.status === 'draft' && (record.grantedBy || record.grantedAt)) {
    ctx.addIssue({
      code: 'custom',
      message: 'draft 授权带有授权人/授权时间（绕过二次确认的伪造痕迹），失败关闭',
      path: ['grantedBy'],
    });
  }
});

// ---- store --------------------------------------------------------------------

/**
 * 写入不变量（94 号 P1-2）：所有写入路径（insert/transition/落盘）统一用同一
 * schema 校验——active 必有有效授权人/时间、draft 不得带授权痕迹、字段形状
 * 合法。违反即抛错，且不改变内存/磁盘状态。
 */
function assertRecordValid(record: CodingAuthorizationRecord): void {
  const parsed = CodingAuthorizationRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new Error(`授权记录违反不变量（失败关闭，内存与磁盘均不修改）: ${parsed.error.message}`);
  }
}

export class CodingAuthorizationStore {
  protected readonly records = new Map<string, CodingAuthorizationRecord>();

  constructor(initial: CodingAuthorizationRecord[] = []) {
    for (const record of initial) {
      this.insert(record);
    }
  }

  /** 返回防御性克隆：调用方修改返回值不会影响 store 内部状态。 */
  get(id: string): CodingAuthorizationRecord | undefined {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  /** 返回防御性克隆（同上）。 */
  list(): CodingAuthorizationRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  /** 返回防御性克隆（同上）。 */
  listByUpstreamPrd(prdToken: string): CodingAuthorizationRecord[] {
    return this.list().filter((record) => record.prdFlowToken === prdToken
      || record.architectureUpstreamPrdToken === prdToken);
  }

  insert(record: CodingAuthorizationRecord): void {
    if (this.records.has(record.id)) throw new Error(`授权记录 id 重复: ${record.id}`);
    assertRecordValid(record);
    this.records.set(record.id, structuredClone(record));
  }

  /**
   * 显式迁移边表（84 号 P1-2）：draft→active（二次确认，**必须**由 patch 写入
   * 授权人/时间，缺 patch 即违反不变量而失败关闭）、draft/active→revoked、
   * active→expired（sweep）、draft/active→invalidated（级联）。active→draft
   * 不存在；一切终态不可作为起点；未列出的边一律拒绝。
   * 迁移先在**克隆**上试算并通过不变量校验后才提交（94 号 P1-2：非法迁移
   * 不得修改内存记录）。
   */
  transition(
    id: string,
    from: CodingAuthorizationStatus,
    to: CodingAuthorizationStatus,
    reason?: string,
    patch?: (record: CodingAuthorizationRecord) => void,
  ): CodingAuthorizationRecord | undefined {
    const edge = `${from}>${to}`;
    if (!ALLOWED_TRANSITIONS.has(edge)) return undefined;
    const record = this.records.get(id);
    if (!record || record.status !== from) return undefined;
    const next = structuredClone(record);
    next.status = to;
    if (reason) next.statusReason = reason;
    else delete next.statusReason;
    patch?.(next);
    assertRecordValid(next);
    this.records.set(id, next);
    return structuredClone(next);
  }

  protected snapshot(): CodingAuthorizationRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  protected restore(records: CodingAuthorizationRecord[]): void {
    this.records.clear();
    for (const record of records) this.records.set(record.id, record);
  }
}

const STATE_FILE_VERSION = 1;

/** 合法迁移边（84 号 P1-2）：未列出的边一律拒绝；终态不可作为起点。 */
const ALLOWED_TRANSITIONS: ReadonlySet<string> = new Set([
  'draft>active',
  'draft>revoked',
  'draft>invalidated',
  'active>revoked',
  'active>invalidated',
  'active>expired',
]);

export class JsonCodingAuthorizationStore extends CodingAuthorizationStore {
  constructor(private readonly filePath: string) {
    super(loadRecords(filePath));
  }

  override insert(record: CodingAuthorizationRecord): void {
    this.mutate(() => super.insert(record));
  }

  override transition(
    id: string,
    from: CodingAuthorizationStatus,
    to: CodingAuthorizationStatus,
    reason?: string,
    patch?: (record: CodingAuthorizationRecord) => void,
  ): CodingAuthorizationRecord | undefined {
    return this.mutate(() => super.transition(id, from, to, reason, patch));
  }

  private mutate<T>(operation: () => T): T {
    const previous = this.snapshot();
    try {
      const result = operation();
      // 落盘前统一再校验（94 号 P1-2）：任何写入路径都不允许把违反不变量的
      // 记录写到磁盘。
      for (const record of this.snapshot()) assertRecordValid(record);
      writeJsonState(this.filePath, { _v: STATE_FILE_VERSION, records: this.snapshot() });
      return result;
    } catch (error) {
      this.restore(previous);
      throw error;
    }
  }
}

function loadRecords(filePath: string): CodingAuthorizationRecord[] {
  const state = readJsonState(filePath);
  if (state === undefined) return [];
  const parsed = z.object({
    _v: z.literal(STATE_FILE_VERSION),
    records: z.array(z.unknown()),
  }).parse(state);
  return parsed.records.map((row) => {
    const result = CodingAuthorizationRecordSchema.safeParse(row);
    if (!result.success) {
      throw new Error(`编码授权状态记录无效（失败关闭）: ${filePath}: ${result.error.message}`);
    }
    return result.data;
  });
}

// ---- 服务：显式授权入口（模型级门禁，不接真实派发） ---------------------------

export interface AuthorizationDraftInput {
  /** 可信卡片载荷中的 flowToken（PRD 或架构制品）。 */
  flowToken: string;
  /**
   * 相对工作区的允许路径（服务端校验）。**必须显式提供**：卡片未携带路径时
   * 授权入口失败关闭并提示（84 号 P1-4）——不得静默默认整个工作区。
   */
  allowedPaths?: string[];
  ttlMs?: number;
}

function isApprovedWithDigest(flow: ProductSpecFlow): boolean {
  return flow.status === 'approved' && flow.content_digest != null;
}

function sameRequester(record: Pick<CodingAuthorizationRecord, 'requesterOpenId' | 'requesterUnionId'>, operator: OperatorIdentity): boolean {
  return isTaskOwner(
    { ownerOpenId: record.requesterOpenId, ownerUnionId: record.requesterUnionId },
    operator,
  );
}

/**
 * 第一次显式操作：创建授权**草稿**（展示完整内容后需第二次确认才 active）。
 * 服务端核对：operator = 制品 owner；PRD/架构已批准且摘要绑定；架构上游与
 * PRD 版本一致；批准后制品未漂移（完整回读重算）；工作区 realpath 与允许
 * 路径合法。任何一步失败即拒绝，不产生草稿。
 */
export async function createCodingAuthorizationDraft(options: {
  store: Pick<CodingAuthorizationStore, 'insert'>;
  flows: ProductSpecFlowStore;
  operator: OperatorIdentity;
  input: AuthorizationDraftInput;
  resolveWorkspaceDir: (sessionId: string) => string | undefined;
  now?: () => Date;
}): Promise<CodingAuthorizationRecord> {
  const now = (options.now ?? (() => new Date()))();
  const flow = options.flows.get(options.input.flowToken);
  if (!flow) throw new Error('找不到对应的制品，无法创建授权草稿。');
  if (!isTaskOwner(flow, options.operator)) {
    throw new Error('只有任务发起人可以创建编码授权。');
  }

  let prd: ProductSpecFlow = flow;
  let architecture: ProductSpecFlow | undefined;
  if ((flow.artifact_kind ?? 'prd') === 'architecture') {
    architecture = flow;
    const upstream = architecture.upstream
      ? options.flows.get(architecture.upstream.prdToken)
      : undefined;
    if (!upstream) throw new Error('架构设计的上游产品方案已不存在，不能授权。');
    if (architecture.upstream!.prdDigest !== upstream.content_digest) {
      throw new Error('架构上游与产品方案版本不一致，不能授权。');
    }
    prd = upstream;
  }
  if (!isApprovedWithDigest(prd)) throw new Error('产品方案尚未确认或没有绑定内容摘要，不能授权编码。');
  if (architecture && !isApprovedWithDigest(architecture)) {
    throw new Error('架构设计尚未确认或没有绑定内容摘要，不能授权编码。');
  }

  // 批准后漂移即时复核（S-03：授权前回读完整制品）。
  await assertArtifactUnchanged(options, prd, '产品方案');
  if (architecture) await assertArtifactUnchanged(options, architecture, '架构设计');

  // 工作区：优先架构（开发会话）工作区，否则 PRD 会话工作区；必须可 realpath。
  const workspaceDir = options.resolveWorkspaceDir(
    architecture ? architecture.sessionId : prd.sessionId,
  );
  if (!workspaceDir) throw new Error('找不到制品对应的会话工作区，无法创建授权草稿。');
  if (!options.input.allowedPaths || options.input.allowedPaths.length === 0) {
    throw new Error('未选择允许路径：授权必须显式限定写入范围（当前卡片暂无路径选择输入，请在指令中提供允许路径后重试），不能默认整个工作区。');
  }
  const allowed = await resolveAuthorizedPaths({
    workspaceDir,
    allowedPaths: options.input.allowedPaths,
  });

  const ttl = Math.min(
    Math.max(1, options.input.ttlMs ?? DEFAULT_AUTHORIZATION_TTL_MS),
    MAX_AUTHORIZATION_TTL_MS,
  );
  const record: CodingAuthorizationRecord = {
    id: `ca_${randomUUID().replaceAll('-', '')}`,
    status: 'draft',
    requesterOpenId: flow.ownerOpenId,
    ...(flow.ownerUnionId ? { requesterUnionId: flow.ownerUnionId } : {}),
    prdFlowToken: prd.token,
    prdDigest: prd.content_digest!,
    ...(architecture ? {
      architectureFlowToken: architecture.token,
      architectureDigest: architecture.content_digest!,
      architectureUpstreamPrdToken: architecture.upstream!.prdToken,
    } : {}),
    workspaceRealpath: allowed.workspaceRealpath,
    allowedPaths: allowed.paths,
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
    createdAt: now.toISOString(),
    ...(allowed.pendingRecheck ? { pendingPathRecheck: true } : {}),
  };
  options.store.insert(record);
  return record;
}

/**
 * 第二次明确确认：draft → active。仅制品 owner 本人；非 draft/重复确认失败
 * 关闭；确认时**重新**核对上游状态、摘要漂移、工作区 realpath 与允许路径。
 */
export async function confirmCodingAuthorization(options: {
  store: CodingAuthorizationStore;
  flows: ProductSpecFlowStore;
  operator: OperatorIdentity;
  authorizationId: string;
  resolveWorkspaceDir: (sessionId: string) => string | undefined;
  now?: () => Date;
}): Promise<CodingAuthorizationRecord> {
  const now = (options.now ?? (() => new Date()))();
  const record = options.store.get(options.authorizationId);
  if (!record) throw new Error('找不到这份编码授权。');
  if (!sameRequester(record, options.operator)) {
    throw new Error('只有被授权制品的发起人可以确认编码授权。');
  }
  if (record.status !== 'draft') {
    throw new Error(`这份编码授权已处于 ${record.status} 状态，不能再次确认。`);
  }
  if (now.getTime() >= Date.parse(record.expiresAt)) {
    throw new Error('授权草稿已超过有效期，需重新发起。');
  }
  const { prd, architecture } = resolveBoundFlows(options.flows, record);
  // 绑定一致性（84 号 P1-1）：确认的必须仍是**草稿绑定的那一次审批版本**——
  // 当前 PRD 摘要 ≠ 草稿 prdDigest（重新审批为新版本）即拒绝，即使磁盘文件
  // 与新摘要一致也不得确认旧草稿。
  if (!prd || !isApprovedWithDigest(prd) || prd.content_digest !== record.prdDigest) {
    throw new Error('上游产品方案已重新审批或版本变化，与授权草稿绑定不一致，不能确认。');
  }
  if (record.architectureFlowToken && !architecture) {
    throw new Error('架构设计记录已不存在，不能确认授权。');
  }
  if (architecture) {
    if (!isApprovedWithDigest(architecture)) throw new Error('架构设计已失效或版本变化，不能确认授权。');
    if (architecture.upstream?.prdToken !== prd.token
      || architecture.upstream.prdDigest !== record.prdDigest
      || architecture.content_digest !== record.architectureDigest) {
      throw new Error('架构与上游产品方案版本不一致（或与授权草稿绑定不符），不能确认授权。');
    }
    await assertArtifactUnchanged(options, architecture, '架构设计');
  }
  await assertArtifactUnchanged(options, prd, '产品方案');
  // 工作区与允许路径复核：realpath 必须与草稿一致（工作区被移动/替换即拒绝）；
  // 允许路径重新解析（含父链符号链接替换检测，84 号 P1-3）。
  const workspaceDir = options.resolveWorkspaceDir(
    (architecture ?? prd).sessionId,
  );
  if (!workspaceDir) throw new Error('找不到会话工作区，不能确认授权。');
  const recheck = await resolveAuthorizedPaths({ workspaceDir, allowedPaths: record.allowedPaths });
  if (recheck.workspaceRealpath !== record.workspaceRealpath) {
    throw new Error('工作区真实路径与授权草稿不一致（可能被移动或替换），不能确认。');
  }
  if (recheck.paths.length !== record.allowedPaths.length
    || [...recheck.paths].sort().join('\0') !== [...record.allowedPaths].sort().join('\0')) {
    throw new Error('允许路径解析结果与授权草稿不一致（可能被替换为别名或符号链接），不能确认。');
  }
  // 状态与授权人/时间在**同一次原子持久化**中提交（84 号 P1-2）：不存在
  // “active 但无授权人”的落盘窗口。
  const confirmed = options.store.transition(
    options.authorizationId,
    'draft',
    'active',
    undefined,
    (current) => {
      current.grantedBy = options.operator.operatorOpenId;
      current.grantedAt = now.toISOString();
      if (recheck.pendingRecheck) current.pendingPathRecheck = true;
      else delete current.pendingPathRecheck;
    },
  );
  if (!confirmed) throw new Error('授权状态已变化，确认失败。');
  return options.store.get(options.authorizationId)!;
}

/** owner 显式撤销（draft/active 可撤销；终态失败关闭）。 */
export function revokeCodingAuthorization(options: {
  store: CodingAuthorizationStore;
  operator: OperatorIdentity;
  authorizationId: string;
  reason?: string;
}): CodingAuthorizationRecord {
  const record = options.store.get(options.authorizationId);
  if (!record) throw new Error('找不到这份编码授权。');
  if (!sameRequester(record, options.operator)) {
    throw new Error('只有被授权制品的发起人可以撤销编码授权。');
  }
  if (record.status !== 'draft' && record.status !== 'active') {
    throw new Error(`这份编码授权已处于 ${record.status} 状态，无需撤销。`);
  }
  const revoked = options.store.transition(
    options.authorizationId,
    record.status,
    'revoked',
    options.reason ?? '发起人撤销',
  );
  if (!revoked) throw new Error('授权状态已变化，撤销失败。');
  return revoked;
}

/** 惰性过期：active 且已过 expires_at ⇒ 有效状态为 expired（不落盘）。 */
export function effectiveStatus(
  record: CodingAuthorizationRecord,
  now: Date = new Date(),
): CodingAuthorizationStatus {
  if (record.status === 'active' && now.getTime() >= Date.parse(record.expiresAt)) {
    return 'expired';
  }
  return record.status;
}

/** 把已到期的 active 落盘为 expired；返回迁移数量。 */
export function sweepExpirations(options: {
  store: CodingAuthorizationStore;
  now?: () => Date;
}): number {
  const now = (options.now ?? (() => new Date()))();
  let swept = 0;
  for (const record of options.store.list()) {
    if (record.status === 'active' && effectiveStatus(record, now) === 'expired') {
      if (options.store.transition(record.id, 'active', 'expired', '超过有效期')) swept += 1;
    }
  }
  return swept;
}

/**
 * 上游失效级联：PRD（或架构，按其上游 PRD）invalidated ⇒ 绑定它的 draft/active
 * 授权全部 invalidated。返回级联数量。生产接线经 ArtifactMonitor 的
 * onInvalidated 钩子（app 层适配）；本批只交付模型与 fixture 验证。
 */
export function invalidateAuthorizationsForPrd(options: {
  store: CodingAuthorizationStore;
  prdToken: string;
  reason: string;
}): number {
  let invalidated = 0;
  for (const record of options.store.listByUpstreamPrd(options.prdToken)) {
    if (record.status !== 'draft' && record.status !== 'active') continue;
    if (options.store.transition(record.id, record.status, 'invalidated', options.reason)) {
      invalidated += 1;
    }
  }
  return invalidated;
}

/**
 * 模型级使用门禁（每次编码启动前复核）：授权有效状态为 active、上游 PRD/
 * 架构仍已批准且版本摘要一致、制品文件未漂移、工作区 realpath 一致。任何
 * 一步失败抛错。**这不是执行层写隔离**——T-022 canary 通过前，active 授权
 * 不接入真实开发派发。
 */
export async function assertAuthorizationUsable(options: {
  store: Pick<CodingAuthorizationStore, 'get'>;
  flows: ProductSpecFlowStore;
  authorizationId: string;
  resolveWorkspaceDir: (sessionId: string) => string | undefined;
  now?: () => Date;
  /**
   * 149 号 P1-2 测试钩子：在全部异步核验完成之后、末次 CAS 复检之前挂起，
   * 用于注入「G3 进行中撤销/到期/改授权范围」的竞态。仅测试注入使用。
   */
  pauseBeforeFinalRecheck?: () => Promise<void>;
}): Promise<CodingAuthorizationRecord> {
  const now = (options.now ?? (() => new Date()))();
  const record = options.store.get(options.authorizationId);
  if (!record) throw new Error('编码授权不存在。');
  const status = effectiveStatus(record, now);
  if (status !== 'active') {
    throw new Error(`编码授权不可用（状态 ${status}${record.statusReason ? `：${record.statusReason}` : ''}）。`);
  }
  // 防御性兜底（94 号 P1-2）：active 却缺二次确认元数据 ⇒ 视为无效，不可用。
  if (!record.grantedBy || !record.grantedAt) {
    throw new Error('active 授权缺少二次确认元数据（授权人/时间），视为无效。');
  }
  // 138 号 P0-1：active 也不能带待复核路径——缺失叶子授权范围未经服务端
  // 重新核验前一律阻断（不能把「未来才复核」当「现在可用」）。
  if (record.pendingPathRecheck) {
    throw new Error('active 授权仍含待复核（pendingPathRecheck）允许路径，编码使用被阻断：需服务端可信地重新授权并复核路径后才可用。');
  }
  const { prd, architecture } = resolveBoundFlows(options.flows, record);
  if (!prd || !isApprovedWithDigest(prd) || prd.content_digest !== record.prdDigest) {
    throw new Error('上游产品方案已失效或版本变化，授权不可用。');
  }
  if (record.architectureFlowToken) {
    if (!architecture
      || !isApprovedWithDigest(architecture)
      || architecture.content_digest !== record.architectureDigest
      || architecture.upstream?.prdToken !== record.prdFlowToken) {
      throw new Error('架构设计已失效或版本绑定不一致，授权不可用。');
    }
    await assertArtifactUnchanged(options, architecture, '架构设计');
  }
  await assertArtifactUnchanged(options, prd, '产品方案');
  const workspaceDir = options.resolveWorkspaceDir((architecture ?? prd).sessionId);
  if (!workspaceDir) throw new Error('找不到会话工作区，授权不可用。');
  const workspaceRealpath = await realpath(workspaceDir).catch(() => {
    throw new Error('授权工作区无法解析 realpath，授权不可用。');
  });
  if (workspaceRealpath !== record.workspaceRealpath) {
    throw new Error('工作区真实路径与授权绑定不一致，授权不可用。');
  }
  // 允许路径复核（84 号 P1-3，报告承诺的“使用前复核”）：逐条重新解析并比对
  // 规范路径集合——路径被替换为根外符号链接（解析抛错）或折叠别名变化
  // （集合不一致）都拒绝；仍缺失的叶子允许保留待复核标志，不忽略后续替换。
  const pathsRecheck = await resolveAuthorizedPaths({
    workspaceDir,
    allowedPaths: record.allowedPaths,
  }).catch((error: Error) => {
    throw new Error(`允许路径复核失败，授权不可用：${error.message}`);
  });
  if (pathsRecheck.paths.length !== record.allowedPaths.length
    || [...pathsRecheck.paths].sort().join('\0') !== [...record.allowedPaths].sort().join('\0')) {
    throw new Error('允许路径与授权绑定不一致（可能被替换为别名或符号链接），授权不可用。');
  }
  // 末次 CAS 复检（149 号 P1-2）：以上多次 await 期间记录可能被撤销/置失效/
  // 到期/改授权范围——旧快照不得放行。测试可经 pauseBeforeFinalRecheck 注入
  // 竞态；此处重新取**当前**记录并逐项比对，返回的也是这份最终核定的记录。
  if (options.pauseBeforeFinalRecheck) {
    await options.pauseBeforeFinalRecheck();
  }
  const finalNow = (options.now ?? (() => new Date()))();
  const fresh = options.store.get(options.authorizationId);
  if (!fresh) throw new Error('编码授权在核验期间被删除，末次复检失败关闭。');
  const freshStatus = effectiveStatus(fresh, finalNow);
  if (freshStatus !== 'active') {
    throw new Error(`编码授权在核验期间变为不可用（状态 ${freshStatus}${fresh.statusReason ? `：${fresh.statusReason}` : ''}），末次复检失败关闭。`);
  }
  if (!fresh.grantedBy || !fresh.grantedAt) {
    throw new Error('active 授权缺少二次确认元数据，末次复检失败关闭。');
  }
  if (fresh.pendingPathRecheck) {
    throw new Error('active 授权仍含待复核允许路径，末次复检失败关闭。');
  }
  if (fresh.workspaceRealpath !== record.workspaceRealpath
    || fresh.prdFlowToken !== record.prdFlowToken
    || fresh.prdDigest !== record.prdDigest
    || fresh.architectureFlowToken !== record.architectureFlowToken
    || fresh.architectureDigest !== record.architectureDigest
    || fresh.allowedPaths.length !== record.allowedPaths.length
    || [...fresh.allowedPaths].sort().join('\0') !== [...record.allowedPaths].sort().join('\0')) {
    throw new Error('编码授权在核验期间被修改（授权范围/上游/工作区变化），末次复检失败关闭。');
  }
  return fresh;
}

// ---- 内部辅助 -----------------------------------------------------------------

function resolveBoundFlows(
  flows: ProductSpecFlowStore,
  record: Pick<CodingAuthorizationRecord, 'prdFlowToken' | 'architectureFlowToken'>,
): { prd?: ProductSpecFlow; architecture?: ProductSpecFlow } {
  const architecture = record.architectureFlowToken
    ? flows.get(record.architectureFlowToken)
    : undefined;
  const prd = flows.get(record.prdFlowToken);
  return { prd, architecture };
}

async function assertArtifactUnchanged(
  options: { resolveWorkspaceDir: (sessionId: string) => string | undefined },
  flow: ProductSpecFlow,
  label: string,
): Promise<void> {
  const workspaceDir = options.resolveWorkspaceDir(flow.sessionId);
  if (!workspaceDir) throw new Error(`找不到${label}的会话工作区，无法复核摘要。`);
  await assertArtifactStillMatchesApproval({
    flow: {
      status: flow.status,
      content_digest: flow.content_digest,
      request: flow.request,
      artifact_kind: flow.artifact_kind,
    },
    workspaceDir,
  });
}
