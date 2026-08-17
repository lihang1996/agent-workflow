import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildPipelineStepPrompt,
  DEFAULT_PIPELINE_STEPS,
  DELIVERY_SQUAD_STEPS,
  parsePipelineSteps,
  resolveSkillsRoot,
} from '../src/core/pipeline.js';
import { JsonQuestionnaireStore, extractQuestionnaireIdsFromText, questionnaireMatchesContext } from '../src/core/questionnaire-store.js';
import { JsonApprovalStore } from '../src/core/approval-store.js';
import { JsonSpecStore } from '../src/core/spec-store.js';
import { SessionManager } from '../src/core/session-manager.js';
import { JsonTopicStore } from '../src/core/topic-store.js';
import { assertManualWorkflowRetryAllowed, JsonWorkflowStore } from '../src/core/workflow-store.js';
import { CreatedDocumentWriteError, normalizeDocumentMarkdown, partitionConvertedBlocks } from '../src/im/lark.js';
import {
  buildQuestionnaireCard,
  buildSpecConfirmationCard,
  buildSpecReviewCard,
  buildSpecStatusCard,
} from '../src/im/workflow-card.js';
import {
  confirmSpecForReview,
  confirmSpecAndStartDelivery,
  completeProductStep,
  ensureCanonicalSpecSnapshotFile,
  pauseWorkflowOnUserStop,
  reconcileWorkflowTopicCliIds,
  reconcileWorkflowSpecStates,
  rejectSpecConfirmation,
  abortBlockedWorkflow,
  resumePausedOrOrphanedWorkflow,
  runDeliverySquad,
  runTeamPipeline,
} from '../src/runtime/pipeline-runner.js';
import {
  approveSpecReview,
  CARD_REVIEW_COMMENT_PREFIX,
  publishSpecToDoc,
  requestSpecChangesFromCard,
  runSpecReviewSync,
  startSpecReviewSync,
  stopSpecReviewSync,
} from '../src/runtime/spec-review.js';
import { reconcileApprovalExecutions } from '../src/runtime/approval-status.js';
import type { AppContext } from '../src/runtime/app-context.js';
import { handleCardAction } from '../src/runtime/message-handler.js';

test('手工工作流重试不能复用旧审批授权或重放定时轮次', () => {
  assert.throws(
    () => assertManualWorkflowRetryAllowed({ executionPolicy: 'approved', approvalId: 'approval', scheduleJobId: undefined }),
    /不能用 \/workflow retry 复用旧授权/,
  );
  assert.throws(
    () => assertManualWorkflowRetryAllowed({ executionPolicy: 'standard', approvalId: undefined, scheduleJobId: 'job' }),
    /不能手工重放本轮/,
  );
  assert.doesNotThrow(() => assertManualWorkflowRetryAllowed({
    executionPolicy: 'standard', approvalId: undefined, scheduleJobId: undefined,
  }));
});

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

test('可从 /form 文案提取问卷 ID 并绑定到工作流', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-questionnaire-bind-'));
  try {
    const store = new JsonQuestionnaireStore(root);
    const workflowId = '14a8e2a5-12b8-4b9e-b37e-52bb6833d1d0';
    const orphan = await store.create({
      title: '搜索框选中态',
      questions: [{ id: 'style', prompt: '选中态？', kind: 'single_choice', options: ['红框', '阴影'] }],
    });
    assert.equal(orphan.workflowId, undefined);
    assert.deepEqual(
      extractQuestionnaireIdsFromText(`请发送：\n\n/form ${orphan.id}\n\n等待用户作答。`),
      [orphan.id],
    );
    assert.equal(
      (await store.recoverAwaitingFromProductOutput(`/form ${orphan.id}`, workflowId))?.id,
      orphan.id,
    );
    const bound = await store.attachWorkflowContext(orphan.id, {
      workflowId,
      chatId: 'oc_chat',
      topicId: 'omt_topic',
      ownerOpenId: 'ou_owner',
      botId: 'pm',
      messageId: 'om_message',
    });
    assert.equal(bound.workflowId, workflowId);
    assert.equal(bound.chatId, 'oc_chat');
    assert.equal((await store.latestAwaitingForWorkflow(workflowId))?.id, orphan.id);
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

test('升级前 CEO 已选 Codex 的等待中工作流会迁移为话题统一引擎', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-workflow-topic-engine-migration-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const topics = await JsonTopicStore.open(join(root, 'topics.json'));
    const sessions = new SessionManager({
      createId: (() => {
        let value = 0;
        return () => `migration-session-${++value}`;
      })(),
      defaultCliId: 'claude',
    });
    const address = (botId: string) => ({
      messageId: `om-${botId}`, chatId: 'oc', threadId: 'omt', rootId: '', botId,
    });
    const ceo = (await sessions.resolve(address('ceo'))).session;
    await sessions.transition(ceo.id, 'idle');
    await sessions.setCliId(ceo.id, 'codex');
    const pm = (await sessions.resolve(address('pm'))).session;
    await sessions.transition(pm.id, 'idle');
    await sessions.setCliSessionId(pm.id, 'old-claude-context');
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: '修复问题', stepIds: ['pm'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    await workflows.update(workflow.id, { status: 'awaiting_questions' });
    const ctx = {
      workflows,
      topics,
      sessions,
      defaultCliId: 'claude',
      contextWindows: new Map([[pm.id, 200_000]]),
    } as unknown as AppContext;

    await reconcileWorkflowTopicCliIds(ctx);

    assert.equal(topics.getCliId('oc', 'omt'), 'codex');
    assert.equal(sessions.get(pm.id)?.cliId, 'codex');
    assert.equal(sessions.get(pm.id)?.cliSessionId, undefined);
    assert.equal(ctx.contextWindows.has(pm.id), false);
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

test('工作流、Spec 与问卷落盘失败后清理临时文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-core-store-temp-cleanup-'));
  try {
    const workflowPath = join(root, 'workflows.json');
    const specPath = join(root, 'specs.json');
    const questionnaireDir = join(root, 'questionnaires');
    const questionnaireId = '6b4ca8b5-b1f3-48e4-839f-9007ce250aa1';
    await Promise.all([
      mkdir(workflowPath),
      mkdir(specPath),
      mkdir(join(questionnaireDir, `${questionnaireId}.json`), { recursive: true }),
    ]);

    await assert.rejects(() => new JsonWorkflowStore(workflowPath).create({
      kind: 'team',
      name: '临时文件清理',
      initiatorBotId: 'ceo',
      goal: '验证工作流临时文件清理',
      stepIds: ['pm'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: '', senderOpenId: 'ou' },
    }));
    await assert.rejects(() => new JsonSpecStore(specPath).create({
      title: '临时文件清理',
      content: '验证 Spec 临时文件清理',
      chatId: 'oc',
      topicId: 'omt',
      messageId: 'om',
      ownerOpenId: 'ou',
      botId: 'pm',
    }));
    const now = new Date().toISOString();
    await assert.rejects(() => new JsonQuestionnaireStore(questionnaireDir).save({
      id: questionnaireId,
      title: '临时文件清理',
      questions: [{ id: 'scope', prompt: '范围？', kind: 'text' }],
      status: 'awaiting_answers',
      createdAt: now,
      updatedAt: now,
    }));

    const remaining = [
      ...await readdir(root),
      ...await readdir(questionnaireDir),
    ];
    assert.deepEqual(remaining.filter((name) => name.endsWith('.tmp')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('损坏的工作流、Spec 与问卷记录会阻止启动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-core-store-invalid-'));
  try {
    const workflowPath = join(root, 'workflows.json');
    const specPath = join(root, 'specs.json');
    const questionnaireDir = join(root, 'questionnaires');
    await writeFile(workflowPath, JSON.stringify([{ id: 'broken' }]));
    await writeFile(specPath, JSON.stringify([{ id: 'broken' }]));
    await mkdir(questionnaireDir);
    await writeFile(join(questionnaireDir, '12345678.json'), JSON.stringify({ id: 'broken' }));
    await assert.rejects(() => JsonWorkflowStore.open(workflowPath), /第 1 条记录格式错误/);
    await assert.rejects(() => JsonSpecStore.open(specPath), /第 1 条记录格式错误/);
    await assert.rejects(() => JsonQuestionnaireStore.open(questionnaireDir), /问卷文件格式错误/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('问卷文件名必须与内容 ID 一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-questionnaire-id-mismatch-'));
  try {
    const fileId = '12345678';
    const contentId = '87654321';
    const now = new Date().toISOString();
    await writeFile(join(root, `${fileId}.json`), JSON.stringify({
      id: contentId,
      title: '错位问卷',
      questions: [{ id: 'scope', prompt: '范围？', kind: 'text' }],
      status: 'awaiting_answers',
      createdAt: now,
      updatedAt: now,
    }));
    await assert.rejects(() => JsonQuestionnaireStore.open(root), /问卷文件 ID 不一致/);
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

test('问卷、Spec 退回和产品评审使用飞书 form_submit，Spec 确认不提交退回意见', () => {
  const questionnaire = {
    id: '6b4ca8b5-b1f3-48e4-839f-9007ce250aa1',
    title: '澄清',
    questions: [
      { id: 'sharedQuestionPrefixAlpha', prompt: '范围', kind: 'text' as const },
      { id: 'sharedQuestionPrefixBeta', prompt: '期限', kind: 'text' as const },
      {
        id: 'focusStyle',
        prompt: '搜索框选中态',
        kind: 'single_choice' as const,
        options: ['红框', '阴影'],
      },
    ],
    status: 'awaiting_answers' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const spec = {
    id: 'spec-1',
    title: '登录',
    content: '### RQ-001 登录\n内容',
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
  assert.equal(questionForm.elements.at(-1).form_action_type, 'submit');
  assert.equal(
    questionForm.elements.at(-1).behaviors[0].value.questionnaireVersion,
    questionnaire.updatedAt,
  );
  const ids = questionForm.elements
    .filter((item: any) => item.tag !== 'button' && item.tag !== 'markdown')
    .map((item: any) => item.element_id);
  assert.equal(new Set(ids).size, ids.length);
  const select = questionForm.elements.find((item: any) => item.tag === 'select_static');
  assert.ok(select);
  assert.equal(select.label, undefined);
  assert.equal(select.required, true);
  assert.equal(
    questionForm.elements.some((item: any) => item.tag === 'markdown' && String(item.content).includes('搜索框选中态')),
    true,
  );
  const confirmationCard = buildSpecConfirmationCard(spec) as any;
  const confirmationForm = confirmationCard.body.elements.find((item: any) => item.tag === 'form');
  assert.ok(confirmationForm);
  const confirmationButtons = confirmationForm.elements.filter((item: any) => item.tag === 'button');
  assert.deepEqual(
    confirmationButtons.map((item: any) => item.behaviors[0].value.action),
    ['reject_spec'],
  );
  assert.equal(confirmationButtons[0].form_action_type, 'submit');
  assert.equal(confirmationButtons.every((item: any) =>
    item.behaviors[0].value.specVersion === spec.updatedAt), true);
  const confirmButton = confirmationCard.body.elements.find((item: any) =>
    item.tag === 'button' && item.behaviors[0].value.action === 'confirm_spec');
  assert.ok(confirmButton);
  assert.equal(confirmButton.form_action_type, undefined);
  assert.equal(confirmationForm.elements.find((item: any) => item.name === 'confirmationFeedback').required, true);
  const reviewCard = buildSpecReviewCard({ ...spec, status: 'in_review', docId: 'doc', docUrl: 'https://feishu.cn/docx/doc' }) as any;
  const reviewForm = reviewCard.body.elements.find((item: any) => item.tag === 'form');
  assert.ok(reviewForm);
  assert.equal(reviewForm.elements.filter((item: any) => item.tag === 'button').every((item: any) =>
    item.behaviors[0].value.specVersion === spec.updatedAt), true);
  assert.ok((buildSpecStatusCard({
    ...spec, status: 'in_review', docId: 'doc', docUrl: 'https://feishu.cn/docx/doc',
  }) as any).body.elements.find((item: any) => item.tag === 'form'));
});

test('旧版问卷卡片不能覆盖已经提交的需求答案', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-questionnaire-stale-card-'));
  try {
    const questionnaires = new JsonQuestionnaireStore(root);
    const ownerOpenId = process.env.OWNER_OPEN_ID?.trim() || 'ou_owner';
    const questionnaire = await questionnaires.create({
      title: '范围确认',
      questions: [{ id: 'scope', prompt: '范围', kind: 'single_choice', options: ['A', 'B'] }],
      ownerOpenId,
    });
    const first = await handleCardAction({ questionnaires } as unknown as AppContext, {
      operatorOpenId: ownerOpenId,
      messageId: 'om-form',
      value: {
        action: 'submit_questionnaire',
        questionnaireId: questionnaire.id,
        questionnaireVersion: questionnaire.updatedAt,
      },
      formValue: { scope: 'A' },
    });
    assert.equal(first.toast?.type, 'success');

    const stale = await handleCardAction({ questionnaires } as unknown as AppContext, {
      operatorOpenId: ownerOpenId,
      messageId: 'om-form-old',
      value: {
        action: 'submit_questionnaire',
        questionnaireId: questionnaire.id,
        questionnaireVersion: questionnaire.updatedAt,
      },
      formValue: { scope: 'B' },
    });
    assert.match(stale.toast?.content ?? '', /卡片已过期/);
    assert.equal((await questionnaires.get(questionnaire.id))?.answers?.scope, 'A');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('旧版 Spec 卡片不能确认最新版方案', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-spec-stale-card-'));
  try {
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const ownerOpenId = process.env.OWNER_OPEN_ID?.trim() || 'ou_owner';
    const spec = await specs.create({
      title: '登录', content: '最新版', chatId: 'oc', topicId: 'omt', messageId: 'om',
      ownerOpenId, botId: 'pm',
    });
    const response = await handleCardAction({ specs } as unknown as AppContext, {
      operatorOpenId: ownerOpenId,
      messageId: 'om_old_card',
      value: { action: 'confirm_spec', specId: spec.id, specVersion: '2026-01-01T00:00:00.000Z' },
      formValue: {},
    });
    assert.match(response.toast?.content ?? '', /卡片已过期/);
    assert.equal(specs.get(spec.id)?.status, 'pending_confirmation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('普通白名单不能代替负责人批准含风险接受条款的 Spec', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-spec-waiver-owner-'));
  const previousOwner = process.env.OWNER_OPEN_ID;
  const previousAllowed = process.env.AGENT_OS_ALLOWED_OPEN_IDS;
  process.env.OWNER_OPEN_ID = 'ou_owner';
  process.env.AGENT_OS_ALLOWED_OPEN_IDS = 'ou_helper';
  try {
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const spec = await specs.create({
      title: '登录风险',
      content: '### RQ-001 登录\n[RISK_WAIVER] {"findingId":"FIND-1","owner":"ou_owner","reason":"兼容窗口","scope":"旧路由","compensatingControl":"监控","expiresAt":"2099-01-01T00:00:00.000Z"}',
      chatId: 'oc', topicId: 'omt', messageId: 'om', ownerOpenId: 'ou_requester', botId: 'pm',
    });
    const response = await handleCardAction({ specs } as unknown as AppContext, {
      operatorOpenId: 'ou_helper',
      messageId: 'om-card',
      value: { action: 'confirm_spec', specId: spec.id, specVersion: spec.updatedAt },
      formValue: {},
    });
    assert.match(response.toast?.content ?? '', /只有指定负责人/);
    assert.equal(specs.get(spec.id)?.status, 'pending_confirmation');
  } finally {
    if (previousOwner === undefined) delete process.env.OWNER_OPEN_ID;
    else process.env.OWNER_OPEN_ID = previousOwner;
    if (previousAllowed === undefined) delete process.env.AGENT_OS_ALLOWED_OPEN_IDS;
    else process.env.AGENT_OS_ALLOWED_OPEN_IDS = previousAllowed;
    await rm(root, { recursive: true, force: true });
  }
});

test('Skill 根目录可配置且默认指向仓库 skills/', () => {
  const previous = process.env.AGENT_OS_SKILLS_DIR;
  try {
    delete process.env.AGENT_OS_SKILLS_DIR;
    assert.match(resolveSkillsRoot().replace(/\\/g, '/'), /\/skills\/?$/);
    process.env.AGENT_OS_SKILLS_DIR = '/tmp/custom-skills';
    assert.equal(resolveSkillsRoot(), '/tmp/custom-skills');
  } finally {
    if (previous === undefined) delete process.env.AGENT_OS_SKILLS_DIR;
    else process.env.AGENT_OS_SKILLS_DIR = previous;
  }
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
  assert.match(revision, /必须调用 MCP 工具 propose_questions/);
});

test('PM 未创建问卷时不能把内联澄清问题保存成待确认 Spec', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-pm-output-contract-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const questionnaires = await JsonQuestionnaireStore.open(join(root, 'questionnaires'));
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: '修复登录', stepIds: ['pm'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    await workflows.update(workflow.id, { status: 'executing' });
    const cards: unknown[] = [];
    const replies: string[] = [];
    const pm = {
      id: 'pm',
      replyCard: async (_messageId: string, card: unknown) => { cards.push(card); return 'om-card'; },
    } as any;
    const ceo = {
      id: 'ceo',
      reply: async (_messageId: string, content: string) => { replies.push(content); return 'om-reply'; },
    } as any;
    const ctx = {
      workflows,
      specs,
      questionnaires,
      botsById: new Map([['pm', pm], ['ceo', ceo]]),
    } as unknown as AppContext;

    await assert.rejects(
      () => completeProductStep(ctx, workflow.id, 0, pm, '## 需要确认\n1. 登录方式是什么？'),
      /本次输出不会保存或显示确认卡/,
    );
    assert.equal(specs.findByWorkflowId(workflow.id), undefined);
    assert.equal(workflows.get(workflow.id)?.status, 'executing');
    assert.equal(cards.length, 0);
    assert.equal(replies.length, 0);

    await completeProductStep(
      ctx,
      workflow.id,
      0,
      pm,
      '### RQ-001 登录\n- [ ] 可以成功登录\n本轮不登记 [RISK_WAIVER]，也没有已接受风险。',
    );
    assert.equal(specs.findByWorkflowId(workflow.id)?.status, 'pending_confirmation');
    assert.equal(workflows.get(workflow.id)?.status, 'awaiting_spec_confirmation');
    assert.equal(cards.length, 1);
    assert.match(replies[0] ?? '', /产品 Spec 已生成/);
    assert.match(JSON.stringify(cards[0]), /confirm_spec_start/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('产品步骤能从 /form 文案找回未绑定工作流的问卷', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-pm-form-recover-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const questionnaires = await JsonQuestionnaireStore.open(join(root, 'questionnaires'));
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: '修复搜索框', stepIds: ['pm'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    await workflows.update(workflow.id, { status: 'executing' });
    const orphan = await questionnaires.create({
      title: '搜索框选中态澄清',
      questions: [{ id: 'style', prompt: '选中态？', kind: 'single_choice', options: ['红框', '阴影'] }],
    });
    const cards: unknown[] = [];
    const replies: string[] = [];
    const pm = {
      id: 'pm',
      replyCard: async (_messageId: string, card: unknown) => { cards.push(card); return 'om-card'; },
    } as any;
    const ceo = {
      id: 'ceo',
      reply: async (_messageId: string, content: string) => { replies.push(content); return 'om-reply'; },
    } as any;
    const ctx = {
      workflows,
      specs,
      questionnaires,
      botsById: new Map([['pm', pm], ['ceo', ceo]]),
    } as unknown as AppContext;

    await completeProductStep(
      ctx,
      workflow.id,
      0,
      pm,
      `需求仍存在关键歧义，已创建飞书澄清问卷。\n\n请发送：\n\n\`/form ${orphan.id}\`\n`,
    );
    assert.equal(workflows.get(workflow.id)?.status, 'awaiting_questions');
    assert.equal(workflows.get(workflow.id)?.questionnaireId, orphan.id);
    assert.equal((await questionnaires.get(orphan.id))?.workflowId, workflow.id);
    assert.equal(specs.findByWorkflowId(workflow.id), undefined);
    assert.equal(cards.length, 1);
    assert.match(replies[0] ?? '', /结构化问题/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test('用户停止任务后流水线进入 paused，重启不会自动续跑，retry 才从当前步骤继续', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-workflow-paused-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const stepIds = DEFAULT_PIPELINE_STEPS.map((step) => step.id);
    const workflow = await workflows.create({
      kind: 'team',
      name: '团队交付流水线',
      initiatorBotId: 'ceo',
      goal: '全站焦点',
      stepIds,
      qualityPolicy: 'gated',
      projectRoot: '/project/paused',
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    await workflows.update(workflow.id, {
      status: 'executing',
      nextStepIndex: 3,
      priorOutputs: { pm: 'spec', architect: 'plan', dev: 'impl' },
    });
    const ctx = { workflows, activeRuns: new Map() } as import('../src/runtime/app-context.js').AppContext;
    const paused = await pauseWorkflowOnUserStop(ctx, workflow.id);
    assert.equal(paused.status, 'paused');
    assert.equal(workflows.listRecoverable().length, 0);
    assert.equal((await pauseWorkflowOnUserStop(ctx, workflow.id)).status, 'paused');

    const second = await workflows.create({
      kind: 'team',
      name: '另一条',
      initiatorBotId: 'ceo',
      goal: '冲突',
      stepIds,
      qualityPolicy: 'gated',
      projectRoot: '/project/paused',
      message: { messageId: 'om-2', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt-2', senderOpenId: 'ou' },
    });
    await workflows.update(second.id, { status: 'awaiting_spec_confirmation', nextStepIndex: 1 });
    await assert.rejects(
      () => pauseWorkflowOnUserStop(ctx, second.id),
      /不是 executing/,
    );

    // 自动终止 paused 工作流，新工作流可以直接激活
    const activated = await workflows.activateTechnicalDelivery(second.id, 'awaiting_spec_confirmation');
    assert.equal(activated?.status, 'ready');
    assert.equal(workflows.get(workflow.id)?.status, 'failed');
    assert.match(workflows.get(workflow.id)?.error ?? '', /已自动终止本工作流/);

    // 为 resume 测试创建第三个独立项目的工作流
    const third = await workflows.create({
      kind: 'team',
      name: '第三条',
      initiatorBotId: 'ceo',
      goal: '独立项目',
      stepIds,
      qualityPolicy: 'gated',
      projectRoot: '/project/resume-test',
      message: { messageId: 'om-3', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt-3', senderOpenId: 'ou' },
    });
    await workflows.update(third.id, {
      status: 'executing',
      nextStepIndex: 2,
      priorOutputs: { pm: 'spec', architect: 'plan' },
    });
    await pauseWorkflowOnUserStop(ctx, third.id);

    // 测试 resumePausedOrOrphanedWorkflow 在有 dying session 时的行为
    const dying = new AbortController();
    dying.abort();
    ctx.activeRuns.set('dying-session', {
      workflowId: third.id,
      controller: dying,
    } as import('../src/runtime/types.js').ActiveRun);
    await assert.rejects(
      () => resumePausedOrOrphanedWorkflow(ctx, third.id),
      /仍在退出/,
    );
    ctx.activeRuns.delete('dying-session');

    // 现在可以恢复 paused 工作流
    const resumed = await resumePausedOrOrphanedWorkflow(ctx, third.id);
    assert.equal(resumed.status, 'ready');
    assert.equal(resumed.nextStepIndex, 2);
    assert.equal(resumed.error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('paused 工作流会被自动终止，为同项目新工作流让路', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-workflow-abort-lease-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const stepIds = DEFAULT_PIPELINE_STEPS.map((step) => step.id);
    const occupied = await workflows.create({
      kind: 'team',
      name: '旧交付',
      initiatorBotId: 'ceo',
      goal: '焦点环',
      stepIds,
      qualityPolicy: 'gated',
      projectRoot: '/project/shared',
      message: { messageId: 'om-old', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt-old', senderOpenId: 'ou' },
    });
    await workflows.update(occupied.id, {
      status: 'executing',
      nextStepIndex: 3,
      priorOutputs: { pm: 'spec', architect: 'plan', dev: 'impl' },
    });
    const ctx = {
      workflows,
      activeRuns: new Map(),
      botsById: new Map(),
    } as import('../src/runtime/app-context.js').AppContext;
    await pauseWorkflowOnUserStop(ctx, occupied.id);

    const waiting = await workflows.create({
      kind: 'team',
      name: '新交付',
      initiatorBotId: 'ceo',
      goal: 'P0',
      stepIds,
      qualityPolicy: 'gated',
      projectRoot: '/project/shared',
      message: { messageId: 'om-new', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt-new', senderOpenId: 'ou' },
    });
    await workflows.update(waiting.id, { status: 'awaiting_spec_confirmation', nextStepIndex: 1 });
    // 自动终止 paused 工作流，新工作流可以直接激活
    const activated = await workflows.activateTechnicalDelivery(waiting.id, 'awaiting_spec_confirmation');
    assert.equal(activated?.status, 'ready');
    assert.equal(workflows.get(occupied.id)?.status, 'failed');
    assert.match(workflows.get(occupied.id)?.error ?? '', /已自动终止本工作流/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('确认方案并直接开始技术交付，跳过飞书文档发布', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-spec-start-direct-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: '登录', stepIds: ['pm'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    const spec = await specs.create({
      title: '登录', content: '### RQ-001 登录\n可执行 Spec', chatId: 'oc', topicId: 'omt', messageId: 'om',
      ownerOpenId: 'ou', botId: 'pm', workflowId: workflow.id,
    });
    await workflows.update(workflow.id, {
      status: 'awaiting_spec_confirmation', nextStepIndex: 1, specId: spec.id,
    });
    const ctx = {
      workflows,
      specs,
      botsById: new Map([['ceo', { reply: async () => 'card' }]]),
    } as unknown as AppContext;
    await confirmSpecAndStartDelivery(ctx, spec.id);
    assert.equal(specs.get(spec.id)?.status, 'approved');
    assert.equal(specs.get(spec.id)?.canonical, true);
    assert.equal(workflows.get(workflow.id)?.status, 'completed');
    assert.match(workflows.get(workflow.id)?.priorOutputs.pm ?? '', /可执行 Spec/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('含风险接受条款的 Spec 不能从截断确认卡直接批准', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-spec-waiver-full-review-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: '登录', stepIds: ['pm'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    const waiver = {
      findingId: 'FIND-001',
      owner: '负责人',
      reason: '兼容窗口',
      scope: '仅旧登录路由',
      compensatingControl: '监控并保留回滚开关',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const spec = await specs.create({
      title: '登录',
      content: `### RQ-001 登录\n${'正文'.repeat(3_000)}\n[RISK_WAIVER] ${JSON.stringify(waiver)}`,
      chatId: 'oc', topicId: 'omt', messageId: 'om', ownerOpenId: 'ou', botId: 'pm', workflowId: workflow.id,
    });
    await workflows.update(workflow.id, {
      status: 'awaiting_spec_confirmation', nextStepIndex: 1, specId: spec.id,
    });
    const ctx = { workflows, specs, botsById: new Map() } as unknown as AppContext;
    await assert.rejects(
      confirmSpecAndStartDelivery(ctx, spec.id),
      /必须发布到飞书云文档完成全文评审/,
    );
    assert.equal(specs.get(spec.id)?.status, 'pending_confirmation');
    assert.equal(workflows.get(workflow.id)?.status, 'awaiting_spec_confirmation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('缺少稳定需求 ID 的 Spec 不能越过人工确认直接进入技术交付', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-spec-missing-requirement-id-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: '登录', stepIds: ['pm'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    const spec = await specs.create({
      title: '登录', content: '这里仅举例请使用 RQ-001，但没有需求条目',
      chatId: 'oc', topicId: 'omt', messageId: 'om', ownerOpenId: 'ou', botId: 'pm', workflowId: workflow.id,
    });
    await workflows.update(workflow.id, {
      status: 'awaiting_spec_confirmation', nextStepIndex: 1, specId: spec.id,
    });
    await assert.rejects(
      confirmSpecAndStartDelivery({ workflows, specs } as AppContext, spec.id),
      /缺少以条目开头声明的稳定需求 ID/,
    );
    assert.equal(specs.get(spec.id)?.status, 'pending_confirmation');
    assert.equal(workflows.get(workflow.id)?.status, 'awaiting_spec_confirmation');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('已确认但未发布的 Spec 可跳过云文档直接进入技术交付', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-spec-start-confirmed-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: '登录', stepIds: ['pm'],
      message: { messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    const spec = await specs.create({
      title: '登录', content: '### RQ-001 登录\n可执行 Spec', chatId: 'oc', topicId: 'omt', messageId: 'om',
      ownerOpenId: 'ou', botId: 'pm', workflowId: workflow.id,
    });
    await workflows.update(workflow.id, {
      status: 'awaiting_doc_review', nextStepIndex: 1, specId: spec.id,
    });
    await specs.update(spec.id, { status: 'confirmed' });
    const ctx = {
      workflows,
      specs,
      botsById: new Map([['ceo', { reply: async () => 'card' }]]),
    } as unknown as AppContext;
    await confirmSpecAndStartDelivery(ctx, spec.id);
    assert.equal(specs.get(spec.id)?.status, 'approved');
    assert.equal(specs.get(spec.id)?.canonical, true);
    assert.equal(workflows.get(workflow.id)?.status, 'completed');
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
      title: '登录', content: '### RQ-001 登录\n可执行 Spec', chatId: 'oc', topicId: 'omt', messageId: 'om',
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

test('重启会补齐已批准 Spec 的 canonical 切换并直接恢复技术交付', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-approved-spec-reconcile-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: '登录', stepIds: ['pm'],
      message: { messageId: 'om-approved', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    const spec = await specs.create({
      title: '登录', content: '### RQ-001 登录\n验收：成功进入首页',
      chatId: 'oc', topicId: 'omt', messageId: 'om-approved', ownerOpenId: 'ou', botId: 'pm', workflowId: workflow.id,
    });
    await specs.update(spec.id, { status: 'approved' });
    await workflows.update(workflow.id, {
      status: 'awaiting_spec_confirmation', nextStepIndex: 1, specId: spec.id,
    });

    await reconcileWorkflowSpecStates({ workflows, specs } as AppContext);

    assert.equal(specs.get(spec.id)?.canonical, true);
    assert.equal(workflows.get(workflow.id)?.status, 'ready');
    assert.equal(workflows.get(workflow.id)?.priorOutputs.pm, '### RQ-001 登录\n验收：成功进入首页');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('重启会把历史无效待确认 Spec 自动退回 PM，而不是继续展示可确认状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-invalid-pending-spec-reconcile-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: '登录', stepIds: ['pm'],
      message: { messageId: 'om-invalid-pending', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou' },
    });
    const spec = await specs.create({
      title: '登录', content: '## 需要确认\n1. 登录方式是什么？', chatId: 'oc', topicId: 'omt',
      messageId: 'om-invalid-pending', ownerOpenId: 'ou', botId: 'pm', workflowId: workflow.id,
    });
    await workflows.update(workflow.id, {
      status: 'awaiting_spec_confirmation', nextStepIndex: 1, specId: spec.id,
    });

    await reconcileWorkflowSpecStates({ workflows, specs } as AppContext);

    assert.equal(specs.get(spec.id)?.status, 'changes_requested');
    assert.match(specs.get(spec.id)?.confirmationFeedback ?? '', /系统自动退回/);
    assert.equal(workflows.get(workflow.id)?.status, 'ready');
    assert.equal(workflows.get(workflow.id)?.nextStepIndex, 0);
    assert.match(workflows.get(workflow.id)?.priorOutputs.confirmation_feedback ?? '', /propose_questions/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('坏 Spec 只会隔离对应工作流，不会阻断其他工作流恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-spec-reconcile-isolation-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const message = {
      messageId: 'om-reconcile', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt', senderOpenId: 'ou',
    };
    const invalidWorkflow = await workflows.create({
      kind: 'team', name: '坏规格', initiatorBotId: 'ceo', goal: '旧需求', stepIds: ['pm'], message,
    });
    const invalidSpec = await specs.create({
      title: '旧规格', content: '没有稳定需求编号', chatId: 'oc', topicId: 'omt',
      messageId: 'om-reconcile', ownerOpenId: 'ou', botId: 'pm', workflowId: invalidWorkflow.id,
    });
    await specs.update(invalidSpec.id, { status: 'approved' });
    await workflows.update(invalidWorkflow.id, {
      status: 'awaiting_spec_confirmation', nextStepIndex: 1, specId: invalidSpec.id,
    });

    const validWorkflow = await workflows.create({
      kind: 'team', name: '健康规格', initiatorBotId: 'ceo', goal: '新需求', stepIds: ['pm'],
      message: { ...message, messageId: 'om-reconcile-valid' },
    });
    const validSpec = await specs.create({
      title: '新规格', content: '### RQ-001 登录\n验收：成功进入首页', chatId: 'oc', topicId: 'omt',
      messageId: 'om-reconcile-valid', ownerOpenId: 'ou', botId: 'pm', workflowId: validWorkflow.id,
    });
    await specs.update(validSpec.id, { status: 'approved' });
    await workflows.update(validWorkflow.id, {
      status: 'awaiting_spec_confirmation', nextStepIndex: 1, specId: validSpec.id,
    });

    await reconcileWorkflowSpecStates({ workflows, specs, botsById: new Map() } as AppContext);

    assert.equal(workflows.get(invalidWorkflow.id)?.status, 'failed');
    assert.match(workflows.get(invalidWorkflow.id)?.error ?? '', /缺少.*稳定需求 ID/);
    assert.equal(workflows.get(validWorkflow.id)?.status, 'ready');
    assert.equal(specs.get(validSpec.id)?.canonical, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('canonical Spec 快照保留完整正文并拒绝被 Agent 改写', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-canonical-spec-snapshot-'));
  try {
    const specs = await JsonSpecStore.open(join(root, 'specs.json'));
    const content = `### RQ-001 长规格\n${'完整要求'.repeat(8_000)}`;
    const created = await specs.create({
      title: '长规格', content, projectId: root,
      chatId: 'oc', topicId: 'omt', messageId: 'om', ownerOpenId: 'ou', botId: 'pm',
    });
    await specs.update(created.id, { status: 'approved' });
    const canonical = await specs.markCanonical(created.id);

    const reference = await ensureCanonicalSpecSnapshotFile(root, canonical);
    assert.equal(await readFile(reference.path, 'utf8'), content);
    assert.equal(reference.sha256, canonical.contentHash);

    await writeFile(reference.path, 'tampered');
    await assert.rejects(
      ensureCanonicalSpecSnapshotFile(root, canonical),
      /被改写或已过期/,
    );
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

test('开发纯环境阻塞的自动纠偏在存储锁内最多执行一次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-dev-environment-autocorrect-'));
  try {
    const store = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const workflow = await store.create({
      kind: 'team', name: '交付流水线', initiatorBotId: 'dev', goal: '修复问题', stepIds: ['dev'],
      message: { messageId: 'om-auto', chatId: 'oc', chatType: 'group', rootId: '', threadId: '', senderOpenId: 'ou' },
    });
    await store.claimReady(workflow.id);
    const retries = await Promise.all([
      store.retryCurrentDevEnvironmentBlockOnce(workflow.id, 0, '重新生成 pass manifest', '第一次阻塞证据'),
      store.retryCurrentDevEnvironmentBlockOnce(workflow.id, 0, '重复指令', '重复阻塞证据'),
    ]);
    assert.equal(retries.filter(Boolean).length, 1);
    assert.equal(store.get(workflow.id)?.status, 'ready');
    assert.equal(store.get(workflow.id)?.nextStepIndex, 0);
    assert.equal(store.get(workflow.id)?.priorOutputs.dev_environment_autocorrect, '重新生成 pass manifest');
    assert.equal(store.get(workflow.id)?.priorOutputs.blocked_dev, '第一次阻塞证据');

    await store.claimReady(workflow.id);
    assert.equal(
      await store.retryCurrentDevEnvironmentBlockOnce(workflow.id, 0, '第三次指令', '第三次阻塞证据'),
      undefined,
    );
    const paused = await store.updateIfCurrentStep(workflow.id, 0, 'dev', {
      status: 'awaiting_step_unblock',
      error: '第二次仍为环境阻塞',
    });
    assert.equal(paused?.status, 'awaiting_step_unblock');
    assert.equal(paused?.priorOutputs.dev_environment_autocorrect, '重新生成 pass manifest');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('开发环境纠偏成功推进后清理本轮 marker 与旧阻塞证据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-dev-environment-autocorrect-cleanup-'));
  try {
    const store = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const workflow = await store.create({
      kind: 'team', name: '交付流水线', initiatorBotId: 'dev', goal: '修复问题', stepIds: ['dev', 'qa'],
      message: { messageId: 'om-auto-clean', chatId: 'oc', chatType: 'group', rootId: '', threadId: '', senderOpenId: 'ou' },
    });
    await store.claimReady(workflow.id);
    await store.retryCurrentDevEnvironmentBlockOnce(
      workflow.id,
      0,
      '重新生成 pass manifest',
      '旧环境阻塞证据',
    );
    await store.claimReady(workflow.id);
    const completed = await store.completeCurrentStep(workflow.id, 0, 'dev', '开发纠偏后通过');
    assert.equal(completed?.nextStepIndex, 1);
    assert.equal(completed?.priorOutputs.dev, '开发纠偏后通过');
    assert.equal(completed?.priorOutputs.dev_environment_autocorrect, undefined);
    assert.equal(completed?.priorOutputs.blocked_dev, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('同一项目只能原子激活一条技术交付，避免跨话题代码与证据污染', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-project-lease-'));
  try {
    const store = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const stepIds = DEFAULT_PIPELINE_STEPS.map((step) => step.id);
    const message = {
      messageId: 'om-lease-a', chatId: 'oc', chatType: 'group', rootId: '', threadId: 'omt-a', senderOpenId: 'ou',
    };
    const first = await store.create({
      kind: 'team', name: '交付 A', initiatorBotId: 'ceo', goal: 'A', stepIds,
      qualityPolicy: 'gated', projectRoot: '/project/shared', message,
    });
    const second = await store.create({
      kind: 'team', name: '交付 B', initiatorBotId: 'ceo', goal: 'B', stepIds,
      qualityPolicy: 'gated', projectRoot: '/project/shared',
      message: { ...message, messageId: 'om-lease-b', threadId: 'omt-b' },
    });
    await store.update(first.id, { status: 'awaiting_spec_confirmation', nextStepIndex: 1 });
    await store.update(second.id, { status: 'awaiting_doc_review', nextStepIndex: 1 });

    const callbacks: string[] = [];
    const activations = await Promise.allSettled([
      store.activateTechnicalDelivery(first.id, 'awaiting_spec_confirmation', {}, async () => {
        callbacks.push(first.id);
      }),
      store.activateTechnicalDelivery(second.id, 'awaiting_doc_review', {}, async () => {
        callbacks.push(second.id);
      }),
    ]);

    assert.equal(activations.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(activations.filter((result) => result.status === 'rejected').length, 1);
    const rejected = activations.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.match(String(rejected?.reason), /已有技术交付工作流/);
    assert.equal(callbacks.length, 1);
    assert.equal([store.get(first.id), store.get(second.id)].filter((item) => item?.status === 'ready').length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('内部交付小队固定完整角色且不会被流水线配置裁剪', async () => {
  assert.deepEqual(DELIVERY_SQUAD_STEPS.map((step) => step.id), [
    'architect', 'dev', 'review', 'qa', 'runtime_audit', 'final_review',
  ]);
  assert.throws(() => parsePipelineSteps('dev,dev,unknown,review,qa'), /未知步骤|重复步骤/);
  assert.deepEqual(parsePipelineSteps(undefined), DEFAULT_PIPELINE_STEPS);
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

test('门禁流水线不从目标文本或 Bot 默认目录隐式绑定项目', async () => {
  const ceo = { id: 'ceo', name: 'CEO', workdir: '/tmp/implicit-project' } as any;
  const botsById = new Map<string, any>();
  for (const id of ['ceo', 'pm', 'architect', 'dev', 'reviewer', 'qa']) botsById.set(id, ceo);
  const ctx = {
    shuttingDown: false,
    pipelineSteps: DEFAULT_PIPELINE_STEPS,
    botsById,
    topics: { getWorkdir: () => undefined },
  } as AppContext;
  await assert.rejects(
    () => runTeamPipeline(ctx, {
      ceo,
      msg: {
        messageId: 'om', topicId: 'omt', chatId: 'oc', chatType: 'group', rootId: '', threadId: '',
        senderOpenId: 'ou', messageType: 'text', text: '', senderType: 'user', mentions: [], rawContent: '{}',
      },
      goal: '优化 /tmp/implicit-project 的代码',
    }),
    /必须先绑定真实项目目录/,
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
    {
      block_id: 'child-1',
      block_type: 31,
      table: {
        merge_info: [{ row_span: 2 }],
        property: { row_size: 1, column_size: 1, merge_info: [{ row_span: 1, col_span: 1 }] },
      },
    },
    { block_id: 'root-2', block_type: 2 },
  ], 2);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((batch) => batch.childrenIds), [['root-1'], ['root-2']]);
  const table = batches[0].blocks[1].table ?? {};
  assert.equal(Object.hasOwn(table, 'merge_info'), false);
  assert.equal(Object.hasOwn((table.property as object) ?? {}, 'merge_info'), false);
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
      content: '### RQ-001 登录\n最终 Spec',
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
    assert.equal(workflows.get(workflow.id)?.priorOutputs.pm, '### RQ-001 登录\n最终 Spec');
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

test('产品评审定时同步会兜底入口异常并清理运行标记', async () => {
  const ctx = {
    shuttingDown: false,
    specReviewRunning: false,
    specs: {
      listPendingDocumentResolution: () => {
        throw new Error('secret=review-token\n伪造日志');
      },
    },
  } as unknown as AppContext;
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    startSpecReviewSync(ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ctx.specReviewRunning, false);
    assert.match(errors.join('\n'), /云文档评论同步任务异常/);
    assert.doesNotMatch(errors.join('\n'), /review-token/);
    assert.match(errors.join('\n'), /\\n伪造日志/);
  } finally {
    stopSpecReviewSync(ctx);
    console.error = originalError;
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
