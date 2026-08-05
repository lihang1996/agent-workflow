import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildPipelineStepPrompt,
  DEFAULT_PIPELINE_STEPS,
  DELIVERY_SQUAD_STEPS,
  parsePipelineSteps,
} from '../src/core/pipeline.js';
import { JsonQuestionnaireStore, questionnaireMatchesContext } from '../src/core/questionnaire-store.js';
import { JsonApprovalStore } from '../src/core/approval-store.js';
import { JsonSpecStore } from '../src/core/spec-store.js';
import { JsonWorkflowStore } from '../src/core/workflow-store.js';
import { CreatedDocumentWriteError, normalizeDocumentMarkdown, partitionConvertedBlocks } from '../src/im/lark.js';
import { buildQuestionnaireCard, buildSpecConfirmationCard, buildSpecReviewCard } from '../src/im/workflow-card.js';
import {
  confirmSpecForReview,
  reconcileWorkflowSpecStates,
  rejectSpecConfirmation,
  runDeliverySquad,
} from '../src/runtime/pipeline-runner.js';
import {
  approveSpecReview,
  CARD_REVIEW_COMMENT_PREFIX,
  publishSpecToDoc,
  requestSpecChangesFromCard,
  runSpecReviewSync,
} from '../src/runtime/spec-review.js';
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

test('问卷仓库兼容早期 8 位 ID 数据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-questionnaire-legacy-'));
  try {
    const legacy = {
      id: '244f742c',
      title: '早期问卷',
      questions: [{ id: 'auth', prompt: '登录方式？', kind: 'single_choice', options: ['密码', '验证码'] }],
      answers: { auth: '密码' },
      status: 'answered',
      createdAt: '2026-08-04T09:36:48.458Z',
      updatedAt: '2026-08-04T09:36:48.461Z',
    };
    await writeFile(join(root, '244f742c.json'), JSON.stringify(legacy));
    const store = new JsonQuestionnaireStore(root);
    assert.deepEqual(await store.get(legacy.id), legacy);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('问卷拒绝歧义结构与越界答案', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-questionnaire-validation-'));
  try {
    const store = new JsonQuestionnaireStore(root);
    await assert.rejects(
      store.create({
        title: '重复问题',
        questions: [
          { id: 'scope', prompt: '范围', kind: 'text' },
          { id: 'scope', prompt: '范围确认', kind: 'text' },
        ],
      }),
      /问题 ID 重复/,
    );
    const questionnaire = await store.create({
      title: '答案校验',
      questions: [
        { id: 'scope', prompt: '范围', kind: 'single_choice', options: ['A', 'B'] },
        { id: 'targets', prompt: '目标', kind: 'multi_choice', options: ['Web', 'App'] },
      ],
    });
    await assert.rejects(store.recordAnswers(questionnaire.id, { unknown: 'A' }), /问卷不包含问题/);
    await assert.rejects(store.recordAnswers(questionnaire.id, { scope: 'C' }), /选项无效/);
    await assert.rejects(store.recordAnswers(questionnaire.id, { scope: ['A', 'B'] }), /只能选择一个选项/);
    await assert.rejects(store.recordAnswers(questionnaire.id, { targets: ['Web', 'Web'] }), /不能重复/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('并发提交问卷不会覆盖答案', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-questionnaire-concurrent-'));
  try {
    const store = new JsonQuestionnaireStore(root);
    const questionnaire = await store.create({
      title: '并发回答',
      questions: [
        { id: 'scope', prompt: '范围', kind: 'text' },
        { id: 'deadline', prompt: '期限', kind: 'text' },
      ],
    });
    await Promise.all([
      store.recordAnswers(questionnaire.id, { scope: '后台' }),
      store.recordAnswers(questionnaire.id, { deadline: '明天' }),
    ]);
    const saved = await store.get(questionnaire.id);
    assert.deepEqual(saved?.answers, { scope: '后台', deadline: '明天' });
    assert.equal(saved?.status, 'answered');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('问卷访问范围覆盖工作流与飞书会话', () => {
  const questionnaire = {
    id: '6b4ca8b5-b1f3-48e4-839f-9007ce250aa1',
    title: '作用域',
    questions: [{ id: 'scope', prompt: '范围', kind: 'text' as const }],
    status: 'awaiting_answers' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workflowId: '3709353f-7ad1-4558-9075-8939b4ca4629',
    ownerOpenId: 'ou_owner',
    chatId: 'oc_chat',
    topicId: 'omt_topic',
    botId: 'pm',
    messageId: 'om_message',
  };
  const exact = {
    workflowId: questionnaire.workflowId,
    ownerOpenId: questionnaire.ownerOpenId,
    chatId: questionnaire.chatId,
    topicId: questionnaire.topicId,
    botId: questionnaire.botId,
    messageId: questionnaire.messageId,
  };
  assert.equal(questionnaireMatchesContext(questionnaire, exact), true);
  assert.equal(questionnaireMatchesContext(questionnaire, { ...exact, chatId: 'oc_other' }), false);
  assert.equal(questionnaireMatchesContext(questionnaire, { ...exact, workflowId: undefined }), false);
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

test('同一消息、审批轮次或定时轮次只创建一份工作流', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-workflow-idempotent-'));
  const path = join(root, 'workflows.json');
  try {
    const store = await JsonWorkflowStore.open(path);
    const base = {
      kind: 'team' as const,
      name: '团队交付流水线',
      initiatorBotId: 'ceo',
      goal: '完成登录功能',
      stepIds: ['pm' as const],
      message: {
        messageId: 'om_message', chatId: 'oc_chat', chatType: 'group',
        rootId: '', threadId: '', senderOpenId: 'ou_owner',
      },
    };
    const [first, duplicate] = await Promise.all([store.create(base), store.create(base)]);
    assert.equal(duplicate.id, first.id);

    const approvalInput = {
      ...base,
      message: { ...base.message, messageId: 'om_approval' },
      executionPolicy: 'approved' as const,
      approvalId: '3e3f9af8-009a-4f7f-8ce4-793fac7922d0',
      approvalAttempt: 1,
    };
    const approved = await store.create(approvalInput);
    assert.equal((await store.create(approvalInput)).id, approved.id);
    assert.equal(store.findByApproval(approvalInput.approvalId, 1)?.id, approved.id);

    const scheduleInput = {
      ...base,
      message: { ...base.message, messageId: 'om_schedule' },
      scheduleJobId: 'job-1',
      scheduleRunCount: 1,
    };
    const scheduled = await store.create(scheduleInput);
    assert.equal((await store.create(scheduleInput)).id, scheduled.id);
    assert.equal(store.findBySchedule('job-1', 1)?.id, scheduled.id);
    const nextRun = await store.create({ ...scheduleInput, scheduleRunCount: 2 });
    assert.notEqual(nextRun.id, scheduled.id);
    assert.equal(store.list().length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('工作流与 Spec 落盘失败时回滚内存状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-core-store-rollback-'));
  try {
    const workflowBlocker = join(root, 'workflow-blocker');
    const specBlocker = join(root, 'spec-blocker');
    await writeFile(workflowBlocker, 'not-a-directory');
    await writeFile(specBlocker, 'not-a-directory');
    const workflows = new JsonWorkflowStore(join(workflowBlocker, 'workflows.json'));
    const specs = new JsonSpecStore(join(specBlocker, 'specs.json'));
    await assert.rejects(() => workflows.create({
      kind: 'team',
      name: '失败流水线',
      initiatorBotId: 'ceo',
      goal: '验证回滚',
      stepIds: ['pm'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: '', senderOpenId: 'ou' },
    }));
    await assert.rejects(() => specs.create({
      title: '失败 Spec',
      content: '不会留在内存',
      chatId: 'oc',
      topicId: 'omt',
      messageId: 'om',
      ownerOpenId: 'ou',
      botId: 'pm',
    }));
    assert.equal(workflows.list().length, 0);
    assert.equal(specs.listByTopic('oc', 'omt').length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('损坏的工作流与 Spec 记录会阻止启动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-core-store-invalid-'));
  try {
    const workflowPath = join(root, 'workflows.json');
    const specPath = join(root, 'specs.json');
    await writeFile(workflowPath, JSON.stringify([{ id: 'broken' }]));
    await writeFile(specPath, JSON.stringify([{ id: 'broken' }]));
    await assert.rejects(() => JsonWorkflowStore.open(workflowPath), /第 1 条记录格式错误/);
    await assert.rejects(() => JsonSpecStore.open(specPath), /第 1 条记录格式错误/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('同一交付工作流只能关联一份产品 Spec', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-workflow-spec-unique-'));
  try {
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const workflowId = '6b4ca8b5-b1f3-48e4-839f-9007ce250aa1';
    const first = await specs.create({
      title: '登录',
      content: '第一版',
      chatId: 'oc',
      topicId: 'omt',
      messageId: 'om',
      ownerOpenId: 'ou',
      botId: 'pm',
      workflowId,
    });
    assert.equal(specs.findByWorkflowId(workflowId)?.id, first.id);
    await assert.rejects(() => specs.create({
      title: '重复方案',
      content: '不应创建',
      chatId: 'oc',
      topicId: 'omt',
      messageId: 'om',
      ownerOpenId: 'ou',
      botId: 'pm',
      workflowId,
    }), /已经关联产品 Spec/);
    assert.equal(specs.listByTopic('oc', 'omt').length, 1);
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
    await approvals.setCardMessageId(approval.id, 'om_approval_card');
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
    questions: [
      { id: 'sharedQuestionPrefixAlpha', prompt: '范围', kind: 'text' as const },
      { id: 'sharedQuestionPrefixBeta', prompt: '期限', kind: 'text' as const },
    ],
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
  const ids = questionForm.elements
    .filter((item: any) => item.tag !== 'button')
    .map((item: any) => item.element_id);
  assert.equal(new Set(ids).size, ids.length);
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

test('方案确认与退回并发时只能有一个状态生效', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-spec-confirm-race-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: '登录', stepIds: ['pm', 'dev'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    const spec = await specs.create({
      title: '登录', content: '可执行 Spec', chatId: 'oc', topicId: 'omt', messageId: 'om',
      ownerOpenId: 'ou', botId: 'pm', workflowId: workflow.id,
    });
    await workflows.update(workflow.id, {
      status: 'awaiting_spec_confirmation', nextStepIndex: 1, specId: spec.id,
    });
    const ctx = { workflows, specs } as AppContext;
    const results = await Promise.allSettled([
      confirmSpecForReview(ctx, spec.id),
      rejectSpecConfirmation(ctx, spec.id, '补充异常流程'),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(specs.get(spec.id)?.status, 'confirmed');
    assert.equal(workflows.get(workflow.id)?.status, 'awaiting_doc_review');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('方案退回意见持久化并可在中断后恢复工作流', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-spec-confirm-recover-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: '登录', stepIds: ['pm', 'dev'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    const spec = await specs.create({
      title: '登录', content: '上一版', chatId: 'oc', topicId: 'omt', messageId: 'om',
      ownerOpenId: 'ou', botId: 'pm', workflowId: workflow.id,
    });
    await workflows.update(workflow.id, {
      status: 'awaiting_spec_confirmation', nextStepIndex: 1, specId: spec.id,
    });
    const ctx = { workflows, specs } as AppContext;
    const rejected = await rejectSpecConfirmation(ctx, spec.id, '补充异常流程');
    assert.equal(rejected.spec.confirmationFeedback, '补充异常流程');
    assert.equal(workflows.get(workflow.id)?.status, 'ready');
    assert.equal(workflows.get(workflow.id)?.priorOutputs.confirmation_feedback, '补充异常流程');

    await workflows.update(workflow.id, { status: 'awaiting_spec_confirmation' });
    await specs.update(spec.id, { status: 'confirmed', confirmationFeedback: undefined });
    await reconcileWorkflowSpecStates(ctx);
    assert.equal(workflows.get(workflow.id)?.status, 'awaiting_doc_review');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('同一工作流步骤只能被一个并发执行者认领', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-workflow-claim-'));
  try {
    const store = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const workflow = await store.create({
      kind: 'team', name: '交付流水线', initiatorBotId: 'dev', goal: '修复问题', stepIds: ['dev'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: '', senderOpenId: 'ou' },
    });
    const claims = await Promise.all([store.claimReady(workflow.id), store.claimReady(workflow.id)]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(store.get(workflow.id)?.status, 'executing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('内部交付小队固定完整角色且不会被流水线配置裁剪', async () => {
  assert.deepEqual(DELIVERY_SQUAD_STEPS.map((step) => step.id), ['architect', 'dev', 'review', 'qa']);
  assert.deepEqual(parsePipelineSteps('dev,dev,unknown,review,qa').map((step) => step.id), ['dev', 'review', 'qa']);
  const dev = { id: 'dev' } as any;
  await assert.rejects(
    () => runDeliverySquad({
      shuttingDown: false,
      pipelineSteps: [{ id: 'dev', botId: 'dev', title: '开发实现' }],
      botsById: new Map([['dev', dev]]),
    } as AppContext, {
      initiator: dev,
      msg: {} as any,
      goal: '修复登录问题',
    }),
    /缺少已连接角色：architect、reviewer、qa/,
  );
});

test('内部交付小队持久化时拒绝缺步骤或重复步骤', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-squad-schema-'));
  try {
    const store = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const base = {
      name: '内部交付小队', initiatorBotId: 'dev', goal: '修复问题',
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: '', senderOpenId: 'ou' },
    };
    const complete = await store.create({
      ...base,
      kind: 'squad',
      stepIds: ['architect', 'dev', 'review', 'qa'],
    });
    assert.deepEqual(complete.stepIds, ['architect', 'dev', 'review', 'qa']);
    await assert.rejects(
      store.create({ ...base, kind: 'squad', stepIds: ['dev'] }),
      /完整执行/,
    );
    await assert.rejects(
      store.create({ ...base, kind: 'team', stepIds: ['dev', 'dev'] }),
      /不能重复/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('迟到的步骤回调不能重复推进或覆盖下一步骤', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-workflow-stale-callback-'));
  try {
    const store = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const workflow = await store.create({
      kind: 'team', name: '交付流水线', initiatorBotId: 'dev', goal: '修复问题',
      stepIds: ['architect', 'dev'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: '', senderOpenId: 'ou' },
    });
    await store.claimReady(workflow.id);
    const completions = await Promise.all([
      store.completeCurrentStep(workflow.id, 0, 'architect', '方案 A'),
      store.completeCurrentStep(workflow.id, 0, 'architect', '重复方案'),
    ]);
    assert.equal(completions.filter(Boolean).length, 1);
    assert.equal(store.get(workflow.id)?.nextStepIndex, 1);
    assert.equal(store.get(workflow.id)?.priorOutputs.architect, '方案 A');
    assert.equal(
      await store.updateIfCurrentStep(workflow.id, 0, 'architect', { status: 'failed', error: '迟到失败' }),
      undefined,
    );
    await store.claimReady(workflow.id);
    assert.equal(await store.completeCurrentStep(workflow.id, 0, 'architect', '更迟的结果'), undefined);
    const failed = await store.updateIfCurrentStep(workflow.id, 1, 'dev', {
      status: 'failed',
      error: '开发失败',
    });
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.nextStepIndex, 1);
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
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: '登录', stepIds: ['pm'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
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
      workflowId: workflow.id,
    });
    await specs.update(created.id, { status: 'confirmed' });
    await workflows.update(workflow.id, { status: 'awaiting_doc_review', specId: created.id, nextStepIndex: 1 });
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
      workflows,
      botsById: new Map([['pm', bot]]),
    } as AppContext, created.id);
    assert.deepEqual(calls, ['update:doc-existing:新版 Spec']);
    assert.equal(published.docId, 'doc-existing');
    assert.equal(published.status, 'in_review');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('并发发布同一 Spec 只创建一份飞书云文档', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-spec-publish-race-'));
  try {
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: '登录', stepIds: ['pm'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    const spec = await specs.create({
      title: '登录', content: '最终 Spec', chatId: 'oc', topicId: 'omt', messageId: 'om',
      ownerOpenId: 'ou', botId: 'pm', workflowId: workflow.id,
    });
    await specs.update(spec.id, { status: 'confirmed' });
    await workflows.update(workflow.id, { status: 'awaiting_doc_review', specId: spec.id, nextStepIndex: 1 });
    let creates = 0;
    const bot = {
      id: 'pm',
      createDocument: async () => {
        creates += 1;
        return { documentId: 'doc-once', url: 'https://feishu.cn/docx/doc-once' };
      },
    } as any;
    const ctx = { specs, workflows, botsById: new Map([['pm', bot]]) } as AppContext;
    const [first, second] = await Promise.all([
      publishSpecToDoc(ctx, spec.id),
      publishSpecToDoc(ctx, spec.id),
    ]);
    assert.equal(creates, 1);
    assert.equal(first.docId, 'doc-once');
    assert.equal(second.docId, 'doc-once');
    assert.equal(specs.get(spec.id)?.status, 'in_review');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('云文档正文首次写入失败后重试复用原文档', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-spec-publish-recover-'));
  try {
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: '登录', stepIds: ['pm'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    const spec = await specs.create({
      title: '登录', content: '最终 Spec', chatId: 'oc', topicId: 'omt', messageId: 'om',
      ownerOpenId: 'ou', botId: 'pm', workflowId: workflow.id,
    });
    await specs.update(spec.id, { status: 'confirmed' });
    await workflows.update(workflow.id, { status: 'awaiting_doc_review', specId: spec.id, nextStepIndex: 1 });
    let creates = 0;
    const updates: string[] = [];
    const bot = {
      id: 'pm',
      createDocument: async () => {
        creates += 1;
        throw new CreatedDocumentWriteError(
          'doc-recover',
          'https://feishu.cn/docx/doc-recover',
          new Error('写入失败'),
        );
      },
      updateDocument: async (documentId: string) => { updates.push(documentId); },
    } as any;
    const ctx = { specs, workflows, botsById: new Map([['pm', bot]]) } as AppContext;
    await assert.rejects(() => publishSpecToDoc(ctx, spec.id), /请重试/);
    assert.equal(specs.get(spec.id)?.docId, 'doc-recover');
    assert.equal(specs.get(spec.id)?.status, 'confirmed');
    const published = await publishSpecToDoc(ctx, spec.id);
    assert.equal(creates, 1);
    assert.deepEqual(updates, ['doc-recover']);
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
      docId: 'doc-approved',
      docUrl: 'https://feishu.cn/docx/doc-approved',
    });
    await specs.update(spec.id, { status: 'in_review' });
    await workflows.update(workflow.id, {
      status: 'awaiting_doc_review',
      nextStepIndex: 1,
      specId: spec.id,
    });
    const replies: string[] = [];
    const ceo = { id: 'ceo', reply: async (_id: string, text: string) => { replies.push(text); } } as any;
    const pm = { id: 'pm', openId: 'ou_pm', listDocumentComments: async () => [] } as any;
    const approved = await approveSpecReview({
      shuttingDown: false,
      workflows,
      specs,
      botsById: new Map([['ceo', ceo], ['pm', pm]]),
    } as AppContext, spec.id);
    assert.equal(approved.status, 'approved');
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

test('并发提交产品修改意见只创建一次云文档评论', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-review-comment-race-'));
  try {
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: '登录', stepIds: ['pm'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    const spec = await specs.create({
      title: '登录', content: 'Spec', chatId: 'oc', topicId: 'omt', messageId: 'om',
      ownerOpenId: 'ou', botId: 'pm', workflowId: workflow.id,
      docId: 'doc-review', docUrl: 'https://feishu.cn/docx/doc-review',
    });
    await specs.update(spec.id, { status: 'in_review' });
    await workflows.update(workflow.id, { status: 'awaiting_doc_review', specId: spec.id, nextStepIndex: 1 });
    let remoteCreates = 0;
    const pm = {
      id: 'pm', openId: 'ou_pm',
      createDocumentComment: async () => `comment-${++remoteCreates}`,
      replyCard: async () => 'om-card',
    } as any;
    const ctx = {
      shuttingDown: true,
      specs,
      workflows,
      botsById: new Map([['pm', pm]]),
    } as AppContext;
    const results = await Promise.allSettled([
      requestSpecChangesFromCard(ctx, spec.id, 'ou', '补充异常流程'),
      requestSpecChangesFromCard(ctx, spec.id, 'ou', '补充异常流程'),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(remoteCreates, 1);
    assert.equal(specs.get(spec.id)?.comments.length, 1);
    assert.equal(workflows.get(workflow.id)?.status, 'ready');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('评审通过前发现远端新评论会转回产品修订', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-review-remote-gate-'));
  try {
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: '登录', stepIds: ['pm'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    const spec = await specs.create({
      title: '登录', content: 'Spec', chatId: 'oc', topicId: 'omt', messageId: 'om',
      ownerOpenId: 'ou', botId: 'pm', workflowId: workflow.id,
      docId: 'doc-gate', docUrl: 'https://feishu.cn/docx/doc-gate',
    });
    await specs.update(spec.id, { status: 'in_review' });
    await workflows.update(workflow.id, { status: 'awaiting_doc_review', specId: spec.id, nextStepIndex: 1 });
    const pm = {
      id: 'pm', openId: 'ou_pm',
      listDocumentComments: async () => [{
        id: 'comment-new', commentId: 'comment-new', authorOpenId: 'ou_reviewer',
        content: '补充失败重试规则', resolved: false,
      }],
      replyCard: async () => 'om-card',
    } as any;
    const ctx = {
      shuttingDown: true,
      specs,
      workflows,
      botsById: new Map([['pm', pm]]),
    } as AppContext;
    await assert.rejects(() => approveSpecReview(ctx, spec.id), /发现新的云文档评审意见/);
    assert.equal(specs.get(spec.id)?.status, 'changes_requested');
    assert.equal(specs.get(spec.id)?.comments[0]?.docCommentId, 'comment-new');
    assert.equal(workflows.get(workflow.id)?.status, 'ready');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('卡片评论远端成功而本地中断后可由评审检查恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-review-card-recover-'));
  try {
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: '登录', stepIds: ['pm'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    const spec = await specs.create({
      title: '登录', content: 'Spec', chatId: 'oc', topicId: 'omt', messageId: 'om',
      ownerOpenId: 'ou', botId: 'pm', workflowId: workflow.id,
      docId: 'doc-card-recover', docUrl: 'https://feishu.cn/docx/doc-card-recover',
    });
    await specs.update(spec.id, { status: 'in_review' });
    await workflows.update(workflow.id, { status: 'awaiting_doc_review', specId: spec.id, nextStepIndex: 1 });
    const pm = {
      id: 'pm', openId: 'ou_pm',
      listDocumentComments: async () => [{
        id: 'comment-card', commentId: 'comment-card', authorOpenId: 'ou_pm',
        content: `${CARD_REVIEW_COMMENT_PREFIX} 补充失败重试规则`, resolved: false,
      }],
      replyCard: async () => 'om-card',
    } as any;
    await assert.rejects(() => approveSpecReview({
      shuttingDown: true,
      specs,
      workflows,
      botsById: new Map([['pm', pm]]),
    } as AppContext, spec.id), /发现新的云文档评审意见/);
    assert.equal(specs.get(spec.id)?.comments[0]?.content, '补充失败重试规则');
    assert.equal(workflows.get(workflow.id)?.status, 'ready');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('本地已处理评论会补偿同步为云文档已解决', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-review-resolution-sync-'));
  try {
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    let spec = await specs.create({
      title: '登录', content: 'Spec', chatId: 'oc', topicId: 'omt', messageId: 'om',
      ownerOpenId: 'ou', botId: 'pm', docId: 'doc-resolution',
      docUrl: 'https://feishu.cn/docx/doc-resolution',
    });
    spec = await specs.addComment(spec.id, 'ou_reviewer', '补充边界', 'comment-root:reply-a');
    spec = await specs.resolveComments(spec.id, new Set([spec.comments[0].id]));
    const resolved: string[] = [];
    const pm = {
      id: 'pm',
      resolveDocumentComment: async (_docId: string, commentId: string) => { resolved.push(commentId); },
    } as any;
    await runSpecReviewSync({
      shuttingDown: false,
      specReviewRunning: false,
      specs,
      botsById: new Map([['pm', pm]]),
    } as AppContext);
    assert.deepEqual(resolved, ['comment-root']);
    assert.ok(specs.get(spec.id)?.comments[0].documentResolvedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('产品评审卡会转义未处理评论', () => {
  const card = buildSpecReviewCard({
    id: 'spec-review-card', title: '登录', content: 'Spec', chatId: 'oc', topicId: 'omt', messageId: 'om',
    ownerOpenId: 'ou', botId: 'pm', status: 'changes_requested',
    docId: 'doc-card', docUrl: 'https://feishu.cn/docx/doc-card',
    comments: [{
      id: '6b4ca8b5-b1f3-48e4-839f-9007ce250aa1', authorOpenId: 'ou_reviewer',
      content: '*伪造强调* <at id=all>', resolved: false, createdAt: new Date().toISOString(),
    }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }) as any;
  const comments = card.body.elements.find((item: any) => item.tag === 'markdown' && /待处理意见/.test(item.content));
  assert.match(comments.content, /\\\*伪造强调\\\*/);
  assert.match(comments.content, /\\<at id=all\\>/);
});
