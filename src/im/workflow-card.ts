import { createHash } from 'node:crypto';
import type { ApprovalRequest } from '../core/approval-store.js';
import type { Questionnaire, Question } from '../core/questionnaire-store.js';
import { extractRequirementIds } from '../core/requirement-ids.js';
import type { ProductSpec } from '../core/spec-store.js';
import { redactSecrets } from '../core/log-inspection.js';
import { classifyStepBlockReason, type StepBlockKind } from '../core/step-result.js';
import type { CardJson } from './card.js';

/** 流水线步骤 [RESULT:blocked] 后的人工纠正卡。 */
export function buildStepBlockedCard(options: {
  workflowId: string;
  stepId: string;
  stepTitle: string;
  reason: string;
  suggestedWorkdir?: string;
  blockKind?: StepBlockKind;
  testResourceAuthorizationAvailable?: boolean;
  /** 阻塞版本号（workflow.updatedAt），防止旧卡重放到新阻塞步骤 */
  blockVersion: string;
}): CardJson {
  const blockKind = options.blockKind ?? classifyStepBlockReason(options.reason);
  const isWorkdirBlock = blockKind === 'workdir';
  const suggestedWorkdir = isWorkdirBlock ? options.suggestedWorkdir : undefined;
  const value = {
    workflowId: options.workflowId,
    stepId: options.stepId,
    blockVersion: options.blockVersion,
    ...(suggestedWorkdir ? { workdir: suggestedWorkdir } : {}),
  };
  const guidance = blockGuidance(
    blockKind,
    suggestedWorkdir,
    options.testResourceAuthorizationAvailable === true,
  );
  const retryLabel = blockKind === 'workdir'
    ? '按当前话题目录重试'
    : blockKind === 'environment'
      ? '环境就绪后重试'
      : blockKind === 'test-resource'
        ? '资源授权完成后重试'
        : blockKind === 'gate-evidence'
          ? '修正证据后重试'
          : '重试当前步骤';
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: `流水线已阻塞：${options.stepTitle}` } },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `流水线已阻塞 · ${options.stepTitle}` },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            `**步骤**：${escapeCardMarkdown(options.stepTitle, 80)}`,
            `**原因**：${escapeCardMarkdown(options.reason, 800)}`,
            guidance,
            '',
            '流水线已暂停，不会继续评审/测试。纠正后可重跑**同一步**。',
          ].join('\n'),
        },
        ...(suggestedWorkdir
          ? [button('retry_blocked_step_with_workdir', value, '绑定建议目录并重试', 'primary')]
          : []),
        ...(options.testResourceAuthorizationAvailable
          ? [button(
            'authorize_test_resource_and_retry',
            value,
            '确认隔离测试库并授权重试',
            'primary',
          )]
          : []),
        button('retry_blocked_step', value, retryLabel, 'default'),
        button('abort_blocked_workflow', value, '终止流水线', 'danger'),
      ],
    },
  };
}

export type StepBlockedActionState =
  | 'retrying'
  | 'authorized-retrying'
  | 'rerouted'
  | 'inactive'
  | 'aborted';

/** 阻塞卡按钮被接受后的不可交互状态卡，防止旧按钮继续显示或重复提交。 */
export function buildStepBlockedActionCard(options: {
  stepTitle: string;
  state: StepBlockedActionState;
  detail?: string;
}): CardJson {
  const presentation = {
    retrying: {
      template: 'blue',
      title: `流水线重试中 · ${options.stepTitle}`,
      status: '已提交当前步骤重试。',
    },
    'authorized-retrying': {
      template: 'blue',
      title: `已授权并重试 · ${options.stepTitle}`,
      status: '已确认隔离测试资源授权，正在重试当前步骤。',
    },
    rerouted: {
      template: 'blue',
      title: `流水线已转交 · ${options.stepTitle}`,
      status: '已按问题类型转交正确步骤处理。',
    },
    inactive: {
      template: 'grey',
      title: `阻塞操作已失效 · ${options.stepTitle}`,
      status: '流水线状态已经变化，这张旧阻塞卡不再可操作。',
    },
    aborted: {
      template: 'grey',
      title: `流水线已终止 · ${options.stepTitle}`,
      status: '已终止这条阻塞中的流水线。',
    },
  } as const;
  const current = presentation[options.state];
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: current.title } },
    header: {
      template: current.template,
      title: { tag: 'plain_text', content: current.title },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [{
        tag: 'markdown',
        content: [
          `**步骤**：${escapeCardMarkdown(options.stepTitle, 80)}`,
          `**状态**：${current.status}`,
          ...(options.detail ? [`**说明**：${escapeCardMarkdown(options.detail, 800)}`] : []),
          '',
          '原阻塞操作已关闭；后续结果或新的阻塞会在当前话题中更新。',
        ].join('\n'),
      }],
    },
  };
}

function blockGuidance(
  kind: StepBlockKind,
  suggestedWorkdir?: string,
  testResourceAuthorizationAvailable = false,
): string {
  if (kind === 'workdir') {
    return suggestedWorkdir
      ? `**建议目录**：\`${escapeCardMarkdown(suggestedWorkdir, 300)}\``
      : '**处理方式**：用 `/workdir <绝对路径>` 绑定正确项目目录，再重试。';
  }
  if (kind === 'environment') {
    return [
      '**处理方式**：保持当前项目目录不变，确认服务已启用 Codex 本机回环网络，并准备好浏览器/本地测试数据库。',
      ...(testResourceAuthorizationAvailable
        ? ['若检查会执行 migration/TRUNCATE，请确认使用隔离测试库，再点击下方授权按钮；预检仍会拒绝开发/生产库。']
        : []),
    ].join('\n');
  }
  if (kind === 'test-resource') {
    return [
      '**处理方式**：先确认测试数据库与开发/生产库完全隔离。',
      testResourceAuthorizationAvailable
        ? '确认后点击下方授权按钮；该授权只在本流水线 QA 中生效，且不会绕过测试库命名与运行库不相等检查。'
        : '也可由负责人设置 `AGENT_OS_TEST_RESOURCE_SENTINEL=true` 后重启；该开关不会绕过隔离性检查。',
    ].join('\n');
  }
  if (kind === 'gate-evidence') {
    return '**处理方式**：保持当前项目目录不变，补齐或重新生成本步骤的 Gate/artifact 证据后重试。';
  }
  return '**处理方式**：保持当前项目目录不变，解决上面的前置条件后重试。';
}

function button(
  action: string,
  value: Record<string, string>,
  text: string,
  type = 'default',
  formSubmit = false,
) {
  return {
    tag: 'button',
    element_id: `${action}_button`.slice(0, 20),
    name: `${action}_submit`.slice(0, 20),
    text: { tag: 'plain_text', content: text },
    type,
    // CLAUDE.md 错题本实战记录：form_action_type: "submit" 必须有（否则 300123）。
    // 官方文档写的 behaviors 数组 form_action 方式实际 API 报 "unknown behavior type" 400。
    // 以实战经验为准。
    ...(formSubmit ? { form_action_type: 'submit' } : {}),
    behaviors: [{ type: 'callback', value: { action, ...value } }],
  };
}

type FormElement = Record<string, unknown>;

function questionElements(question: Question, answer?: string | string[]): FormElement[] {
  const required = question.required === false ? '（可选）' : '（必答）';
  const title = `${question.prompt}${required}`;
  if (question.kind === 'text') {
    return [{
      tag: 'input',
      element_id: questionElementId('input', question.id),
      name: question.id,
      required: question.required !== false,
      label: { tag: 'plain_text', content: title },
      placeholder: { tag: 'plain_text', content: '请输入回答' },
      ...(typeof answer === 'string' ? { default_value: answer } : {}),
    }];
  }
  // JSON 2.0 的 select_static 没有 label；题干必须用独立 markdown，否则飞书 230099/200621。
  return [
    { tag: 'markdown', content: `**${title}**` },
    {
      tag: 'select_static',
      element_id: questionElementId('select', question.id),
      name: question.id,
      required: question.required !== false,
      placeholder: { tag: 'plain_text', content: '请选择' },
      options: (question.options ?? []).map((option) => ({
        text: { tag: 'plain_text', content: option },
        value: option,
      })),
      ...(question.kind === 'multi_choice' ? { multiple: true } : {}),
      ...(typeof answer === 'string'
        ? { initial_option: answer }
        : Array.isArray(answer) ? { initial_options: answer } : {}),
    },
  ];
}

function questionElementId(prefix: 'input' | 'select', questionId: string): string {
  return `${prefix}_${createHash('sha256').update(questionId).digest('hex').slice(0, 12)}`;
}

/** 第六章：把结构化问题渲染成飞书交互式表单。 */
export function buildQuestionnaireCard(questionnaire: Questionnaire): CardJson {
  const answered = questionnaire.status === 'answered';
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: `需求澄清：${questionnaire.title}` } },
    header: {
      template: answered ? 'green' : 'blue',
      title: { tag: 'plain_text', content: `需求澄清 · ${answered ? '已完成' : '待填写'}` },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        { tag: 'markdown', content: `**${questionnaire.title}**${questionnaire.goal ? `\n${questionnaire.goal}` : ''}` },
        ...(answered
          ? [{ tag: 'markdown', content: '✅ 已收到全部必答项，产品经理可以据此生成或更新 Spec。' }]
          : [{
            tag: 'form',
            name: `questionnaire_${questionnaire.id}`.slice(0, 40),
            elements: [
              ...questionnaire.questions.flatMap((question) => (
                questionElements(question, questionnaire.answers?.[question.id])
              )),
              button('submit_questionnaire', {
                questionnaireId: questionnaire.id,
                questionnaireVersion: questionnaire.updatedAt,
              }, '提交澄清结果', 'primary', true),
            ],
          }]),
      ],
    },
  };
}

export function buildSpecConfirmationCard(spec: ProductSpec): CardJson {
  const confirmed = spec.status === 'confirmed' || spec.status === 'published' || spec.status === 'in_review' || spec.status === 'approved';
  const requiresFullDocumentReview = spec.content.includes('[RISK_WAIVER]');
  const hasStableRequirementIds = extractRequirementIds(spec.content).length > 0;
  const invalidPendingSpec = spec.status === 'pending_confirmation' && !hasStableRequirementIds;
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: `Spec 待确认：${spec.title}` } },
    header: { template: confirmed ? 'green' : spec.status === 'changes_requested' ? 'red' : 'orange', title: { tag: 'plain_text', content: `产品 Spec · ${confirmed ? '已确认' : spec.status === 'changes_requested' ? '待修改' : '待确认'}` } },
    body: {
      direction: 'vertical',
      elements: [
        { tag: 'markdown', content: `**${spec.title}**\n\n${spec.content.slice(0, 5_500)}` },
        {
          tag: 'markdown',
          content: confirmed
            ? requiresFullDocumentReview
              ? '✅ 需求已确认。此 Spec 含风险接受条款，必须发布到飞书云文档完成全文评审后才能开始技术交付。'
              : '✅ 需求已确认。下一步可发布到飞书云文档评审，或直接开始技术交付。'
            : spec.status === 'changes_requested'
              ? `⛔ 已退回产品经理修改。${spec.confirmationFeedback ? `\n\n**退回意见**：${escapeCardMarkdown(spec.confirmationFeedback, 2_000)}` : ''}`
              : invalidPendingSpec
                ? '⚠️ 当前内容不是可确认的产品 Spec（缺少以条目开头声明的稳定需求 ID）。系统恢复时会自动退回产品经理；此卡不提供确认入口。'
                : requiresFullDocumentReview
                  ? '此 Spec 含风险接受条款；确认后必须发布到飞书云文档完成全文评审，不能从截断预览直接批准。'
                  : '确认方案后可选择发布到飞书云文档评审，或直接开始技术交付。',
        },
        // Schema 2.0 已废弃 tag=action 交互模块；按钮必须直接放进 body.elements（与审批卡一致）。
        ...(spec.status === 'pending_confirmation'
          ? [
            ...(!invalidPendingSpec
              ? [button('confirm_spec', { specId: spec.id, specVersion: spec.updatedAt }, '确认方案', 'primary')]
              : []),
            {
              tag: 'form',
              name: `spec_rejection_${spec.id}`.slice(0, 40),
              elements: [
                {
                  tag: 'input',
                  element_id: 'spec_feedback_input',
                  name: 'confirmationFeedback',
                  required: true,
                  input_type: 'multiline_text',
                  rows: 3,
                  // 飞书 input 默认 max_length 上限为 1000，超过会 400（code 230099 / 11310）
                  max_length: 1_000,
                  label: { tag: 'plain_text', content: '修改意见（仅点击“退回修改”时提交）' },
                  placeholder: { tag: 'plain_text', content: '请输入需要产品经理修改或补充的内容' },
                },
                button('reject_spec', { specId: spec.id, specVersion: spec.updatedAt }, '退回修改', 'danger', true),
              ],
            },
            ...(!invalidPendingSpec && !requiresFullDocumentReview
              ? [button('confirm_spec_start', { specId: spec.id, specVersion: spec.updatedAt }, '确认并直接开始技术交付', 'primary')]
              : []),
          ]
          : spec.status === 'confirmed'
            ? requiresFullDocumentReview
              ? [button('publish_spec', { specId: spec.id, specVersion: spec.updatedAt }, '发布到飞书云文档并评审', 'primary')]
              : [
                button('publish_spec', { specId: spec.id, specVersion: spec.updatedAt }, '发布到飞书云文档', 'default'),
                button('confirm_spec_start', { specId: spec.id, specVersion: spec.updatedAt }, '直接开始技术交付', 'primary'),
              ]
            : []),
      ],
    },
  };
}

export function buildSpecReviewCard(spec: ProductSpec): CardJson {
  const comment = spec.comments
    .filter((item) => !item.resolved)
    .map((item) => `- ${escapeCardMarkdown(item.content, 2_000)}`)
    .join('\n');
  const reviewing = spec.status === 'in_review';
  const statusTitle = spec.status === 'approved'
    ? '产品 Spec · 评审通过'
    : reviewing ? '产品 Spec · 评审中' : '产品 Spec · 修订中';
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: `Spec 评审：${spec.title}` } },
    header: { template: spec.status === 'approved' ? 'green' : 'blue', title: { tag: 'plain_text', content: statusTitle } },
    body: {
      direction: 'vertical',
      elements: [
        { tag: 'markdown', content: `**${spec.title}**\n${spec.docUrl ? `[打开飞书云文档](${spec.docUrl})\n评审意见将同步为云文档全文评论。` : '云文档发布中或尚未发布。'}` },
        ...(comment ? [{ tag: 'markdown', content: `**待处理意见**\n${comment}` }] : []),
        ...(reviewing
          ? [
            {
              tag: 'form',
              name: `spec_review_${spec.id}`.slice(0, 40),
              elements: [
                {
                  tag: 'input',
                  element_id: 'review_comment_input',
                  name: 'reviewComment',
                  required: false,
                  input_type: 'multiline_text',
                  rows: 3,
                  // 飞书 input 默认 max_length 上限为 1000，超过会 400（code 230099 / 11310）
                  max_length: 1_000,
                  label: { tag: 'plain_text', content: '修改意见（要求修改时必填）' },
                  placeholder: { tag: 'plain_text', content: '请输入需要产品经理处理的意见' },
                },
                button('approve_spec_review', { specId: spec.id, specVersion: spec.updatedAt }, '评审通过', 'primary', true),
                button('request_spec_changes', { specId: spec.id, specVersion: spec.updatedAt }, '要求修改', 'danger', true),
              ],
            },
          ]
          : [{ tag: 'markdown', content: spec.status === 'approved' ? '✅ 产品评审已通过，内部交付小队已启动。' : '🛠️ 产品经理正在处理评审意见。' }]),
      ],
    },
  };
}

/** `/spec show` 根据当前阶段返回可操作的最新卡片。 */
export function buildSpecStatusCard(spec: ProductSpec): CardJson {
  const reviewStage = !!spec.docId
    && (spec.status === 'published'
      || spec.status === 'in_review'
      || spec.status === 'changes_requested'
      || spec.status === 'approved');
  return reviewStage ? buildSpecReviewCard(spec) : buildSpecConfirmationCard(spec);
}

export function buildApprovalCard(approval: ApprovalRequest): CardJson {
  const authorizationExpired = !!approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now();
  const retryAllowed = approval.status === 'failed'
    && !approval.scheduleJobId
    && !authorizationExpired;
  const appearance = {
    pending: { template: 'orange', label: '等待负责人拍板', detail: '⏳ 尚未执行。审批过期后必须重新发起。' },
    approved: { template: 'blue', label: '已批准', detail: '✅ 已批准，正在等待执行。' },
    executing: { template: 'blue', label: '执行中', detail: '▶️ 已批准，本次任务正在执行。请勿重复点击。' },
    succeeded: { template: 'green', label: '已完成', detail: '✅ 本次批准的任务已执行完成。' },
    failed: {
      template: 'red',
      label: '执行失败',
      detail: approval.scheduleJobId
        ? `❌ 执行失败：${escapeCardMarkdown(approval.executionError ?? '未知错误')}\n\n定时任务会按补偿策略重新触发并生成新审批。`
        : authorizationExpired
          ? `❌ 执行失败：${escapeCardMarkdown(approval.executionError ?? '未知错误')}\n\n本次批准已过期，如需重试请重新发起审批。`
          : `❌ 执行失败：${escapeCardMarkdown(approval.executionError ?? '未知错误')}`,
    },
    rejected: { template: 'grey', label: '已拒绝', detail: '⛔ 已拒绝，任务没有执行。' },
    expired: { template: 'grey', label: '已过期', detail: '⌛ 审批已失效，任务没有执行；如仍需执行请重新发起。' },
  }[approval.status];
  const expiresAt = approval.expiresAt
    ? new Date(approval.expiresAt).toLocaleString('zh-CN', { hour12: false })
    : '未设置';
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: `高风险操作审批：${approval.reason}` } },
    header: {
      template: appearance.template,
      title: { tag: 'plain_text', content: `高风险操作 · ${appearance.label}` },
    },
    body: {
      direction: 'vertical',
      elements: [
        {
          tag: 'markdown',
          content: [
            `**风险原因**：${escapeCardMarkdown(redactSecrets(approval.reason), 300)}`,
            `**审批编号**：${approval.id}`,
            `**有效期至**：${expiresAt}`,
            `**拟执行任务**\n${escapeCardMarkdown(redactSecrets(approval.prompt), 2_000)}`,
            appearance.detail,
          ].join('\n\n'),
        },
        ...(approval.status === 'pending'
          ? [
            button('approve_high_risk', { approvalId: approval.id }, '批准执行', 'primary'),
            button('reject_high_risk', { approvalId: approval.id }, '拒绝', 'danger'),
          ]
          : retryAllowed
            ? [button('retry_high_risk', { approvalId: approval.id }, '重试本次批准任务', 'primary')]
            : []),
      ],
    },
  };
}

function escapeCardMarkdown(value: string, maxLength = 800): string {
  const text = value.trim().slice(0, maxLength);
  const suffix = value.trim().length > maxLength ? '…' : '';
  return `${text.replace(/[\\`*_~\[\]<>#]/g, '\\$&')}${suffix}`;
}
