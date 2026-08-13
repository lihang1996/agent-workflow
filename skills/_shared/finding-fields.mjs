/**
 * Gate finding 字段与控制器 GateFindingSchema 对齐。
 * 本地 Skill 校验脚本必须复用本模块，避免「脚本 pass / 控制器 fail」。
 * 修改枚举或别名时同步更新 src/core/quality-gates.ts 中的同名常量。
 */

export const FINDING_SEVERITIES = Object.freeze(['P0', 'P1', 'P2', 'P3']);
export const FINDING_STATUSES = Object.freeze(['open', 'planned', 'resolved', 'waived']);
export const FINDING_CATEGORIES = Object.freeze([
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
]);
export const FINDING_CONFIDENCES = Object.freeze(['low', 'medium', 'high']);
export const FINDING_EXPLOITABILITIES = Object.freeze([
  'not-applicable',
  'unreachable',
  'conditional',
  'reachable',
  'unverified',
]);

/** 设计 riskAssessments.disposition（非 finding.status）。 */
export const RISK_DISPOSITIONS = Object.freeze([
  'applicable',
  'not-applicable',
  'analysis-required',
]);

const CATEGORY_ALIASES = Object.freeze({
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
});

const CONFIDENCE_ALIASES = Object.freeze({
  low: 'low',
  l: 'low',
  medium: 'medium',
  med: 'medium',
  m: 'medium',
  high: 'high',
  h: 'high',
});

const EXPLOITABILITY_ALIASES = Object.freeze({
  'not-applicable': 'not-applicable',
  na: 'not-applicable',
  'n/a': 'not-applicable',
  none: 'not-applicable',
  unreachable: 'unreachable',
  conditional: 'conditional',
  reachable: 'reachable',
  unverified: 'unverified',
  unknown: 'unverified',
});

const SEVERITY_ALIASES = Object.freeze({
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
});

const STATUS_ALIASES = Object.freeze({
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
  accepted: 'waived',
  'accepted-residual': 'waived',
  residual: 'waived',
  acknowledged: 'waived',
  informational: 'resolved',
  waived: 'waived',
  'wont-fix': 'waived',
  wontfix: 'waived',
  'not-a-bug': 'waived',
});

function asLower(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function normalizeFindingSeverity(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3) {
    return `P${value}`;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const upper = trimmed.toUpperCase();
  if (FINDING_SEVERITIES.includes(upper)) return upper;
  const prefixed = upper.match(/^P([0-3])\b/);
  if (prefixed) return `P${prefixed[1]}`;
  return SEVERITY_ALIASES[trimmed.toLowerCase()] ?? SEVERITY_ALIASES[trimmed];
}

export function normalizeFindingStatus(value) {
  const key = asLower(value);
  if (!key) return undefined;
  if (FINDING_STATUSES.includes(key)) return key;
  return STATUS_ALIASES[key];
}

export function normalizeFindingCategory(value) {
  const key = asLower(value);
  if (!key) return undefined;
  if (FINDING_CATEGORIES.includes(key)) return key;
  return CATEGORY_ALIASES[key];
}

export function normalizeFindingConfidence(value) {
  const key = asLower(value);
  if (!key) return undefined;
  if (FINDING_CONFIDENCES.includes(key)) return key;
  return CONFIDENCE_ALIASES[key];
}

export function normalizeFindingExploitability(value) {
  const key = asLower(value);
  if (!key) return undefined;
  if (FINDING_EXPLOITABILITIES.includes(key)) return key;
  return EXPLOITABILITY_ALIASES[key];
}

/**
 * @param {unknown} finding
 * @param {number} index
 * @param {{ requireCategory?: boolean, allowPlanned?: boolean, requireSecurityExploitability?: boolean }} [options]
 * @returns {string[]}
 */
export function validateFindingFields(finding, index, options = {}) {
  const errors = [];
  const prefix = `findings[${index}]`;
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    errors.push(`${prefix} must be an object`);
    return errors;
  }

  if (!finding.id || typeof finding.id !== 'string' || !finding.id.trim()) {
    errors.push(`${prefix} needs id`);
  }
  if (!finding.summary || typeof finding.summary !== 'string' || !finding.summary.trim()) {
    errors.push(`${prefix} needs summary`);
  }

  const severity = normalizeFindingSeverity(finding.severity ?? finding.priority ?? finding.level);
  if (!severity) {
    errors.push(`${prefix} severity must be one of ${FINDING_SEVERITIES.join('|')}`);
  }

  const status = normalizeFindingStatus(finding.status ?? finding.disposition);
  if (!status) {
    errors.push(`${prefix} status must be one of ${FINDING_STATUSES.join('|')}`);
  } else if (status === 'planned' && options.allowPlanned === false) {
    errors.push(`${prefix} cannot remain planned`);
  }

  if (finding.category != null && finding.category !== '') {
    const category = normalizeFindingCategory(finding.category);
    if (!category) {
      errors.push(
        `${prefix} category Invalid option: expected one of "${FINDING_CATEGORIES.join('"|"')}"`,
      );
    }
  } else if (options.requireCategory) {
    errors.push(`${prefix} category is required`);
  }

  if (finding.confidence != null && finding.confidence !== '') {
    const confidence = normalizeFindingConfidence(finding.confidence);
    if (!confidence) {
      errors.push(`${prefix} confidence must be one of ${FINDING_CONFIDENCES.join('|')}`);
    }
  }

  if (finding.exploitability != null && finding.exploitability !== '') {
    const exploitability = normalizeFindingExploitability(finding.exploitability);
    if (!exploitability) {
      errors.push(
        `${prefix} exploitability must be one of ${FINDING_EXPLOITABILITIES.join('|')}`,
      );
    }
  }

  const category = normalizeFindingCategory(finding.category);
  if (
    options.requireSecurityExploitability !== false
    && ['P0', 'P1'].includes(severity)
    && category === 'security'
    && !normalizeFindingExploitability(finding.exploitability)
  ) {
    errors.push(`${prefix} security P0/P1 needs exploitability`);
  }

  // P1 修复：与控制器对齐，findings 必须有 evidence 字段。
  // 默认 opt-in：只有显式 requireEvidence=true 才在本地脚本校验，避免阻塞草稿阶段。
  if (options.requireEvidence === true) {
    const hasEvidence = typeof finding.evidence === 'string' && finding.evidence.trim()
      || (Array.isArray(finding.evidence) && finding.evidence.length > 0);
    if (!hasEvidence) {
      errors.push(`${prefix} needs evidence (string or non-empty array)`);
    }
  }

  return errors;
}

/**
 * @param {unknown[]} findings
 * @param {{ allowPlanned?: boolean, requireCategory?: boolean }} [options]
 */
export function validateFindingsArray(findings, options = {}) {
  if (!Array.isArray(findings)) return ['findings must be an array'];
  const errors = [];
  for (const [index, finding] of findings.entries()) {
    errors.push(...validateFindingFields(finding, index, options));
  }
  return errors;
}

export function validateRiskDisposition(disposition, index) {
  if (typeof disposition !== 'string' || !disposition.trim()) {
    return [`riskAssessments[${index}] disposition is required`];
  }
  const key = disposition.trim().toLowerCase();
  if (!RISK_DISPOSITIONS.includes(key)) {
    return [
      `riskAssessments[${index}] disposition must be one of ${RISK_DISPOSITIONS.join('|')}`,
    ];
  }
  return [];
}

export const FINDING_FIELD_DOC = [
  `severity: ${FINDING_SEVERITIES.join('|')}`,
  `status: ${FINDING_STATUSES.join('|')}（设计门禁可用 planned；审查/QA/运行时/终审不得保留 planned）`,
  `category（可选，一旦填写必须合法）: ${FINDING_CATEGORIES.join('|')}`,
  `confidence（可选）: ${FINDING_CONFIDENCES.join('|')}`,
  `exploitability（安全类 P0/P1 必需）: ${FINDING_EXPLOITABILITIES.join('|')}`,
].join('；');
