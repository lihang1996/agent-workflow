import {
  DEFAULT_PIPELINE_STEPS,
  buildPipelineStepPrompt,
  filterRunnableSteps,
  type PipelineStep,
} from '../core/pipeline.js';
import type { DeliveryWorkflow } from '../core/workflow-store.js';
import { buildQuestionnaireCard, buildSpecConfirmationCard } from '../im/workflow-card.js';
import type { Bot, IncomingMessage } from '../im/lark.js';
import type { AppContext } from './app-context.js';
import { runCollabReview } from './collab-runner.js';
import { startCliTask } from './cli-task.js';
import { ensureRunnableSession, topicIdOf, truncate } from './sessions.js';
import { finishApprovalExecution } from './approval-status.js';

interface ApprovedWorkflowLaunch {
  executionPolicy?: DeliveryWorkflow['executionPolicy'];
  approvalId?: string;
  approvalAttempt?: number;
  scheduleJobId?: string;
  scheduleRunCount?: number;
}

/** CEO 团队交付流水线：按步骤串联各角色，关键人工节点会持久化暂停。 */
export async function runTeamPipeline(
  ctx: AppContext,
  options: { ceo: Bot; msg: IncomingMessage; goal: string } & ApprovedWorkflowLaunch,
): Promise<void> {
  return createAndStartWorkflow(ctx, {
    initiator: options.ceo,
    msg: options.msg,
    goal: options.goal,
    requestedSteps: ctx.pipelineSteps,
    name: '团队交付流水线',
    kind: 'team',
    executionPolicy: options.executionPolicy,
    approvalId: options.approvalId,
    approvalAttempt: options.approvalAttempt,
  });
}

/** 开发内部交付小队：聚焦技术方案、实现、评审与验收。 */
export async function runDeliverySquad(
  ctx: AppContext,
  options: { initiator: Bot; msg: IncomingMessage; goal: string } & ApprovedWorkflowLaunch,
): Promise<void> {
  const requestedSteps = ctx.pipelineSteps.filter((step) =>
    step.id === 'architect' || step.id === 'dev' || step.id === 'review' || step.id === 'qa');
  return createAndStartWorkflow(ctx, {
    ...options,
    requestedSteps,
    name: '开发内部交付小队',
    kind: 'squad',
  });
}

async function createAndStartWorkflow(
  ctx: AppContext,
  options: {
    initiator: Bot;
    msg: IncomingMessage;
    goal: string;
    requestedSteps: PipelineStep[];
    name: string;
    kind: 'team' | 'squad';
  } & ApprovedWorkflowLaunch,
): Promise<void> {
  const {
    initiator,
    msg,
    goal,
    requestedSteps,
    name,
    kind,
    executionPolicy = 'standard',
    approvalId,
    approvalAttempt,
    scheduleJobId,
    scheduleRunCount,
  } = options;
  if (ctx.shuttingDown) throw new Error('服务正在停止，无法启动流水线');
  if ((approvalId && !approvalAttempt) || (!approvalId && approvalAttempt)) {
    throw new Error('审批工作流缺少完整的审批编号或执行轮次。');
  }
  if ((scheduleJobId && !scheduleRunCount) || (!scheduleJobId && scheduleRunCount)) {
    throw new Error('定时工作流缺少完整的任务编号或运行轮次。');
  }
  const steps = filterRunnableSteps(requestedSteps, new Set(ctx.botsById.keys()));
  if (steps.length === 0) throw new Error('没有可执行的流水线步骤，请检查 Bot 配置');

  const workflow = await ctx.workflows.create({
    kind,
    name,
    initiatorBotId: initiator.id,
    goal,
    stepIds: steps.map((step) => step.id),
    executionPolicy,
    approvalId,
    approvalAttempt,
    scheduleJobId,
    scheduleRunCount,
    message: storedMessage(msg),
  });
  if (approvalId && approvalAttempt) {
    try {
      await ctx.approvals.attachWorkflow(approvalId, approvalAttempt, workflow.id);
    } catch (error) {
      await ctx.workflows.update(workflow.id, {
        status: 'failed',
        error: `绑定审批失败：${(error as Error).message}`,
      });
      throw error;
    }
  }
  console.log(`[${name}] workflow=${workflow.id} 目标=${truncate(goal, 60)} 步骤=${workflow.stepIds.join(' → ')}`);
  try {
    await initiator.reply(
      msg.messageId,
      [`已启动${name}。`, `目标：${goal}`, `步骤：${steps.map((s, i) => `${i + 1}.${s.title}`).join(' → ')}`].join('\n'),
      hasThread(msg),
    );
    await continueDeliveryWorkflow(ctx, workflow.id);
  } catch (error) {
    await failWorkflow(ctx, workflow.id, `启动失败：${(error as Error).message}`);
    throw error;
  }
}

/** 从持久化状态执行一个步骤；异步 CLI 完成后由回调推进下一步。 */
export async function continueDeliveryWorkflow(ctx: AppContext, workflowId: string): Promise<void> {
  if (ctx.shuttingDown) return;
  const workflow = await ctx.workflows.claimReady(workflowId);
  if (!workflow) return;
  const steps = stepsFor(workflow);
  const msg = messageForWorkflow(workflow);
  const initiator = ctx.botsById.get(workflow.initiatorBotId);
  if (!initiator) {
    await failWorkflow(ctx, workflow.id, `发起 Bot 未连接：${workflow.initiatorBotId}`);
    return;
  }
  if (workflow.nextStepIndex >= steps.length) {
    const completed = await ctx.workflows.update(workflow.id, { status: 'completed', error: undefined });
    await settleWorkflowApproval(ctx, completed, 'succeeded');
    await settleWorkflowSchedule(ctx, completed, 'succeeded');
    await initiator.reply(msg.messageId, `${workflow.name}已全部完成。`, hasThread(msg)).catch((error) => {
      console.error(`[${workflow.name}] 完成通知发送失败:`, (error as Error).message);
    });
    return;
  }

  const stepIndex = workflow.nextStepIndex;
  const step = steps[stepIndex];
  const stepLabel = `步骤 ${stepIndex + 1}/${steps.length} · ${step.title}`;
  if (step.id === 'review') {
    await initiator.reply(msg.messageId, `${stepLabel}：启动评审协作。`, hasThread(msg));
    try {
      await runCollabReview(ctx, {
        initiator,
        msg,
        task: buildPipelineStepPrompt(step, workflow.goal, workflow.priorOutputs),
        round: 1,
        executionPolicy: workflow.executionPolicy,
        approvedScope: workflow.executionPolicy === 'approved' ? workflow.goal : undefined,
        onComplete: async ({ approved, answer }) => {
          if (!approved) {
            await failWorkflow(ctx, workflow.id, '代码评审未通过，流水线已停止，不能继续 QA。');
            return;
          }
          await completeRegularStep(ctx, workflow.id, stepIndex, step.id, answer);
        },
        onFailure: async (error) => failWorkflow(ctx, workflow.id, error.message),
      });
    } catch (error) {
      await failWorkflow(ctx, workflow.id, (error as Error).message);
    }
    return;
  }

  const actor = ctx.botsById.get(step.botId);
  if (!actor) {
    await failWorkflow(ctx, workflow.id, `角色 ${step.botId} 未连接`);
    return;
  }
  const actorSession = await ensureRunnableSession(ctx, actor, msg);
  if (!actorSession) {
    await failWorkflow(ctx, workflow.id, `${actor.name} 正忙，请稍后重新发起。`);
    return;
  }

  await initiator.reply(msg.messageId, `${stepLabel}：交给 ${actor.name}。`, hasThread(msg));
  try {
    await startCliTask(ctx, {
      bot: actor,
      msg,
      session: actorSession,
      prompt: buildPipelineStepPrompt(step, workflow.goal, workflow.priorOutputs),
      workflowId: workflow.id,
      executionPolicy: workflow.executionPolicy,
      approvedScope: workflow.executionPolicy === 'approved' ? workflow.goal : undefined,
      onSuccess: async (answer) => {
        if (step.id === 'pm') await completeProductStep(ctx, workflow.id, stepIndex, actor, answer);
        else await completeRegularStep(ctx, workflow.id, stepIndex, step.id, answer);
      },
      onFailure: async (error) => failWorkflow(ctx, workflow.id, error.message),
    });
  } catch (error) {
    await failWorkflow(ctx, workflow.id, (error as Error).message);
  }
}

async function completeProductStep(
  ctx: AppContext,
  workflowId: string,
  stepIndex: number,
  actor: Bot,
  answer: string,
): Promise<void> {
  let workflow = requireWorkflow(ctx, workflowId);
  const msg = messageForWorkflow(workflow);
  const initiator = ctx.botsById.get(workflow.initiatorBotId) ?? actor;
  const questionnaire = await ctx.questionnaires.latestAwaitingForWorkflow(workflow.id);
  if (questionnaire) {
    workflow = await ctx.workflows.update(workflow.id, {
      status: 'awaiting_questions',
      questionnaireId: questionnaire.id,
      error: undefined,
    });
    await actor.replyCard(msg.messageId, buildQuestionnaireCard(questionnaire), hasThread(msg));
    await initiator.reply(
      msg.messageId,
      `产品经理提出了结构化问题（${questionnaire.id}）。完成卡片后流水线会自动继续。`,
      hasThread(msg),
    );
    return;
  }

  const existing = workflow.specId ? ctx.specs.get(workflow.specId) : undefined;
  const handledCommentIds = new Set(
    (workflow.priorOutputs.review_comment_ids ?? '').split(',').map((id) => id.trim()).filter(Boolean),
  );
  if (existing?.docId && handledCommentIds.size > 0) {
    const documentCommentIds = new Set(existing.comments
      .filter((comment) => handledCommentIds.has(comment.id) && comment.docCommentId)
      .map((comment) => comment.docCommentId!.split(':', 1)[0]));
    for (const commentId of documentCommentIds) {
      await actor.resolveDocumentComment(existing.docId, commentId);
    }
  }
  let spec = existing
    ? await ctx.specs.update(existing.id, {
      content: answer,
      status: 'pending_confirmation',
      questionnaireId: workflow.questionnaireId,
    })
    : await ctx.specs.create({
      title: workflow.goal.slice(0, 80),
      content: answer,
      chatId: msg.chatId,
      topicId: topicIdOf(msg),
      messageId: msg.messageId,
      ownerOpenId: msg.senderOpenId,
      botId: actor.id,
      questionnaireId: workflow.questionnaireId,
      workflowId: workflow.id,
    });
  if (existing && handledCommentIds.size > 0) {
    spec = await ctx.specs.resolveComments(existing.id, handledCommentIds);
  }
  const nextPriorOutputs = { ...workflow.priorOutputs };
  delete nextPriorOutputs.previous_spec;
  delete nextPriorOutputs.confirmation_feedback;
  delete nextPriorOutputs.review_comment_ids;
  workflow = await ctx.workflows.update(workflow.id, {
    status: 'awaiting_spec_confirmation',
    specId: spec.id,
    nextStepIndex: stepIndex + 1,
    priorOutputs: { ...nextPriorOutputs, pm: answer },
    error: undefined,
  });
  await actor.replyCard(msg.messageId, buildSpecConfirmationCard(spec), hasThread(msg));
  await initiator.reply(
    msg.messageId,
    `产品 Spec 已生成（${spec.id}）。确认前架构和开发步骤不会启动。`,
    hasThread(msg),
  );
}

async function completeRegularStep(
  ctx: AppContext,
  workflowId: string,
  stepIndex: number,
  stepId: string,
  answer: string,
): Promise<void> {
  const workflow = requireWorkflow(ctx, workflowId);
  await ctx.workflows.update(workflow.id, {
    status: 'ready',
    nextStepIndex: stepIndex + 1,
    priorOutputs: { ...workflow.priorOutputs, [stepId]: answer },
    error: undefined,
  });
  await continueDeliveryWorkflow(ctx, workflow.id);
}

/** 飞书表单完成后，用答案重新执行 PM 步骤。 */
export async function resumeWorkflowAfterQuestionnaire(ctx: AppContext, questionnaireId: string): Promise<void> {
  const questionnaire = await ctx.questionnaires.get(questionnaireId);
  if (!questionnaire || questionnaire.status !== 'answered' || !questionnaire.workflowId) return;
  const workflow = requireWorkflow(ctx, questionnaire.workflowId);
  if (workflow.status !== 'awaiting_questions' || workflow.questionnaireId !== questionnaire.id) return;
  const answers = questionnaire.questions.map((question) => {
    const answer = questionnaire.answers?.[question.id];
    return `- ${question.prompt}：${Array.isArray(answer) ? answer.join('、') : answer ?? '(未答)'}`;
  }).join('\n');
  await ctx.workflows.update(workflow.id, {
    status: 'ready',
    questionnaireId: questionnaire.id,
    priorOutputs: { ...workflow.priorOutputs, clarification: answers },
    error: undefined,
  });
  await continueDeliveryWorkflow(ctx, workflow.id);
}

/** Spec 确认后进入云文档评审等待；评审通过前不启动开发步骤。 */
export async function resumeWorkflowAfterSpecConfirmation(ctx: AppContext, specId: string): Promise<void> {
  const spec = ctx.specs.get(specId);
  if (!spec?.workflowId || spec.status !== 'confirmed') return;
  const workflow = requireWorkflow(ctx, spec.workflowId);
  if (workflow.status !== 'awaiting_spec_confirmation' || workflow.specId !== spec.id) return;
  await ctx.workflows.update(workflow.id, { status: 'awaiting_doc_review', error: undefined });
}

/** Spec 被退回时回到 PM 步骤，根据确认意见生成同一份 Spec 的修订版。 */
export async function resumeWorkflowForSpecRevision(
  ctx: AppContext,
  specId: string,
  feedback: string,
  commentIds: string[] = [],
): Promise<void> {
  const spec = ctx.specs.get(specId);
  if (!spec?.workflowId) return;
  const workflow = requireWorkflow(ctx, spec.workflowId);
  const pmIndex = workflow.stepIds.indexOf('pm');
  if (pmIndex < 0) throw new Error('当前工作流没有产品经理步骤。');
  await ctx.workflows.update(workflow.id, {
    status: 'ready',
    nextStepIndex: pmIndex,
    priorOutputs: {
      ...workflow.priorOutputs,
      previous_spec: spec.content,
      confirmation_feedback: feedback,
      ...(commentIds.length > 0 ? { review_comment_ids: commentIds.join(',') } : {}),
    },
    error: undefined,
  });
  await continueDeliveryWorkflow(ctx, workflow.id);
}

/** 产品评审通过后，启动架构、开发、评审和 QA 内部交付步骤。 */
export async function resumeWorkflowAfterProductReview(ctx: AppContext, specId: string): Promise<void> {
  const spec = ctx.specs.get(specId);
  if (!spec) throw new Error(`Spec 不存在: ${specId}`);
  if (!spec.workflowId) throw new Error(`Spec ${spec.id} 没有关联交付工作流。`);
  if (spec.status !== 'approved') throw new Error(`Spec ${spec.id} 尚未通过产品评审。`);
  const workflow = requireWorkflow(ctx, spec.workflowId);
  if (workflow.status !== 'awaiting_doc_review' || workflow.specId !== spec.id) {
    throw new Error(`工作流当前状态为 ${workflow.status}，无法启动内部交付小队。`);
  }
  await ctx.workflows.update(workflow.id, {
    status: 'ready',
    priorOutputs: { ...workflow.priorOutputs, pm: spec.content },
    error: undefined,
  });
  await continueDeliveryWorkflow(ctx, workflow.id);
}

/** 服务重启后恢复尚未进入人工等待节点的流水线。 */
export async function resumeRecoverableWorkflows(ctx: AppContext): Promise<void> {
  await reconcileWorkflowSchedules(ctx);
  for (const workflow of ctx.workflows.listRecoverable()) {
    try {
      if (workflow.status === 'executing') {
        await ctx.workflows.update(workflow.id, {
          status: 'ready',
          error: '上次执行被服务重启中断，本次将从当前步骤重新检查并继续。',
        });
      }
      await continueDeliveryWorkflow(ctx, workflow.id);
    } catch (error) {
      await failWorkflow(ctx, workflow.id, `恢复失败：${(error as Error).message}`).catch((failError) => {
        console.error(`[工作流] ${workflow.id} 保存恢复失败状态异常:`, (failError as Error).message);
      });
    }
  }
}

async function failWorkflow(ctx: AppContext, workflowId: string, error: string): Promise<void> {
  const current = ctx.workflows.get(workflowId);
  if (!current || current.status === 'failed' || current.status === 'completed') return;
  const failed = await ctx.workflows.update(workflowId, { status: 'failed', error });
  const initiator = ctx.botsById.get(failed.initiatorBotId);
  if (initiator) {
    const msg = messageForWorkflow(failed);
    await initiator.reply(msg.messageId, `${failed.name}已停止：${error}`, hasThread(msg)).catch(() => undefined);
  }
  await settleWorkflowApproval(ctx, failed, 'failed', error);
  await settleWorkflowSchedule(ctx, failed, 'failed', error);
}

async function settleWorkflowApproval(
  ctx: AppContext,
  workflow: DeliveryWorkflow,
  outcome: 'succeeded' | 'failed',
  error?: string,
): Promise<void> {
  if (!workflow.approvalId || !workflow.approvalAttempt) return;
  await finishApprovalExecution(
    ctx,
    workflow.approvalId,
    workflow.approvalAttempt,
    outcome,
    error,
  ).catch((settleError) => {
    console.error(`[审批] 工作流 ${workflow.id} 回写失败:`, (settleError as Error).message);
  });
}

async function settleWorkflowSchedule(
  ctx: AppContext,
  workflow: DeliveryWorkflow,
  outcome: 'succeeded' | 'failed',
  error?: string,
): Promise<void> {
  if (!workflow.scheduleJobId || !workflow.scheduleRunCount) return;
  const job = ctx.schedules.get(workflow.scheduleJobId);
  if (!job || job.lastStatus !== 'running' || job.runCount !== workflow.scheduleRunCount) return;
  await ctx.schedules.finishRun(
    job.id,
    outcome,
    outcome === 'failed' ? (error?.trim() || '交付工作流执行失败') : undefined,
  ).catch((settleError) => {
    console.error(`[定时任务] 工作流 ${workflow.id} 结算失败:`, (settleError as Error).message);
  });
}

export async function reconcileWorkflowSchedules(ctx: AppContext): Promise<void> {
  for (const workflow of ctx.workflows.list()) {
    if (!workflow.scheduleJobId || !workflow.scheduleRunCount) continue;
    await ctx.schedules.restoreInterruptedRun(workflow.scheduleJobId, workflow.scheduleRunCount);
    if (workflow.status === 'completed') {
      await settleWorkflowSchedule(ctx, workflow, 'succeeded');
    } else if (workflow.status === 'failed') {
      await settleWorkflowSchedule(ctx, workflow, 'failed', workflow.error);
    }
  }
}

function requireWorkflow(ctx: AppContext, id: string): DeliveryWorkflow {
  const workflow = ctx.workflows.get(id);
  if (!workflow) throw new Error(`工作流不存在: ${id}`);
  return workflow;
}

function stepsFor(workflow: DeliveryWorkflow): PipelineStep[] {
  return workflow.stepIds.map((id) => {
    const step = DEFAULT_PIPELINE_STEPS.find((candidate) => candidate.id === id);
    if (!step) throw new Error(`未知工作流步骤: ${id}`);
    return step;
  });
}

function storedMessage(msg: IncomingMessage): DeliveryWorkflow['message'] {
  return {
    messageId: msg.messageId,
    chatId: msg.chatId,
    chatType: msg.chatType,
    rootId: msg.rootId,
    threadId: msg.threadId,
    senderOpenId: msg.senderOpenId,
  };
}

function messageForWorkflow(workflow: DeliveryWorkflow): IncomingMessage {
  return {
    ...workflow.message,
    messageType: 'text',
    text: '',
    senderType: 'user',
    mentions: [],
    rawContent: JSON.stringify({ text: '' }),
  };
}

function hasThread(msg: IncomingMessage): boolean {
  return !!msg.threadId || !!msg.rootId;
}
