import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPipelineStepPrompt, DEFAULT_PIPELINE_STEPS } from '../src/core/pipeline.js';
import { JsonQuestionnaireStore } from '../src/core/questionnaire-store.js';
import { JsonWorkflowStore } from '../src/core/workflow-store.js';
import { buildQuestionnaireCard, buildSpecConfirmationCard, buildSpecReviewCard } from '../src/im/workflow-card.js';

test('问卷带工作流作用域并可持久化答案', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-questionnaire-'));
  try {
    const store = new JsonQuestionnaireStore(root);
    const workflowId = '6b4ca8b5-b1f3-48e4-839f-9007ce250aa1';
    const questionnaire = await store.create({
      title: '需求澄清',
      questions: [{ id: 'scope', prompt: '范围是什么？', kind: 'single_choice', options: ['A', 'B'] }],
      chatId: 'oc_chat',
      topicId: 'omt_topic',
      ownerOpenId: 'ou_owner',
      botId: 'pm',
      messageId: 'om_message',
      workflowId,
    });
    assert.match(questionnaire.id, /^[0-9a-f-]{36}$/);
    assert.equal((await store.latestAwaitingForWorkflow(workflowId))?.id, questionnaire.id);
    const answered = await store.recordAnswers(questionnaire.id, { scope: 'A' });
    assert.equal(answered.questionnaire.status, 'answered');
    assert.equal(await store.latestAwaitingForWorkflow(workflowId), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('交付工作流状态可在重启后恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-workflow-'));
  const path = join(root, 'workflows.json');
  try {
    const store = await JsonWorkflowStore.open(path);
    const workflow = await store.create({
      kind: 'team',
      name: '团队交付流水线',
      initiatorBotId: 'ceo',
      goal: '完成登录功能',
      stepIds: ['pm', 'dev'],
      message: {
        messageId: 'om_message',
        chatId: 'oc_chat',
        chatType: 'group',
        rootId: 'om_root',
        threadId: '',
        senderOpenId: 'ou_owner',
      },
    });
    await store.update(workflow.id, {
      status: 'awaiting_spec_confirmation',
      nextStepIndex: 1,
      specId: 'spec-1',
      priorOutputs: { pm: 'spec' },
    });
    const reopened = await JsonWorkflowStore.open(path);
    assert.equal(reopened.get(workflow.id)?.status, 'awaiting_spec_confirmation');
    assert.equal(reopened.get(workflow.id)?.nextStepIndex, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('问卷、Spec 确认和产品评审均使用飞书 form_submit', () => {
  const questionnaire = {
    id: '6b4ca8b5-b1f3-48e4-839f-9007ce250aa1',
    title: '澄清',
    questions: [{ id: 'scope', prompt: '范围', kind: 'text' as const }],
    status: 'awaiting_answers' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const spec = {
    id: 'spec-1',
    title: '登录',
    content: '内容',
    chatId: 'oc',
    topicId: 'omt',
    messageId: 'om',
    ownerOpenId: 'ou',
    botId: 'pm',
    status: 'pending_confirmation' as const,
    comments: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const questionCard = buildQuestionnaireCard(questionnaire) as any;
  const questionForm = questionCard.body.elements.find((item: any) => item.tag === 'form');
  assert.ok(questionForm);
  assert.equal(questionForm.elements.at(-1).action_type, 'form_submit');
  const confirmationCard = buildSpecConfirmationCard(spec) as any;
  const confirmationForm = confirmationCard.body.elements.find((item: any) => item.tag === 'form');
  assert.ok(confirmationForm);
  assert.equal(confirmationForm.elements.filter((item: any) => item.tag === 'button').every((item: any) => item.action_type === 'form_submit'), true);
  const reviewCard = buildSpecReviewCard({ ...spec, status: 'in_review', docId: 'doc', docUrl: 'https://feishu.cn/docx/doc' }) as any;
  assert.ok(reviewCard.body.elements.find((item: any) => item.tag === 'form'));
});

test('PM 在澄清完成后输出可执行 Spec，退回后输出修订版', () => {
  const pm = DEFAULT_PIPELINE_STEPS[0];
  const clarified = buildPipelineStepPrompt(pm, '登录', { clarification: '- 登录方式：验证码' });
  assert.match(clarified, /可勾选清单/);
  assert.doesNotMatch(clarified, /propose_questions/);
  const revision = buildPipelineStepPrompt(pm, '登录', {
    previous_spec: '旧版',
    confirmation_feedback: '补充异常流程',
  });
  assert.match(revision, /产品经理修订/);
  assert.match(revision, /补充异常流程/);
});

test('工作流支持在云文档评审节点暂停', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-doc-review-'));
  try {
    const store = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const workflow = await store.create({
      kind: 'team',
      name: '团队交付流水线',
      initiatorBotId: 'ceo',
      goal: '登录',
      stepIds: ['pm', 'dev'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    const waiting = await store.update(workflow.id, { status: 'awaiting_doc_review', nextStepIndex: 1 });
    assert.equal(waiting.status, 'awaiting_doc_review');
    assert.equal(store.listRecoverable().length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
