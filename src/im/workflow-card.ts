import { createHash } from 'node:crypto';
import type { ApprovalRequest } from '../core/approval-store.js';
import type { Questionnaire, Question } from '../core/questionnaire-store.js';
import type { ProductSpec } from '../core/spec-store.js';
import { redactSecrets } from '../core/log-inspection.js';
import type { CardJson } from './card.js';

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
    ...(formSubmit ? { action_type: 'form_submit' } : {}),
    behaviors: [{ type: 'callback', value: { action, ...value } }],
  };
}

function questionElement(question: Question, answer?: string | string[]) {
  const required = question.required === false ? '（可选）' : '（必答）';
  if (question.kind === 'text') {
    return {
      tag: 'input',
      element_id: questionElementId('input', question.id),
      name: question.id,
      required: question.required !== false,
      label: { tag: 'plain_text', content: `${question.prompt}${required}` },
      placeholder: { tag: 'plain_text', content: '请输入回答' },
      ...(typeof answer === 'string' ? { default_value: answer } : {}),
    };
  }
  return {
    tag: 'select_static',
    element_id: questionElementId('select', question.id),
    name: question.id,
    required: question.required !== false,
    label: { tag: 'plain_text', content: `${question.prompt}${required}` },
    placeholder: { tag: 'plain_text', content: '请选择' },
    options: (question.options ?? []).map((option) => ({
      text: { tag: 'plain_text', content: option },
      value: option,
    })),
    ...(question.kind === 'multi_choice' ? { multiple: true } : {}),
    ...(typeof answer === 'string'
      ? { initial_option: answer }
      : Array.isArray(answer) ? { initial_options: answer } : {}),
  };
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
              ...questionnaire.questions.map((question) => questionElement(question, questionnaire.answers?.[question.id])),
              button('submit_questionnaire', { questionnaireId: questionnaire.id }, '提交澄清结果', 'primary', true),
            ],
          }]),
      ],
    },
  };
}

export function buildSpecConfirmationCard(spec: ProductSpec): CardJson {
  const confirmed = spec.status === 'confirmed' || spec.status === 'published' || spec.status === 'in_review' || spec.status === 'approved';
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
            ? '✅ 需求已确认。下一步可发布到飞书云文档。'
            : spec.status === 'changes_requested'
              ? `⛔ 已退回产品经理修改。${spec.confirmationFeedback ? `\n\n**退回意见**：${escapeCardMarkdown(spec.confirmationFeedback, 2_000)}` : ''}`
              : '确认后会进入飞书云文档发布流程。',
        },
        ...(spec.status === 'pending_confirmation'
          ? [{
            tag: 'form',
            name: `spec_confirmation_${spec.id}`.slice(0, 40),
            elements: [
              {
                tag: 'input',
                element_id: 'spec_feedback_input',
                name: 'confirmationFeedback',
                required: false,
                input_type: 'multiline_text',
                rows: 3,
                max_length: 4_000,
                label: { tag: 'plain_text', content: '退回意见（退回修改时必填）' },
                placeholder: { tag: 'plain_text', content: '请输入需要产品经理修改的内容' },
              },
              button('confirm_spec', { specId: spec.id }, '确认方案', 'primary', true),
              button('reject_spec', { specId: spec.id }, '退回修改', 'danger', true),
            ],
          }]
          : spec.status === 'confirmed'
            ? [button('publish_spec', { specId: spec.id }, '发布到飞书云文档', 'primary')]
            : []),
      ],
    },
  };
}

export function buildSpecReviewCard(spec: ProductSpec): CardJson {
  const comment = spec.comments.filter((item) => !item.resolved).map((item) => `- ${item.content}`).join('\n');
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
                  label: { tag: 'plain_text', content: '修改意见（要求修改时必填）' },
                  placeholder: { tag: 'plain_text', content: '请输入需要产品经理处理的意见' },
                },
                button('approve_spec_review', { specId: spec.id }, '评审通过', 'primary', true),
                button('request_spec_changes', { specId: spec.id }, '要求修改', 'danger', true),
              ],
            },
          ]
          : [{ tag: 'markdown', content: spec.status === 'approved' ? '✅ 产品评审已通过，内部交付小队已启动。' : '🛠️ 产品经理正在处理评审意见。' }]),
      ],
    },
  };
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
