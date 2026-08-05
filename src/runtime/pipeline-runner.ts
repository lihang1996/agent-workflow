import {
  DEFAULT_PIPELINE_STEPS,
  DELIVERY_SQUAD_STEPS,
  buildPipelineStepPrompt,
  filterRunnableSteps,
  missingBotIdsForSteps,
  type PipelineStep,
} from '../core/pipeline.js';
import type { DeliveryWorkflow } from '../core/workflow-store.js';
import type { ProductSpec } from '../core/spec-store.js';
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

interface WorkflowStepExpectation {
  stepIndex: number;
  stepId: PipelineStep['id'];
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
    scheduleJobId: options.scheduleJobId,
    scheduleRunCount: options.scheduleRunCount,
  });
}

/** 开发内部交付小队：聚焦技术方案、实现、评审与验收。 */
export async function runDeliverySquad(
  ctx: AppContext,
  options: { initiator: Bot; msg: IncomingMessage; goal: string } & ApprovedWorkflowLaunch,
): Promise<void> {
  const missingBotIds = missingBotIdsForSteps(DELIVERY_SQUAD_STEPS, new Set(ctx.botsById.keys()));
  if (missingBotIds.length > 0) {
    throw new Error(`内部交付小队缺少已连接角色：${missingBotIds.join('、')}`);
  }
  return createAndStartWorkflow(ctx, {
    ...options,
    requestedSteps: DELIVERY_SQUAD_STEPS,
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
  const msg = messageForWorkflow(workflow);
  const initiator = ctx.botsById.get(workflow.initiatorBotId);
  try {
    if (!initiator) throw new Error(`发起 Bot 未连接：${workflow.initiatorBotId}`);
    const steps = stepsFor(workflow);
    if (workflow.nextStepIndex >= steps.length) {
      const completed = await ctx.workflows.updateIfStatus(workflow.id, 'executing', {
        status: 'completed',
        error: undefined,
      });
      if (!completed) return;
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
      await runCollabReview(ctx, {
        initiator,
        msg,
        task: buildPipelineStepPrompt(step, workflow.goal, workflow.priorOutputs),
        round: 1,
        executionPolicy: workflow.executionPolicy,
        approvedScope: workflow.executionPolicy === 'approved' ? workflow.goal : undefined,
        stateKey: `workflow:${workflow.id}`,
        onComplete: async ({ approved, answer }) => {
          if (!approved) {
            await failWorkflow(
              ctx,
              workflow.id,
              '代码评审未通过，流水线已停止，不能继续 QA。',
              { stepIndex, stepId: step.id },
            );
            return;
          }
          await completeRegularStep(ctx, workflow.id, stepIndex, step.id, answer);
        },
        onFailure: async (error) => failWorkflow(
          ctx,
          workflow.id,
          error.message,
          { stepIndex, stepId: step.id },
        ),
      });
      return;
    }

    const actor = ctx.botsById.get(step.botId);
    if (!actor) throw new Error(`角色 ${step.botId} 未连接`);
    const actorSession = await ensureRunnableSession(ctx, actor, msg);
    if (!actorSession) throw new Error(`${actor.name} 正忙，请稍后重新发起。`);

    await initiator.reply(msg.messageId, `${stepLabel}：交给 ${actor.name}。`, hasThread(msg));
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
      onFailure: async (error) => failWorkflow(
        ctx,
        workflow.id,
        error.message,
        { stepIndex, stepId: step.id },
      ),
    });
  } catch (error) {
    const currentStepId = workflow.stepIds[workflow.nextStepIndex];
    await failWorkflow(
      ctx,
      workflow.id,
      (error as Error).message,
      currentStepId ? { stepIndex: workflow.nextStepIndex, stepId: currentStepId } : undefined,
    );
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
  if (!isCurrentExecutingStep(workflow, stepIndex, 'pm')) return;
  const msg = messageForWorkflow(workflow);
  const initiator = ctx.botsById.get(workflow.initiatorBotId) ?? actor;
  const questionnaire = await ctx.questionnaires.latestAwaitingForWorkflow(workflow.id);
  workflow = requireWorkflow(ctx, workflowId);
  if (!isCurrentExecutingStep(workflow, stepIndex, 'pm')) return;
  if (questionnaire) {
    const paused = await ctx.workflows.updateIfCurrentStep(workflow.id, stepIndex, 'pm', {
      status: 'awaiting_questions',
      questionnaireId: questionnaire.id,
      error: undefined,
    });
    if (!paused) return;
    workflow = paused;
    await actor.replyCard(msg.messageId, buildQuestionnaireCard(questionnaire), hasThread(msg));
    await initiator.reply(
      msg.messageId,
      `产品经理提出了结构化问题（${questionnaire.id}）。完成卡片后流水线会自动继续。`,
      hasThread(msg),
    );
    return;
  }

  const linkedById = workflow.specId ? ctx.specs.get(workflow.specId) : undefined;
  if (workflow.specId && !linkedById) {
    throw new Error(`工作流关联的 Spec 不存在: ${workflow.specId}`);
  }
  if (linkedById?.workflowId && linkedById.workflowId !== workflow.id) {
    throw new Error(`Spec ${linkedById.id} 不属于工作流 ${workflow.id}`);
  }
  const recovered = ctx.specs.findByWorkflowId(workflow.id);
  if (linkedById && recovered && linkedById.id !== recovered.id) {
    throw new Error(`工作流 ${workflow.id} 关联了多份产品 Spec`);
  }
  // 修复“Spec 已写入、工作流关联尚未写入”时的重启窗口，避免重复创建方案。
  const existing = linkedById ?? recovered;
  const handledCommentIds = new Set(
    (workflow.priorOutputs.review_comment_ids ?? '').split(',').map((id) => id.trim()).filter(Boolean),
  );
  const documentCommentGroups = new Map<string, string[]>();
  if (existing?.docId && handledCommentIds.size > 0) {
    for (const comment of existing.comments) {
      if (!handledCommentIds.has(comment.id) || !comment.docCommentId) continue;
      const documentCommentId = comment.docCommentId.split(':', 1)[0];
      documentCommentGroups.set(
        documentCommentId,
        [...(documentCommentGroups.get(documentCommentId) ?? []), comment.id],
      );
    }
  }
  let spec = existing
    ? await ctx.specs.update(existing.id, {
      content: answer,
      status: 'pending_confirmation',
      questionnaireId: workflow.questionnaireId,
      confirmationFeedback: undefined,
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
  const paused = await ctx.workflows.updateIfCurrentStep(workflow.id, stepIndex, 'pm', {
    status: 'awaiting_spec_confirmation',
    specId: spec.id,
    nextStepIndex: stepIndex + 1,
    priorOutputs: { ...nextPriorOutputs, pm: answer },
    error: undefined,
  });
  if (!paused) throw new Error('产品步骤状态已变化，已停止发送过期的方案确认卡。');
  workflow = paused;
  await actor.replyCard(msg.messageId, buildSpecConfirmationCard(spec), hasThread(msg));
  await initiator.reply(
    msg.messageId,
    `产品 Spec 已生成（${spec.id}）。确认前架构和开发步骤不会启动。`,
    hasThread(msg),
  );
  if (existing?.docId) {
    for (const [documentCommentId, localCommentIds] of documentCommentGroups) {
      try {
        await actor.resolveDocumentComment(existing.docId, documentCommentId);
        await ctx.specs.markDocumentCommentsResolved(existing.id, new Set(localCommentIds));
      } catch (error) {
        console.error(
          `[产品评审] 同步解决 Spec ${existing.id} 评论 ${documentCommentId} 失败，将由轮询重试:`,
          (error as Error).message,
        );
      }
    }
  }
}

function isCurrentExecutingStep(
  workflow: DeliveryWorkflow,
  stepIndex: number,
  stepId: PipelineStep['id'],
): boolean {
  return workflow.status === 'executing'
    && workflow.nextStepIndex === stepIndex
    && workflow.stepIds[stepIndex] === stepId;
}

async function completeRegularStep(
  ctx: AppContext,
  workflowId: string,
  stepIndex: number,
  stepId: PipelineStep['id'],
  answer: string,
): Promise<void> {
  const advanced = await ctx.workflows.completeCurrentStep(workflowId, stepIndex, stepId, answer);
  if (!advanced) return;
  await continueDeliveryWorkflow(ctx, advanced.id);
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
  const transitioned = await ctx.workflows.updateIfStatus(workflow.id, 'awaiting_questions', {
    status: 'ready',
    questionnaireId: questionnaire.id,
    priorOutputs: { ...workflow.priorOutputs, clarification: answers },
    error: undefined,
  });
  if (!transitioned || transitioned.questionnaireId !== questionnaire.id) return;
  await continueDeliveryWorkflow(ctx, transitioned.id);
}

/** 原子确认 Spec，并把交付工作流推进到云文档评审等待。 */
export async function confirmSpecForReview(ctx: AppContext, specId: string) {
  const spec = ctx.specs.get(specId);
  if (!spec) throw new Error(`Spec 不存在: ${specId}`);
  if (!spec.workflowId) throw new Error(`Spec ${spec.id} 没有关联交付工作流。`);
  const workflow = requireWorkflow(ctx, spec.workflowId);
  if (workflow.status !== 'awaiting_spec_confirmation' || workflow.specId !== spec.id) {
    throw new Error('交付工作流不在方案确认节点。');
  }
  const confirmed = await ctx.specs.updateIfStatus(spec.id, 'pending_confirmation', {
    status: 'confirmed',
    confirmationFeedback: undefined,
  });
  if (!confirmed) throw new Error(`Spec 当前状态为 ${ctx.specs.get(spec.id)?.status ?? 'unknown'}，无法重复确认。`);
  try {
    const transitioned = await ctx.workflows.updateIfStatus(workflow.id, 'awaiting_spec_confirmation', {
      status: 'awaiting_doc_review',
      error: undefined,
    });
    if (!transitioned || transitioned.specId !== confirmed.id) {
      throw new Error('交付工作流状态已变化，方案确认未生效。');
    }
    return confirmed;
  } catch (error) {
    await ctx.specs.updateIfStatus(confirmed.id, 'confirmed', { status: 'pending_confirmation' })
      .catch((rollbackError) => {
        console.error(`[工作流] 回滚 Spec ${confirmed.id} 确认状态失败:`, (rollbackError as Error).message);
      });
    throw error;
  }
}

/** 记录退回意见并把工作流安全地放回 PM 步骤；调用方再异步启动该步骤。 */
export async function rejectSpecConfirmation(
  ctx: AppContext,
  specId: string,
  feedback: string,
): Promise<{ spec: ProductSpec; workflowId: string }> {
  const normalized = feedback.trim();
  if (!normalized) throw new Error('退回修改时请填写具体意见。');
  if (normalized.length > 4_000) throw new Error('退回意见不能超过 4000 字。');
  const spec = ctx.specs.get(specId);
  if (!spec) throw new Error(`Spec 不存在: ${specId}`);
  if (!spec.workflowId) throw new Error(`Spec ${spec.id} 没有关联交付工作流。`);
  const workflow = requireWorkflow(ctx, spec.workflowId);
  if (workflow.status !== 'awaiting_spec_confirmation' || workflow.specId !== spec.id) {
    throw new Error('交付工作流不在方案确认节点。');
  }
  const changed = await ctx.specs.updateIfStatus(spec.id, 'pending_confirmation', {
    status: 'changes_requested',
    confirmationFeedback: normalized,
  });
  if (!changed) throw new Error(`Spec 当前状态为 ${ctx.specs.get(spec.id)?.status ?? 'unknown'}，无法重复退回。`);
  try {
    const transitioned = await prepareWorkflowForSpecRevision(ctx, changed, normalized, [], 'awaiting_spec_confirmation');
    if (!transitioned) throw new Error('交付工作流状态已变化，方案退回未生效。');
    return { spec: changed, workflowId: workflow.id };
  } catch (error) {
    await ctx.specs.updateIfStatus(changed.id, 'changes_requested', {
      status: 'pending_confirmation',
      confirmationFeedback: undefined,
    }).catch((rollbackError) => {
      console.error(`[工作流] 回滚 Spec ${changed.id} 退回状态失败:`, (rollbackError as Error).message);
    });
    throw error;
  }
}

/** Spec 被退回时回到 PM 步骤，根据确认意见生成同一份 Spec 的修订版。 */
export async function resumeWorkflowForSpecRevision(
  ctx: AppContext,
  specId: string,
  feedback: string,
  commentIds: string[] = [],
): Promise<void> {
  const spec = ctx.specs.get(specId);
  if (!spec?.workflowId || spec.status !== 'changes_requested') return;
  const workflow = requireWorkflow(ctx, spec.workflowId);
  const transitioned = await prepareWorkflowForSpecRevision(
    ctx,
    spec,
    feedback,
    commentIds,
    'awaiting_doc_review',
  );
  if (!transitioned) return;
  await continueDeliveryWorkflow(ctx, workflow.id);
}

async function prepareWorkflowForSpecRevision(
  ctx: AppContext,
  spec: ProductSpec,
  feedback: string,
  commentIds: string[],
  expectedStatus: DeliveryWorkflow['status'] | readonly DeliveryWorkflow['status'][],
): Promise<DeliveryWorkflow | undefined> {
  if (!spec.workflowId) return undefined;
  const workflow = requireWorkflow(ctx, spec.workflowId);
  if (workflow.specId !== spec.id) throw new Error('Spec 与交付工作流关联不一致。');
  const pmIndex = workflow.stepIds.indexOf('pm');
  if (pmIndex < 0) throw new Error('当前工作流没有产品经理步骤。');
  return ctx.workflows.updateIfStatus(workflow.id, expectedStatus, {
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
  const transitioned = await ctx.workflows.updateIfStatus(workflow.id, 'awaiting_doc_review', {
    status: 'ready',
    priorOutputs: { ...workflow.priorOutputs, pm: spec.content },
    error: undefined,
  });
  if (!transitioned) throw new Error(`工作流当前状态为 ${ctx.workflows.get(workflow.id)?.status ?? 'unknown'}，无法启动内部交付小队。`);
  await continueDeliveryWorkflow(ctx, workflow.id);
}

/** 服务重启后恢复尚未进入人工等待节点的流水线。 */
export async function resumeRecoverableWorkflows(ctx: AppContext): Promise<void> {
  await reconcileWorkflowSchedules(ctx);
  await reconcileWorkflowSpecStates(ctx);
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

/** 修复 Spec 与工作流分文件写入之间的进程中断窗口。 */
export async function reconcileWorkflowSpecStates(ctx: AppContext): Promise<void> {
  for (const workflow of ctx.workflows.list()) {
    if (!workflow.specId) continue;
    const spec = ctx.specs.get(workflow.specId);
    if (!spec || spec.workflowId !== workflow.id) {
      throw new Error(`工作流 ${workflow.id} 的 Spec 关联损坏。`);
    }
    if (
      workflow.status === 'awaiting_spec_confirmation'
      && (spec.status === 'confirmed' || spec.status === 'published' || spec.status === 'in_review' || spec.status === 'approved')
    ) {
      await ctx.workflows.updateIfStatus(workflow.id, 'awaiting_spec_confirmation', {
        status: 'awaiting_doc_review',
        error: undefined,
      });
      continue;
    }
    if (workflow.status === 'awaiting_spec_confirmation' && spec.status === 'changes_requested' && spec.confirmationFeedback) {
      await prepareWorkflowForSpecRevision(
        ctx,
        spec,
        spec.confirmationFeedback,
        [],
        'awaiting_spec_confirmation',
      );
      continue;
    }
    if (workflow.status === 'awaiting_doc_review' && spec.status === 'changes_requested') {
      const comments = spec.comments.filter((comment) => !comment.resolved);
      if (comments.length > 0) {
        await prepareWorkflowForSpecRevision(
          ctx,
          spec,
          comments.map((comment) => `- ${comment.content.slice(0, 2_000)}`).join('\n'),
          comments.map((comment) => comment.id),
          'awaiting_doc_review',
        );
      }
      continue;
    }
    if (workflow.status === 'awaiting_doc_review' && spec.status === 'approved') {
      await ctx.workflows.updateIfStatus(workflow.id, 'awaiting_doc_review', {
        status: 'ready',
        priorOutputs: { ...workflow.priorOutputs, pm: spec.content },
        error: undefined,
      });
    }
  }
}

async function failWorkflow(
  ctx: AppContext,
  workflowId: string,
  error: string,
  expectedStep?: WorkflowStepExpectation,
): Promise<void> {
  const normalizedError = error.trim().slice(-10_000) || '工作流执行失败';
  const failed = expectedStep
    ? await ctx.workflows.updateIfCurrentStep(
      workflowId,
      expectedStep.stepIndex,
      expectedStep.stepId,
      { status: 'failed', error: normalizedError },
    )
    : await ctx.workflows.updateIfStatus(
      workflowId,
      ['ready', 'executing', 'awaiting_questions', 'awaiting_spec_confirmation', 'awaiting_doc_review'],
      { status: 'failed', error: normalizedError },
    );
  if (!failed) return;
  const initiator = ctx.botsById.get(failed.initiatorBotId);
  if (initiator) {
    const msg = messageForWorkflow(failed);
    await initiator.reply(msg.messageId, `${failed.name}已停止：${normalizedError}`, hasThread(msg)).catch(() => undefined);
  }
  await settleWorkflowApproval(ctx, failed, 'failed', normalizedError);
  await settleWorkflowSchedule(ctx, failed, 'failed', normalizedError);
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
