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

const QUALITY_HANDOFF_STEPS = new Set(['review', 'qa', 'runtime_audit', 'final_review']);

// 支持：
// [RESULT:blocked] 工作目录不可写
// [RESULT:blocked|工作目录不可写]
// [RESULT:failed：构建失败]
// 标记必须在行首（(?:^|\n)），避免普通回答里举例 [RESULT:failed] 被误判为失败。
const RESULT_RE = /(?:^|\n)\s*\[RESULT:\s*(done|blocked|failed)(?:\s*[|：:]\s*([^\]]+))?\]\s*([^\n\r]*)/gi;
const EXPLICIT_RESULT_RE = /(?:^|\n)\s*\[RESULT:\s*(?:done|blocked|failed)(?:\s*[|：:]\s*[^\]]+)?\]/i;

/** 流水线控制器用它执行 fail-closed；parseStepResult 本身继续兼容旧调用方。 */
export function hasExplicitStepResult(answer: string): boolean {
  return EXPLICIT_RESULT_RE.test(answer);
}

/**
 * 从回答中解析结果标记；无标记时视为 done（兼容旧行为，宁可漏拦也不误拦）。
 * 只取最后一个匹配（多标记取末尾），且标记必须在行首。
 */
export function parseStepResult(answer: string): StepResult {
  const matches = [...answer.matchAll(RESULT_RE)];
  if (matches.length === 0) return { kind: 'done' };
  const match = matches[matches.length - 1]; // 多个标记时取最后一个
  const kind = match[1].toLowerCase() as StepResultKind;
  const reason = (match[2] || match[3] || '').trim();
  return reason ? { kind, reason } : { kind };
}

/** 环境/目录类阻塞：应停在同一步等人纠正，不要退回开发。 */
export function isEnvironmentBlockReason(reason: string): boolean {
  const text = reason.trim();
  if (!text) return false;
  // 明确代码缺陷优先于目录话术
  if (/FIND-|P0|P1|implementation\s*修复|需.?改代码|trustHost|UntrustedHost/i.test(text)) {
    return false;
  }
  return /工作目录|不可写|无代码仓库|workdir|绑定.?目录|话题目录|路径.*(不存在|无效|错误)|缺少项目|骨架|依赖未安装|端口被占用|无法访问项目目录/i.test(text);
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
  if (/与审查 artifact 不一致|findings 集合不一致|Gate 结果格式错误|缺少可解析的 \[GATE_RESULT\]|缺少显式 \[RESULT:|终态标记|sha256|证据目录|hash 不匹配|waiver 不完整|尝试上限|无限返工/i.test(reason)) {
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

/** 写入 architect / dev / qa / summary 的强制收尾说明。 */
export const PIPELINE_RESULT_INSTRUCTION = [
  '结束时必须单独一行输出且只能选一个结果标记：',
  '[RESULT:done] 本步目标已达成',
  '[RESULT:blocked] <仅用于环境/目录/前置条件，例如：工作目录不可写 / 目标路径无代码仓库>',
  '[RESULT:failed] <发现需改代码的缺陷时用这个：写清 FIND-id、严重级别与修复要点；系统会记 bug 并退回开发（或架构）>',
  '禁止用 [RESULT:blocked] 表示「发现 P0/P1 要改代码」——那会错误弹出绑目录重试卡。',
  '若因目录权限、缺少项目骨架等原因无法落地，必须输出 [RESULT:blocked]，禁止用「已完成」口吻结束。',
].join('\n');

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
