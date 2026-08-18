/**
 * CEO 团队交付流水线定义 + 各步骤 prompt 模板。
 *
 * 固定 8 步流水线：PM → 架构 → 开发 → 评审 → 测试 → 运行时审计 → 最终审查 → CEO 汇总。
 * PIPELINE_STEPS 环境变量只能声明完整顺序，不能裁剪或重排质量门禁。
 *
 * 本文件核心职责：
 * 1. 定义 PipelineStep 类型和 8 个步骤常量
 * 2. 解析 PIPELINE_STEPS 环境变量
 * 3. 查找缺失的 Bot 角色
 * 4. 解析步骤的逻辑角色（会话隔离用）
 * 5. 为每个步骤构造完整的 CLI prompt（buildPipelineStepPrompt）
 *
 * prompt 构造逻辑：
 *   roleConstitution()           → 全局角色边界声明
 *   roleBriefForStep(stepId)     → 本步骤的角色简介
 *   skillInstruction(step)       → 强制读取哪个 Skill
 *   evidenceOwnershipInstruction → 本步骤只能写哪个 artifact
 *   priorBlock(step, priorOutputs) → 前置步骤的输出摘要
 *   gatedTail(step)              → [RESULT:xxx] 和 [GATE_RESULT] 格式说明
 */

// ─── 导入：依赖模块 ───
// step-result.ts 提供 [RESULT:done|blocked|failed] 格式说明
import { pipelineResultInstruction } from './step-result.js';
// quality-gates.ts 提供 [GATE_RESULT] 格式说明 + 步骤对应的 Skill 名
import { gateResultInstruction, skillNameForStep } from './quality-gates.js';
// role-constitution.ts 提供全局角色边界 + 各步骤的角色简介
import { roleBriefForStep, roleConstitution } from './role-constitution.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
// agent-output.ts 提供文本压缩（截取摘要，去掉冗余行）
import { compactAgentOutput } from './agent-output.js';

/**
 * 流水线步骤 ID（8 个固定步骤）。
 * 顺序即执行顺序，不可重排。
 */
export type PipelineStepId =
  | 'pm'            // 产品经理：需求澄清 + Spec
  | 'architect'     // 架构师：技术方案设计（只设计不实现）
  | 'dev'           // 开发工程师：代码实现
  | 'review'        // 代码评审：审查变更
  | 'qa'            // 测试工程师：完整验收
  | 'runtime_audit' // 运行时边界审计（可选独立 Bot）
  | 'final_review'  // 最终交付审查（可选独立 Bot）
  | 'summary';      // CEO 汇总

/**
 * 单个流水线步骤的定义。
 */
export interface PipelineStep {
  /** 步骤唯一 ID */
  id: PipelineStepId;
  /** 缺独立 Bot 时使用的飞书角色；summary 由 CEO 做，review 由 reviewer 做 */
  botId: 'pm' | 'architect' | 'dev' | 'qa' | 'ceo' | 'reviewer';
  /** 会话隔离用的逻辑角色；与 botId 相同时可省略 */
  logicalRole?: string;
  /** 若已配置独立飞书 Bot，优先使用；未配置不阻断流水线 */
  preferredBotId?: 'runtime_auditor' | 'final_reviewer';
  /** 步骤显示名（用于卡片和日志） */
  title: string;
}

/**
 * 默认流水线步骤（固定顺序，不可裁剪或重排）。
 *
 * 运行时审计和最终审查可配独立 Bot（preferredBotId）。
 * 未配置独立 Bot 时回退到 QA / reviewer，不阻断流水线。
 */
export const DEFAULT_PIPELINE_STEPS: PipelineStep[] = [
  { id: 'pm', botId: 'pm', logicalRole: 'pm', title: '需求澄清 / Spec' },
  { id: 'architect', botId: 'architect', logicalRole: 'architect', title: '技术方案' },
  { id: 'dev', botId: 'dev', logicalRole: 'dev', title: '开发实现' },
  { id: 'review', botId: 'reviewer', logicalRole: 'reviewer', title: '代码评审' },
  { id: 'qa', botId: 'qa', logicalRole: 'qa', title: '测试验收' },
  {
    id: 'runtime_audit',
    botId: 'qa',
    logicalRole: 'runtime_auditor',
    preferredBotId: 'runtime_auditor',
    title: '运行时边界审计',
  },
  {
    id: 'final_review',
    botId: 'reviewer',
    logicalRole: 'final_reviewer',
    preferredBotId: 'final_reviewer',
    title: '最终交付审查',
  },
  { id: 'summary', botId: 'ceo', logicalRole: 'ceo', title: '交付汇总' },
];

/**
 * 开发内部交付小队（/squad）固定步骤。
 * 包含完整的技术交付闭环（不含 PM 需求和 CEO 汇总），不允许通过配置裁剪。
 * 用途：开发工程师或 CEO 直接发起技术交付，跳过需求澄清阶段。
 */
export const DELIVERY_SQUAD_STEPS: PipelineStep[] = DEFAULT_PIPELINE_STEPS.filter((step) =>
  step.id === 'architect'
  || step.id === 'dev'
  || step.id === 'review'
  || step.id === 'qa'
  || step.id === 'runtime_audit'
  || step.id === 'final_review');

/**
 * 解析 PIPELINE_STEPS 环境变量。
 *
 * 规则：只能显式声明完整规范顺序，不能裁剪或重排质量门禁。
 * 如果用户写了 "pm,architect,dev"（缺步骤）或 "dev,pm,..."（重排），
 * 都会抛出错误，防止绕过门禁。
 *
 * @param value - 环境变量 PIPELINE_STEPS 的值
 * @returns 固定的 DEFAULT_PIPELINE_STEPS（任何合法输入都返回同样的东西）
 * @throws 如果步骤名不对、有重复、顺序不对
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

/**
 * 返回一组步骤实际运行所缺少的 Bot。
 *
 * 评审步骤同时依赖 reviewer 与 dev（协作回传开发修复）。
 * 独立审计/终审 Bot 是可选的（preferredBotId），缺失不阻断。
 *
 * @param steps          - 要检查的步骤列表
 * @param availableBotIds - 当前已连接的 Bot ID 集合
 * @returns 缺失的 Bot ID 列表（空数组表示全部可用）
 */
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

/**
 * 获取步骤的逻辑角色名。
 *
 * 逻辑角色用于 CLI 会话隔离：同一个飞书 Bot 扮演不同步骤时，
 * CLI 上下文必须隔离，不能串线。
 *
 * 例如 QA Bot 同时扮演 qa 和 runtime_auditor，
 * 它们的 CLI 会话是分开的。
 */
export function logicalRoleForStep(step: PipelineStep): string {
  if (step.logicalRole?.trim()) return step.logicalRole.trim();
  if (step.id === 'runtime_audit') return 'runtime_auditor';
  if (step.id === 'final_review') return 'final_reviewer';
  if (step.id === 'summary') return 'ceo';
  return step.botId;
}

/**
 * 解析步骤实际使用的 Bot ID。
 *
 * 如果步骤有 preferredBotId 且该独立 Bot 已连接，优先使用。
 * 否则回退到步骤的 botId（如 runtime_audit 回退到 qa）。
 */
export function resolvePipelineActorId(
  step: PipelineStep,
  availableBotIds: ReadonlySet<string>,
): string {
  if (step.preferredBotId && availableBotIds.has(step.preferredBotId)) return step.preferredBotId;
  return step.botId;
}

/**
 * 每个步骤需要看到的前置产出 key 列表（按优先级排序）。
 *
 * priorOutputs 是一个 Record<string, string>，记录了之前步骤的输出。
 * 每个步骤只需要看部分前置产出，避免上下文过长。
 *
 * 例如 dev 需要看 pm(Spec) + architect(技术方案) + 各种 blocked_* (修复请求)，
 * 但不需要看 summary（还没到那步）。
 */
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
    'dev_environment_autocorrect',
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

/** 前置产出总字符数上限：36K（避免 prompt 过长挤掉 CLI 上下文窗口） */
const PRIOR_CONTEXT_TOTAL_LIMIT = 36_000;

const CANONICAL_WAIVER_SPEC_INSTRUCTION =
  '没有用户已明确接受的风险时，Spec 正文不要出现 RISK_WAIVER 标记（包括说明、示例、非目标）。'
  + '只有用户已经明确接受的已知风险，才可单独一行写入该标记并紧跟完整 JSON 对象，'
  + '字段为 findingId、owner、reason、scope、compensatingControl、expiresAt（带时区的 ISO 时间）；'
  + '不得把本说明、省略号占位或未闭合对象写进 Spec，不得替用户决定或为未来未知风险预授权。'
  + '交卷前把 Spec 写入临时 markdown，运行 '
  + skillPath('establish-delivery-contract').replace(/SKILL\.md$/, 'scripts/validate-spec-markdown.mjs')
  + ' <该文件>；脚本失败则先修正再输出，不要把未校验正文交给控制器。'
  + '若控制器因 Spec 结构拒绝，会在同一 CLI 会话纠偏一次（Claude/Codex/Cursor 相同），不要重新做项目发现。';

/**
 * 构造前置产出文本块。
 *
 * 从 priorOutputs 中按 PRIOR_CONTEXT_KEYS 顺序提取，
 * 每项压缩到 perItemLimit（pm 8K，quality_evidence 12K，其他 6K），
 * 总计不超过 36K。
 *
 * 输出格式：
 * ### pm
 * <PM Spec 摘要>
 * ### architect
 * <技术方案摘要>
 */
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

/**
 * 构造 Skill 读取指令。
 *
 * 每个步骤有对应的 Skill（如 establish-delivery-contract、design-risk-aware-change 等）。
 * Agent 必须完整读取 SKILL.md，并按渐进式路由读取 references/ 和运行 scripts/。
 * 交卷前必须跑通 validate-*.mjs 脚本。
 */
function skillInstruction(step: PipelineStep): string {
  const skillName = skillNameForStep(step.id);
  if (!skillName) return '';
  const lines = [
    '强制 Skill：' + skillPath(skillName),
    '执行前必须完整读取该 SKILL.md，并按其中的渐进式路由读取所需 references/ 和运行 scripts/。',
  ];
  if (step.id !== 'summary') {
    lines.push(
      '交卷前必须跑通本 Skill 的 validate-*.mjs。控制器若因 RESULT/GATE_RESULT/Spec 结构拒绝，会在同一 CLI 会话纠偏一次（Claude/Codex/Cursor 相同），不要重新做完整探索。',
    );
  }
  lines.push('缺少前置输入、命令未实际执行或证据不可定位时，不得报告 pass。');
  return lines.join('\n');
}

/**
 * 各步骤拥有的主 artifact 文件名。
 * 用于 evidenceOwnershipInstruction() 生成证据边界指令。
 * Agent 只能写自己的 artifact，不得改其他步骤的。
 */
const OWNED_PRIMARY_ARTIFACT: Partial<Record<PipelineStepId, string>> = {
  architect: 'change-plan.json',
  dev: 'implementation-manifest.json',
  review: 'change-review.json',
  qa: 'verification-report.json',
  runtime_audit: 'runtime-audit.json',
  final_review: 'final-review.json',
};

/**
 * 构造证据职责边界指令。
 *
 * 告诉 Agent：你只能写你的 artifact，不得改别人的。
 * canonical-spec.md 和 evidence-chain.json 是控制器生成的，只读。
 */
function evidenceOwnershipInstruction(step: PipelineStep): string {
  const fileName = OWNED_PRIMARY_ARTIFACT[step.id];
  if (!fileName) return '';
  return [
    `证据职责边界：本步骤只拥有主 artifact ${fileName}。`,
    '不得创建、覆盖或修补其他步骤的主 artifact；canonical-spec.md 与 evidence-chain.json 由控制器生成，只读。',
    '若发现其他步骤证据格式错误，报告 failed/blocked 并交回该证据所属步骤，不得代改。',
  ].join('\n');
}

/**
 * 解析 Skill 目录根路径。
 * 优先用 AGENT_OS_SKILLS_DIR 环境变量，否则回退到项目内 skills/ 目录。
 */
export function resolveSkillsRoot(): string {
  const configuredRoot = process.env.AGENT_OS_SKILLS_DIR?.trim();
  return configuredRoot
    ? resolve(configuredRoot)
    : fileURLToPath(new URL('../../skills/', import.meta.url));
}

/** 拼接某个 Skill 的 SKILL.md 绝对路径 */
function skillPath(skillName: string): string {
  return resolve(resolveSkillsRoot(), skillName, 'SKILL.md');
}

/**
 * 构造步骤 prompt 的结尾部分：[RESULT:xxx] 格式说明 + [GATE_RESULT] 格式说明。
 * 非 PM 步骤必须输出 [RESULT:done|blocked|failed]。
 * 有门禁的步骤还要输出 [GATE_RESULT] JSON。
 */
function gatedTail(step: PipelineStep): string[] {
  const instruction = gateResultInstruction(step.id);
  const resultInstruction = pipelineResultInstruction(step.id);
  return instruction ? ['', resultInstruction, '', instruction] : ['', resultInstruction];
}

/**
 * 组装完整的步骤 prompt。
 * 结构：角色边界声明 + 角色简介 + 步骤正文。
 */
function composeStepPrompt(step: PipelineStep, body: string[]): string {
  return [roleConstitution(), roleBriefForStep(step.id), ...body].join('\n');
}

/**
 * ★ 构造各角色在流水线中的完整任务 prompt。
 *
 * 这是流水线最核心的函数：为每个步骤生成完整的 CLI prompt，包含：
 * - 角色边界声明（全局）
 * - 角色简介（本步骤）
 * - Skill 读取指令
 * - 证据职责边界
 * - 前置产出摘要
 * - 步骤具体指令（每个角色不同）
 * - [RESULT] 和 [GATE_RESULT] 格式说明
 *
 * PM 步骤有三种分支：
 * 1. confirmation_feedback 存在 → 修订模式（负责人退回了 Spec）
 * 2. clarification 存在 → 用户已澄清，输出 Spec
 * 3. 都没有 → 首次执行，可能需要发问卷
 *
 * @param step         - 步骤定义
 * @param goal         - 用户目标（CEO 传入的自然语言目标）
 * @param priorOutputs - 前置步骤的输出（Record<string, string>）
 * @returns 完整的 CLI prompt 字符串
 */
export function buildPipelineStepPrompt(
  step: PipelineStep,
  goal: string,
  priorOutputs: Record<string, string>,
): string {
  const prior = priorBlock(step, priorOutputs);
  let body: string[];
  switch (step.id) {
    case 'pm':
      if (priorOutputs.confirmation_feedback) {
        body = [
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
        ];
        break;
      }
      if (priorOutputs.clarification) {
        body = [
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
        ];
        break;
      }
      body = [
        '【团队流水线 · 产品经理】',
        `用户目标：${goal}`,
        '强制 Skill：' + skillPath('establish-delivery-contract') + '。执行前必须完整读取并遵循。',
        '若目标含糊，请通过编排器提供的提问工具（MCP propose_questions）发起结构化澄清，然后停止并等待作答。',
        '不要自行猜测答案，也不要在澄清完成前输出最终 Spec。',
        '若信息已经充分，输出可执行 Spec：背景、用户目标、范围、非目标、交互/业务规则、可勾选验收标准、风险与待确认项。',
        '每条可交付需求必须单独以唯一稳定 ID 开头（例如 `### RQ-001 登录`），并逐条给出优先级与可观察验收。',
        '运行时与安全基线只写业务约束（必须支持的用户环境、合规、不可接受风险）；技术控制留给架构师。',
        CANONICAL_WAIVER_SPEC_INSTRUCTION,
      ];
      break;
    case 'architect':
      body = [
        '【团队流水线 · 架构师】',
        `用户目标：${goal}`,
        skillInstruction(step),
        evidenceOwnershipInstruction(step),
        '前置产出：',
        prior,
        '',
        '请给出技术方案：模块边界、关键改动点、风险与取舍。',
        '绝对禁止实现：不得创建、修改或删除目标仓库的产品代码、测试、配置或脚本；本步只产出 change-plan 与设计证据。',
        '本步只设计不实现。发现的 P0/P1 登记为 planned 后必须输出 [RESULT:done]，交给开发闭环；禁止因这些 FIND 输出 [RESULT:failed]。',
        '与 PM 业务约束冲突时不得标成 not-applicable，必须 [RESULT:blocked] 交人。',
        ...gatedTail(step),
      ];
      break;
    case 'dev':
      body = [
        '【团队流水线 · 开发工程师】',
        `用户目标：${goal}`,
        skillInstruction(step),
        evidenceOwnershipInstruction(step),
        '前置产出：',
        prior,
        '',
        '请按 Spec 与技术方案在当前可写项目目录落地实现，并简述改动点。',
        '本步的必需验证职责固定为：完整变更范围与需求追踪、本次改动的目标快速测试、静态检查与编译可行性。',
        '完整 production build、dev/production server、浏览器与普通功能 E2E 的验收责任属于 QA；开发阶段可提前运行，但不得因纯环境限制把它们升格为开发必需门禁。',
        '若上述 QA 验收项仅因沙箱禁止绑定端口、缺少浏览器/数据库/网络等环境而无法取证，在 implementation-manifest 中记为 required=false、status=blocked/unverified 且 delegatedTo="verification"，写明原因并交由 QA 执行；开发必需项全部通过时 Gate 保持 pass 并输出 [RESULT:done]，不得仅因这类环境缺证输出 [RESULT:blocked] 或 [RESULT:failed]。',
        '委派不会自动消除风险；只有后续 QA 在 verification gate 中以完全相同的 check id、command argv 和 cwd 运行，并记为 required=true/status=pass/exitCode=0，该环境缺证才算被覆盖；未委派或未精确覆盖的 optional gap 仍作为残余风险。',
        '若前置产出包含 dev_environment_autocorrect，这是控制器的一次性契约纠偏：必须按其中说明重新生成 implementation-manifest 与 GATE_RESULT，不得复用上一轮 blocked manifest 或再次把同一纯环境缺证作为开发阻塞。',
        '若目标快速测试、静态/编译检查真实失败，或已确认是代码导致的 build/E2E 失败，仍必须记录 required=true + status=fail 并输出 [RESULT:failed]；不得伪装成环境缺证。',
        '若当前 cwd 不是目标项目、目录不可写、或目标路径尚无代码仓库，不要空跑评审话术，直接 [RESULT:blocked]。',
        ...gatedTail(step),
      ];
      break;
    case 'qa':
      body = [
        '【团队流水线 · 测试工程师】',
        `用户目标：${goal}`,
        skillInstruction(step),
        evidenceOwnershipInstruction(step),
        '前置产出：',
        prior,
        '',
        '请负责完整交付验收：在适用时真实运行 production build、dev/production server、集成测试、浏览器普通功能 E2E 与冒烟检查，列出步骤、结果和遗留风险。',
        '开发 artifact 中 required=false 的环境缺证只是交接信息，不是 QA 豁免；按 Spec 和项目发现应当验证的完整构建、服务或 E2E 在 QA 报告中必须保持 required=true。',
        '对 implementation check 中 delegatedTo="verification" 的交接，QA 必须在 executedChecks 中保留完全相同的 id、command argv 和 cwd，并真实执行到 required=true/status=pass/exitCode=0；不得用相似 id、摘要或任意其他通过检查代替。',
        '若这些必需项仅因浏览器、端口、数据库、网络或授权环境不可用而无法取证，记录 required=true + status=blocked/unverified，保持 verification gate 非 pass 并输出 [RESULT:blocked]，留在 QA 等待环境，不得倒退成开发阶段的环境责任。',
        '命令已真实运行且因产品代码或测试失败时，记录 status=fail，写明可复现缺陷，输出 [RESULT:done] + [DECISION:rejected] + [HANDOFF:dev]；禁止用 [RESULT:failed] 表示「有 bug」，不得误报为环境阻塞。',
        ...gatedTail(step),
      ];
      break;
    case 'runtime_audit':
      body = [
        '【团队流水线 · 运行时边界审计】',
        `用户目标：${goal}`,
        skillInstruction(step),
        evidenceOwnershipInstruction(step),
        '前置产出：',
        prior,
        '',
        '请只对适用的运行时边界做真实探测。表面类型来自 workflow_context.runtimeSurfaceKinds（http|ui|cli|job|none）；缺省则本步发现，不要默认键盘/Safari/CDN。',
        '复用 QA 已验证的构建与普通功能 E2E 证据；不得重复 QA 已完成的普通功能 E2E，不得在本步重做完整 production build。',
        '不适用项要给出证据和理由，不能伪造通过；适用边界因环境缺失无法取证时停在运行时审计阻塞。代码导致的越权/泄露用 [RESULT:done] + [DECISION:rejected] + [HANDOFF:dev]。',
        ...gatedTail(step),
      ];
      break;
    case 'final_review':
      body = [
        '【团队流水线 · 最终交付审查】',
        `用户目标：${goal}`,
        skillInstruction(step),
        evidenceOwnershipInstruction(step),
        '前置产出：',
        prior,
        '',
        '请独立核对需求追踪、变更范围、QA 与运行时证据是否同一快照。你批准的是证据闭合，不是再做一遍代码评审；最高风险路径只需抽查是否对得上证据。',
        '开放 P0/P1 输出 [RESULT:done] + [DECISION:rejected] + [HANDOFF:dev]。证据断链、hash 不匹配或缺 gate 必须 [RESULT:blocked] + [BLOCK_KIND:gate-evidence]，禁止 [RESULT:failed] 交回开发改产品代码。',
        ...gatedTail(step),
      ];
      break;
    case 'summary':
      body = [
        '【团队流水线 · CEO 交付汇总】',
        `用户目标：${goal}`,
        skillInstruction(step),
        '各角色产出：',
        prior,
        '',
        '完整 canonical Spec 与控制器证据路径见 workflow_context；需要核对细节时读取对应文件，不要从截断摘要猜测。',
        '请用简洁中文汇总：做了什么、如何验证、剩余风险、下一步建议。残余风险写进正文，禁止用 [RESULT:failed] 把已通过的流水线打成失败，禁止输出 [DECISION:approved]。',
        '',
        pipelineResultInstruction('summary'),
      ];
      break;
    case 'review':
      body = [
        '【团队流水线 · 实现变更审查】',
        `用户目标：${goal}`,
        skillInstruction(step),
        evidenceOwnershipInstruction(step),
        '前置产出：',
        prior,
        '',
        '请独立检查完整变更范围和关联契约。可参考开发总结了解意图，但 reviewScope 和 findings 必须来自独立 diff 与脚本，不得以开发总结替代。',
        '开放 P0/P1 时给出可执行修复意见并拒绝批准：输出 [RESULT:done] 且不要写 [APPROVED]，可另写 [DECISION:rejected] + [HANDOFF:dev]，让协作回传开发。禁止因这些 FIND 输出 [RESULT:failed]。审查做不完用 [RESULT:blocked] + [BLOCK_KIND:gate-evidence]。',
        ...gatedTail(step),
      ];
      break;
    default:
      return goal;
  }
  return composeStepPrompt(step, body);
}
