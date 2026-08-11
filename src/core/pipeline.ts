/**
 * CEO 团队交付流水线：PM → 架构 → 开发 → 评审 → 测试 → 运行时审计 → 最终审查 → CEO 汇总。
 */
import { PIPELINE_RESULT_INSTRUCTION } from './step-result.js';
import { gateResultInstruction, skillNameForStep } from './quality-gates.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { compactAgentOutput } from './agent-output.js';

export type PipelineStepId =
  | 'pm'
  | 'architect'
  | 'dev'
  | 'review'
  | 'qa'
  | 'runtime_audit'
  | 'final_review'
  | 'summary';

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
  { id: 'runtime_audit', botId: 'qa', title: '运行时边界审计' },
  { id: 'final_review', botId: 'reviewer', title: '最终交付审查' },
  { id: 'summary', botId: 'ceo', title: '交付汇总' },
];

/** 开发内部交付小队固定包含完整的技术交付闭环，不允许通过配置裁剪。 */
export const DELIVERY_SQUAD_STEPS: PipelineStep[] = DEFAULT_PIPELINE_STEPS.filter((step) =>
  step.id === 'architect'
  || step.id === 'dev'
  || step.id === 'review'
  || step.id === 'qa'
  || step.id === 'runtime_audit'
  || step.id === 'final_review');

/**
 * 解析固定交付链。环境变量只能显式声明完整规范顺序，不能裁剪或重排质量门禁。
 */
export function parsePipelineSteps(value: string | undefined): PipelineStep[] {
  if (!value?.trim()) return DEFAULT_PIPELINE_STEPS;
  const ids = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const expected = DEFAULT_PIPELINE_STEPS.map((step) => step.id);
  const unknown = ids.filter((id) => !expected.includes(id as PipelineStepId));
  if (unknown.length > 0) {
    throw new Error('PIPELINE_STEPS 包含未知步骤：' + [...new Set(unknown)].join('、'));
  }
  if (new Set(ids).size !== ids.length) throw new Error('PIPELINE_STEPS 不能包含重复步骤');
  if (ids.join(',') !== expected.join(',')) {
    throw new Error('PIPELINE_STEPS 必须保持完整顺序：' + expected.join(','));
  }
  return DEFAULT_PIPELINE_STEPS;
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

const PRIOR_CONTEXT_KEYS: Record<PipelineStepId, readonly string[]> = {
  pm: ['clarification', 'previous_spec', 'confirmation_feedback'],
  architect: ['pm', 'canonical_spec', 'workflow_context', 'quality_evidence', 'fingerprint_drift', 'quality_fix_request'],
  dev: [
    'pm',
    'canonical_spec',
    'architect',
    'workflow_context',
    'quality_evidence',
    'fingerprint_drift',
    'quality_fix_request',
    'blocked_review',
    'blocked_qa',
    'blocked_runtime_audit',
    'blocked_final_review',
  ],
  review: ['pm', 'canonical_spec', 'architect', 'dev', 'workflow_context', 'quality_evidence', 'quality_fix_request'],
  qa: ['pm', 'canonical_spec', 'dev', 'review', 'workflow_context', 'quality_evidence'],
  runtime_audit: ['pm', 'canonical_spec', 'qa', 'workflow_context', 'quality_evidence'],
  final_review: ['canonical_spec', 'review', 'qa', 'runtime_audit', 'workflow_context', 'quality_evidence'],
  // 汇总优先拿最终事实与控制器路径；完整 Spec 从 canonical-spec.md 读取，避免长 PM 正文挤掉 QA/终审。
  summary: [
    'canonical_spec',
    'workflow_context',
    'quality_evidence',
    'final_review',
    'runtime_audit',
    'qa',
    'review',
    'dev',
    'architect',
    'pm',
  ],
};

const PRIOR_CONTEXT_TOTAL_LIMIT = 36_000;

const CANONICAL_WAIVER_SPEC_INSTRUCTION =
  '只有用户已经明确接受的已知风险，才可在风险条目后单独写入一行 '
  + '`[RISK_WAIVER] {"findingId":"FIND-...","owner":"...","reason":"...","scope":"...",'
  + '"compensatingControl":"...","expiresAt":"带时区的 ISO 时间"}`；不得替用户决定、填占位值或为未来未知风险预授权。';

function priorBlock(step: PipelineStep, priorOutputs: Record<string, string>): string {
  const entries = PRIOR_CONTEXT_KEYS[step.id]
    .flatMap((key) => priorOutputs[key] === undefined ? [] : [[key, priorOutputs[key]] as const]);
  if (entries.length === 0) return '(暂无前置产出)';
  const sections: string[] = [];
  let remaining = PRIOR_CONTEXT_TOTAL_LIMIT;
  for (const [id, text] of entries) {
    if (remaining <= 0) break;
    const perItemLimit = id === 'pm' ? 8_000 : id === 'quality_evidence' ? 12_000 : 6_000;
    const content = compactAgentOutput(text, Math.min(perItemLimit, remaining));
    if (!content) continue;
    const section = `### ${id}\n${content}`;
    sections.push(section);
    remaining -= section.length + 2;
  }
  return sections.join('\n\n') || '(暂无前置产出)';
}

function skillInstruction(step: PipelineStep): string {
  const skillName = skillNameForStep(step.id);
  if (!skillName) return '';
  return [
    '强制 Skill：' + skillPath(skillName),
    '执行前必须完整读取该 SKILL.md，并按其中的渐进式路由读取所需 references/ 和运行 scripts/。',
    '缺少前置输入、命令未实际执行或证据不可定位时，不得报告 pass。',
  ].join('\n');
}

const OWNED_PRIMARY_ARTIFACT: Partial<Record<PipelineStepId, string>> = {
  architect: 'change-plan.json',
  dev: 'implementation-manifest.json',
  review: 'change-review.json',
  qa: 'verification-report.json',
  runtime_audit: 'runtime-audit.json',
  final_review: 'final-review.json',
};

function evidenceOwnershipInstruction(step: PipelineStep): string {
  const fileName = OWNED_PRIMARY_ARTIFACT[step.id];
  if (!fileName) return '';
  return [
    `证据职责边界：本步骤只拥有主 artifact ${fileName}。`,
    '不得创建、覆盖或修补其他步骤的主 artifact；canonical-spec.md 与 evidence-chain.json 由控制器生成，只读。',
    '若发现其他步骤证据格式错误，报告 failed/blocked 并交回该证据所属步骤，不得代改。',
  ].join('\n');
}

function skillPath(skillName: string): string {
  const configuredRoot = process.env.AGENT_OS_SKILLS_DIR?.trim();
  const root = configuredRoot
    ? resolve(configuredRoot)
    : fileURLToPath(new URL('../../skills/', import.meta.url));
  return resolve(root, skillName, 'SKILL.md');
}

function gatedTail(step: PipelineStep): string[] {
  const instruction = gateResultInstruction(step.id);
  return instruction ? ['', PIPELINE_RESULT_INSTRUCTION, '', instruction] : ['', PIPELINE_RESULT_INSTRUCTION];
}

/** 构造各角色在流水线中的任务 prompt。 */
export function buildPipelineStepPrompt(
  step: PipelineStep,
  goal: string,
  priorOutputs: Record<string, string>,
): string {
  const prior = priorBlock(step, priorOutputs);
  switch (step.id) {
    case 'pm':
      if (priorOutputs.confirmation_feedback) {
        return [
          '【团队流水线 · 产品经理修订】',
          `用户目标：${goal}`,
          '强制 Skill：' + skillPath('establish-delivery-contract') + '。执行前必须完整读取并遵循。',
          '上一版 Spec：',
          priorOutputs.previous_spec
            ? compactAgentOutput(priorOutputs.previous_spec, 20_000)
            : '(缺失)',
          '',
          '负责人退回意见：',
          priorOutputs.confirmation_feedback,
          '',
          '若上一版其实是未完成的澄清问题，或仍缺少会影响范围、安全取舍或验收的答案，必须调用 MCP 工具 propose_questions 创建结构化问卷，然后停止等待；不得把问题正文再次当作 Spec 输出。',
          '请根据意见重写完整、可执行的产品 Spec，只输出新版正文。',
          '每条可交付需求必须单独以稳定 ID 开头（例如 `### RQ-001 登录`），并保留未被修改需求的原 ID。',
          CANONICAL_WAIVER_SPEC_INSTRUCTION,
        ].join('\n');
      }
      if (priorOutputs.clarification) {
        return [
          '【团队流水线 · 产品经理】',
          `用户目标：${goal}`,
          '强制 Skill：' + skillPath('establish-delivery-contract') + '。执行前必须完整读取并遵循。',
          '用户已经完成结构化澄清：',
          priorOutputs.clarification,
          '',
          '请据此输出可执行产品 Spec，必须包含：背景、用户目标、范围、非目标、交互/业务规则、验收标准、风险与待确认项。',
          '每条可交付需求必须单独以唯一稳定 ID 开头（例如 `### RQ-001 登录`），并逐条给出优先级与可观察验收。',
          '验收标准使用可勾选清单；只输出 Spec 正文，不再重复提问。',
          CANONICAL_WAIVER_SPEC_INSTRUCTION,
        ].join('\n');
      }
      return [
        '【团队流水线 · 产品经理】',
        `用户目标：${goal}`,
        '强制 Skill：' + skillPath('establish-delivery-contract') + '。执行前必须完整读取并遵循。',
        '若目标含糊，请调用 MCP 工具 propose_questions 发起结构化澄清，然后停止并等待用户在飞书表单作答。',
        '不要自行猜测答案，也不要在澄清完成前输出最终 Spec。',
        '若信息已经充分，输出可执行 Spec：背景、用户目标、范围、非目标、交互/业务规则、可勾选验收标准、风险与待确认项。',
        '每条可交付需求必须单独以唯一稳定 ID 开头（例如 `### RQ-001 登录`），并逐条给出优先级与可观察验收。',
        CANONICAL_WAIVER_SPEC_INSTRUCTION,
      ].join('\n');
    case 'architect':
      return [
        '【团队流水线 · 架构师】',
        `用户目标：${goal}`,
        skillInstruction(step),
        evidenceOwnershipInstruction(step),
        '前置产出：',
        prior,
        '',
        '请给出技术方案：模块边界、关键改动点、风险与取舍。不要直接大面积改代码。',
        ...gatedTail(step),
      ].join('\n');
    case 'dev':
      return [
        '【团队流水线 · 开发工程师】',
        `用户目标：${goal}`,
        skillInstruction(step),
        evidenceOwnershipInstruction(step),
        '前置产出：',
        prior,
        '',
        '请按 Spec 与技术方案在当前可写项目目录落地实现，并简述改动点。',
        '若当前 cwd 不是目标项目、目录不可写、或目标路径尚无代码仓库，不要空跑评审话术，直接 [RESULT:blocked]。',
        ...gatedTail(step),
      ].join('\n');
    case 'qa':
      return [
        '【团队流水线 · 测试工程师】',
        `用户目标：${goal}`,
        skillInstruction(step),
        evidenceOwnershipInstruction(step),
        '前置产出：',
        prior,
        '',
        '请做冒烟/验收检查：列测试步骤、结果、遗留风险。必要时可运行构建或测试命令。',
        ...gatedTail(step),
      ].join('\n');
    case 'runtime_audit':
      return [
        '【团队流水线 · 运行时边界审计】',
        `用户目标：${goal}`,
        skillInstruction(step),
        evidenceOwnershipInstruction(step),
        '前置产出：',
        prior,
        '',
        '请对适用的运行时边界做真实探测；不适用项要给出证据和理由，不能伪造通过。',
        ...gatedTail(step),
      ].join('\n');
    case 'final_review':
      return [
        '【团队流水线 · 最终交付审查】',
        `用户目标：${goal}`,
        skillInstruction(step),
        evidenceOwnershipInstruction(step),
        '前置产出：',
        prior,
        '',
        '请独立核对需求追踪、变更范围、QA 与运行时证据。发现证据断链或开放 P0/P1 必须失败。',
        ...gatedTail(step),
      ].join('\n');
    case 'summary':
      return [
        '【团队流水线 · CEO 交付汇总】',
        `用户目标：${goal}`,
        '各角色产出：',
        prior,
        '',
        '完整 canonical Spec 与控制器证据路径见 workflow_context；需要核对细节时读取对应文件，不要从截断摘要猜测。',
        '请用简洁中文汇总：做了什么、如何验证、剩余风险、下一步建议。',
        '',
        PIPELINE_RESULT_INSTRUCTION,
      ].join('\n');
    case 'review':
      return [
        '【团队流水线 · 实现变更审查】',
        `用户目标：${goal}`,
        skillInstruction(step),
        evidenceOwnershipInstruction(step),
        '前置产出：',
        prior,
        '',
        '请独立检查完整变更范围和关联契约；不能只依据开发总结。开放 P0/P1 时给出可执行修复意见并拒绝批准。',
        ...gatedTail(step),
      ].join('\n');
    default:
      return goal;
  }
}
