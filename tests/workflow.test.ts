import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPipelineStepPrompt, DEFAULT_PIPELINE_STEPS } from '../src/core/pipeline.js';
import { JsonQuestionnaireStore } from '../src/core/questionnaire-store.js';
import { JsonApprovalStore } from '../src/core/approval-store.js';
import { JsonSpecStore } from '../src/core/spec-store.js';
import { JsonWorkflowStore } from '../src/core/workflow-store.js';
import { normalizeDocumentMarkdown, partitionConvertedBlocks } from '../src/im/lark.js';
import { buildQuestionnaireCard, buildSpecConfirmationCard, buildSpecReviewCard } from '../src/im/workflow-card.js';
import { resumeWorkflowAfterProductReview } from '../src/runtime/pipeline-runner.js';
import { publishSpecToDoc } from '../src/runtime/spec-review.js';
import { reconcileApprovalExecutions } from '../src/runtime/approval-status.js';
import type { AppContext } from '../src/runtime/app-context.js';

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
      executionPolicy: 'approved',
      approvalId: '3e3f9af8-009a-4f7f-8ce4-793fac7922d0',
      approvalAttempt: 2,
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
    assert.equal(reopened.get(workflow.id)?.executionPolicy, 'approved');
    assert.equal(reopened.get(workflow.id)?.approvalAttempt, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('重启可修复已落盘工作流与审批之间的关联窗口', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-workflow-approval-link-'));
  try {
    const approvals = await JsonApprovalStore.open(join(root, 'approvals.json'));
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const approval = await approvals.create({
      botId: 'ceo', ownerOpenId: 'ou_owner', action: 'pipeline', prompt: '部署生产', reason: '生产发布',
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: '', senderOpenId: 'ou' },
    });
    const executing = await approvals.beginExecution(approval.id, 'ou_owner');
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: approval.prompt,
      stepIds: ['pm'], executionPolicy: 'approved', approvalId: approval.id,
      approvalAttempt: executing.executionAttempt, message: approval.message,
    });
    const ctx = { approvals, workflows, botsById: new Map() } as unknown as AppContext;
    await reconcileApprovalExecutions(ctx);
    assert.equal(approvals.get(approval.id)?.workflowId, workflow.id);
    assert.equal(approvals.get(approval.id)?.status, 'executing');
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

test('同一工作流步骤只能被一个并发执行者认领', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-workflow-claim-'));
  try {
    const store = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const workflow = await store.create({
      kind: 'squad', name: '内部交付小队', initiatorBotId: 'dev', goal: '修复问题', stepIds: ['dev'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: '', senderOpenId: 'ou' },
    });
    const claims = await Promise.all([store.claimReady(workflow.id), store.claimReady(workflow.id)]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(store.get(workflow.id)?.status, 'executing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('飞书 Markdown 转换保留图片链接并按完整子树分批', () => {
  assert.equal(normalizeDocumentMarkdown('查看 ![原型图](https://example.com/a.png)'), '查看 [原型图](https://example.com/a.png)');
  const batches = partitionConvertedBlocks([
    'root-1',
    'root-2',
  ], [
    { block_id: 'root-1', block_type: 3, children: ['child-1'] },
    { block_id: 'child-1', block_type: 31, table: { merge_info: [{ row_span: 2 }] } },
    { block_id: 'root-2', block_type: 2 },
  ], 2);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((batch) => batch.childrenIds), [['root-1'], ['root-2']]);
  assert.equal(Object.hasOwn(batches[0].blocks[1].table ?? {}, 'merge_info'), false);
});

test('Spec 修订发布覆盖原云文档且不创建新链接', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-spec-update-'));
  try {
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const created = await specs.create({
      title: '登录',
      content: '新版 Spec',
      chatId: 'oc',
      topicId: 'omt',
      messageId: 'om',
      ownerOpenId: 'ou',
      botId: 'pm',
      docId: 'doc-existing',
      docUrl: 'https://feishu.cn/docx/doc-existing',
    });
    await specs.update(created.id, { status: 'confirmed' });
    const calls: string[] = [];
    const bot = {
      id: 'pm',
      updateDocument: async (documentId: string, markdown: string) => {
        calls.push(`update:${documentId}:${markdown}`);
      },
      createDocument: async () => {
        calls.push('create');
        return { documentId: 'new', url: 'https://feishu.cn/docx/new' };
      },
    } as any;
    const published = await publishSpecToDoc({
      specs,
      botsById: new Map([['pm', bot]]),
    } as AppContext, created.id);
    assert.deepEqual(calls, ['update:doc-existing:新版 Spec']);
    assert.equal(published.docId, 'doc-existing');
    assert.equal(published.status, 'in_review');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('产品评审通过后恢复内部交付工作流', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-review-resume-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const workflow = await workflows.create({
      kind: 'team',
      name: '团队交付流水线',
      initiatorBotId: 'ceo',
      goal: '登录',
      stepIds: ['pm'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    const spec = await specs.create({
      title: '登录',
      content: '最终 Spec',
      chatId: 'oc',
      topicId: 'omt',
      messageId: 'om',
      ownerOpenId: 'ou',
      botId: 'pm',
      workflowId: workflow.id,
    });
    await specs.update(spec.id, { status: 'approved' });
    await workflows.update(workflow.id, {
      status: 'awaiting_doc_review',
      nextStepIndex: 1,
      specId: spec.id,
    });
    const replies: string[] = [];
    const ceo = { id: 'ceo', reply: async (_id: string, text: string) => { replies.push(text); } } as any;
    await resumeWorkflowAfterProductReview({
      shuttingDown: false,
      workflows,
      specs,
      botsById: new Map([['ceo', ceo]]),
    } as AppContext, spec.id);
    assert.equal(workflows.get(workflow.id)?.status, 'completed');
    assert.equal(workflows.get(workflow.id)?.priorOutputs.pm, '最终 Spec');
    assert.match(replies[0], /全部完成/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('云文档评论按远端 ID 去重并只解决本轮意见', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-spec-comments-'));
  try {
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    let spec = await specs.create({
      title: '登录', content: 'Spec', chatId: 'oc', topicId: 'omt', messageId: 'om', ownerOpenId: 'ou', botId: 'pm',
    });
    spec = await specs.addComment(spec.id, 'ou-a', '意见 A', 'comment-a');
    const commentA = spec.comments[0];
    spec = await specs.addComment(spec.id, 'ou-a', '重复意见', 'comment-a');
    assert.equal(spec.comments.length, 1);
    spec = await specs.addComment(spec.id, 'ou-b', '意见 B', 'comment-b');
    spec = await specs.resolveComments(spec.id, new Set([commentA.id]));
    assert.equal(spec.comments.find((item) => item.docCommentId === 'comment-a')?.resolved, true);
    assert.equal(spec.comments.find((item) => item.docCommentId === 'comment-b')?.resolved, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
