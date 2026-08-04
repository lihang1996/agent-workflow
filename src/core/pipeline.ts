/**
 * CEO 团队交付流水线：PM → 架构 → 开发 → 评审 → 测试 → CEO 汇总。
 */
export type PipelineStepId = 'pm' | 'architect' | 'dev' | 'review' | 'qa' | 'summary';

export interface PipelineStep {
  id: PipelineStepId;
  /** 执行角色 botId；summary / review 有特殊编排 */
  botId: 'pm' | 'architect' | 'dev' | 'qa' | 'ceo' | 'reviewer';
  title: string;
}

export const DEFAULT_PIPELINE_STEPS: PipelineStep[] = [
  { id: 'pm', botId: 'pm', title: '需求澄清 / Spec' },
  { id: 'architect', botId: 'architect', title: '技术方案' },
  { id: 'dev', botId: 'dev', title: '开发实现' },
  { id: 'review', botId: 'reviewer', title: '代码评审' },
  { id: 'qa', botId: 'qa', title: '测试验收' },
  { id: 'summary', botId: 'ceo', title: '交付汇总' },
];

/** 解析 PIPELINE_STEPS=pm,architect,dev,review,qa,summary */
export function parsePipelineSteps(value: string | undefined): PipelineStep[] {
  if (!value?.trim()) return DEFAULT_PIPELINE_STEPS;
  const ids = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const steps: PipelineStep[] = [];
  for (const id of ids) {
    const found = DEFAULT_PIPELINE_STEPS.find((step) => step.id === id);
    if (found) steps.push(found);
  }
  return steps.length > 0 ? steps : DEFAULT_PIPELINE_STEPS;
}

/** 按已连接 Bot 过滤可执行步骤（summary 始终保留给 CEO）。 */
export function filterRunnableSteps(
  steps: PipelineStep[],
  availableBotIds: ReadonlySet<string>,
): PipelineStep[] {
  return steps.filter((step) => {
    if (step.id === 'summary') return availableBotIds.has('ceo');
    if (step.id === 'review') {
      return availableBotIds.has('reviewer') && availableBotIds.has('dev');
    }
    return availableBotIds.has(step.botId);
  });
}

function priorBlock(priorOutputs: Record<string, string>): string {
  const entries = Object.entries(priorOutputs);
  if (entries.length === 0) return '(暂无前置产出)';
  return entries.map(([id, text]) => `### ${id}\n${text}`).join('\n\n');
}

/** 构造各角色在流水线中的任务 prompt。 */
export function buildPipelineStepPrompt(
  step: PipelineStep,
  goal: string,
  priorOutputs: Record<string, string>,
): string {
  const prior = priorBlock(priorOutputs);
  switch (step.id) {
    case 'pm':
      return [
        '【团队流水线 · 产品经理】',
        `用户目标：${goal}`,
        '若目标含糊，请先调用 MCP 工具 propose_questions 发起结构化澄清，再用 record_answers 记录结论。',
        '随后输出简短 Spec：背景、范围、验收标准、非目标。控制在一页以内。',
      ].join('\n');
    case 'architect':
      return [
        '【团队流水线 · 架构师】',
        `用户目标：${goal}`,
        '前置产出：',
        prior,
        '',
        '请给出技术方案：模块边界、关键改动点、风险与取舍。不要直接大面积改代码。',
      ].join('\n');
    case 'dev':
      return [
        '【团队流水线 · 开发工程师】',
        `用户目标：${goal}`,
        '前置产出：',
        prior,
        '',
        '请按 Spec 与技术方案在当前项目目录落地实现，并简述改动点。',
      ].join('\n');
    case 'qa':
      return [
        '【团队流水线 · 测试工程师】',
        `用户目标：${goal}`,
        '前置产出：',
        prior,
        '',
        '请做冒烟/验收检查：列测试步骤、结果、遗留风险。必要时可运行构建或测试命令。',
      ].join('\n');
    case 'summary':
      return [
        '【团队流水线 · CEO 交付汇总】',
        `用户目标：${goal}`,
        '各角色产出：',
        prior,
        '',
        '请用简洁中文汇总：做了什么、如何验证、剩余风险、下一步建议。',
      ].join('\n');
    case 'review':
      return `针对目标完成代码评审并推动必要修复：${goal}`;
    default:
      return goal;
  }
}
