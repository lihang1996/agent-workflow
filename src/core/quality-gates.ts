import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { PipelineStepId } from './pipeline.js';
import { hashPathArtifact } from './project-snapshot.js';

export const QualityPolicySchema = z.enum(['legacy', 'gated']);
export type QualityPolicy = z.infer<typeof QualityPolicySchema>;

export const GateIdSchema = z.enum([
  'design',
  'implementation',
  'change-review',
  'verification',
  'runtime-audit',
  'final-review',
]);
export type GateId = z.infer<typeof GateIdSchema>;

export const GateStatusSchema = z.enum(['pass', 'fail', 'warning', 'unverified', 'blocked', 'not-applicable']);
export type GateStatus = z.infer<typeof GateStatusSchema>;

export const GateFindingStatusSchema = z.enum(['open', 'planned', 'resolved', 'waived']);
export type GateFindingStatus = z.infer<typeof GateFindingStatusSchema>;
export const GateCheckStatusSchema = z.enum(['pass', 'fail', 'blocked', 'unverified', 'skipped']);
export type GateCheckStatus = z.infer<typeof GateCheckStatusSchema>;

/**
 * 命令数组的单个元素（argv 的一项）允许的最大字符数。
 * Codex/Claude 常用 `/bin/zsh -lc "CHECK_START=... node -e '...'"` 格式，
 * 内联脚本动辄 3000-5000 字符；2000 太紧导致整条流水线中断。
 * 10000 足够覆盖绝大多数内联脚本，同时仍能防止失控输出。
 */
const MAX_COMMAND_PART_CHARS = 10_000;

/**
 * LLM 输出兼容层：把 GATE_RESULT / change-plan 常见别名与错误形状归一化。
 * 目标是挡住低级格式问题（字符串当数组、INFO severity、accepted status 等），
 * 不放行真正缺失的关键字段或未识别的危险取值。
 */
const DISPOSITION_TO_STATUS: Record<string, GateFindingStatus> = {
  open: 'open',
  planned: 'planned',
  'planned-fix': 'planned',
  'fix-planned': 'planned',
  'to-fix': 'planned',
  resolved: 'resolved',
  fixed: 'resolved',
  done: 'resolved',
  closed: 'resolved',
  mitigated: 'resolved',
  // 接受残余风险不是“已解决”；必须走显式 waiver 并接受完整性校验。
  accepted: 'waived',
  'accepted-residual': 'waived',
  residual: 'waived',
  acknowledged: 'waived',
  informational: 'resolved',
  waived: 'waived',
  'wont-fix': 'waived',
  wontfix: 'waived',
  'not-a-bug': 'waived',
};

const SEVERITY_ALIASES: Record<string, 'P0' | 'P1' | 'P2' | 'P3'> = {
  p0: 'P0',
  p1: 'P1',
  p2: 'P2',
  p3: 'P3',
  info: 'P3',
  information: 'P3',
  informational: 'P3',
  note: 'P3',
  none: 'P3',
  low: 'P3',
  medium: 'P2',
  med: 'P2',
  high: 'P1',
  critical: 'P0',
  blocker: 'P0',
  '严重': 'P0',
  '高': 'P1',
  '中': 'P2',
  '低': 'P3',
};

/** 与 skills/_shared/finding-fields.mjs 保持同步；未知标签仍 fail closed。 */
export const GATE_FINDING_CATEGORIES = [
  'correctness',
  'security',
  'reliability',
  'architecture',
  'performance',
  'maintainability',
  'testing',
  'compatibility',
  'scope',
  'other',
] as const;
export type GateFindingCategory = (typeof GATE_FINDING_CATEGORIES)[number];

export const GATE_FINDING_EXPLOITABILITIES = [
  'not-applicable',
  'unreachable',
  'conditional',
  'reachable',
  'unverified',
] as const;
export type GateFindingExploitability = (typeof GATE_FINDING_EXPLOITABILITIES)[number];

const CATEGORY_ALIASES: Record<string, GateFindingCategory> = {
  correctness: 'correctness',
  bug: 'correctness',
  bugs: 'correctness',
  defect: 'correctness',
  functional: 'correctness',
  logic: 'correctness',
  security: 'security',
  secure: 'security',
  vuln: 'security',
  vulnerability: 'security',
  vulnerabilities: 'security',
  auth: 'security',
  authz: 'security',
  xss: 'security',
  csrf: 'security',
  reliability: 'reliability',
  reliable: 'reliability',
  stability: 'reliability',
  resilience: 'reliability',
  availability: 'reliability',
  'test-reliability': 'testing',
  flaky: 'testing',
  flake: 'testing',
  architecture: 'architecture',
  arch: 'architecture',
  design: 'architecture',
  solid: 'architecture',
  performance: 'performance',
  perf: 'performance',
  latency: 'performance',
  maintainability: 'maintainability',
  maintainable: 'maintainability',
  readability: 'maintainability',
  docs: 'maintainability',
  documentation: 'maintainability',
  'documentation-accuracy': 'maintainability',
  'doc-accuracy': 'maintainability',
  testing: 'testing',
  test: 'testing',
  tests: 'testing',
  e2e: 'testing',
  qa: 'testing',
  coverage: 'testing',
  compatibility: 'compatibility',
  compat: 'compatibility',
  browser: 'compatibility',
  a11y: 'compatibility',
  accessibility: 'compatibility',
  scope: 'scope',
  'out-of-scope': 'scope',
  other: 'other',
  misc: 'other',
  ux: 'other',
  ui: 'other',
  dx: 'other',
};

const CONFIDENCE_ALIASES: Record<string, 'low' | 'medium' | 'high'> = {
  low: 'low',
  l: 'low',
  medium: 'medium',
  med: 'medium',
  m: 'medium',
  high: 'high',
  h: 'high',
};

const EXPLOITABILITY_ALIASES: Record<string, GateFindingExploitability> = {
  'not-applicable': 'not-applicable',
  na: 'not-applicable',
  'n/a': 'not-applicable',
  none: 'not-applicable',
  unreachable: 'unreachable',
  conditional: 'conditional',
  reachable: 'reachable',
  unverified: 'unverified',
  unknown: 'unverified',
};

function normalizeFindingCategory(value: unknown): GateFindingCategory | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim().toLowerCase();
  if (!key) return undefined;
  if ((GATE_FINDING_CATEGORIES as readonly string[]).includes(key)) {
    return key as GateFindingCategory;
  }
  return CATEGORY_ALIASES[key];
}

function normalizeFindingConfidence(value: unknown): 'low' | 'medium' | 'high' | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim().toLowerCase();
  if (!key) return undefined;
  if (key === 'low' || key === 'medium' || key === 'high') return key;
  return CONFIDENCE_ALIASES[key];
}

function normalizeFindingExploitability(value: unknown): GateFindingExploitability | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim().toLowerCase();
  if (!key) return undefined;
  if ((GATE_FINDING_EXPLOITABILITIES as readonly string[]).includes(key)) {
    return key as GateFindingExploitability;
  }
  return EXPLOITABILITY_ALIASES[key];
}

function asStringList(value: unknown, maxItemLength: number): string[] | unknown {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item.trim().slice(0, maxItemLength);
      if (item == null) return '';
      return String(item).trim().slice(0, maxItemLength);
    }).filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    // 常见写法：单条证据，或用分号/换行拼多条
    const parts = trimmed.split(/\n+|;\s+/).map((part) => part.trim()).filter(Boolean);
    return (parts.length > 0 ? parts : [trimmed]).map((part) => part.slice(0, maxItemLength));
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value).slice(0, maxItemLength)];
  }
  return value;
}

function normalizeSeverity(value: unknown): 'P0' | 'P1' | 'P2' | 'P3' | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3) {
    return (`P${value}` as 'P0' | 'P1' | 'P2' | 'P3');
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const upper = trimmed.toUpperCase();
  if (upper === 'P0' || upper === 'P1' || upper === 'P2' || upper === 'P3') return upper;
  const prefixed = upper.match(/^P([0-3])\b/);
  if (prefixed) return (`P${prefixed[1]}` as 'P0' | 'P1' | 'P2' | 'P3');
  return SEVERITY_ALIASES[trimmed.toLowerCase()] ?? SEVERITY_ALIASES[trimmed];
}

function normalizeFindingStatus(value: unknown): GateFindingStatus | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === 'open' || trimmed === 'planned' || trimmed === 'resolved' || trimmed === 'waived') {
    return trimmed;
  }
  return DISPOSITION_TO_STATUS[trimmed];
}

function normalizeExpiresAt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  // 风险接受期限必须带显式时区。禁止把纯日期或本地时间悄悄解释为 UTC，
  // 否则会在不同时区把 waiver 延长或缩短数小时。
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(trimmed)) return undefined;

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

type WaiverRecord = {
  owner: string;
  reason: string;
  expiresAt: string;
  scope?: string;
  compensatingControl?: string;
  approvedAt?: string;
  approvalEvidence?: string;
};
type WaiverIndex = Map<string, WaiverRecord>;

/** 从 artifact / GATE_RESULT 顶层 waivers[] 建立索引（支持 findingId / id / waiverId）。 */
function buildWaiverIndex(source: unknown): WaiverIndex {
  const index: WaiverIndex = new Map();
  if (!Array.isArray(source)) return index;
  for (const item of source) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const owner = typeof raw.owner === 'string' ? raw.owner.trim() : '';
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
    const expiresAt = normalizeExpiresAt(raw.expiresAt ?? raw.expires ?? raw.expireAt);
    if (!owner || !reason || !expiresAt) continue;
    const record: WaiverRecord = {
      owner,
      reason,
      expiresAt,
      ...(typeof raw.scope === 'string' && raw.scope.trim() ? { scope: raw.scope.trim() } : {}),
      ...(typeof raw.compensatingControl === 'string' && raw.compensatingControl.trim()
        ? { compensatingControl: raw.compensatingControl.trim() }
        : {}),
      ...(typeof raw.approvedAt === 'string' && normalizeExpiresAt(raw.approvedAt)
        ? { approvedAt: normalizeExpiresAt(raw.approvedAt)! }
        : {}),
      ...(typeof raw.approvalEvidence === 'string' && raw.approvalEvidence.trim()
        ? { approvalEvidence: raw.approvalEvidence.trim() }
        : {}),
    };
    for (const key of [raw.findingId, raw.id, raw.waiverId]) {
      if (typeof key === 'string' && key.trim()) index.set(key.trim(), record);
    }
  }
  return index;
}

function resolveWaiverForFinding(
  finding: Record<string, unknown>,
  waiverIndex?: WaiverIndex,
): WaiverRecord | undefined {
  const embedded = finding.waiver;
  if (embedded && typeof embedded === 'object' && !Array.isArray(embedded)) {
    const values = embedded as Record<string, unknown>;
    const owner = typeof values.owner === 'string' ? values.owner.trim() : '';
    const reason = typeof values.reason === 'string' ? values.reason.trim() : '';
    const expiresAt = normalizeExpiresAt(values.expiresAt ?? values.expires ?? values.expireAt);
    if (owner && reason && expiresAt) {
      return {
        owner,
        reason,
        expiresAt,
        ...(typeof values.scope === 'string' && values.scope.trim() ? { scope: values.scope.trim() } : {}),
        ...(typeof values.compensatingControl === 'string' && values.compensatingControl.trim()
          ? { compensatingControl: values.compensatingControl.trim() }
          : {}),
        ...(typeof values.approvedAt === 'string' && normalizeExpiresAt(values.approvedAt)
          ? { approvedAt: normalizeExpiresAt(values.approvedAt)! }
          : {}),
        ...(typeof values.approvalEvidence === 'string' && values.approvalEvidence.trim()
          ? { approvalEvidence: values.approvalEvidence.trim() }
          : {}),
      };
    }
  }

  const waiverId = typeof finding.waiverId === 'string' ? finding.waiverId.trim()
    : typeof finding.waiverRef === 'string' ? finding.waiverRef.trim()
      : typeof finding.waiver_id === 'string' ? finding.waiver_id.trim()
        : '';
  const candidates: string[] = [];
  if (waiverId) candidates.push(waiverId);
  if (typeof finding.id === 'string' && finding.id.trim()) {
    const id = finding.id.trim();
    candidates.push(id);
    const match = id.match(/^FIND-(.+)$/i);
    if (match) candidates.push(`WAIVER-${match[1]}`);
  }
  if (!waiverIndex) return undefined;
  for (const key of candidates) {
    const hit = waiverIndex.get(key);
    if (hit) return hit;
  }
  return undefined;
}

function normalizeFindingInput(
  input: unknown,
  waiverIndex?: WaiverIndex,
): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const raw = { ...(input as Record<string, unknown>) };

  if (typeof raw.summary !== 'string' || !raw.summary.trim()) {
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const detail = typeof raw.detail === 'string' ? raw.detail.trim() : '';
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    const combined = [title, detail || description].filter(Boolean).join(' — ');
    if (combined) raw.summary = combined.slice(0, 4_000);
  }

  const severitySource = raw.severity ?? raw.priority ?? raw.level;
  const severity = normalizeSeverity(severitySource);
  const severityWasInformational = typeof severitySource === 'string'
    && /^(info|information|informational|note|none)$/i.test(severitySource.trim());
  if (severity) raw.severity = severity;

  const statusFromField = normalizeFindingStatus(raw.status);
  const statusFromDisposition = normalizeFindingStatus(raw.disposition);
  if (statusFromField) raw.status = statusFromField;
  else if (statusFromDisposition) raw.status = statusFromDisposition;
  else if (severityWasInformational) raw.status = 'resolved';

  // LLM 常写 status=waived + waiverId，完整条款在顶层 waivers[]。
  // 只允许从真实 registry 补全；缺失时保持 waived 并让 schema fail closed。
  // 严禁编造 owner/期限，或把风险静默改成 resolved。
  if (raw.status === 'waived') {
    const resolved = resolveWaiverForFinding(raw, waiverIndex);
    if (resolved) raw.waiver = resolved;
  }

  const evidence = asStringList(raw.evidence ?? raw.evidences ?? raw.refs ?? raw.locations, 2_000);
  if (Array.isArray(evidence)) raw.evidence = evidence;

  if (typeof raw.confidence === 'string') {
    const confidence = normalizeFindingConfidence(raw.confidence);
    if (confidence) raw.confidence = confidence;
    else raw.confidence = raw.confidence.trim().toLowerCase();
  }
  if (typeof raw.category === 'string') {
    const category = normalizeFindingCategory(raw.category);
    if (category) raw.category = category;
    else raw.category = raw.category.trim().toLowerCase();
  }
  if (typeof raw.exploitability === 'string') {
    const exploitability = normalizeFindingExploitability(raw.exploitability);
    if (exploitability) raw.exploitability = exploitability;
    else raw.exploitability = raw.exploitability.trim().toLowerCase();
  }

  return raw;
}

function normalizeFindingsWithRegistry(findings: unknown, waivers: unknown): unknown[] {
  const index = buildWaiverIndex(waivers);
  const list = Array.isArray(findings) ? findings : findings == null ? [] : [findings];
  return list.map((item) => normalizeFindingInput(item, index));
}

function normalizeCheckInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const raw = { ...(input as Record<string, unknown>) };
  // 命令字符串无法可靠保留 shell quoting，不能作为可复现 argv 证据。
  if (Array.isArray(raw.command)) {
    // P 修复：Codex/Claude 经常生成长内联脚本命令（/bin/zsh -lc "CHECK_START=... node -e '...'")
    // 超过旧 2000 字符限制导致整条流水线中断。这里先截断到 MAX_COMMAND_PART_CHARS，
    // 再由 schema 校验通过；截断的命令仍然保留了可复现性主体（命令名、关键参数）。
    raw.command = raw.command
      .map((part) => {
        const s = String(part).trim();
        if (s.length > MAX_COMMAND_PART_CHARS) {
          console.warn(
            `[门禁] check command 元素超过 ${MAX_COMMAND_PART_CHARS} 字符，已截断（原长 ${s.length}）。建议将长脚本写入临时文件。`,
          );
          return s.slice(0, MAX_COMMAND_PART_CHARS);
        }
        return s;
      })
      .filter((s) => s.length > 0)
      .slice(0, 100);
  }
  if (typeof raw.exitCode === 'string' && /^-?\d+$/.test(raw.exitCode.trim())) {
    raw.exitCode = Number(raw.exitCode.trim());
  }
  if (typeof raw.durationMs === 'string' && /^\d+$/.test(raw.durationMs.trim())) {
    raw.durationMs = Number(raw.durationMs.trim());
  }
  if (typeof raw.required === 'string') {
    if (/^true$/i.test(raw.required.trim())) raw.required = true;
    else if (/^false$/i.test(raw.required.trim())) raw.required = false;
  }
  if (typeof raw.delegatedTo === 'string') {
    raw.delegatedTo = raw.delegatedTo.trim().toLowerCase();
  }
  if (typeof raw.status === 'string') {
    const status = raw.status.trim().toLowerCase();
    raw.status = status === 'success' ? 'pass' : status === 'error' ? 'fail' : status;
  } else if (typeof raw.exitCode === 'number') {
    raw.status = raw.exitCode === 0 ? 'pass' : 'fail';
  } else {
    raw.status = 'unverified';
  }
  return raw;
}

/**
 * 清洗 LLM 声称的 sha256：去前缀/空白；只在能明确得到恰好 64 位 hex 时才改写。
 * 对 66 位之类“全是 hex 但长度错了”的值不截断（截断会得到错误 hash），留给磁盘重算修复。
 */
function normalizeSha256Claim(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  let s = value.trim().toLowerCase();
  s = s.replace(/^sha-?256\s*[:=]\s*/i, '');
  s = s.replace(/\s+/g, '');
  const exact = s.match(/^(?:hash|digest)?[\("']?([a-f0-9]{64})[\)"']?$/);
  if (exact) return exact[1];
  if (/^[a-f0-9]{64}$/.test(s)) return s;
  // 被标点/说明文字包裹的 64 位 token，而不是更长 hex 串的子串
  const token = s.match(/(^|[^a-f0-9])([a-f0-9]{64})([^a-f0-9]|$)/);
  if (token) return token[2];
  return s;
}

function normalizeArtifactInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const raw = { ...(input as Record<string, unknown>) };
  raw.sha256 = normalizeSha256Claim(raw.sha256);
  if (typeof raw.kind === 'string') {
    const kind = raw.kind.trim().toLowerCase();
    const kindAliases: Record<string, string> = {
      plan: 'plan',
      'change-plan': 'plan',
      changeplan: 'plan',
      contract: 'contract',
      manifest: 'manifest',
      'implementation-manifest': 'manifest',
      report: 'other',
      'command-report': 'command-report',
      commandreport: 'command-report',
      'verification-report': 'command-report',
      'runtime-report': 'runtime-report',
      runtimereport: 'runtime-report',
      'runtime-audit': 'runtime-report',
      'review-report': 'review-report',
      reviewreport: 'review-report',
      'change-review': 'review-report',
      'final-review': 'review-report',
      'evidence-chain': 'other',
      other: 'other',
    };
    raw.kind = kindAliases[kind] ?? kind;
  }
  return raw;
}

/**
 * 以证据目录内真实文件内容重算 sha256，覆盖 LLM 编造/多写/少写的 hash。
 * 只处理位于 evidenceRoot 下的普通文件，避免把任意路径的内容写进 Gate 结果。
 */
async function repairArtifactHashesFromDisk(
  input: unknown,
  evidenceRoot?: string,
): Promise<unknown> {
  if (!evidenceRoot || !input || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }
  const raw = { ...(input as Record<string, unknown>) };
  if (!Array.isArray(raw.artifacts)) return raw;

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolve(evidenceRoot));
  } catch {
    return raw;
  }

  raw.artifacts = await Promise.all(raw.artifacts.map(async (artifact) => {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return artifact;
    const item = { ...(artifact as Record<string, unknown>) };
    if (typeof item.path !== 'string' || !item.path.trim()) return item;
    try {
      const canonicalPath = await realpath(resolve(item.path.trim()));
      const rel = relative(canonicalRoot, canonicalPath);
      if (rel === '' || rel.startsWith('..') || resolve(canonicalRoot, rel) !== canonicalPath) {
        return item;
      }
      const stats = await lstat(canonicalPath);
      if (!stats.isFile()) return item;
      const content = await readFile(canonicalPath);
      item.sha256 = createHash('sha256').update(content).digest('hex');
    } catch {
      // 读盘失败时保留声称值，交给 schema / verify 报更具体的错
    }
    return item;
  }));
  return raw;
}

function normalizeGateResultInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const raw = { ...(input as Record<string, unknown>) };

  if (typeof raw.gateId === 'string') raw.gateId = raw.gateId.trim().toLowerCase();
  if (typeof raw.status === 'string') raw.status = raw.status.trim().toLowerCase();

  const requirementIds = asStringList(raw.requirementIds ?? raw.requirements, 100);
  if (Array.isArray(requirementIds)) raw.requirementIds = requirementIds;

  const evidence = asStringList(raw.evidence ?? raw.evidences, 4_000);
  if (Array.isArray(evidence)) raw.evidence = evidence;

  if (raw.checks && !Array.isArray(raw.checks)) raw.checks = [raw.checks];
  if (Array.isArray(raw.checks)) raw.checks = raw.checks.map(normalizeCheckInput);

  if (raw.artifacts && !Array.isArray(raw.artifacts)) raw.artifacts = [raw.artifacts];
  if (Array.isArray(raw.artifacts)) raw.artifacts = raw.artifacts.map(normalizeArtifactInput);

  if (raw.findings && !Array.isArray(raw.findings)) raw.findings = [raw.findings];
  if (Array.isArray(raw.findings)) {
    raw.findings = normalizeFindingsWithRegistry(raw.findings, raw.waivers ?? raw.waiverRegistry);
  }

  return raw;
}

export const GateFindingSchema = z.preprocess(
  (input) => normalizeFindingInput(input),
  z.object({
    id: z.string().trim().min(1).max(200),
    severity: z.enum(['P0', 'P1', 'P2', 'P3']),
    status: GateFindingStatusSchema.default('open'),
    category: z.enum(GATE_FINDING_CATEGORIES).optional(),
    confidence: z.enum(['low', 'medium', 'high']).optional(),
    impact: z.string().trim().min(1).max(10_000).optional(),
    exploitability: z.enum(GATE_FINDING_EXPLOITABILITIES).optional(),
    summary: z.string().trim().min(1).max(4_000),
    evidence: z.array(z.string().trim().min(1).max(10_000)).max(100).default([]),
    waiver: z.preprocess((input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
      const raw = { ...(input as Record<string, unknown>) };
      const expiresAt = normalizeExpiresAt(raw.expiresAt ?? raw.expires ?? raw.expireAt);
      if (expiresAt) raw.expiresAt = expiresAt;
      if (typeof raw.owner === 'string') raw.owner = raw.owner.trim();
      if (typeof raw.reason === 'string') raw.reason = raw.reason.trim();
      if (typeof raw.scope === 'string') raw.scope = raw.scope.trim();
      if (typeof raw.compensatingControl === 'string') raw.compensatingControl = raw.compensatingControl.trim();
      const approvedAt = normalizeExpiresAt(raw.approvedAt);
      if (approvedAt) raw.approvedAt = approvedAt;
      if (typeof raw.approvalEvidence === 'string') raw.approvalEvidence = raw.approvalEvidence.trim();
      return raw;
    }, z.object({
      owner: z.string().trim().min(1).max(200),
      reason: z.string().trim().min(1).max(2_000),
      expiresAt: z.iso.datetime(),
      scope: z.string().trim().min(1).max(2_000).optional(),
      compensatingControl: z.string().trim().min(1).max(2_000).optional(),
      approvedAt: z.iso.datetime().optional(),
      approvalEvidence: z.string().trim().min(1).max(2_000).optional(),
    }).optional()),
  }).superRefine((finding, ctx) => {
    if (finding.status === 'waived' && !finding.waiver) {
      ctx.addIssue({ code: 'custom', path: ['waiver'], message: 'waived finding 必须包含 owner、reason 和 expiresAt' });
    }
    if (finding.status === 'planned' && finding.evidence.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'planned finding 必须提供指向 change-plan 的实现点与验证点证据',
      });
    }
  }),
);

export const GateArtifactSchema = z.preprocess(
  normalizeArtifactInput,
  z.object({
    path: z.string().trim().min(1).max(4_000)
      .refine((value) => isAbsolute(value), '门禁 artifact path 必须是绝对路径'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(['contract', 'plan', 'manifest', 'command-report', 'runtime-report', 'review-report', 'other']),
  }),
);

export const GateCheckSchema = z.preprocess(
  normalizeCheckInput,
  z.object({
    id: z.string().trim().min(1).max(200),
    // P 修复：从 2000 提高到 MAX_COMMAND_PART_CHARS（10000）。
    // Codex/Claude 生成的 /bin/zsh -lc "CHECK_START=... node -e '...'" 经常超过 2000。
    command: z.array(z.string().trim().min(1).max(MAX_COMMAND_PART_CHARS)).min(1).max(100),
    status: GateCheckStatusSchema,
    required: z.boolean().default(true),
    /**
     * 显式交给 QA 的开发阶段环境缺证。仅凭该字段不会消除残余风险；
     * 最终收敛还要求后续 verification gate 中存在完全相同 id/command/cwd
     * 的 required 真实通过检查。
     */
    delegatedTo: z.literal('verification').optional(),
    exitCode: z.number().int().nullable().optional(),
    durationMs: z.number().int().min(0).optional(),
    cwd: z.string().trim().min(1).max(4_000)
      .refine((value) => isAbsolute(value), 'check.cwd 必须是绝对路径')
      .optional(),
    startedAt: z.iso.datetime().optional(),
    finishedAt: z.iso.datetime().optional(),
    logSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).superRefine((check, ctx) => {
    if (check.delegatedTo && (check.required
      || (check.status !== 'blocked' && check.status !== 'unverified'))) {
      ctx.addIssue({
        code: 'custom',
        path: ['delegatedTo'],
        message: 'delegatedTo 仅适用于 required=false 且 status=blocked/unverified 的环境缺证',
      });
    }
    if (check.status === 'pass' && check.exitCode !== 0) {
      ctx.addIssue({ code: 'custom', path: ['exitCode'], message: 'pass check 必须具有 exitCode=0' });
    }
    if (check.status === 'fail' && (check.exitCode === undefined || check.exitCode === null || check.exitCode === 0)) {
      ctx.addIssue({ code: 'custom', path: ['exitCode'], message: 'fail check 必须具有非零 exitCode' });
    }
    if (check.status !== 'pass' && check.status !== 'fail' && check.exitCode === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['exitCode'],
        message: `${check.status} check 不能声称 exitCode=0`,
      });
    }
    if (check.startedAt && check.finishedAt && Date.parse(check.finishedAt) < Date.parse(check.startedAt)) {
      ctx.addIssue({ code: 'custom', path: ['finishedAt'], message: 'finishedAt 不能早于 startedAt' });
    }
  }),
);

export const GateResultSchema = z.preprocess(
  normalizeGateResultInput,
  z.object({
    gateId: GateIdSchema,
    status: GateStatusSchema,
    summary: z.string().trim().min(1).max(10_000),
    requirementIds: z.array(z.string().trim().min(1).max(100)).max(2_000).default([]),
    checks: z.array(GateCheckSchema).max(500).default([]),
    evidence: z.array(z.string().trim().min(1).max(4_000)).max(500).default([]),
    artifacts: z.array(GateArtifactSchema).min(1).max(100),
    findings: z.array(GateFindingSchema).max(1_000).default([]),
  }).superRefine((result, ctx) => {
    for (const [field, values] of [
      ['requirementIds', result.requirementIds],
      ['checks', result.checks.map((item) => item.id)],
      ['artifacts', result.artifacts.map((item) => resolve(item.path))],
      ['findings', result.findings.map((item) => item.id)],
    ] as const) {
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} 不能包含重复标识` });
      }
    }
    const misplacedDelegations = result.checks
      .filter((check) => check.delegatedTo && result.gateId !== 'implementation');
    if (misplacedDelegations.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['checks'],
        message: 'delegatedTo 只允许由 implementation gate 声明',
      });
    }
  }),
);
export type GateResult = z.infer<typeof GateResultSchema>;

const CANONICAL_WAIVER_MARKER = '[RISK_WAIVER]';

const CanonicalWaiverDeclarationSchema = z.object({
  findingId: z.string().trim().min(1).max(200),
  owner: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(2_000),
  scope: z.string().trim().min(1).max(2_000),
  compensatingControl: z.string().trim().min(1).max(2_000),
  expiresAt: z.preprocess(normalizeExpiresAt, z.iso.datetime()),
}).strict();
export type CanonicalWaiverDeclaration = z.infer<typeof CanonicalWaiverDeclarationSchema>;

export interface CanonicalSpecWaiverContext {
  specId: string;
  version: number;
  content: string;
  contentHash: string;
  approvedAt: string;
}

/**
 * 只读取人工确认前已经写入 canonical Spec 的显式风险接受条款。
 * Gate Agent 后补的 waiver 元数据不构成人工批准，不能作为事实源。
 * P1 修复：排除 fenced code block，防止代码示例中的 [RISK_WAIVER] 被当真实授权。
 */
export function parseCanonicalSpecWaivers(content: string): CanonicalWaiverDeclaration[] {
  // 排除 fenced code block，防止 Spec 中代码示例里的 [RISK_WAIVER] 被误解析。
  const cleaned = content.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
  const declarations: CanonicalWaiverDeclaration[] = [];
  const ids = new Set<string>();
  let from = 0;
  while (from < cleaned.length) {
    const markerIndex = cleaned.indexOf(CANONICAL_WAIVER_MARKER, from);
    if (markerIndex < 0) break;
    if (declarations.length >= 100) throw new Error('canonical Spec 的 RISK_WAIVER 不能超过 100 条');
    const afterMarker = markerIndex + CANONICAL_WAIVER_MARKER.length;
    const remainder = cleaned.slice(afterMarker);
    const braceOffset = remainder.search(/\{/);
    if (braceOffset < 0 || braceOffset > 120 || /[^\s`*'":-]/.test(remainder.slice(0, Math.max(0, braceOffset)))) {
      // Skill/提示词示例常被抄进正文且没有 JSON。无 JSON 的字面量不构成授权，忽略以免整轮作废。
      from = afterMarker;
      continue;
    }
    const json = extractBalancedJsonObject(cleaned, afterMarker + braceOffset);
    if (!json) throw new Error('canonical Spec 的 [RISK_WAIVER] JSON 未闭合');
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (error) {
      throw new Error('canonical Spec 的 [RISK_WAIVER] 不是有效 JSON：' + (error as Error).message);
    }
    const parsed = CanonicalWaiverDeclarationSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `canonical Spec 的 [RISK_WAIVER] 格式错误：${issue?.path.join('.') || '(根)'} ${issue?.message ?? ''}`.trim(),
      );
    }
    if (ids.has(parsed.data.findingId)) {
      throw new Error('canonical Spec 包含重复 RISK_WAIVER findingId：' + parsed.data.findingId);
    }
    ids.add(parsed.data.findingId);
    declarations.push(parsed.data);
    from = afterMarker + braceOffset + json.length;
  }
  return declarations;
}

/** 是否存在已解析的风险接受条款；解析失败时按「含条款」处理，避免从截断预览直接开始交付。 */
export function canonicalSpecHasRiskWaivers(content: string): boolean {
  try {
    return parseCanonicalSpecWaivers(content).length > 0;
  } catch {
    const cleaned = content.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
    return cleaned.includes(CANONICAL_WAIVER_MARKER);
  }
}

/**
 * 把 Gate 中的 waived finding 绑定到控制器已批准的 canonical Spec。
 * approvedAt / approvalEvidence 完全由控制器生成，Agent 声称值会被忽略并重建。
 */
export function bindGateWaiversToCanonicalSpec(
  result: GateResult,
  context: CanonicalSpecWaiverContext,
): GateResult {
  const waived = result.findings.filter((finding) => finding.status === 'waived');
  if (waived.length === 0) return result;
  assertCanonicalWaiverContext(context);
  const declarations = new Map(
    parseCanonicalSpecWaivers(context.content).map((declaration) => [declaration.findingId, declaration]),
  );
  const approvedAt = new Date(context.approvedAt).toISOString();
  const findings = result.findings.map((finding) => {
    if (finding.status !== 'waived') return finding;
    const declaration = declarations.get(finding.id);
    if (!declaration) {
      throw new Error(`waived finding ${finding.id} 未在人工批准前的 canonical Spec 中登记 [RISK_WAIVER]`);
    }
    const claimed = finding.waiver;
    if (!claimed) throw new Error(`waived finding ${finding.id} 缺少风险条款`);
    for (const field of ['owner', 'reason', 'expiresAt'] as const) {
      if (claimed[field] !== declaration[field]) {
        throw new Error(`waived finding ${finding.id} 的 ${field} 与 canonical Spec 不一致`);
      }
    }
    for (const field of ['scope', 'compensatingControl'] as const) {
      if (claimed[field] !== undefined && claimed[field] !== declaration[field]) {
        throw new Error(`waived finding ${finding.id} 的 ${field} 与 canonical Spec 不一致`);
      }
    }
    if (Date.parse(declaration.expiresAt) <= Date.parse(approvedAt)) {
      throw new Error(`waived finding ${finding.id} 的期限没有晚于 Spec 人工批准时间`);
    }
    return {
      ...finding,
      waiver: {
        owner: declaration.owner,
        reason: declaration.reason,
        scope: declaration.scope,
        compensatingControl: declaration.compensatingControl,
        expiresAt: declaration.expiresAt,
        approvedAt,
        approvalEvidence: canonicalWaiverEvidence(context, finding.id),
      },
    };
  });
  return GateResultSchema.parse({ ...result, findings });
}

/** 重读持久化 Gate 时确认 waiver 仍精确绑定同一份 canonical Spec。 */
export function assertGateWaiversBoundToCanonicalSpec(
  result: GateResult,
  context: CanonicalSpecWaiverContext,
): void {
  const rebound = bindGateWaiversToCanonicalSpec(result, context);
  for (let index = 0; index < result.findings.length; index += 1) {
    const actual = result.findings[index];
    if (actual.status !== 'waived') continue;
    const expected = rebound.findings[index].waiver;
    const keys = [
      'owner',
      'reason',
      'scope',
      'compensatingControl',
      'expiresAt',
      'approvedAt',
      'approvalEvidence',
    ] as const;
    if (!expected || keys.some((key) => actual.waiver?.[key] !== expected[key])) {
      throw new Error(`waived finding ${actual.id} 的控制器批准绑定缺失、过期或被改写`);
    }
  }
}

function assertCanonicalWaiverContext(context: CanonicalSpecWaiverContext): void {
  if (!context.specId.trim() || !Number.isInteger(context.version) || context.version < 1) {
    throw new Error('canonical Spec waiver 上下文缺少有效 specId/version');
  }
  if (!/^[a-f0-9]{64}$/.test(context.contentHash)
    || createHash('sha256').update(context.content).digest('hex') !== context.contentHash) {
    throw new Error('canonical Spec waiver 上下文的正文与 hash 不一致');
  }
  if (Number.isNaN(Date.parse(context.approvedAt))) {
    throw new Error('canonical Spec waiver 上下文缺少控制器批准时间');
  }
}

function canonicalWaiverEvidence(context: CanonicalSpecWaiverContext, findingId: string): string {
  return `canonical-spec:${context.specId}:v${context.version}:sha256:${context.contentHash}:waiver:${findingId}`;
}

export const GateRunSchema = z.object({
  id: z.string().uuid(),
  gateId: GateIdSchema,
  stepId: z.string().trim().min(1).max(100),
  attempt: z.number().int().min(1),
  status: GateStatusSchema,
  stepStartFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  projectFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  result: GateResultSchema,
  recordedAt: z.iso.datetime(),
}).superRefine((run, ctx) => {
  const expected: Record<string, GateId> = {
    architect: 'design',
    dev: 'implementation',
    review: 'change-review',
    qa: 'verification',
    runtime_audit: 'runtime-audit',
    final_review: 'final-review',
  };
  if (expected[run.stepId] && expected[run.stepId] !== run.gateId) {
    ctx.addIssue({
      code: 'custom',
      path: ['gateId'],
      message: `步骤 ${run.stepId} 不能记录 gateId=${run.gateId}`,
    });
  }
  if (run.result.gateId !== run.gateId || run.result.status !== run.status) {
    ctx.addIssue({ code: 'custom', path: ['result'], message: 'GateRun 外层状态必须与 result 一致' });
  }
});
export type GateRun = z.infer<typeof GateRunSchema>;

const STEP_GATE_IDS: Partial<Record<PipelineStepId, GateId>> = {
  architect: 'design',
  dev: 'implementation',
  review: 'change-review',
  qa: 'verification',
  runtime_audit: 'runtime-audit',
  final_review: 'final-review',
};

const GATE_SKILLS: Record<GateId, string> = {
  design: 'design-risk-aware-change',
  implementation: 'implement-traceable-change',
  'change-review': 'review-change-set',
  verification: 'verify-software-delivery',
  'runtime-audit': 'audit-runtime-boundaries',
  'final-review': 'review-final-delivery',
};

const GATE_RESULT_MARKER = '[GATE_RESULT]';

/** 各门禁落盘主 artifact：用于答案缺标记或标记被污染时从证据目录恢复。 */
const PRIMARY_EVIDENCE_ARTIFACT: Record<GateId, {
  fileName: string;
  kind: 'contract' | 'plan' | 'manifest' | 'command-report' | 'runtime-report' | 'review-report' | 'other';
}> = {
  design: { fileName: 'change-plan.json', kind: 'plan' },
  implementation: { fileName: 'implementation-manifest.json', kind: 'manifest' },
  'change-review': { fileName: 'change-review.json', kind: 'review-report' },
  verification: { fileName: 'verification-report.json', kind: 'command-report' },
  'runtime-audit': { fileName: 'runtime-audit.json', kind: 'runtime-report' },
  'final-review': { fileName: 'final-review.json', kind: 'review-report' },
};

export function gateIdForStep(stepId: PipelineStepId): GateId | undefined {
  return STEP_GATE_IDS[stepId];
}

export function skillNameForStep(stepId: PipelineStepId): string | undefined {
  const gateId = gateIdForStep(stepId);
  return gateId ? GATE_SKILLS[gateId] : undefined;
}

/**
 * 从 start 处的 `{` 起做括号平衡提取，忽略字符串内的括号。
 * 用于扛住：多行 JSON、行尾 DSML/工具调用垃圾、`} ` 后还有杂质。
 */
export function extractBalancedJsonObject(text: string, startBrace: number): string | null {
  if (startBrace < 0 || startBrace >= text.length || text[startBrace] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startBrace; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(startBrace, i + 1);
    }
  }
  return null;
}

/**
 * 提取答案中全部 [GATE_RESULT] JSON 候选（按出现顺序）。
 * 跳过技能文档里的 `[GATE_RESULT].artifacts` 这类引用。
 */
export function extractGateResultJsonCandidates(answer: string): string[] {
  const candidates: string[] = [];
  let from = 0;
  while (from < answer.length) {
    const idx = answer.indexOf(GATE_RESULT_MARKER, from);
    if (idx < 0) break;
    const afterMarker = idx + GATE_RESULT_MARKER.length;
    const remainder = answer.slice(afterMarker);
    // 文档引用：`[GATE_RESULT].artifacts`
    if (/^\s*\./.test(remainder)) {
      from = afterMarker;
      continue;
    }
    const braceOffset = remainder.search(/\{/);
    if (braceOffset < 0 || braceOffset > 120) {
      from = afterMarker;
      continue;
    }
    const between = remainder.slice(0, braceOffset);
    // P1 修复：允许冒号、json fence 标记和加粗装饰出现在 [GATE_RESULT] 和 JSON 之间。
    // 旧正则 /[^`*'"]/ 拒绝了冒号和 json fence，导致 [GATE_RESULT]: {...} 和
    // [GATE_RESULT]\n```json\n{...} 被跳过。
    if (/[^(\s`*'"\-:#!?.,;)\]a-z]/i.test(between)) {
      from = afterMarker;
      continue;
    }
    const json = extractBalancedJsonObject(answer, afterMarker + braceOffset);
    if (json) candidates.push(json);
    from = afterMarker;
  }
  return candidates;
}

async function recoverGateResultFromEvidence(
  stepId: PipelineStepId,
  evidenceRoot: string,
): Promise<unknown | null> {
  const gateId = gateIdForStep(stepId);
  if (!gateId) return null;
  const primary = PRIMARY_EVIDENCE_ARTIFACT[gateId];
  const artifactPath = resolve(evidenceRoot, primary.fileName);
  let content: Buffer;
  try {
    const stats = await lstat(artifactPath);
    if (!stats.isFile()) return null;
    content = await readFile(artifactPath);
  } catch {
    return null;
  }

  let report: Record<string, unknown>;
  try {
    const parsed = JSON.parse(content.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    report = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const sha256 = createHash('sha256').update(content).digest('hex');
  const reportStatus = typeof report.status === 'string' ? report.status.trim().toLowerCase() : '';
  const decision = typeof report.decision === 'string' ? report.decision.trim().toLowerCase() : '';
  let status: string = reportStatus || 'pass';
  if ((decision === 'approved' || decision === 'approved-with-waiver') && (!reportStatus || reportStatus === 'pass')) status = 'pass';
  if (decision === 'rejected' || decision === 'blocked') status = reportStatus || 'fail';

  const findings = Array.isArray(report.findings) ? report.findings : [];
  const reportChecks = Array.isArray(report.checks)
    ? report.checks
    : Array.isArray(report.executedChecks) ? report.executedChecks : [];
  // 不得为缺失的执行证据伪造一条 `test -f` 成功命令；没有真实 checks 时
  // 由对应 gate 的 validateGatePass 明确阻断。
  const checks = reportChecks;

  const requirementIds = Array.isArray(report.requirementIds)
    ? report.requirementIds
    : Array.isArray(report.requirementCoverage)
      ? report.requirementCoverage.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const id = (item as Record<string, unknown>).id;
        return typeof id === 'string' ? [id] : [];
      })
      : Array.isArray(report.requirementTrace)
        ? report.requirementTrace.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const id = (item as Record<string, unknown>).requirementId ?? (item as Record<string, unknown>).id;
          return typeof id === 'string' ? [id] : [];
        })
        : Array.isArray(report.requirementImplementations)
          ? report.requirementImplementations.flatMap((item) => {
            if (!item || typeof item !== 'object') return [];
            const id = (item as Record<string, unknown>).requirementId;
            return typeof id === 'string' ? [id] : [];
          })
          : Array.isArray(report.requirementResults)
            ? report.requirementResults.flatMap((item) => {
              if (!item || typeof item !== 'object') return [];
              const id = (item as Record<string, unknown>).requirementId ?? (item as Record<string, unknown>).id;
              return typeof id === 'string' ? [id] : [];
            })
            : [];

  return {
    gateId,
    status,
    summary: typeof report.summary === 'string' && report.summary.trim()
      ? report.summary.trim()
      : ('从证据目录恢复门禁结果：' + primary.fileName),
    requirementIds,
    checks,
    evidence: [artifactPath],
    artifacts: [{ path: artifactPath, sha256, kind: primary.kind }],
    findings,
    ...(Array.isArray(report.waivers) ? { waivers: report.waivers } : {}),
  };
}

async function hydrateGateResultFromPrimaryArtifact(
  result: GateResult,
  evidenceRoot?: string,
): Promise<GateResult> {
  if (!evidenceRoot) return result;
  const expected = PRIMARY_EVIDENCE_ARTIFACT[result.gateId];
  const expectedPath = resolve(evidenceRoot, expected.fileName);
  const artifact = result.artifacts.find((item) => resolve(item.path) === expectedPath);
  if (!artifact) return result;

  let content: Buffer;
  try {
    const canonicalRoot = await realpath(resolve(evidenceRoot));
    const canonicalPath = await realpath(resolve(artifact.path));
    const rel = relative(canonicalRoot, canonicalPath);
    if (rel === '' || rel.startsWith('..') || resolve(canonicalRoot, rel) !== canonicalPath) {
      return result;
    }
    content = await readFile(canonicalPath);
  } catch {
    return result;
  }

  let report: Record<string, unknown>;
  try {
    const parsed = JSON.parse(content.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
    report = parsed as Record<string, unknown>;
  } catch {
    return result;
  }

  const next: GateResult = {
    ...result,
    artifacts: result.artifacts.map((item) => (
      item.path === artifact.path
        ? { ...item, sha256: createHash('sha256').update(content).digest('hex') }
        : item
    )),
  };

  const reportChecks = reportCheckCandidates(report);
  if (reportChecks.length > 0) {
    const checks: GateResult['checks'] = reportChecks.map((item, index) => {
      const parsedCheck = GateCheckSchema.safeParse(item);
      if (!parsedCheck.success) {
        const issue = parsedCheck.error.issues[0];
        throw new Error(
          `门禁 artifact checks[${index}] 格式错误：${issue?.path.join('.') || '(根)'} ${issue?.message ?? ''}`.trim(),
        );
      }
      return parsedCheck.data;
    });
    const artifactChecksById = new Map<string, GateResult['checks'][number]>();
    for (const check of checks) {
      if (artifactChecksById.has(check.id)) {
        throw new Error(`门禁 artifact checks 包含重复 id：${check.id}`);
      }
      artifactChecksById.set(check.id, check);
    }

    for (const check of result.checks) {
      const artifactCheck = artifactChecksById.get(check.id);
      if (artifactCheck && !gateChecksSemanticallyEqual(check, artifactCheck)) {
        const artifactOwnsChecks = artifact.kind === expected.kind
          && (expected.kind === 'plan' || expected.kind === 'manifest');
        if (!artifactOwnsChecks || !isCompatibleLaterCheckRerun(artifactCheck, check)) {
          throw new Error(`门禁 artifact 与 Gate 结果的同 ID 检查证据不一致：${check.id}`);
        }
      }
    }

    const resultCheckIds = new Set(result.checks.map((check) => check.id));
    next.checks = [
      ...result.checks.map((check) => artifactChecksById.get(check.id) ?? check),
      ...checks.filter((check) => !resultCheckIds.has(check.id)),
    ];
  }

  // 审查类：artifact 是 findings 权威源，避免 GATE_RESULT 塞超长数组导致截断/污染
  if (artifact.kind === 'review-report' && Array.isArray(report.findings)) {
    // 审查 artifact 是 findings 的权威源，但“权威”不等于可以静默丢弃坏记录。
    // 任意 finding 无法解析都必须 fail closed，否则 GATE_RESULT 也写空数组时风险会凭空消失。
    next.findings = parseReviewArtifactFindings(report, artifact.path);
    if (typeof report.status === 'string' && report.status.trim()) {
      const status = GateStatusSchema.safeParse(report.status.trim().toLowerCase());
      if (status.success) next.status = status.data;
    }
    if (next.evidence.length === 0) next.evidence = [artifact.path];
  }

  if (artifact.kind === 'command-report') {
    if (typeof report.status === 'string' && report.status.trim()) {
      const status = GateStatusSchema.safeParse(report.status.trim().toLowerCase());
      if (status.success) next.status = status.data;
    }
    if (Array.isArray(report.findings)) {
      next.findings = parseReviewArtifactFindings(report, artifact.path);
    }
  }

  if (artifact.kind === 'runtime-report') {
    if (typeof report.status === 'string' && report.status.trim()) {
      const status = GateStatusSchema.safeParse(report.status.trim().toLowerCase());
      if (status.success) next.status = status.data;
    }
    // 运行时报告同样是 finding 事实源；不允许只在 artifact 中保留阻断风险。
    if (Array.isArray(report.findings)) {
      next.findings = parseReviewArtifactFindings(report, artifact.path);
      if (next.evidence.length === 0) next.evidence = [artifact.path];
    }
  }

  return next;
}

function reportCheckCandidates(report: Record<string, unknown>): unknown[] {
  if (Array.isArray(report.checks)) return report.checks;
  if (Array.isArray(report.executedChecks)) return report.executedChecks;
  if (Array.isArray(report.targetedCheckResults)) return report.targetedCheckResults;
  return [];
}

/**
 * Artifact 与 GATE_RESULT 会重复携带同一检查。命令与结论属于门禁语义，
 * 耗时、时间戳、cwd 和日志 hash 属于单边可能缺省的执行元数据。
 */
function gateChecksSemanticallyEqual(
  left: GateResult['checks'][number],
  right: GateResult['checks'][number],
): boolean {
  return left.id === right.id
    && isDeepStrictEqual(left.command, right.command)
    && left.status === right.status
    && left.required === right.required
    && left.delegatedTo === right.delegatedTo
    && left.exitCode === right.exitCode
    // cwd 可以在其中一侧缺省；双方都声明时则属于命令语义，不能静默跨项目替换。
    && (!left.cwd || !right.cwd || left.cwd === right.cwd);
}

/**
 * 计划/实现 artifact 是其内嵌 checks 的事实源。Agent 有时会在写完 artifact 后，
 * 用同一逻辑 ID 再跑一次更严格的校验并把新 argv 放进 GATE_RESULT；这不是证据冲突，
 * 但也不能把两个命令的时间与 argv 拼成一条虚假记录。因此仅在结论完全相同、cwd
 * 相同且 GATE_RESULT 确实晚于 artifact 记录时接受，并继续采用 artifact 原记录。
 *
 * 状态、required、exitCode、目录或时间顺序任一不一致仍 fail closed。
 */
function isCompatibleLaterCheckRerun(
  artifactCheck: GateResult['checks'][number],
  resultCheck: GateResult['checks'][number],
): boolean {
  if (artifactCheck.id !== resultCheck.id
    || artifactCheck.status !== resultCheck.status
    || artifactCheck.required !== resultCheck.required
    || artifactCheck.delegatedTo !== resultCheck.delegatedTo
    || artifactCheck.exitCode !== resultCheck.exitCode
    || artifactCheck.cwd !== resultCheck.cwd
    || !artifactCheck.finishedAt
    || !resultCheck.startedAt
    || !resultCheck.finishedAt) {
    return false;
  }
  const artifactFinishedAt = Date.parse(artifactCheck.finishedAt);
  const rerunStartedAt = Date.parse(resultCheck.startedAt);
  const rerunFinishedAt = Date.parse(resultCheck.finishedAt);
  return rerunStartedAt >= artifactFinishedAt
    && rerunFinishedAt <= Date.now() + 5 * 60 * 1_000;
}

export async function parseGateResult(
  answer: string,
  stepId: PipelineStepId,
  options?: { evidenceRoot?: string },
): Promise<GateResult> {
  const expected = gateIdForStep(stepId);
  const candidates = extractGateResultJsonCandidates(answer);
  const parseErrors: string[] = [];

  const tryParse = async (rawText: string, source: string): Promise<GateResult | null> => {
    let raw: unknown;
    try {
      raw = JSON.parse(rawText);
    } catch (error) {
      parseErrors.push(source + ' JSON 无效: ' + (error as Error).message);
      return null;
    }
    const repaired = await repairArtifactHashesFromDisk(
      normalizeGateResultInput(raw),
      options?.evidenceRoot,
    );
    const parsed = GateResultSchema.safeParse(repaired);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      parseErrors.push(
        (source + ' 格式错误: '
          + (issue?.path.join('.') || '(根)') + ' ' + (issue?.message ?? '')).trim(),
      );
      return null;
    }
    if (!expected || parsed.data.gateId !== expected) {
      parseErrors.push(source + ' gateId=' + parsed.data.gateId + '，期望 ' + (expected ?? '(none)'));
      return null;
    }
    return hydrateGateResultFromPrimaryArtifact(parsed.data, options?.evidenceRoot);
  };

  // 从后往前：模型常先写草稿，最后一次 GATE_RESULT 才是终态
  for (const candidate of [...candidates].reverse()) {
    const parsed = await tryParse(candidate, 'GATE_RESULT');
    if (parsed) return parsed;
  }

  if (options?.evidenceRoot) {
    const recovered = await recoverGateResultFromEvidence(stepId, options.evidenceRoot);
    if (recovered) {
      const parsed = await tryParse(
        JSON.stringify(recovered),
        'evidence:' + (expected ? PRIMARY_EVIDENCE_ARTIFACT[expected].fileName : 'artifact'),
      );
      if (parsed) return parsed;
    }
  }

  if (candidates.length === 0) {
    throw new Error('质量步骤 ' + stepId + ' 缺少可解析的 [GATE_RESULT] JSON 证据'
      + (options?.evidenceRoot ? '（答案与证据目录均未恢复成功）' : ''));
  }
  throw new Error(
    ('质量步骤 ' + stepId + ' 的 Gate 结果格式错误: '
      + (parseErrors[0] ?? '无法解析 GATE_RESULT')).trim(),
  );
}

export function validateGatePass(stepId: PipelineStepId, result: GateResult): void {
  if (result.artifacts.length === 0) throw new Error('质量门禁必须包含已落盘并可校验 hash 的 artifact');
  if (result.requirementIds.length === 0) throw new Error('质量门禁必须声明 canonical requirementIds');
  const misplacedDelegations = result.checks
    .filter((check) => check.delegatedTo && result.gateId !== 'implementation');
  if (misplacedDelegations.length > 0) {
    throw new Error('delegatedTo 只允许由 implementation gate 声明：'
      + misplacedDelegations.map((check) => check.id).join('、'));
  }
  const blocking = result.findings.filter((finding) =>
    (finding.severity === 'P0' || finding.severity === 'P1')
    && (finding.status === 'open' || (stepId !== 'architect' && finding.status === 'planned')));
  if (blocking.length > 0) {
    throw new Error('质量门禁 ' + result.gateId + ' 仍有未闭环 P0/P1：'
      + blocking.map((item) => item.id).join('、'));
  }
  const invalidPlanned = stepId === 'architect'
    ? []
    : result.findings.filter((finding) => finding.status === 'planned');
  if (invalidPlanned.length > 0) {
    throw new Error('只有设计门禁可以登记 planned finding；当前步骤必须 resolved、waived 或如实 open：'
      + invalidPlanned.map((item) => item.id).join('、'));
  }
  const findingsWithoutEvidence = result.findings.filter((finding) => finding.evidence.length === 0);
  if (findingsWithoutEvidence.length > 0) {
    throw new Error('质量门禁 finding 必须包含可定位证据：'
      + findingsWithoutEvidence.map((finding) => finding.id).join('、'));
  }
  const expiredWaivers = result.findings.filter((finding) =>
    finding.status === 'waived'
    && finding.waiver
    && Date.parse(finding.waiver.expiresAt) <= Date.now());
  if (expiredWaivers.length > 0) {
    throw new Error('质量门禁包含已过期 waiver：' + expiredWaivers.map((item) => item.id).join('、'));
  }
  const incompleteWaivers = result.findings.filter((finding) => finding.status === 'waived' && (
    !finding.waiver?.scope
    || !finding.waiver.compensatingControl
    || !finding.waiver.approvedAt
    || !finding.waiver.approvalEvidence
    || !finding.waiver.approvalEvidence.startsWith('canonical-spec:')
  ));
  if (incompleteWaivers.length > 0) {
    throw new Error('质量门禁 waiver 缺少范围、补偿控制或 canonical Spec 人工批准绑定：'
      + incompleteWaivers.map((item) => item.id).join('、'));
  }
  const futureApprovals = result.findings.filter((finding) => finding.status === 'waived'
    && finding.waiver?.approvedAt
    && Date.parse(finding.waiver.approvedAt) > Date.now() + 5 * 60 * 1_000);
  if (futureApprovals.length > 0) {
    throw new Error('质量门禁 waiver 的 approvedAt 位于未来：'
      + futureApprovals.map((item) => item.id).join('、'));
  }
  const invalidWaiverWindows = result.findings.filter((finding) => finding.status === 'waived'
    && finding.waiver?.approvedAt
    && Date.parse(finding.waiver.expiresAt) <= Date.parse(finding.waiver.approvedAt));
  if (invalidWaiverWindows.length > 0) {
    throw new Error('质量门禁 waiver 到期时间必须晚于批准时间：'
      + invalidWaiverWindows.map((item) => item.id).join('、'));
  }
  const runtimeNotApplicable = stepId === 'runtime_audit' && result.status === 'not-applicable';
  if (runtimeNotApplicable && result.evidence.length === 0) {
    throw new Error('运行时审计不适用时必须提供适用性证据');
  }
  if (!runtimeNotApplicable && result.status !== 'pass') {
    throw new Error('质量门禁 ' + result.gateId + ' 未通过：' + result.status + ' · ' + result.summary);
  }
  if (result.checks.length === 0) {
    throw new Error('质量门禁 ' + result.gateId + ' 必须包含真实校验命令及退出码');
  }
  const incompleteRequiredChecks = result.checks.filter((check) => check.required && check.status !== 'pass');
  if (incompleteRequiredChecks.length > 0) {
    throw new Error('质量门禁仍有必需检查未通过：'
      + incompleteRequiredChecks.map((check) => `${check.id}(${check.status})`).join('、'));
  }
  if (!result.checks.some((check) => check.required && check.status === 'pass')) {
    throw new Error(stepId + ' 门禁至少需要一项 required=true 的真实通过检查');
  }
  const missingProvenance = result.checks.filter((check) =>
    !check.cwd || !check.startedAt || !check.finishedAt);
  if (missingProvenance.length > 0) {
    throw new Error(stepId + ' 命令缺少 cwd/startedAt/finishedAt 执行溯源：'
      + missingProvenance.map((check) => check.id).join('、'));
  }
  const futureChecks = result.checks.filter((check) =>
    !!check.finishedAt && Date.parse(check.finishedAt) > Date.now() + 5 * 60 * 1_000);
  if (futureChecks.length > 0) {
    throw new Error(stepId + ' 命令的 finishedAt 位于未来：'
      + futureChecks.map((check) => check.id).join('、'));
  }
  if (stepId === 'qa') {
    if (!result.artifacts.some((artifact) => artifact.kind === 'command-report')) {
      throw new Error('QA 门禁必须包含 command-report artifact');
    }
  }
  if ((stepId === 'review' || stepId === 'runtime_audit' || stepId === 'final_review')
    && result.evidence.length === 0) {
    throw new Error(stepId + ' 门禁必须包含可定位的运行或审查证据');
  }
  if (stepId === 'review') {
    if (!result.artifacts.some((artifact) => artifact.kind === 'review-report')) {
      throw new Error('变更审查门禁必须包含 review-report artifact');
    }
  }
  if (stepId === 'runtime_audit') {
    if (result.checks.length === 0) throw new Error('运行时审计门禁必须包含真实探测或校验命令');
    if (!result.artifacts.some((artifact) => artifact.kind === 'runtime-report')) {
      throw new Error('运行时审计门禁必须包含 runtime-report artifact');
    }
  }
  if (stepId === 'final_review' && !result.artifacts.some((artifact) => artifact.kind === 'review-report')) {
    throw new Error('最终审查门禁必须包含 review-report artifact 和真实校验命令');
  }
}

/** 防止把旧轮次的命令结果复制到当前 Gate；允许少量宿主/容器时钟偏差。 */
export function assertGateChecksBelongToAttempt(
  result: GateResult,
  attemptStartedAt: string,
  clockSkewMs = 5 * 60 * 1_000,
): void {
  const attemptStart = Date.parse(attemptStartedAt);
  if (Number.isNaN(attemptStart)) throw new Error('门禁步骤启动时间无效');
  const stale = result.checks.filter((check) =>
    !!check.startedAt && Date.parse(check.startedAt) < attemptStart - clockSkewMs);
  if (stale.length > 0) {
    throw new Error('门禁检查来自当前步骤启动前的旧轮次：'
      + stale.map((check) => check.id).join('、'));
  }
}

/**
 * 职责边界：架构师只设计不实现，设计门禁登记的 planned P0/P1 由开发实现后闭环。
 * implementation 门禁必须用相同 id 把这些 finding 标记为 resolved（附实现与测试证据）或 waived，
 * 不得遗漏、改名或维持 planned，否则阻断。
 */
export function assertPlannedFindingsClosed(
  stepId: PipelineStepId,
  previousRuns: readonly GateRun[],
  result: GateResult,
): void {
  if (stepId !== 'dev') return;
  const design = latestGateRuns(previousRuns).get('design');
  if (!design) return;
  const planned = design.result.findings.filter((finding) =>
    (finding.severity === 'P0' || finding.severity === 'P1') && finding.status === 'planned');
  if (planned.length === 0) return;
  const reported = new Map(result.findings.map((finding) => [finding.id, finding]));
  const missing = planned.filter((finding) => {
    const current = reported.get(finding.id);
    return !current
      || (current.status !== 'resolved' && current.status !== 'waived')
      || current.evidence.length === 0;
  });
  if (missing.length > 0) {
    throw new Error('实现门禁必须闭环设计门禁登记的 P0/P1：'
      + missing.map((finding) => `${finding.id}(${finding.severity})`).join('、')
      + '；请按 change-plan 落地后用相同 id 标记为 resolved 并附实现与测试证据，或标记为 waived。');
  }
}

/** 同一 finding ID 跨门禁不得静默降级；解决结论则由 validateGatePass 强制附证据。 */
export function assertFindingContinuity(
  previousRuns: readonly GateRun[],
  result: GateResult,
): void {
  const severityRank = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;
  const priorSeverity = new Map<string, keyof typeof severityRank>();
  for (const run of latestGateRuns(previousRuns).values()) {
    for (const finding of run.result.findings) {
      const existing = priorSeverity.get(finding.id);
      if (!existing || severityRank[finding.severity] < severityRank[existing]) {
        priorSeverity.set(finding.id, finding.severity);
      }
    }
  }
  const downgraded = result.findings.filter((finding) => {
    const previous = priorSeverity.get(finding.id);
    return previous !== undefined && severityRank[finding.severity] > severityRank[previous];
  });
  if (downgraded.length > 0) {
    throw new Error('质量门禁不得静默降低既有 finding 严重级别：'
      + downgraded.map((finding) => finding.id).join('、'));
  }
}

export async function verifyGateArtifacts(
  evidenceRoot: string,
  result: GateResult,
  options: { projectRoot?: string } = {},
): Promise<void> {
  let canonicalProjectRoot: string | undefined;
  if (options.projectRoot) {
    canonicalProjectRoot = await realpath(resolve(options.projectRoot)).catch(() => {
      throw new Error('门禁项目根目录不可读取：' + options.projectRoot);
    });
    for (const check of result.checks) {
      if (!check.cwd) continue;
      const canonicalCwd = await realpath(resolve(check.cwd)).catch(() => {
        throw new Error(`门禁检查 ${check.id} 的 cwd 不可读取：${check.cwd}`);
      });
      const cwdStats = await lstat(canonicalCwd);
      if (!cwdStats.isDirectory()) throw new Error(`门禁检查 ${check.id} 的 cwd 不是目录`);
      const rel = relative(canonicalProjectRoot, canonicalCwd);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
        throw new Error(`门禁检查 ${check.id} 的 cwd 必须位于当前项目根目录内：${check.cwd}`);
      }
    }
  }
  const rootStats = await lstat(resolve(evidenceRoot)).catch(() => {
    throw new Error('门禁证据目录不可读取：' + evidenceRoot);
  });
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('门禁证据目录必须是真实目录且不能是符号链接：' + evidenceRoot);
  }
  const canonicalRoot = await realpath(resolve(evidenceRoot));
  const primary = PRIMARY_EVIDENCE_ARTIFACT[result.gateId];
  const expectedPrimaryCandidate = resolve(canonicalRoot, primary.fileName);
  const expectedPrimaryStats = await lstat(expectedPrimaryCandidate).catch(() => {
    throw new Error('门禁缺少规范主 artifact：' + primary.fileName);
  });
  if (expectedPrimaryStats.isSymbolicLink() || !expectedPrimaryStats.isFile()) {
    throw new Error('门禁规范主 artifact 必须是普通文件且不能是符号链接：' + primary.fileName);
  }
  const expectedPrimaryPath = await realpath(resolve(canonicalRoot, primary.fileName)).catch(() => {
    throw new Error('门禁缺少规范主 artifact：' + primary.fileName);
  });
  let primaryMatched = false;
  for (const artifact of result.artifacts) {
    const candidate = resolve(artifact.path);
    const candidateStats = await lstat(candidate).catch(() => {
      throw new Error('门禁 artifact 不可读取：' + artifact.path);
    });
    if (candidateStats.isSymbolicLink()) {
      throw new Error('门禁 artifact 不能是符号链接：' + artifact.path);
    }
    const canonicalPath = await realpath(candidate).catch(() => {
      throw new Error('门禁 artifact 不可读取：' + artifact.path);
    });
    const rel = relative(canonicalRoot, canonicalPath);
    if (rel === '' || rel.startsWith('..') || resolve(canonicalRoot, rel) !== canonicalPath) {
      throw new Error('门禁 artifact 必须位于本工作流证据目录：' + artifact.path);
    }
    const isPrimaryArtifact = canonicalPath === expectedPrimaryPath;
    if (isPrimaryArtifact) {
      if (artifact.kind !== primary.kind) {
        throw new Error(`门禁主 artifact 类型错误：${primary.fileName} 应为 ${primary.kind}`);
      }
      primaryMatched = true;
    } else {
      if (basename(canonicalPath) === 'canonical-spec.md'
        || basename(canonicalPath) === 'evidence-chain.json') {
        throw new Error(`门禁 ${result.gateId} 不得声明控制器拥有的 artifact：${basename(canonicalPath)}`);
      }
      const reservedOwner = Object.entries(PRIMARY_EVIDENCE_ARTIFACT)
        .find(([, contract]) => contract.fileName === basename(canonicalPath));
      if (reservedOwner) {
        throw new Error(`门禁 ${result.gateId} 不得声明其他步骤主 artifact：${reservedOwner[0]}`);
      }
    }
    const stats = await lstat(canonicalPath);
    if (!stats.isFile()) throw new Error('门禁 artifact 不是普通文件：' + artifact.path);
    const content = await readFile(canonicalPath);
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== artifact.sha256) throw new Error('门禁 artifact hash 不匹配：' + artifact.path);
    if (isPrimaryArtifact && artifact.kind === 'plan') {
      validateDesignArtifact(parseJsonArtifact(content, artifact.path), result, artifact.path);
    }
    if (isPrimaryArtifact && artifact.kind === 'manifest') {
      validateImplementationArtifact(parseJsonArtifact(content, artifact.path), result, artifact.path);
    }
    if (artifact.kind === 'command-report') {
      const report = parseJsonArtifact(content, artifact.path);
      if (!Array.isArray(report.findings)) {
        throw new Error('QA artifact findings 必须是数组：' + artifact.path);
      }
      const reportFindings = parseReviewArtifactFindings(report, artifact.path);
      assertArtifactFindingSetMatches(result, reportFindings, 'QA');
      const reportChecks = reportCheckCandidates(report);
      const parsedReportChecks = reportChecks.map((item: unknown, index: number) => {
        const parsed = GateCheckSchema.safeParse(item);
        if (!parsed.success) throw new Error(`QA artifact checks[${index}] 格式错误`);
        return parsed.data;
      });
      const reportIds = new Set(parsedReportChecks.map((check) => check.id));
      const resultIds = new Set(result.checks.map((check) => check.id));
      if (reportIds.size !== parsedReportChecks.length
        || resultIds.size !== result.checks.length
        || reportIds.size !== resultIds.size
        || [...reportIds].some((id) => !resultIds.has(id))) {
        throw new Error('QA 命令集合与 artifact 不一致');
      }
      for (const check of result.checks) {
        const matched = parsedReportChecks.some((candidateCheck) =>
          gateChecksSemanticallyEqual(candidateCheck, check));
        if (!matched) throw new Error('QA 命令证据与 artifact 不一致：' + check.id);
      }
      validateVerificationCoverage(report, parsedReportChecks, result, artifact.path);
      await verifyBuildArtifactReference(report, canonicalProjectRoot, artifact.path);
      if (report.status !== undefined && report.status !== 'pass') {
        throw new Error('QA artifact 未通过：' + artifact.path);
      }
      if (Array.isArray(report.unverified) && report.unverified.length > 0) {
        throw new Error('QA artifact 仍有必需证据未验证');
      }
      if (Array.isArray(report.requirementResults) && report.requirementResults.some((item) => {
        if (!item || typeof item !== 'object') return true;
        const status = (item as Record<string, unknown>).status;
        return status === 'fail' || status === 'blocked' || status === 'unverified';
      })) {
        throw new Error('QA artifact 仍有失败或未验证需求');
      }
    }
    if (artifact.kind === 'runtime-report') {
      const report = parseJsonArtifact(content, artifact.path);
      validateRuntimeArtifact(report, result, artifact.path);
    }
    if (artifact.kind === 'review-report') {
      const report = parseJsonArtifact(content, artifact.path);
      if (!Array.isArray(report.findings)) {
        throw new Error('审查 artifact findings 必须是数组：' + artifact.path);
      }
      const hasWaivers = result.findings.some((finding) => finding.status === 'waived')
        || (Array.isArray(report.waivers) && report.waivers.length > 0);
      const expectedDecision = hasWaivers
        ? 'approved-with-waiver'
        : 'approved';
      if (report.status !== 'pass' || report.decision !== expectedDecision) {
        throw new Error('审查 artifact 没有批准当前门禁');
      }
      if (result.gateId === 'final-review') {
        validateFinalReviewArtifact(report, result, artifact.path);
        await verifyFinalEvidenceChainReference(report, canonicalRoot);
        for (const field of ['waivers', 'notReviewed', 'residualRisks', 'requirementCoverage']) {
          if (!Array.isArray(report[field])) {
            throw new Error(`最终审查 artifact ${field} 必须是数组`);
          }
        }
        if (Array.isArray(report.notReviewed) && report.notReviewed.length > 0) {
          throw new Error('最终审查 artifact 仍有未审查范围');
        }
        if (Array.isArray(report.residualRisks) && report.residualRisks.some((item) => {
          if (!item || typeof item !== 'object') return true;
          const risk = item as Record<string, unknown>;
          return risk.required !== false
            && (risk.status === 'blocked' || risk.status === 'unverified' || risk.status === 'fail');
        })) {
          throw new Error('最终审查 artifact 仍有必需风险未验证');
        }
      }
      const reportFindingsRaw = report.findings;
      const waiverIndex = buildWaiverIndex(report.waivers ?? report.waiverRegistry);
      // 两侧用同一套归一化（含 waiverId → waivers[]），避免 waived 被误降成 resolved 后对不上
      const normalizedReportFindings = parseReviewArtifactFindings(report, artifact.path);
      if (result.gateId === 'change-review') {
        validateChangeReviewArtifact(report, result, reportFindingsRaw, waiverIndex);
      }
      const artifactBlocking = normalizedReportFindings.filter((finding) =>
        (finding.severity === 'P0' || finding.severity === 'P1') && finding.status === 'open');
      if (artifactBlocking.length > 0) throw new Error('审查 artifact 仍有开放 P0/P1');
      for (const finding of result.findings) {
        const matched = normalizedReportFindings.some((candidate) =>
          candidate.id === finding.id
          && candidate.severity === finding.severity
          && candidate.status === finding.status);
        if (!matched) throw new Error('Gate finding 与审查 artifact 不一致：' + finding.id);
      }
      const resultIds = new Set(result.findings.map((finding) => finding.id));
      const reportIds = new Set(normalizedReportFindings.map((finding) => finding.id));
      if (resultIds.size !== result.findings.length
        || reportIds.size !== normalizedReportFindings.length
        || resultIds.size !== reportIds.size
        || [...reportIds].some((id) => !resultIds.has(id))) {
        throw new Error('Gate findings 与审查 artifact findings 集合不一致');
      }
    }
  }
  if (!primaryMatched) {
    throw new Error(`门禁 ${result.gateId} 必须声明规范主 artifact：${primary.fileName}`);
  }
}

function validateVerificationCoverage(
  report: Record<string, unknown>,
  checks: GateResult['checks'],
  result: GateResult,
  path: string,
): void {
  for (const field of ['implementationHash', 'changeReviewHash', 'projectFingerprint', 'buildHash']) {
    if (!hasSha256(report[field])) throw new Error(`${path} 的 ${field} 必须是 64 位 SHA-256`);
  }
  const discovered = requireArrayField(report, 'discoveredGates', path, { nonEmpty: true });
  const seen = new Set<string>();
  const checksById = new Map(checks.map((check) => [check.id, check]));
  for (const [index, item] of discovered.entries()) {
    const gate = typeof item === 'string'
      ? { id: item, required: true }
      : item && typeof item === 'object' && !Array.isArray(item)
        ? item as Record<string, unknown>
        : undefined;
    if (!gate || !hasText(gate.id)) {
      throw new Error(`${path} 的 discoveredGates[${index}] 缺少 id`);
    }
    const id = gate.id;
    if (seen.has(id)) throw new Error(`${path} 的 discoveredGates 包含重复 id：${id}`);
    seen.add(id);
    const required = gate.required !== false;
    if (!required && !hasText(gate.reason) && !hasText(gate.applicabilityEvidence)) {
      throw new Error(`${path} 的可选门禁 ${id} 必须说明不适用理由或证据`);
    }
    const executed = checksById.get(id);
    if (!executed) throw new Error(`${path} 发现的质量门禁未执行：${id}`);
    if (required && (!executed.required || executed.status !== 'pass' || executed.exitCode !== 0)) {
      throw new Error(`${path} 的必需质量门禁未真实通过：${id}`);
    }
  }

  const requirementResults = requireArrayField(report, 'requirementResults', path, { nonEmpty: true });
  for (const [index, item] of requirementResults.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${path} 的 requirementResults[${index}] 格式错误`);
    }
    const requirement = item as Record<string, unknown>;
    if (!hasText(requirement.id)
      || !hasText(requirement.status)
      || !Array.isArray(requirement.evidence)
      || requirement.evidence.length === 0) {
      throw new Error(`${path} 的 requirementResults[${index}] 缺少 id、status 或 evidence`);
    }
    if (requirement.status !== 'pass' && requirement.status !== 'waived') {
      throw new Error(`${path} 的需求仍未通过：${requirement.id}`);
    }
    if (requirement.status === 'waived') {
      const findingId = hasText(requirement.findingId) ? requirement.findingId : undefined;
      if (!findingId || !result.findings.some((finding) =>
        finding.id === findingId && finding.status === 'waived')) {
        throw new Error(`${path} 的 waived 需求必须指向有效 waived finding：${requirement.id}`);
      }
    }
  }
  assertRequirementIdsMatch(
    'QA requirementResults',
    result.requirementIds,
    requirementResults.map((item) => (item as Record<string, unknown>).id),
  );

  if (!Array.isArray(report.unverified)) throw new Error(`${path} 的 unverified 必须是数组`);
  const resourcePreflight = report.resourcePreflight;
  if (!resourcePreflight || typeof resourcePreflight !== 'object' || Array.isArray(resourcePreflight)) {
    throw new Error(`${path} 缺少 resourcePreflight`);
  }
  const preflight = resourcePreflight as Record<string, unknown>;
  if (preflight.status !== 'pass' && preflight.status !== 'not-applicable') {
    throw new Error(`${path} 的 resourcePreflight 未通过`);
  }
  if (preflight.status === 'not-applicable' && !hasText(preflight.reason)) {
    throw new Error(`${path} 的 resourcePreflight 不适用时必须说明原因`);
  }
}

export interface GateLineageContext {
  canonicalSpecHash: string;
  canonicalRequirementIds: readonly string[];
  projectFingerprint: string;
  /** 由控制器在本次步骤启动前捕获；实现重跑时不能用旧 attempt 的结束快照冒充。 */
  stepStartFingerprint?: string;
  previousRuns: readonly GateRun[];
}

/**
 * 校验主 artifact 内的 hash 关系，防止拿“格式正确但属于旧轮次”的报告冒充本次证据。
 * 调用前应先 verifyGateArtifacts，保证路径与内容 hash 已验真。
 */
export async function assertGateLineage(
  stepId: PipelineStepId,
  result: GateResult,
  context: GateLineageContext,
): Promise<void> {
  if (!hasSha256(context.canonicalSpecHash)) throw new Error('canonical Spec hash 无效');
  if (context.canonicalRequirementIds.length === 0) throw new Error('canonical Spec 缺少稳定需求 ID');
  if (!hasSha256(context.projectFingerprint)) throw new Error('项目 fingerprint 无效');
  if (context.stepStartFingerprint !== undefined && !hasSha256(context.stepStartFingerprint)) {
    throw new Error('步骤启动 fingerprint 无效');
  }
  const contract = PRIMARY_EVIDENCE_ARTIFACT[result.gateId];
  assertRequirementIdsMatch('Gate requirementIds', context.canonicalRequirementIds, result.requirementIds);
  const primary = result.artifacts.find((artifact) => basename(artifact.path) === contract.fileName);
  if (!primary) throw new Error(`门禁 ${result.gateId} 缺少主 artifact lineage`);
  const report = parseJsonArtifact(await readFile(primary.path), primary.path);
  const latest = latestGateRuns(context.previousRuns);
  const artifactHash = (gateId: GateId): string | undefined => {
    const run = latest.get(gateId);
    if (!run) return undefined;
    const expected = PRIMARY_EVIDENCE_ARTIFACT[gateId].fileName;
    return run.result.artifacts.find((artifact) => basename(artifact.path) === expected)?.sha256;
  };
  const artifactReport = async (gateId: GateId): Promise<Record<string, unknown> | undefined> => {
    const run = latest.get(gateId);
    if (!run) return undefined;
    const expected = PRIMARY_EVIDENCE_ARTIFACT[gateId].fileName;
    const artifact = run.result.artifacts.find((candidate) => basename(candidate.path) === expected);
    if (!artifact) return undefined;
    const content = await readFile(artifact.path);
    const actualHash = createHash('sha256').update(content).digest('hex');
    if (actualHash !== artifact.sha256) {
      throw new Error(`${gateId} lineage artifact hash 不匹配`);
    }
    return parseJsonArtifact(content, artifact.path);
  };
  const requireMatch = (field: string, expected: string | undefined, label: string) => {
    if (!expected || report[field] !== expected) {
      throw new Error(`${label} lineage 不一致：${field} 未指向本轮权威证据`);
    }
  };

  switch (stepId) {
    case 'architect':
      requireMatch('contractHash', context.canonicalSpecHash, '设计');
      requireMatch('projectFingerprint', context.projectFingerprint, '设计');
      if (context.stepStartFingerprint
        && context.stepStartFingerprint !== context.projectFingerprint) {
        throw new FingerprintDriftError(
          'design',
          'architect',
          '设计步骤执行期间项目快照发生变化；架构门禁必须保持源码只读',
        );
      }
      break;
    case 'dev': {
      requireMatch('contractHash', context.canonicalSpecHash, '实现');
      requireMatch('planHash', artifactHash('design'), '实现');
      const previousImplementation = latest.get('implementation');
      const design = latest.get('design');
      requireMatch(
        'fingerprintBefore',
        context.stepStartFingerprint
          ?? previousImplementation?.projectFingerprint
          ?? design?.projectFingerprint,
        '实现',
      );
      requireMatch('fingerprintAfter', context.projectFingerprint, '实现');
      break;
    }
    case 'review':
      requireMatch('implementationFingerprint', context.projectFingerprint, '变更审查');
      requireMatch('reviewFingerprint', context.projectFingerprint, '变更审查');
      break;
    case 'qa':
      requireMatch('implementationHash', artifactHash('implementation'), 'QA');
      requireMatch('changeReviewHash', artifactHash('change-review'), 'QA');
      requireMatch('projectFingerprint', context.projectFingerprint, 'QA');
      if (!hasSha256(report.buildHash)) throw new Error('QA lineage 不一致：buildHash 无效');
      break;
    case 'runtime_audit': {
      const verificationReport = await artifactReport('verification');
      requireMatch('verificationHash', artifactHash('verification'), '运行时审计');
      requireMatch('projectFingerprint', context.projectFingerprint, '运行时审计');
      requireMatch(
        'buildHash',
        hasSha256(verificationReport?.buildHash) ? verificationReport.buildHash : undefined,
        '运行时审计',
      );
      break;
    }
    case 'final_review':
      requireMatch('finalFingerprint', context.projectFingerprint, '最终审查');
      break;
    default:
      break;
  }
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function requireArrayField(
  report: Record<string, unknown>,
  field: string,
  path: string,
  options: { nonEmpty?: boolean } = {},
): unknown[] {
  const value = report[field];
  if (!Array.isArray(value) || (options.nonEmpty && value.length === 0)) {
    throw new Error(`${path} 的 ${field} 必须是${options.nonEmpty ? '非空' : ''}数组`);
  }
  return value;
}

function parseArtifactChecks(checks: unknown[], path: string): GateResult['checks'] {
  return checks.map((item, index) => {
    const parsed = GateCheckSchema.safeParse(item);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `${path} 的 checks[${index}] 格式错误：${issue?.path.join('.') || '(根)'} ${issue?.message ?? ''}`.trim(),
      );
    }
    return parsed.data;
  });
}

function validateDesignArtifact(
  report: Record<string, unknown>,
  result: GateResult,
  path: string,
): void {
  for (const field of ['contractHash', 'projectFingerprint']) {
    if (!hasSha256(report[field])) throw new Error(`${path} 的 ${field} 必须是 64 位 SHA-256`);
  }
  const traces = requireArrayField(report, 'requirementTrace', path, { nonEmpty: true });
  for (const [index, item] of traces.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${path} 的 requirementTrace[${index}] 格式错误`);
    }
    const trace = item as Record<string, unknown>;
    if (!hasText(trace.requirementId)
      || !Array.isArray(trace.implementationPoints) || trace.implementationPoints.length === 0
      || !Array.isArray(trace.verificationPoints) || trace.verificationPoints.length === 0) {
      throw new Error(`${path} 的 requirementTrace[${index}] 缺少需求、实现点或验证点`);
    }
  }
  assertRequirementIdsMatch(
    '设计 requirementTrace',
    result.requirementIds,
    traces.map((item) => (item as Record<string, unknown>).requirementId),
  );
  const risks = requireArrayField(report, 'riskAssessments', path);
  for (const [index, item] of risks.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${path} 的 riskAssessments[${index}] 格式错误`);
    }
    const risk = item as Record<string, unknown>;
    const hasEvidence = hasText(risk.evidence)
      || (Array.isArray(risk.evidence) && risk.evidence.length > 0);
    if (!hasText(risk.id) || !hasText(risk.disposition) || !hasEvidence) {
      throw new Error(`${path} 的 riskAssessments[${index}] 缺少 id、disposition 或 evidence`);
    }
    if (risk.disposition === 'applicable' && (!risk.control || !risk.verification)) {
      throw new Error(`${path} 的 riskAssessments[${index}] 缺少控制或验证方案`);
    }
  }
  requireArrayField(report, 'allowedPaths', path, { nonEmpty: true });
  requireArrayField(report, 'testPlan', path, { nonEmpty: true });
  const checks = parseArtifactChecks(
    requireArrayField(report, 'checks', path, { nonEmpty: true }),
    path,
  );
  const checkIds = checks.map((check) => check.id);
  if (new Set(checkIds).size !== checkIds.length) {
    throw new Error(`${path} 的 checks 包含重复 id`);
  }
  if (!checks.some((check) => check.required && check.status === 'pass' && check.exitCode === 0)) {
    throw new Error(`${path} 的 checks 至少需要一项 required=true 的真实通过检查`);
  }
  for (const check of checks) {
    if (!result.checks.some((candidate) => gateChecksSemanticallyEqual(candidate, check))) {
      throw new Error(`设计 artifact 的检查未在 Gate 结果中完整声明：${check.id}`);
    }
  }
  if (report.status !== 'pass') {
    throw new Error(`设计 artifact 未通过：${path}`);
  }
}

function validateImplementationArtifact(
  report: Record<string, unknown>,
  result: GateResult,
  path: string,
): void {
  for (const field of ['contractHash', 'planHash', 'fingerprintBefore', 'fingerprintAfter']) {
    if (!hasSha256(report[field])) throw new Error(`${path} 的 ${field} 必须是 64 位 SHA-256`);
  }
  requireArrayField(report, 'changedFiles', path, { nonEmpty: true });
  const implementations = requireArrayField(report, 'requirementImplementations', path, { nonEmpty: true });
  for (const [index, item] of implementations.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${path} 的 requirementImplementations[${index}] 格式错误`);
    }
    const implementation = item as Record<string, unknown>;
    if (!hasText(implementation.requirementId)
      || !Array.isArray(implementation.files) || implementation.files.length === 0) {
      throw new Error(`${path} 的 requirementImplementations[${index}] 缺少需求或文件追踪`);
    }
  }
  assertRequirementIdsMatch(
    '实现 requirementImplementations',
    result.requirementIds,
    implementations.map((item) => (item as Record<string, unknown>).requirementId),
  );
  const targeted = parseArtifactChecks(
    requireArrayField(report, 'targetedCheckResults', path, { nonEmpty: true }),
    path,
  );
  for (const check of targeted) {
    if (!result.checks.some((candidate) => gateChecksSemanticallyEqual(candidate, check))) {
      throw new Error(`实现 artifact 的目标检查未在 Gate 结果中完整声明：${check.id}`);
    }
  }
  if (report.status !== 'pass') {
    throw new Error(`实现 artifact 未通过：${path}`);
  }
}

function validateRuntimeArtifact(
  report: Record<string, unknown>,
  result: GateResult,
  path: string,
): void {
  if (report.status !== result.status) throw new Error('运行时 artifact 状态与 Gate 结果不一致');
  if (!Array.isArray(report.findings)) throw new Error(`运行时 artifact findings 必须是数组：${path}`);
  const findings = parseReviewArtifactFindings(report, path);
  assertArtifactFindingSetMatches(result, findings, '运行时');
  for (const field of ['buildHash', 'projectFingerprint', 'verificationHash']) {
    if (!hasSha256(report[field])) throw new Error(`${path} 的 ${field} 必须是 64 位 SHA-256`);
  }

  if (result.status === 'not-applicable') {
    const applicability = report.applicability;
    if (!applicability || typeof applicability !== 'object' || Array.isArray(applicability)) {
      throw new Error(`运行时不适用 artifact 缺少 applicability：${path}`);
    }
    const detail = applicability as Record<string, unknown>;
    if (!hasText(detail.reason) || !Array.isArray(detail.evidence) || detail.evidence.length === 0) {
      throw new Error(`运行时不适用 artifact 必须包含 reason 和非空 evidence：${path}`);
    }
    return;
  }

  for (const field of ['environment', 'buildHash']) {
    if (!hasText(report[field])) throw new Error(`${path} 缺少 ${field}`);
  }
  const surfaces = requireArrayField(report, 'surfaceMatrix', path, { nonEmpty: true });
  for (const [index, item] of surfaces.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${path} 的 surfaceMatrix[${index}] 格式错误`);
    }
    const surface = item as Record<string, unknown>;
    const requiredStates = Array.isArray(surface.requiredStates) ? surface.requiredStates : [];
    const results = Array.isArray(surface.results) ? surface.results : [];
    const missing = requiredStates.filter((state) => !results.some((entry) =>
      !!entry && typeof entry === 'object' && !Array.isArray(entry)
      && (entry as Record<string, unknown>).state === state
      && (entry as Record<string, unknown>).status === 'pass'));
    if ((surface.priority === 'P0' || surface.priority === 'P1') && missing.length > 0) {
      throw new Error(`${path} 的 surfaceMatrix[${index}] 缺少必需状态：${missing.join('、')}`);
    }
  }
  const requiredBrowsers = Array.isArray(report.requiredBrowsers) ? report.requiredBrowsers : [];
  const browserResults = Array.isArray(report.browserAndViewportResults)
    ? report.browserAndViewportResults : [];
  for (const browser of requiredBrowsers) {
    // P1 修复：不只检查浏览器名称存在，还要求 status=pass。
    // 旧代码 chromium/status=fail 也会算完成。
    if (!browserResults.some((entry) => !!entry && typeof entry === 'object' && !Array.isArray(entry)
      && (entry as Record<string, unknown>).browser === browser
      && (entry as Record<string, unknown>).status === 'pass')) {
      throw new Error(`${path} 缺少必需浏览器通过证据：${String(browser)}`);
    }
  }
  if (!Array.isArray(report.unverified)) throw new Error(`运行时 artifact unverified 必须是数组：${path}`);
  if (report.unverified.length > 0) throw new Error('运行时 artifact 仍有未验证边界');
}

function assertArtifactFindingSetMatches(
  result: GateResult,
  artifactFindings: GateResult['findings'],
  label: string,
): void {
  const resultById = new Map(result.findings.map((finding) => [finding.id, finding]));
  if (resultById.size !== result.findings.length || artifactFindings.length !== result.findings.length) {
    throw new Error(`${label} Gate findings 与 artifact findings 集合不一致`);
  }
  for (const finding of artifactFindings) {
    const matched = resultById.get(finding.id);
    if (!matched || matched.severity !== finding.severity || matched.status !== finding.status) {
      throw new Error(`${label} Gate finding 与 artifact 不一致：${finding.id}`);
    }
  }
}

function validateFinalReviewArtifact(
  report: Record<string, unknown>,
  result: GateResult,
  path: string,
): void {
  if (!hasSha256(report.finalFingerprint)) {
    throw new Error(`${path} 的 finalFingerprint 必须是 64 位 SHA-256`);
  }
  if (!hasText(report.reviewedDiff)) throw new Error(`${path} 缺少 reviewedDiff`);
  const reviewScope = report.reviewScope;
  if (!reviewScope || typeof reviewScope !== 'object' || Array.isArray(reviewScope)
    || !Array.isArray((reviewScope as Record<string, unknown>).changedFiles)) {
    throw new Error(`${path} 缺少 reviewScope.changedFiles`);
  }
  const evidenceChain = report.evidenceChain;
  if (!evidenceChain || typeof evidenceChain !== 'object' || Array.isArray(evidenceChain)) {
    throw new Error(`${path} 的 evidenceChain 必须包含控制器文件 path 与 sha256`);
  }
  const chainReference = evidenceChain as Record<string, unknown>;
  if (!hasText(chainReference.path) || !isAbsolute(chainReference.path) || !hasSha256(chainReference.sha256)) {
    throw new Error(`${path} 的 evidenceChain.path 必须是绝对路径且 sha256 必须有效`);
  }
  const residualRisks = requireArrayField(report, 'residualRisks', path);
  const requirementCoverage = requireArrayField(report, 'requirementCoverage', path, { nonEmpty: true });
  assertRequirementIdsMatch(
    '最终审查 requirementCoverage',
    result.requirementIds,
    requirementCoverage.map((item) => item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>).id
      : undefined),
  );
  const findingIds = new Set(result.findings.map((finding) => finding.id));
  for (const [index, item] of residualRisks.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${path} 的 residualRisks[${index}] 格式错误`);
    }
    const risk = item as Record<string, unknown>;
    if (risk.status !== 'pass' && risk.status !== 'resolved' && !hasText(risk.id)) {
      throw new Error(`${path} 的 residualRisks[${index}] 缺少 finding id`);
    }
    if (hasText(risk.id) && risk.status !== 'pass' && risk.status !== 'resolved' && !findingIds.has(risk.id)) {
      throw new Error(`${path} 的 residual risk 未纳入 Gate findings：${risk.id}`);
    }
  }
}

function validateChangeReviewArtifact(
  report: Record<string, unknown>,
  result: GateResult,
  reportFindings: unknown[],
  waiverIndex?: WaiverIndex,
): void {
  if (report.status !== result.status) throw new Error('变更审查 artifact 状态与 Gate 结果不一致');
  if (report.implementationFingerprint !== report.reviewFingerprint) {
    throw new Error('变更审查 artifact 的实现与审查 fingerprint 不一致');
  }
  const reviewScope = report.reviewScope;
  if (!reviewScope || typeof reviewScope !== 'object' || Array.isArray(reviewScope)) {
    throw new Error('变更审查 artifact 缺少 reviewScope');
  }
  const scope = reviewScope as Record<string, unknown>;
  if (!Array.isArray(scope.changedFiles) || scope.changedFiles.length === 0) {
    throw new Error('变更审查 artifact 没有完整 changedFiles');
  }
  for (const field of ['staged', 'unstaged', 'untracked', 'deleted']) {
    if (!Array.isArray(scope[field])) throw new Error('变更审查 artifact 缺少 reviewScope.' + field);
  }
  const discrepancies = scope.discrepancies;
  if (!discrepancies || typeof discrepancies !== 'object' || Array.isArray(discrepancies)) {
    throw new Error('变更审查 artifact 缺少范围差异核对');
  }
  const values = discrepancies as Record<string, unknown>;
  if (!Array.isArray(values.statusNotInManifest) || !Array.isArray(values.manifestNotInStatus)) {
    throw new Error('变更审查 artifact 范围差异格式错误');
  }
  if (values.statusNotInManifest.length > 0 || values.manifestNotInStatus.length > 0) {
    throw new Error('变更审查 artifact 仍有未解决的范围差异');
  }
  if (!Array.isArray(report.requirementCoverage) || report.requirementCoverage.length === 0) {
    throw new Error('变更审查 artifact 缺少需求覆盖');
  }
  assertRequirementIdsMatch(
    '变更审查 requirementCoverage',
    result.requirementIds,
    report.requirementCoverage.map((item) => item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>).id
      : undefined),
  );
  const incompleteRequirements = report.requirementCoverage.filter((item) => {
    if (!item || typeof item !== 'object') return true;
    const coverage = item as Record<string, unknown>;
    if (typeof coverage.id !== 'string' || typeof coverage.status !== 'string') return true;
    return (coverage.priority === 'P0' || coverage.priority === 'P1')
      && coverage.status !== 'pass'
      && coverage.status !== 'waived';
  });
  if (incompleteRequirements.length > 0) throw new Error('变更审查 artifact 的需求覆盖不完整');
  if (!Array.isArray(report.notReviewed) || !Array.isArray(report.residualRisks)) {
    throw new Error('变更审查 artifact 必须显式声明未覆盖范围和残余风险');
  }
  for (const item of reportFindings) {
    if (!item || typeof item !== 'object') throw new Error('变更审查 artifact finding 格式错误');
    const finding = item as Record<string, unknown>;
    if (typeof finding.id !== 'string'
      || typeof finding.severity !== 'string'
      || typeof finding.status !== 'string'
      || typeof finding.summary !== 'string') {
      throw new Error('变更审查 artifact finding 缺少标识、级别、状态或摘要');
    }
    if (finding.severity === 'P0' || finding.severity === 'P1') {
      if (!Array.isArray(finding.evidence) || finding.evidence.length === 0
        || typeof finding.impact !== 'string'
        || typeof finding.confidence !== 'string') {
        throw new Error('变更审查 artifact 的 P0/P1 finding 缺少证据、影响或置信度');
      }
      if (finding.category === 'security' && typeof finding.exploitability !== 'string') {
        throw new Error('变更审查 artifact 的安全 P0/P1 finding 缺少可达性');
      }
    }
    if (finding.status === 'waived') {
      const resolved = resolveWaiverForFinding(finding, waiverIndex);
      if (!resolved || Date.parse(resolved.expiresAt) <= Date.now()) {
        throw new Error('变更审查 artifact 的 waiver 不完整或已过期');
      }
    }
  }
}

async function verifyFinalEvidenceChainReference(
  report: Record<string, unknown>,
  evidenceRoot: string,
): Promise<void> {
  const reference = report.evidenceChain as Record<string, unknown>;
  const declaredPath = resolve(reference.path as string);
  const expectedPath = resolve(evidenceRoot, 'evidence-chain.json');
  const stats = await lstat(expectedPath).catch(() => {
    throw new Error('最终审查引用的控制器证据链不可读取');
  });
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('最终审查引用的控制器证据链必须是普通文件且不能是符号链接');
  }
  const declaredStats = await lstat(declaredPath).catch(() => {
    throw new Error('最终审查声明的 evidenceChain 路径不可读取');
  });
  if (declaredStats.isSymbolicLink() || !declaredStats.isFile()) {
    throw new Error('最终审查声明的 evidenceChain 必须是普通文件且不能是符号链接');
  }
  const canonicalPath = await realpath(expectedPath);
  const canonicalDeclaredPath = await realpath(declaredPath);
  if (canonicalDeclaredPath !== canonicalPath) {
    throw new Error('最终审查 evidenceChain 必须指向当前工作流的控制器证据链');
  }
  const content = await readFile(canonicalPath);
  const actualHash = createHash('sha256').update(content).digest('hex');
  if (reference.sha256 !== actualHash) {
    throw new Error('最终审查 evidenceChain hash 与控制器证据链不一致');
  }
  const chain = parseJsonArtifact(content, canonicalPath);
  if (chain.schemaVersion !== '2.0'
    || chain.generatedBy !== 'agent-os-controller'
    || chain.controllerOwned !== true) {
    throw new Error('最终审查引用的 evidenceChain 不是控制器拥有的 v2 证据链');
  }
}

async function verifyBuildArtifactReference(
  report: Record<string, unknown>,
  projectRoot: string | undefined,
  reportPath: string,
): Promise<void> {
  // 纯源码包可以明确用已验证项目快照作为 buildHash；它会由 fingerprint lineage 持续复核。
  if (report.buildHash === report.projectFingerprint) return;
  const reference = report.buildArtifact;
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
    throw new Error(`${reportPath} 的独立 buildHash 必须提供 buildArtifact.path/sha256`);
  }
  const build = reference as Record<string, unknown>;
  if (!hasText(build.path) || !isAbsolute(build.path) || !hasSha256(build.sha256)) {
    throw new Error(`${reportPath} 的 buildArtifact.path 必须是绝对路径且 sha256 必须有效`);
  }
  if (build.sha256 !== report.buildHash) {
    throw new Error(`${reportPath} 的 buildArtifact.sha256 与 buildHash 不一致`);
  }
  if (!projectRoot) throw new Error('复核独立构建产物需要当前项目根目录');
  const declaredPath = resolve(build.path);
  const stats = await lstat(declaredPath).catch(() => {
    throw new Error(`${reportPath} 的 buildArtifact 不可读取：${declaredPath}`);
  });
  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
    throw new Error(`${reportPath} 的 buildArtifact 必须是普通文件或目录且不能是符号链接`);
  }
  const canonicalPath = await realpath(declaredPath);
  const rel = relative(projectRoot, canonicalPath);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`${reportPath} 的 buildArtifact 必须位于项目根目录内且不能等于项目根目录`);
  }
  const actual = await hashPathArtifact(canonicalPath);
  if (actual.sha256 !== report.buildHash) {
    throw new Error(`${reportPath} 的 buildArtifact 已变化或 hash 不真实`);
  }
}

function parseJsonArtifact(content: Buffer, path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root must be object');
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error('门禁 artifact 不是有效 JSON：' + path + ' · ' + (error as Error).message);
  }
}

function assertRequirementIdsMatch(
  label: string,
  expectedValues: readonly string[],
  actualValues: readonly unknown[],
): void {
  const expected = new Set(expectedValues);
  const actualIds = actualValues.filter((value): value is string => typeof value === 'string');
  const actual = new Set(actualIds);
  if (expected.size !== expectedValues.length
    || actualIds.length !== actualValues.length
    || actual.size !== actualIds.length
    || expected.size !== actual.size
    || [...expected].some((id) => !actual.has(id))) {
    throw new Error(`${label} 与 canonical Spec 不一致`);
  }
}

function parseReviewArtifactFindings(
  report: Record<string, unknown>,
  path: string,
): GateResult['findings'] {
  if (!Array.isArray(report.findings)) {
    throw new Error('审查 artifact findings 必须是数组：' + path);
  }
  const waiverIndex = buildWaiverIndex(report.waivers ?? report.waiverRegistry);
  return report.findings.map((item, index) => {
    const parsed = GateFindingSchema.safeParse(normalizeFindingInput(item, waiverIndex));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        `审查 artifact findings[${index}] 格式错误：${issue?.path.join('.') || '(根)'} ${issue?.message ?? ''}`.trim(),
      );
    }
    return parsed.data;
  });
}

export function createGateRun(
  stepId: PipelineStepId,
  result: GateResult,
  previousRuns: readonly GateRun[],
  projectFingerprint?: string,
  stepStartFingerprint?: string,
): GateRun {
  const attempt = previousRuns.filter((run) => run.gateId === result.gateId).length + 1;
  return GateRunSchema.parse({
    id: randomUUID(),
    gateId: result.gateId,
    stepId,
    attempt,
    status: result.status,
    stepStartFingerprint,
    projectFingerprint,
    result,
    recordedAt: new Date().toISOString(),
  });
}

export function latestGateRuns(runs: readonly GateRun[]): Map<GateId, GateRun> {
  const latest = new Map<GateId, GateRun>();
  for (const run of runs) {
    const current = latest.get(run.gateId);
    if (!current) {
      latest.set(run.gateId, run);
    } else if (run.attempt > current.attempt) {
      // P1 修复：如果新 attempt 是 pass，直接覆盖（即使旧的是更高 attempt 的 fail）。
      // 如果新 attempt 是 fail 但 attempt 更高，仍覆盖（记录最新状态）。
      // 但如果新 attempt 是 fail 而旧的是 pass，不覆盖（保留最后一次 pass）。
      if (run.status === 'pass' || current.status !== 'pass') {
        latest.set(run.gateId, run);
      }
    }
  }
  return latest;
}

/**
 * 返回每个 gate 最新一次 pass 的 run（用于完成时校验证据链）。
 * 如果没有 pass 的 run，则不在返回的 Map 中。
 */
export function latestAcceptedGateRuns(runs: readonly GateRun[]): Map<GateId, GateRun> {
  const latest = new Map<GateId, GateRun>();
  for (const run of runs) {
    if (run.status !== 'pass') continue;
    const current = latest.get(run.gateId);
    if (!current || run.attempt > current.attempt) {
      latest.set(run.gateId, run);
    }
  }
  return latest;
}

/**
 * 返回最新门禁中仍未收敛的可选检查。
 *
 * 唯一可消除开发环境缺证的委派契约是：
 * - implementation check 显式写入 delegatedTo=verification；
 * - 最新 verification gate 在 implementation 之后记录且整体通过；
 * - QA 以完全相同的 id、原始 argv 和 cwd 运行该检查，并以
 *   required=true/status=pass/exitCode=0 提供证据；
 * - 两个 gate 对应同一项目 fingerprint。
 *
 * 因此不会按 id 前缀、子串、摘要或“有一项 QA 通过”做模糊匹配。
 * 无委派、委派未被最新 QA 精确覆盖，或其他 gate 的可选缺口均保留。
 */
export function unresolvedOptionalCheckGapIds(runs: readonly GateRun[]): string[] {
  const latest = latestGateRuns(runs);
  const gaps: string[] = [];
  for (const sourceRun of latest.values()) {
    for (const sourceCheck of sourceRun.result.checks) {
      if (sourceCheck.required || sourceCheck.status === 'pass') continue;
      let covered = false;
      if (sourceRun.gateId === 'implementation'
        && sourceCheck.delegatedTo === 'verification') {
        const verification = latest.get('verification');
        const targetCheck = verification?.result.checks
          .find((check) => check.id === sourceCheck.id);
        covered = !!verification
          && verification.status === 'pass'
          && verification.result.status === 'pass'
          && Date.parse(verification.recordedAt) > Date.parse(sourceRun.recordedAt)
          && !!sourceRun.projectFingerprint
          && verification.projectFingerprint === sourceRun.projectFingerprint
          && !!targetCheck
          && targetCheck.required
          && targetCheck.status === 'pass'
          && targetCheck.exitCode === 0
          && isDeepStrictEqual(targetCheck.command, sourceCheck.command)
          && targetCheck.cwd === sourceCheck.cwd;
      }
      if (!covered) gaps.push(`${sourceRun.gateId}/${sourceCheck.id}`);
    }
  }
  return gaps;
}

const GATE_SEQUENCE: readonly GateId[] = [
  'design',
  'implementation',
  'change-review',
  'verification',
  'runtime-audit',
  'final-review',
];

/**
 * 按门禁顺序合并同一 finding 的最新处置。后续门禁必须使用同一 ID，
 * 因而 resolved 可以覆盖上游 open，而“后续没有提到”不会让风险凭空消失。
 */
export function consolidateLatestGateFindings(
  runs: readonly GateRun[],
): GateResult['findings'] {
  const latest = latestGateRuns(runs);
  const findings = new Map<string, GateResult['findings'][number]>();
  for (const gateId of GATE_SEQUENCE) {
    const run = latest.get(gateId);
    if (!run) continue;
    for (const finding of run.result.findings) findings.set(finding.id, finding);
  }
  return [...findings.values()];
}

/** 最终审查必须显式继承上游仍未 resolved 的风险，禁止靠省略 finding 获得批准。 */
export function assertOutstandingFindingsCarriedForward(
  previousRuns: readonly GateRun[],
  finalResult: GateResult,
): void {
  if (finalResult.gateId !== 'final-review') return;
  const upstream = consolidateLatestGateFindings(
    previousRuns.filter((run) => run.gateId !== 'final-review'),
  ).filter((finding) => finding.status !== 'resolved');
  const finalById = new Map(finalResult.findings.map((finding) => [finding.id, finding]));
  const missing = upstream.filter((finding) => !finalById.has(finding.id));
  if (missing.length > 0) {
    throw new Error('Gate findings 集合不一致：最终审查未继承上游残余风险 '
      + missing.map((finding) => finding.id).join('、'));
  }

  const severityRank = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;
  const downgraded = upstream.filter((finding) => {
    const current = finalById.get(finding.id);
    return !!current && severityRank[current.severity] > severityRank[finding.severity];
  });
  if (downgraded.length > 0) {
    throw new Error('Gate findings 集合不一致：最终审查不得静默降低残余风险级别 '
      + downgraded.map((finding) => finding.id).join('、'));
  }

  const withoutEvidence = upstream.filter((finding) =>
    (finalById.get(finding.id)?.evidence.length ?? 0) === 0);
  if (withoutEvidence.length > 0) {
    throw new Error('Gate findings 集合不一致：最终审查残余风险缺少可定位证据 '
      + withoutEvidence.map((finding) => finding.id).join('、'));
  }
}

/** 后续门禁发现代码树已偏离上游证据时抛出，供流水线退回重建而不是整单失败。 */
export class FingerprintDriftError extends Error {
  readonly rewindToStepId: PipelineStepId;
  readonly upstreamGateId: GateId;

  constructor(upstreamGateId: GateId, rewindToStepId: PipelineStepId, message: string) {
    super(message);
    this.name = 'FingerprintDriftError';
    this.upstreamGateId = upstreamGateId;
    this.rewindToStepId = rewindToStepId;
  }
}

export function isFingerprintDriftError(error: unknown): error is FingerprintDriftError {
  return error instanceof FingerprintDriftError
    || (error instanceof Error && error.name === 'FingerprintDriftError');
}

/** 从失败文案识别应退回的步骤（兼容旧错误、跨进程序列化）。 */
export function rewindStepIdFromDriftMessage(error: string | undefined): PipelineStepId | undefined {
  if (!error) return undefined;
  if (/设计步骤执行期间项目快照发生变化|架构门禁必须保持源码只读|重建设计证据/.test(error)) {
    return 'architect';
  }
  if (/implementation gate 不一致|重建实现证据|最新实现证据不一致|重新生成 implementation/.test(error)) {
    return 'dev';
  }
  if (/偏离 change-review|必须重新评审|与变更审查快照不一致/.test(error)) return 'review';
  if (/偏离 QA|必须重新验证|最终审查后的项目快照已变化|与 QA 验证快照不一致|与运行时审计快照不一致/.test(error)) {
    return 'qa';
  }
  return undefined;
}

export function requiredGateIdsForSteps(stepIds: readonly PipelineStepId[]): GateId[] {
  return stepIds.map(gateIdForStep).filter((id): id is GateId => id !== undefined);
}

/** 防止跨 Gate 返工形成无限自动循环和无上限模型/命令开销。 */
export function assertGateAttemptBudget(
  stepId: PipelineStepId,
  runs: readonly GateRun[],
  maxAttempts = 8,
): void {
  const gateId = gateIdForStep(stepId);
  if (!gateId) return;
  const attempts = runs.filter((run) => run.gateId === gateId).length;
  if (attempts >= maxAttempts) {
    throw new Error(`质量门禁 ${gateId} 已达到 ${maxAttempts} 次尝试上限；为避免无限返工，已停止自动续跑，请重新评估 Spec/方案后发起新工作流。`);
  }
}

/**
 * 最终审查前由控制器生成证据链；Agent 只读，避免任何角色手工同步 hash。
 * final-review 本身不进入该文件，防止证据链与终审报告形成循环依赖。
 */
export function buildEvidenceChainManifest(
  workflowId: string,
  stepIds: readonly PipelineStepId[],
  runs: readonly GateRun[],
  currentFingerprint: string,
  generatedAt = new Date().toISOString(),
): Record<string, unknown> {
  const finalIndex = stepIds.indexOf('final_review');
  const priorStepIds = finalIndex >= 0 ? stepIds.slice(0, finalIndex) : stepIds;
  const requiredGateIds = requiredGateIdsForSteps(priorStepIds);
  const latest = latestGateRuns(runs);
  const gateRuns = requiredGateIds.map((gateId) => {
    const run = latest.get(gateId);
    if (!run) throw new Error('生成证据链时缺少必需门禁：' + gateId);
    const accepted = run.status === 'pass'
      || (gateId === 'runtime-audit' && run.status === 'not-applicable');
    if (!accepted) throw new Error(`生成证据链时门禁未通过：${gateId}(${run.status})`);
    return run;
  });
  const verification = latest.get('verification');
  if (!verification?.projectFingerprint) throw new Error('生成证据链时缺少 QA 验证 fingerprint');
  if (verification.projectFingerprint !== currentFingerprint) {
    throw new FingerprintDriftError(
      'verification',
      'qa',
      '生成最终证据链时当前项目快照已偏离 QA，必须重新验证',
    );
  }
  const implementation = latest.get('implementation');
  const changeReview = latest.get('change-review');
  const runtime = latest.get('runtime-audit');
  if (implementation && changeReview
    && implementation.projectFingerprint !== changeReview.projectFingerprint) {
    throw new FingerprintDriftError(
      'implementation',
      'dev',
      '生成最终证据链时变更审查快照与实现快照不一致',
    );
  }
  if (changeReview && changeReview.projectFingerprint !== verification.projectFingerprint) {
    throw new FingerprintDriftError(
      'change-review',
      'review',
      '生成最终证据链时 QA 快照与变更审查快照不一致',
    );
  }
  if (runtime && runtime.projectFingerprint !== verification.projectFingerprint) {
    throw new FingerprintDriftError(
      'runtime-audit',
      'qa',
      '生成最终证据链时运行时审计快照与 QA 快照不一致',
    );
  }

  const artifacts = gateRuns.flatMap((run) => run.result.artifacts.map((artifact) => ({
    ...artifact,
    gateId: run.gateId,
    attempt: run.attempt,
  })));
  return {
    schemaVersion: '2.0',
    generatedBy: 'agent-os-controller',
    controllerOwned: true,
    workflowId,
    generatedAt,
    requiredGateIds,
    currentFingerprint,
    verifiedFingerprint: verification.projectFingerprint,
    gateRuns: gateRuns.map((run) => ({
      id: run.id,
      gateId: run.gateId,
      stepId: run.stepId,
      attempt: run.attempt,
      status: run.status,
      stepStartFingerprint: run.stepStartFingerprint,
      projectFingerprint: run.projectFingerprint,
      recordedAt: run.recordedAt,
    })),
    artifacts,
  };
}

export function assertEvidenceChainComplete(
  stepIds: readonly PipelineStepId[],
  runs: readonly GateRun[],
  currentFingerprint?: string,
): void {
  const latest = latestGateRuns(runs);
  for (const gateId of requiredGateIdsForSteps(stepIds)) {
    const run = latest.get(gateId);
    const accepted = run?.status === 'pass'
      || (gateId === 'runtime-audit' && run?.status === 'not-applicable');
    if (!accepted) throw new Error('必需质量门禁未通过：' + gateId);
  }
  const finalRun = latest.get('final-review');
  const verification = latest.get('verification');
  const implementation = latest.get('implementation');
  const changeReview = latest.get('change-review');
  const runtime = latest.get('runtime-audit');
  if (changeReview && implementation?.projectFingerprint !== changeReview.projectFingerprint) {
    throw new FingerprintDriftError(
      'implementation',
      'dev',
      '变更审查快照与最新实现证据不一致，修复后必须重新生成 implementation gate',
    );
  }
  if (verification && changeReview?.projectFingerprint !== verification.projectFingerprint) {
    throw new FingerprintDriftError(
      'change-review',
      'review',
      'QA 验证快照与变更审查快照不一致',
    );
  }
  if (finalRun && verification?.projectFingerprint !== finalRun.projectFingerprint) {
    throw new FingerprintDriftError(
      'verification',
      'qa',
      '最终审查快照与 QA 验证快照不一致',
    );
  }
  if (finalRun && runtime?.projectFingerprint !== finalRun.projectFingerprint) {
    throw new FingerprintDriftError(
      'runtime-audit',
      'qa',
      '最终审查快照与运行时审计快照不一致',
    );
  }
  if (finalRun && finalRun.projectFingerprint !== currentFingerprint) {
    throw new FingerprintDriftError(
      'final-review',
      'qa',
      '最终审查后的项目快照已变化，必须重新验证和审查',
    );
  }
}

export function gateResultInstruction(stepId: PipelineStepId): string {
  const gateId = gateIdForStep(stepId);
  if (!gateId) return '';
  const primary = PRIMARY_EVIDENCE_ARTIFACT[gateId];
  const exampleCheck = gateId === 'verification'
    ? {
      id: 'test',
      command: ['pnpm', 'test'],
      status: 'pass',
      required: true,
      exitCode: 0,
      cwd: '/absolute/project',
      startedAt: '2026-08-11T01:00:00.000Z',
      finishedAt: '2026-08-11T01:00:01.000Z',
    }
    : {
      id: 'validate-artifact',
      command: ['node', 'validator.mjs', primary.fileName],
      status: 'pass',
      required: true,
      exitCode: 0,
      cwd: '/absolute/project',
      startedAt: '2026-08-11T01:00:00.000Z',
      finishedAt: '2026-08-11T01:00:01.000Z',
    };
  const artifactCheckField = gateId === 'design' ? 'checks'
    : gateId === 'implementation' ? 'targetedCheckResults'
      : gateId === 'verification' ? 'executedChecks'
        : undefined;
  const example = JSON.stringify({
    gateId,
    status: 'pass',
    summary: '基于事实的结论',
    requirementIds: ['RQ-001'],
    checks: artifactCheckField ? [] : [exampleCheck],
    evidence: ['绝对路径:行号、命令输出或运行时 artifact'],
    artifacts: [{
      path: `/absolute/project/.agent-os/evidence/workflow-id/${primary.fileName}`,
      sha256: '0'.repeat(64),
      kind: primary.kind,
    }],
    findings: [],
  });
  return [
    '本步骤属于不可跳过的结构化质量门禁。',
    `本步骤的规范主 artifact 固定为 evidenceRoot/${primary.fileName}（kind=${primary.kind}）；文件名不得带 round 后缀。`,
    '只能修改本步骤拥有的主 artifact；不得修改其他 gate 主 artifact，canonical-spec.md 与 evidence-chain.json 由控制器生成且只读。',
    'canonical Spec 的完整正文必须从 workflow_context.canonicalSpec.path 读取，并核对其 sha256；不要只依赖提示词中可能被截断的 pm 摘要。',
    '完成正文后必须单独输出：[GATE_RESULT] 后紧跟 JSON（推荐单行；允许多行，但 JSON 结束后不要再追加工具调用、DSML、markdown 或其它杂质）。示例：[GATE_RESULT] ' + example,
    'JSON 不得省略字段；系统会按括号匹配提取 JSON，并可用证据目录内真实文件重算 sha256。',
    'artifacts[].sha256 必须是文件内容的真实 SHA-256：恰好 64 位小写十六进制（/[a-f0-9]{64}/），禁止编造、截断或加长；用 node -e "crypto.createHash(\'sha256\').update(fs.readFileSync(path)).digest(\'hex\')" 计算。',
    'artifact 中的项目 fingerprint 必须来自 workflow_context.projectFingerprintBeforeStep，或实际运行 workflow_context.fingerprintCommand 后读取其 fingerprint；禁止用 Git commit hash、自行拼接或凭空生成。修改项目文件后必须重新运行该命令。',
    'requirementIds 必须逐项复制 workflow_context.canonicalRequirementIds，集合完全一致且不得增删、重命名或重复；主 artifact 的需求追踪/覆盖字段也必须使用同一组 ID。',
    'findings 形状：{"id":"FIND-001","severity":"P0|P1|P2|P3","status":"planned|open|resolved|waived","summary":"...","evidence":["绝对路径或定位"],"category?":"correctness|security|reliability|architecture|performance|maintainability|testing|compatibility|scope|other","confidence?":"low|medium|high","exploitability?":"not-applicable|unreachable|conditional|reachable|unverified"}；category/confidence/exploitability 一旦填写必须使用上述枚举（禁止自造标签如 test-reliability）；evidence 必须是数组。',
    'status=waived 只允许引用人工确认前已写入 canonical Spec 的同 ID `[RISK_WAIVER]` 条款；GATE_RESULT 提供匹配的 owner/reason/scope/compensatingControl/expiresAt，approvedAt 与 approvalEvidence 由控制器绑定。Agent 不得新增、代批或伪造 waiver。',
    'checks 形状：{id,command:string[],status:"pass|fail|blocked|unverified|skipped",required:boolean,exitCode,cwd,startedAt,finishedAt,delegatedTo?}；命令必须是原始 argv 数组，禁止用自然语言描述或 command 字符串。',
    gateId === 'implementation'
      ? '仅因环境缺证而交给 QA 的 optional blocked/unverified check 可写 delegatedTo="verification"；仅有后续 verification gate 以完全相同 id、command argv 和 cwd 记录 required=true/status=pass/exitCode=0 才会消除该残余风险，不做模糊 ID 匹配。'
      : gateId === 'verification'
        ? '若 implementation check 显式 delegatedTo="verification"，必须在 QA executedChecks 中以完全相同 id、command argv 和 cwd 真实重跑，并记录 required=true/status=pass/exitCode=0；不得用相似 ID 或任意其他通过项替代。'
        : 'delegatedTo 只允许 implementation 对 verification 声明；本门禁的 checks 必须省略该字段。',
    'checks[].startedAt/finishedAt 必须来自本轮真实执行，startedAt 不得早于 workflow_context.gateAttemptStartedAt（允许少量时钟偏差）；禁止复用旧轮次时间戳。',
    artifactCheckField
      ? `${primary.fileName}.${artifactCheckField} 是本步骤检查的权威集合；GATE_RESULT.checks 不得重复其中任何 id，没有额外检查时必须写 []，由控制器水合。确需登记额外检查时只能使用新的唯一 id。`
      : `${primary.fileName} 不承载本步骤的命令集合；GATE_RESULT.checks 必须保留真实的 artifact 校验、审查或运行探测命令，不得写空数组。`,
    '审查、QA 或运行时主 artifact 已包含完整 findings 时，GATE_RESULT.findings 可以写 [] 由控制器水合；这不代表 checks 也应清空。',
    stepId === 'architect'
      ? '设计门禁 status=pass 时允许 findings 为 planned 的 P0/P1（交给开发闭环）；open 的 P0/P1 才阻断。不得包含 required=true 且非 pass 的检查。所有门禁都至少需要一项 required=true 的真实通过检查，每条命令都必须包含绝对 cwd 与起止时间。'
      : 'status=pass 时不得包含 open/planned 的 P0/P1，也不得包含 required=true 且非 pass 的检查；设计以外步骤不得使用 planned。所有门禁都至少需要一项 required=true 的真实通过检查，每条命令都必须包含绝对 cwd 与起止时间。',
    stepId === 'review'
      ? '变更审查 pass 必须附带 validate-review-report 的真实命令、review-report artifact 和可定位 evidence；只有这些证据通过后才可另起一行输出 [APPROVED]。'
      : '',
    stepId === 'runtime_audit'
      ? '若项目确无运行时表面，可报告 status=not-applicable，但必须提交含 applicability.reason/evidence[] 和空 findings 的 artifact，并提供真实适用性校验命令。'
      : '',
    stepId === 'final_review'
      ? 'final-review.json 的 evidenceChain 必须逐项复制 workflow_context.controllerEvidenceChain 的绝对 path 与 sha256；禁止只写文件名、旧 hash 或自行创建证据链。'
      : '',
  ].join('\n');
}
