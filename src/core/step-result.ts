/**
 * 流水线步骤语义结果。
 * 仅认显式标记，避免把「分析性长文」误判成阻塞或失败。
 */
export type StepResultKind = 'done' | 'blocked' | 'failed';
export type DecisionKind = 'approved' | 'rejected' | 'approved-with-waiver';
export type ProtocolHandoffTarget = 'dev' | 'architect' | 'pm' | 'qa' | 'runtime_auditor' | 'human';

export interface StepResult {
  kind: StepResultKind;
  /** 标记里可选的简短原因 */
  reason?: string;
}

export interface StepOutcome extends StepResult {
  decision?: DecisionKind;
  handoff?: ProtocolHandoffTarget;
  blockKind?: StepBlockKind;
}

export type QualityHandoffTarget = 'dev' | 'architect';
export type QualitySourceStep = 'review' | 'qa' | 'runtime_audit' | 'final_review';
export type StepBlockKind = 'workdir' | 'environment' | 'test-resource' | 'gate-evidence' | 'other';

export interface MisroutedEnvironmentBlock {
  sourceStepId: QualitySourceStep;
  reason: string;
}

const QUALITY_HANDOFF_STEPS = new Set(['review', 'qa', 'runtime_audit', 'final_review']);
const BLOCK_KIND_VALUES = new Set<StepBlockKind>([
  'workdir',
  'environment',
  'test-resource',
  'gate-evidence',
]);

// 支持：
// [RESULT:blocked] 工作目录不可写
// [RESULT:blocked|工作目录不可写]
// [RESULT:failed：构建失败]
// 标记必须在行首（(?:^|\n)），避免普通回答里举例 [RESULT:failed] 被误判为失败。
const RESULT_RE = /(?:^|\n)\s*\[RESULT:\s*(done|blocked|failed)(?:\s*[|：:]\s*([^\]]+))?\]\s*([^\n\r]*)/gi;
const EXPLICIT_RESULT_RE = /(?:^|\n)\s*\[RESULT:\s*(?:done|blocked|failed)(?:\s*[|：:]\s*[^\]]+)?\]/i;
const DECISION_RE = /(?:^|\n)\s*\[DECISION:\s*(approved-with-waiver|approved|rejected)\]/gi;
const HANDOFF_RE = /(?:^|\n)\s*\[HANDOFF:\s*(dev|architect|pm|qa|runtime_auditor|human)\]/gi;
const BLOCK_KIND_RE = /(?:^|\n)\s*\[BLOCK_KIND:\s*(environment|workdir|test-resource|gate-evidence)\]/gi;
const APPROVED_LINE_RE = /(?:^|\n)\s*\[APPROVED\](?:\s*[。.!！])?(?:\s|$)/gi;
const REJECTED_LINE_RE = /(?:^|\n)\s*\[REJECTED\](?:\s*[。.!！])?(?:\s|$)/gi;

/** 去掉 fenced code block，防止代码示例中的 RESULT 标记被误解析。 */
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
}

function lastMatch<T>(text: string, regex: RegExp, pick: (match: RegExpMatchArray) => T): T | undefined {
  const matches = [...text.matchAll(regex)];
  const match = matches[matches.length - 1];
  return match ? pick(match) : undefined;
}

/** 流水线控制器用它执行 fail-closed；parseStepResult 本身继续兼容旧调用方。 */
export function hasExplicitStepResult(answer: string): boolean {
  return EXPLICIT_RESULT_RE.test(stripCodeBlocks(answer));
}

/**
 * 从回答中解析结果标记；无标记时视为 done（兼容旧行为，宁可漏拦也不误拦）。
 * 只取最后一个匹配（多标记取末尾），且标记必须在行首。
 * 排除 fenced code block 中的示例标记。
 */
export function parseStepResult(answer: string): StepResult {
  const cleaned = stripCodeBlocks(answer);
  const matches = [...cleaned.matchAll(RESULT_RE)];
  if (matches.length === 0) return { kind: 'done' };
  const match = matches[matches.length - 1]; // 多个标记时取最后一个
  const kind = match[1].toLowerCase() as StepResultKind;
  const reason = (match[2] || match[3] || '').trim();
  return reason ? { kind, reason } : { kind };
}

export function parseDecision(answer: string): DecisionKind | undefined {
  const cleaned = stripCodeBlocks(answer);
  let last: { index: number; value: DecisionKind } | undefined;
  const consider = (index: number, value: DecisionKind) => {
    if (last == null || index >= last.index) last = { index, value };
  };
  for (const match of cleaned.matchAll(DECISION_RE)) {
    consider(match.index ?? 0, match[1].toLowerCase() as DecisionKind);
  }
  for (const match of cleaned.matchAll(APPROVED_LINE_RE)) {
    consider(match.index ?? 0, 'approved');
  }
  for (const match of cleaned.matchAll(REJECTED_LINE_RE)) {
    consider(match.index ?? 0, 'rejected');
  }
  return last?.value;
}

export function parseHandoff(answer: string): ProtocolHandoffTarget | undefined {
  return lastMatch(stripCodeBlocks(answer), HANDOFF_RE, (match) => (
    match[1].toLowerCase() as ProtocolHandoffTarget
  ));
}

export function parseBlockKindTag(answer: string): Exclude<StepBlockKind, 'other'> | undefined {
  const value = lastMatch(stripCodeBlocks(answer), BLOCK_KIND_RE, (match) => (
    match[1].toLowerCase() as Exclude<StepBlockKind, 'other'>
  ));
  return value && BLOCK_KIND_VALUES.has(value) ? value : undefined;
}

/** RESULT + DECISION + HANDOFF + BLOCK_KIND 的完整交卷语义。 */
export function parseStepOutcome(answer: string): StepOutcome {
  const result = parseStepResult(answer);
  const taggedKind = parseBlockKindTag(answer);
  const classified = classifyStepBlockReason(`${result.reason ?? ''}\n${answer}`);
  return {
    ...result,
    decision: parseDecision(answer),
    handoff: parseHandoff(answer),
    blockKind: taggedKind ?? (result.kind === 'blocked' || result.kind === 'failed' ? classified : undefined),
  };
}

/**
 * 对人工可纠正的阻塞做显式分类。
 * 显式 [BLOCK_KIND:…] 优先于自然语言正则。
 */
export function classifyStepBlockReason(reason: string): StepBlockKind {
  const text = reason.trim();
  if (!text) return 'other';
  const tagged = parseBlockKindTag(text);
  if (tagged) return tagged;
  if (/(?:工作目录|workdir|项目目录|话题目录|绑定.?目录|目标路径).{0,24}(?:不可写|不能写|无法访问|不存在|无效|错误|未绑定|missing|invalid|unwritable|not writable|unavailable|cannot access)|(?:不可写|不能写|无法访问|不存在|无效|错误|未绑定|missing|invalid|unwritable|not writable|unavailable|cannot access).{0,24}(?:工作目录|workdir|项目目录|话题目录|绑定.?目录|目标路径)|无代码仓库|缺少项目(?:目录|骨架)|项目骨架(?:缺失|不存在)/i.test(text)) {
    return 'workdir';
  }
  if (/沙箱|sandbox|EPERM|EACCES|Operation not permitted|禁止监听|无法监听|loopback|localhost|127\.0\.0\.1|::1|本地端口|端口被占用|浏览器.{0,20}(不可用|未安装|无实例|无法启动|启动失败)|Playwright.{0,32}(?:EPERM|EACCES|禁止|未安装|无可用浏览器|无法启动|启动失败|no executable|browser executable)|PostgreSQL.{0,24}(拒绝|不可达|无法|EPERM)|数据库.{0,16}(拒绝访问|不可达|连接失败)|网络.{0,12}(禁止|不可用)|依赖未安装/i.test(text)) {
    return 'environment';
  }
  if (requiresTestResourceAuthorization(text)) {
    return 'test-resource';
  }
  if (/与审查 artifact 不一致|findings 集合不一致|Gate 结果格式错误|缺少可解析的 \[GATE_RESULT\]|缺少显式 \[RESULT:|终态标记|sha256|证据目录|hash 不匹配|waiver 不完整|尝试上限|无限返工|审查本身无法完成|缺 implementation|fingerprint 对不上|validate-review-report 无法|validate-final-review 无法|证据断链|缺 gate/i.test(text)) {
    return 'gate-evidence';
  }
  return 'other';
}

/** 是否需要负责人显式授权隔离测试资源上的破坏性测试命令。 */
export function requiresTestResourceAuthorization(reason: string): boolean {
  return /sentinel|一次性资源|disposableResourceId|破坏性测试资源|测试资源.{0,16}(授权|审批|预检)|(?:migration|migrate|TRUNCATE|DROP|seed).{0,24}(授权|审批|拒绝|阻塞)/i.test(reason);
}

/** 环境/目录/测试资源类阻塞：应停在原步骤等人纠正，不要退回开发。 */
export function isEnvironmentBlockReason(reason: string): boolean {
  const text = reason.trim();
  if (!text) return false;
  const kind = classifyStepBlockReason(text);
  if (kind !== 'workdir' && kind !== 'environment' && kind !== 'test-resource') return false;

  // 同时明确写出“需修产品代码”时才覆盖环境词；P0/P1、FIND-id 本身只是严重级别/编号。
  const explicitlyNoCodeDefect = /未发现.{0,24}(?:产品)?代码缺陷|不是(?:产品)?代码缺陷|代码(?:仍)?(?:保持)?正确/i.test(text);
  const explicitCodeFix = /implementation\s*修复|需(?:要)?(?:修改|修复).{0,16}(?:产品)?代码|(?:产品)?代码缺陷.{0,24}(?:已确认|需修复)|trustHost|UntrustedHost/i.test(text);
  return explicitlyNoCodeDefect || !explicitCodeFix;
}

export function isGateEvidenceBlockReason(reason: string): boolean {
  return classifyStepBlockReason(reason) === 'gate-evidence';
}

/**
 * 开发步骤把纯运行环境缺证误报为 blocked 时，允许控制器做一次契约纠偏。
 * 目录、测试资源授权、Gate 证据和任何明确代码缺陷都不能走这条自动路径。
 */
export function shouldAutoCorrectDevEnvironmentBlock(
  stepId: string,
  reason: string | undefined,
  answer: string,
): boolean {
  // Agent 可能把原因写在正文，最后只单独输出 `[RESULT:blocked]`；此时仍需从完整回答识别。
  const primaryReason = reason?.trim() || answer.trim();
  if (stepId !== 'dev' || classifyStepBlockReason(primaryReason) !== 'environment') return false;
  const evidence = `${primaryReason}\n${answer}`;
  if (requiresTestResourceAuthorization(evidence)) return false;
  if (classifyStepBlockReason(answer) === 'workdir') return false;
  if (/implementation\s*修复|需(?:要)?(?:修改|修复).{0,16}(?:产品)?代码|(?:产品)?代码缺陷.{0,24}(?:已确认|需修复)|trustHost|UntrustedHost/i.test(evidence)) {
    return false;
  }
  if (/(?:变更范围|需求追踪|目标(?:快速)?测试|targeted(?:\s+check|\s+test)?|unit[- ]?tests?|静态检查|typecheck|\btsc\b|代码编译|compile|\blint\b).{0,48}(?:失败|未通过|报错|fail(?:ed)?|error)|required\s*["']?\s*[:=]\s*true.{0,120}status\s*["']?\s*[:=]\s*["']?fail|status\s*["']?\s*[:=]\s*["']?fail.{0,120}required\s*["']?\s*[:=]\s*true/i.test(evidence)) {
    return false;
  }
  return isEnvironmentBlockReason(evidence);
}

/**
 * 识别历史版本把 QA/评审环境阻塞错误移交到 dev/architect 的工作流。
 * 返回原质量步骤，供重试时自动修复持久化游标。
 */
export function findMisroutedEnvironmentBlock(
  currentStepId: string | undefined,
  priorOutputs: Record<string, string>,
): MisroutedEnvironmentBlock | undefined {
  if (currentStepId !== 'dev' && currentStepId !== 'architect') return undefined;
  const request = priorOutputs.quality_fix_request?.trim();
  if (!request) return undefined;
  const source = request.match(/来源步骤：[^\n]*[（(](review|qa|runtime_audit|final_review)[）)]/i)?.[1]
    ?.toLowerCase() as QualitySourceStep | undefined;
  if (!source || !QUALITY_HANDOFF_STEPS.has(source)) return undefined;
  const summary = request.match(/缺陷摘要：([^\n]+)/)?.[1]?.trim() || request;
  const blockedOutput = priorOutputs[`blocked_${source}`] || '';
  const evidence = [summary, blockedOutput].filter(Boolean).join('\n');
  return isEnvironmentBlockReason(evidence)
    ? { sourceStepId: source, reason: summary }
    : undefined;
}

function explicitHandoffTarget(answer: string | undefined): QualityHandoffTarget | undefined {
  const handoff = answer ? parseHandoff(answer) : undefined;
  if (handoff === 'dev' || handoff === 'architect') return handoff;
  return undefined;
}

/**
 * 评审/QA/运行时审计发现需要改代码时，决定退回开发还是架构。
 * 显式 [HANDOFF:…] 优先；环境/证据问题不回传。
 */
export function resolveQualityHandoffTarget(
  stepId: string,
  reason: string,
  answer?: string,
): QualityHandoffTarget | undefined {
  const evidence = [reason, answer].filter(Boolean).join('\n');
  const explicit = explicitHandoffTarget(evidence);
  if (parseHandoff(evidence) === 'human') return undefined;
  if (!QUALITY_HANDOFF_STEPS.has(stepId)) return undefined;
  if (isEnvironmentBlockReason(evidence)) return undefined;
  if (classifyStepBlockReason(evidence) === 'gate-evidence') return undefined;
  if (explicit) return explicit;
  if (/重新设计|架构(方案|缺陷|门禁)|方案不可行|需架构师|改 change-plan|重新做技术方案|design gate/i.test(evidence)) {
    return 'architect';
  }
  return 'dev';
}

/** 证据/格式失败应停在本步或 rewind，不能当成代码缺陷退回开发。 */
export function shouldPauseAsEvidenceBlock(stepId: string, reason: string, answer = ''): boolean {
  if (!QUALITY_HANDOFF_STEPS.has(stepId) && stepId !== 'architect' && stepId !== 'dev') return false;
  return classifyStepBlockReason(`${reason}\n${answer}`) === 'gate-evidence';
}

/** 已完成审查/验收但拒绝批准时，按缺陷回传，而不是把步骤标成成功往下走。 */
export function resolveRejectedDecisionHandoff(
  stepId: string,
  outcome: StepOutcome,
  answer: string,
): QualityHandoffTarget | undefined {
  if (outcome.kind !== 'done' || outcome.decision !== 'rejected') return undefined;
  return resolveQualityHandoffTarget(stepId, outcome.reason || answer, answer) ?? (
    QUALITY_HANDOFF_STEPS.has(stepId) ? 'dev' : undefined
  );
}

/** 从失败/阻塞文案识别应退回的修复步骤（兼容旧文案）。 */
export function handoffStepIdFromQualityMessage(
  stepId: string | undefined,
  error: string | undefined,
): QualityHandoffTarget | undefined {
  if (!error) return undefined;
  return resolveQualityHandoffTarget(stepId ?? 'runtime_audit', error);
}

const SHARED_PROTOCOL_LINES = [
  '结束时必须单独一行输出且只能有一个 [RESULT:…]：',
  '[RESULT:done] 本步使命完成（审查完成但拒绝批准也算 done）',
  '[RESULT:blocked] 环境/目录/授权/本步证据格式不可用。必须另起一行 [BLOCK_KIND:environment|workdir|test-resource|gate-evidence]',
  '[RESULT:failed] 仅当本步使命无法完成（缺输入、方案不成立）。禁止用它表示「发现了该别人修的 bug」',
  '禁止用 [RESULT:blocked] 表示「发现 P0/P1 要改代码」——那会错误弹出绑目录重试卡。',
  '若因目录权限、缺少项目骨架等原因无法落地，必须输出 [RESULT:blocked]，禁止用「已完成」口吻结束。',
] as const;

const DECISION_LINES = [
  '有批准权时另起一行 [DECISION:approved]、[DECISION:rejected] 或 [DECISION:approved-with-waiver]。',
  '独立一行 [APPROVED] 兼容为 [DECISION:approved]；[REJECTED] 兼容为 [DECISION:rejected]。',
  '拒绝或确认产品缺陷时另起一行 [HANDOFF:dev] 或 [HANDOFF:architect]。',
] as const;

/** 写入 architect / dev / qa / summary 的强制收尾说明。 */
export const PIPELINE_RESULT_INSTRUCTION = [
  ...SHARED_PROTOCOL_LINES,
  '[RESULT:failed] 在开发步骤仍可用于目标测试/静态检查/代码编译真实失败：写清 FIND-id 与修复要点，留在开发继续修。',
].join('\n');

const ARCHITECT_RESULT_INSTRUCTION = [
  ...SHARED_PROTOCOL_LINES,
  '[RESULT:done] 设计完成：change-plan 已通过本地校验；P0/P1 已登记为 planned 并交给开发实现。',
  '[RESULT:failed] 仅当设计本身无法完成：缺需求映射、写竞争未解决、validate-change-plan 失败、GATE_RESULT 无法 pass。失败留在本步修订，不会自动当成完成往下走。',
  '禁止把「已规划给开发修的 FIND-*」写成 [RESULT:failed]——设计门禁 planned P0/P1 必须随 [RESULT:done] 通过。',
  '本步没有交付批准权，不要输出 [DECISION:approved]。',
].join('\n');

const REVIEW_RESULT_INSTRUCTION = [
  ...SHARED_PROTOCOL_LINES,
  ...DECISION_LINES,
  '[RESULT:done] 本轮评审完成。通过时 [DECISION:approved]（或独立一行 [APPROVED]）；未通过时 [DECISION:rejected] 且不要写 [APPROVED]，系统会把意见回传开发。',
  '开放 P0/P1 必须 [RESULT:done] + [DECISION:rejected] + [HANDOFF:dev]。禁止把「发现需开发修的 FIND-*」写成 [RESULT:failed]。',
  '审查本身无法完成（缺 implementation 证据、fingerprint 对不上、validate-review-report 无法执行）用 [RESULT:blocked] + [BLOCK_KIND:gate-evidence]，不要送去改产品代码。',
  '存在有效契约 waiver 且无开放 P0/P1 时用 [DECISION:approved-with-waiver]。',
].join('\n');

const SUMMARY_RESULT_INSTRUCTION = [
  '结束时必须单独一行输出且只能选一个结果标记：',
  '[RESULT:done] 汇总完成。残余 P2/P3、waiver 和下一步建议写进正文即可，前面门禁已经披露',
  '[RESULT:blocked] <仅当缺少 workflow_context 或证据路径，无法写出汇总>',
  '禁止输出 [RESULT:failed]：汇总不能把已经通过门禁的流水线打成失败。若误标，控制器会按完成落盘，但不要依赖这个纠偏。',
].join('\n');

const QUALITY_RESULT_INSTRUCTION = [
  ...SHARED_PROTOCOL_LINES,
  ...DECISION_LINES,
  '[RESULT:done] 本步目标已达成，门禁 pass。本步无交付批准权时不要把 gate pass 写成可发布。',
  '产品代码或测试真实失败：优先 [RESULT:done] + [DECISION:rejected] + [HANDOFF:dev]；兼容旧写法 [RESULT:failed]（系统仍会退回开发，不是永久停掉流水线）。',
  '终审证据断链、hash 不匹配或缺 gate：必须 [RESULT:blocked] + [BLOCK_KIND:gate-evidence]，禁止 [RESULT:failed] 交回开发改产品代码。',
].join('\n');

export function pipelineResultInstruction(stepId?: string): string {
  if (stepId === 'architect') return ARCHITECT_RESULT_INSTRUCTION;
  if (stepId === 'review') return REVIEW_RESULT_INSTRUCTION;
  if (stepId === 'summary') return SUMMARY_RESULT_INSTRUCTION;
  if (stepId === 'qa' || stepId === 'runtime_audit' || stepId === 'final_review') {
    return QUALITY_RESULT_INSTRUCTION;
  }
  return PIPELINE_RESULT_INSTRUCTION;
}

/**
 * 不再把架构师误标的 failed 静默改成 done。
 * 门禁已通过仍写 failed 时，由格式纠偏或失败留在本步处理。
 */
export function shouldAcceptArchitectFailedAsDone(
  _stepId: string,
  _resultKind: StepResultKind,
  _gateAlreadyValidated: boolean,
): boolean {
  return false;
}

/**
 * 仅 CEO 汇总误把残余风险标成 failed 时按完成落盘。
 * 评审 failed 不再当 done：审查做不完应 blocked，有 bug 应 done+rejected。
 */
export function shouldTreatFailedResultAsDone(stepId: string): boolean {
  return stepId === 'summary';
}

/**
 * 从文本中提取疑似绝对路径（仅用于阻塞卡展示候选目录，仍需用户显式确认）。
 * 只收集常见 Unix 绝对路径形态，不做存在性校验。
 */
export function extractAbsolutePathCandidates(text: string): string[] {
  const matches = text.matchAll(/(?:^|[\s`'"(=])(\/(?:Users|home|opt|var|tmp|Volumes)\/[^\s`'":\n]+)/g);
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const match of matches) {
    let path = match[1]?.replace(/[.,;]+$/, '') ?? '';
    // 去掉尾部中文或说明性后缀前的路径截断：保留到最后一个有意义的路径段
    path = path.replace(/\/+$/, '');
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}
