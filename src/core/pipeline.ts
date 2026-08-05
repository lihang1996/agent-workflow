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

/** 开发内部交付小队固定包含完整的技术交付闭环，不受 CEO 流水线裁剪配置影响。 */
export const DELIVERY_SQUAD_STEPS: PipelineStep[] = DEFAULT_PIPELINE_STEPS.filter((step) =>
  step.id === 'architect' || step.id === 'dev' || step.id === 'review' || step.id === 'qa');

/** 解析 PIPELINE_STEPS=pm,architect,dev,review,qa,summary */
export function parsePipelineSteps(value: string | undefined): PipelineStep[] {
  if (!value?.trim()) return DEFAULT_PIPELINE_STEPS;
  const ids = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const steps: PipelineStep[] = [];
  const seen = new Set<PipelineStepId>();
  for (const id of ids) {
    const found = DEFAULT_PIPELINE_STEPS.find((step) => step.id === id);
    if (found && !seen.has(found.id)) {
      steps.push(found);
      seen.add(found.id);
    }
  }
  return steps.length > 0 ? steps : DEFAULT_PIPELINE_STEPS;
}

/** 返回一组步骤实际运行所缺少的 Bot；评审步骤同时依赖 reviewer 与 dev。 */
export function missingBotIdsForSteps(
  steps: readonly PipelineStep[],
  availableBotIds: ReadonlySet<string>,
): string[] {
  const required = new Set<string>();
  for (const step of steps) {
    required.add(step.botId);
    if (step.id === 'review') required.add('dev');
  }
  return [...required].filter((botId) => !availableBotIds.has(botId));
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
      if (priorOutputs.confirmation_feedback) {
        return [
          '【团队流水线 · 产品经理修订】',
          `用户目标：${goal}`,
          '上一版 Spec：',
          priorOutputs.previous_spec ?? '(缺失)',
          '',
          '负责人退回意见：',
          priorOutputs.confirmation_feedback,
          '',
          '请根据意见重写完整、可执行的产品 Spec，只输出新版正文。',
        ].join('\n');
      }
      if (priorOutputs.clarification) {
        return [
          '【团队流水线 · 产品经理】',
          `用户目标：${goal}`,
          '用户已经完成结构化澄清：',
          priorOutputs.clarification,
          '',
          '请据此输出可执行产品 Spec，必须包含：背景、用户目标、范围、非目标、交互/业务规则、验收标准、风险与待确认项。',
          '验收标准使用可勾选清单；只输出 Spec 正文，不再重复提问。',
        ].join('\n');
      }
      return [
        '【团队流水线 · 产品经理】',
        `用户目标：${goal}`,
        '若目标含糊，请调用 MCP 工具 propose_questions 发起结构化澄清，然后停止并等待用户在飞书表单作答。',
        '不要自行猜测答案，也不要在澄清完成前输出最终 Spec。',
        '若信息已经充分，输出可执行 Spec：背景、用户目标、范围、非目标、交互/业务规则、可勾选验收标准、风险与待确认项。',
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
