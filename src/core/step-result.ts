/**
 * 流水线步骤语义结果。
 * 仅认显式标记，避免把「分析性长文」误判成阻塞或失败。
 */
export type StepResultKind = 'done' | 'blocked' | 'failed';

export interface StepResult {
  kind: StepResultKind;
  /** 标记里可选的简短原因 */
  reason?: string;
}

export type QualityHandoffTarget = 'dev' | 'architect';
export type QualitySourceStep = 'review' | 'qa' | 'runtime_audit' | 'final_review';
export type StepBlockKind = 'workdir' | 'environment' | 'test-resource' | 'gate-evidence' | 'other';

export interface MisroutedEnvironmentBlock {
  sourceStepId: QualitySourceStep;
  reason: string;
}

const QUALITY_HANDOFF_STEPS = new Set(['review', 'qa', 'runtime_audit', 'final_review']);

// 支持：
// [RESULT:blocked] 工作目录不可写
// [RESULT:blocked|工作目录不可写]
// [RESULT:failed：构建失败]
// 标记必须在行首（(?:^|\n)），避免普通回答里举例 [RESULT:failed] 被误判为失败。
const RESULT_RE = /(?:^|\n)\s*\[RESULT:\s*(done|blocked|failed)(?:\s*[|：:]\s*([^\]]+))?\]\s*([^\n\r]*)/gi;
const EXPLICIT_RESULT_RE = /(?:^|\n)\s*\[RESULT:\s*(?:done|blocked|failed)(?:\s*[|：:]\s*[^\]]+)?\]/i;

/** 去掉 fenced code block，防止代码示例中的 RESULT 标记被误解析。 */
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
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

/**
 * 对人工可纠正的阻塞做显式分类。
 * 顺序很重要：同一段报告可能同时包含 P0/P1 和“沙箱禁止监听”；严重级别不是代码缺陷证据。
 */
export function classifyStepBlockReason(reason: string): StepBlockKind {
  const text = reason.trim();
  if (!text) return 'other';
  if (/(?:工作目录|workdir|项目目录|话题目录|绑定.?目录|目标路径).{0,24}(?:不可写|不能写|无法访问|不存在|无效|错误|未绑定|missing|invalid|unwritable|not writable|unavailable|cannot access)|(?:不可写|不能写|无法访问|不存在|无效|错误|未绑定|missing|invalid|unwritable|not writable|unavailable|cannot access).{0,24}(?:工作目录|workdir|项目目录|话题目录|绑定.?目录|目标路径)|无代码仓库|缺少项目(?:目录|骨架)|项目骨架(?:缺失|不存在)/i.test(text)) {
    return 'workdir';
  }
  if (/沙箱|sandbox|EPERM|EACCES|Operation not permitted|禁止监听|无法监听|loopback|localhost|127\.0\.0\.1|::1|本地端口|端口被占用|浏览器.{0,20}(不可用|未安装|无实例|无法启动|启动失败)|Playwright.{0,32}(?:EPERM|EACCES|禁止|未安装|无可用浏览器|无法启动|启动失败|no executable|browser executable)|PostgreSQL.{0,24}(拒绝|不可达|无法|EPERM)|数据库.{0,16}(拒绝访问|不可达|连接失败)|网络.{0,12}(禁止|不可用)|依赖未安装/i.test(text)) {
    return 'environment';
  }
  if (requiresTestResourceAuthorization(text)) {
    return 'test-resource';
  }
  if (/与审查 artifact 不一致|findings 集合不一致|Gate 结果格式错误|缺少可解析的 \[GATE_RESULT\]|缺少显式 \[RESULT:|终态标记|sha256|证据目录|hash 不匹配|waiver 不完整|尝试上限|无限返工/i.test(text)) {
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

/**
 * 评审/QA/运行时审计发现需要改代码时，决定退回开发还是架构。
 * - 实现/配置/缺陷修复 → dev
 * - 方案级重做 → architect
 * - 纯环境/目录问题 → undefined（继续走阻塞卡）
 */
export function resolveQualityHandoffTarget(
  stepId: string,
  reason: string,
): QualityHandoffTarget | undefined {
  if (!QUALITY_HANDOFF_STEPS.has(stepId)) return undefined;
  if (isEnvironmentBlockReason(reason)) return undefined;
  // 证据/格式层问题：应修 GATE_RESULT 或重跑同一步，不是退回开发改产品代码
  if (classifyStepBlockReason(reason) === 'gate-evidence') {
    return undefined;
  }
  if (/重新设计|架构(方案|缺陷|门禁)|方案不可行|需架构师|改 change-plan|重新做技术方案|design gate/i.test(reason)) {
    return 'architect';
  }
  // 质量步骤上非环境阻塞，默认记 bug 退回开发（含 FIND-RB-001 / P1 / 需 implementation 修复）
  return 'dev';
}

/** 从失败/阻塞文案识别应退回的修复步骤（兼容旧文案）。 */
export function handoffStepIdFromQualityMessage(
  stepId: string | undefined,
  error: string | undefined,
): QualityHandoffTarget | undefined {
  if (!error) return undefined;
  return resolveQualityHandoffTarget(stepId ?? 'runtime_audit', error);
}

const RESULT_BLOCKED_LINES = [
  '[RESULT:blocked] <仅用于环境/目录/前置条件，例如：工作目录不可写 / 目标路径无代码仓库>',
  '禁止用 [RESULT:blocked] 表示「发现 P0/P1 要改代码」——那会错误弹出绑目录重试卡。',
  '若因目录权限、缺少项目骨架等原因无法落地，必须输出 [RESULT:blocked]，禁止用「已完成」口吻结束。',
] as const;

/** 写入 architect / dev / qa / summary 的强制收尾说明。 */
export const PIPELINE_RESULT_INSTRUCTION = [
  '结束时必须单独一行输出且只能选一个结果标记：',
  '[RESULT:done] 本步目标已达成',
  RESULT_BLOCKED_LINES[0],
  '[RESULT:failed] <发现需改代码的缺陷时用这个：写清 FIND-id、严重级别与修复要点；系统会记 bug 并退回开发（或架构）>',
  RESULT_BLOCKED_LINES[1],
  RESULT_BLOCKED_LINES[2],
].join('\n');

const ARCHITECT_RESULT_INSTRUCTION = [
  '结束时必须单独一行输出且只能选一个结果标记：',
  '[RESULT:done] 设计完成：change-plan 已通过本地校验；P0/P1 已登记为 planned 并交给开发实现',
  RESULT_BLOCKED_LINES[0],
  '[RESULT:failed] <仅当设计本身无法完成：缺需求映射、写竞争未解决、validate-change-plan 失败、GATE_RESULT 无法 pass>',
  '禁止把「已规划给开发修的 FIND-*」写成 [RESULT:failed]——那会停掉流水线而不是进入开发。设计门禁 planned P0/P1 必须随 [RESULT:done] 通过。',
  RESULT_BLOCKED_LINES[1],
  RESULT_BLOCKED_LINES[2],
].join('\n');

const REVIEW_RESULT_INSTRUCTION = [
  '结束时必须单独一行输出且只能选一个结果标记：',
  '[RESULT:done] 本轮评审完成。通过时另起一行 [APPROVED]；未通过时不要写 [APPROVED]，系统会把意见回传开发',
  RESULT_BLOCKED_LINES[0],
  '[RESULT:failed] <仅当审查本身无法完成：缺 implementation 证据、fingerprint 对不上、validate-review-report 无法执行>',
  '禁止把「发现需开发修的 FIND-*」写成 [RESULT:failed]——那会跳过协作回传、直接停掉流水线。未通过必须 [RESULT:done] 且不要 [APPROVED]。',
  RESULT_BLOCKED_LINES[1],
  RESULT_BLOCKED_LINES[2],
].join('\n');

const SUMMARY_RESULT_INSTRUCTION = [
  '结束时必须单独一行输出且只能选一个结果标记：',
  '[RESULT:done] 汇总完成。残余 P2/P3、waiver 和下一步建议写进正文即可，前面门禁已经披露',
  '[RESULT:blocked] <仅当缺少 workflow_context 或证据路径，无法写出汇总>',
  '禁止输出 [RESULT:failed]：汇总不能把已经通过门禁的流水线打成失败。',
].join('\n');

const QUALITY_RESULT_INSTRUCTION = [
  '结束时必须单独一行输出且只能选一个结果标记：',
  '[RESULT:done] 本步目标已达成，门禁 pass',
  RESULT_BLOCKED_LINES[0],
  '[RESULT:failed] <产品代码或测试真实失败：写清 FIND-id、严重级别与修复要点；系统会退回开发继续修，不是永久停掉流水线>',
  RESULT_BLOCKED_LINES[1],
  RESULT_BLOCKED_LINES[2],
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
 * 架构师把「已规划给开发修的 FIND」误标成 [RESULT:failed] 时，
 * 若设计门禁已经校验通过，按 done 继续而不是停掉流水线。
 */
export function shouldAcceptArchitectFailedAsDone(
  stepId: string,
  resultKind: StepResultKind,
  gateAlreadyValidated: boolean,
): boolean {
  return stepId === 'architect' && resultKind === 'failed' && gateAlreadyValidated;
}

/**
 * 评审未通过、CEO 汇总误把残余风险标成 failed 时：
 * 不跑「失败即停流水线」，让 onSuccess 继续（评审回传开发 / 汇总落盘）。
 */
export function shouldTreatFailedResultAsDone(stepId: string): boolean {
  return stepId === 'review' || stepId === 'summary';
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
