import type { ApprovalRequest } from '../core/approval-store.js';
import type { Questionnaire, Question } from '../core/questionnaire-store.js';
import type { ProductSpec } from '../core/spec-store.js';
import type { CardJson } from './card.js';

function button(action: string, value: Record<string, string>, text: string, type = 'default') {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    behaviors: [{ type: 'callback', value: { action, ...value } }],
  };
}

function questionElement(question: Question, answer?: string | string[]) {
  const required = question.required === false ? '（可选）' : '（必答）';
  if (question.kind === 'text') {
    return {
      tag: 'input',
      name: question.id,
      label: { tag: 'plain_text', content: `${question.prompt}${required}` },
      placeholder: { tag: 'plain_text', content: '请输入回答' },
      ...(typeof answer === 'string' ? { default_value: answer } : {}),
    };
  }
  return {
    tag: 'select_static',
    name: question.id,
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
        ...questionnaire.questions.map((question) => questionElement(question, questionnaire.answers?.[question.id])),
        ...(answered
          ? [{ tag: 'markdown', content: '✅ 已收到全部必答项，产品经理可以据此生成或更新 Spec。' }]
          : [button('submit_questionnaire', { questionnaireId: questionnaire.id }, '提交澄清结果', 'primary')]),
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
        { tag: 'markdown', content: confirmed ? '✅ 需求已确认。下一步可发布到飞书云文档。' : spec.status === 'changes_requested' ? '⛔ 已退回产品经理修改。' : '确认后会进入飞书云文档发布流程。' },
        ...(spec.status === 'pending_confirmation'
          ? [
            button('confirm_spec', { specId: spec.id }, '确认方案', 'primary'),
            button('reject_spec', { specId: spec.id }, '退回修改', 'danger'),
          ]
          : []),
      ],
    },
  };
}

export function buildSpecReviewCard(spec: ProductSpec): CardJson {
  const comment = spec.comments.filter((item) => !item.resolved).map((item) => `- ${item.content}`).join('\n');
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: `Spec 评审：${spec.title}` } },
    header: { template: spec.status === 'approved' ? 'green' : 'blue', title: { tag: 'plain_text', content: '产品 Spec · 评审中' } },
    body: {
      direction: 'vertical',
      elements: [
        { tag: 'markdown', content: `**${spec.title}**\n${spec.docUrl ? `[打开飞书云文档](${spec.docUrl})` : '云文档发布中或尚未发布。'}` },
        ...(comment ? [{ tag: 'markdown', content: `**待处理意见**\n${comment}` }] : []),
        { tag: 'input', name: 'reviewComment', label: { tag: 'plain_text', content: '修改意见（要求修改时必填）' }, placeholder: { tag: 'plain_text', content: '请输入需要产品经理处理的意见' } },
        button('approve_spec_review', { specId: spec.id }, '评审通过', 'primary'),
        button('request_spec_changes', { specId: spec.id }, '要求修改', 'danger'),
      ],
    },
  };
}

export function buildApprovalCard(approval: ApprovalRequest): CardJson {
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: `高风险操作审批：${approval.reason}` } },
    header: { template: approval.status === 'approved' ? 'green' : approval.status === 'rejected' ? 'red' : 'orange', title: { tag: 'plain_text', content: '高风险操作 · 需要你拍板' } },
    body: {
      direction: 'vertical',
      elements: [
        { tag: 'markdown', content: `**风险原因**：${approval.reason}\n\n**拟执行任务**\n${approval.prompt}` },
        ...(approval.status === 'pending'
          ? [
            button('approve_high_risk', { approvalId: approval.id }, '批准执行', 'primary'),
            button('reject_high_risk', { approvalId: approval.id }, '拒绝', 'danger'),
          ]
          : [{ tag: 'markdown', content: approval.status === 'approved' ? '✅ 已批准，任务正在执行。' : '⛔ 已拒绝，任务不会执行。' }]),
      ],
    },
  };
}
