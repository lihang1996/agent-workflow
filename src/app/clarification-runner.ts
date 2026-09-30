import { releaseTask, executeTask, executionStore } from './task-lifecycle.js';
import { createTaskCardUpdater, deliveryOutbox } from './result-delivery.js';
import { flowMatchesSession } from './session-guard.js';
import type { Bot } from '../im/lark.js';
import { answerContinuation, answerNeedsContinuation, buildArchitectureApprovalCard, buildClarificationCard, buildProductSpecApprovalCard, buildTaskCard, splitLongText } from '../im/card.js';
import { buildBotPrompt, type BotConfig } from '../core/bot-registry.js';
import { findClarificationRequest, formatClarificationAnswers, type ClarificationFlow } from '../core/clarification.js';
import { TaskProgressTracker } from '../core/task-progress.js';
import { getCliAdapter } from '../cli/registry.js';
import { executeCli } from './cli-execution.js';
import { createProductionIsolationPreparer } from '../core/isolation.js';
import { createSessionIsolationSupplier, requireScratchRootForSubmission } from './cli-execution.js';
import {
  applyModelDecision,
  assertRecreateWithoutHistoryDependency,
  planExecutionModel,
} from './execution-model.js';
import { sendResultNotification } from './notification-service.js';

import type { AppRuntime } from './runtime.js';
import { findArchitectureRequest, findProductSpecRequest } from '../core/product-spec.js';
import { normalizeProductDocument } from './product-document-url.js';
import { ensureProductSpecSubmission } from './product-spec-submission.js';
import { createBoundProductSpecFlow } from './product-spec-creation.js';
import { createBoundArchitectureFlow } from './architecture-flow.js';

export async function continueClarificationFlow(options: {
  runtime: AppRuntime;
  bot: Bot;
  config: BotConfig;
  flow: ClarificationFlow;
  run: AbortController;
  defaultDeliveryMode: 'local' | 'lark-doc';
  execute?: typeof executeCli;
  planModel?: typeof planExecutionModel;
}): Promise<void> {
  const { flow, run, runtime } = options;
  try {
    await executeClarification(options);
  } finally {
    await releaseTask(runtime, flow.sessionId, run);
  }
}

async function executeClarification(options: Parameters<typeof continueClarificationFlow>[0]): Promise<void> {
  const { bot, config, flow, run, runtime, defaultDeliveryMode } = options;
  const session = runtime.sessions.get(flow.sessionId);
  if (!session || !flowMatchesSession(flow, session)) throw new Error('需求澄清对应的会话已经失效');

  const adapter = getCliAdapter(session.cliId, runtime.teamRegistry.appToolsFor(config.id));
  const progress = new TaskProgressTracker(
    Date.now,
    runtime.contextWindows.get(session.id),
    false,
  );
  const progressCardMessageId = await bot.replyCard(
    flow.originalMessageId,
    buildTaskCard({
      title: adapter.displayName,
      status: 'running',
      detail: '正在基于你的选择继续任务',
      progress: progress.snapshot(),
      abortSessionId: session.id,
    }),
    flow.replyInThread,
  );
  if (!progressCardMessageId) {
    throw new Error('飞书没有返回需求整理进度卡片的 message_id');
  }

  const cardUpdater = createTaskCardUpdater({ runtime, bot, botId: config.id, sessionId: session.id,
    cardId: progressCardMessageId, replyToMessageId: flow.originalMessageId, replyInThread: flow.replyInThread });
  const renderProgress = () => {
    const snapshot = progress.snapshot();
    cardUpdater.push(buildTaskCard({
      title: adapter.displayName,
      status: 'running',
      detail: snapshot.current || '正在基于你的选择继续任务',
      progress: snapshot,
      abortSessionId: session.id,
    }));
  };
  const heartbeat = setInterval(renderProgress, 1_000);
  heartbeat.unref();

  try {
    // 澄清续跑与普通任务同一套模型决策：blocked 即失败给原因，recreate 开新原生会话。
    const modelPlan = await (options.planModel ?? planExecutionModel)(
      config.modelOverrides,
      session,
      { command: adapter.command },
    );
    // 返修 3（二轮）：依赖历史上下文的 recreate 一律阻断（指令洗白风险），
    // 引导用户新话题提供明确上下文；澄清答案本身随本次 prompt 传递，不受影响。
    if (modelPlan.decision.action === 'recreate') {
      assertRecreateWithoutHistoryDependency({ hadNativeSession: !!session.cliSessionId });
    }
    const resumeCliSessionId = applyModelDecision(modelPlan);
    const result = await executeTask({ runtime, id: `clarification:${flow.token}`, sessionId: session.id, botId: config.id,
      modelSelection: modelPlan.modelSelection,
      freshNativeSession: resumeCliSessionId === undefined,
      execute: () => (options.execute ?? executeCli)(
        adapter,
        buildBotPrompt(config, formatClarificationAnswers(flow), runtime.teamRegistry.contextFor(config.id), defaultDeliveryMode),
        session.workspaceDir,
        resumeCliSessionId,
        run.signal,
        (event) => {
          if (
            event.type !== 'tool_start'
            && event.type !== 'tool_end'
            && event.type !== 'context'
          ) return;
          progress.accept(event);
          renderProgress();
        },
        undefined,
        modelPlan.modelSelection,
        createSessionIsolationSupplier(
          runtime,
          session.id,
          runtime.isolationPreparer ?? createProductionIsolationPreparer(),
        ),
        flow.taskId,
      ) });
    clearInterval(heartbeat);
    const nextRequest = adapter.appTools.includes('request_clarification')
      ? findClarificationRequest(result.toolCalls)
      : undefined;
    if (nextRequest) {
      const nextFlow = runtime.clarificationFlows.create({
        taskId: flow.taskId,
        botId: config.id,
        sessionId: session.id,
        sessionVersion: session.version ?? 0,
        ownerOpenId: flow.ownerOpenId,
        ownerUnionId: flow.ownerUnionId,
        ownerBotId: flow.ownerBotId,
        collaboration: flow.collaboration,
        originalMessageId: flow.originalMessageId,
        cardMessageId: progressCardMessageId,
        replyInThread: flow.replyInThread,
        request: nextRequest,
      });
      await cardUpdater.finish(buildClarificationCard({ flow: nextFlow }), { kind: 'clarification', token: nextFlow.token });
      await sendResultNotification({
        runtime, botId: config.id, sessionId: session.id, afterCardId: progressCardMessageId,
        bot,
        replyToMessageId: flow.originalMessageId,
        target: { openId: flow.ownerOpenId, name: '' },
        text: `还需要确认 ${nextRequest.questions.length} 个问题，请在上方卡片中选择。`,
        replyInThread: flow.replyInThread,
      });
      return;
    }

    const managesProductSpec = adapter.appTools.includes('request_spec_approval') && !!findProductSpecRequest(result.toolCalls);
    if (managesProductSpec) {
      const submission = await ensureProductSpecSubmission({ result });
      const productSpecRequest = await normalizeProductDocument(bot, submission.request!);
      // 澄清后产物创建与 message-handler 共用同一服务端路径：本地模式在创建点
      // 计算并绑定完整摘要（否则 G1 永远拒绝）；失败即失败关闭，不生成确认卡。
      const productSpecFlow = await createBoundProductSpecFlow({
        store: runtime.productSpecFlows,
        workspaceDir: session.workspaceDir,
        ...(productSpecRequest.deliveryMode === 'local'
          ? { scratchRoot: requireScratchRootForSubmission(runtime, session.id, flow.taskId) }
          : {}),
        identity: {
          taskId: flow.taskId,
          botId: config.id,
          sessionId: session.id,
          sessionVersion: session.version ?? 0,
          ownerOpenId: flow.ownerOpenId,
          ownerUnionId: flow.ownerUnionId,
          ownerBotId: flow.ownerBotId,
          collaboration: flow.collaboration,
        },
        request: productSpecRequest,
      });
      await cardUpdater.finish(buildProductSpecApprovalCard(productSpecFlow), { kind: 'product', token: productSpecFlow.token });
      runtime.clarificationFlows.delete(flow.token);
      await sendResultNotification({
        runtime, botId: config.id, sessionId: session.id, afterCardId: progressCardMessageId,
        bot,
        replyToMessageId: flow.originalMessageId,
        target: { openId: flow.ownerOpenId, name: '' },
        text: '产品方案已生成，请查看上方卡片了解确认状态。',
        replyInThread: flow.replyInThread,
      });
      return;
    }

    // 架构提交（澄清后续跑）与 message-handler 共用同一服务端路径：交接码
    // 服务端核验 + 上游漂移检查 + 摘要绑定；失败关闭，不生成确认卡。
    if (adapter.appTools.includes('request_architecture_review')) {
      const architectureSubmission = findArchitectureRequest(result.toolCalls);
      if (architectureSubmission) {
        if (!runtime.architectureHandoffs) {
          throw new Error('架构交接服务不可用：本次架构提交失败关闭，未创建任何确认卡。');
        }
        const normalizedRequest = await normalizeProductDocument(bot, architectureSubmission.request);
        const archFlow = await createBoundArchitectureFlow({
          flows: runtime.productSpecFlows,
          handoffs: runtime.architectureHandoffs,
          workspaceDir: session.workspaceDir,
          ...(normalizedRequest.deliveryMode === 'local'
            ? { scratchRoot: requireScratchRootForSubmission(runtime, session.id, flow.taskId) }
            : {}),
          resolvePrdWorkspaceDir: ({ prdSessionId }) => runtime.sessions.get(prdSessionId)?.workspaceDir,
          identity: {
            taskId: flow.taskId,
            botId: config.id,
            sessionId: session.id,
            sessionVersion: session.version ?? 0,
            ownerOpenId: flow.ownerOpenId,
            ownerUnionId: flow.ownerUnionId,
            ownerBotId: flow.ownerBotId,
            collaboration: flow.collaboration,
          },
          request: normalizedRequest,
          handoffToken: architectureSubmission.handoffToken,
        });
        await cardUpdater.finish(buildArchitectureApprovalCard(archFlow), { kind: 'product', token: archFlow.token });
        runtime.clarificationFlows.delete(flow.token);
        await sendResultNotification({
          runtime, botId: config.id, sessionId: session.id, afterCardId: progressCardMessageId,
          bot,
          replyToMessageId: flow.originalMessageId,
          target: { openId: flow.ownerOpenId, name: '' },
          text: '架构设计已生成，请查看上方卡片了解确认状态。',
          replyInThread: flow.replyInThread,
        });
        return;
      }
    }

    await cardUpdater.finish(buildTaskCard({
      title: adapter.displayName,
      status: 'success',
      detail: '已根据你的选择完成',
      progress: progress.snapshot(),
      answer: result.answer,
      stats: result.stats,
    }));
    runtime.clarificationFlows.delete(flow.token);
    if (answerNeedsContinuation(result.answer)) {
      await deliveryOutbox(runtime, config.id, bot).submit({
        id: `clarification:${flow.token}:text`, botId: config.id, sessionId: session.id,
        operations: splitLongText(answerContinuation(result.answer)).map((text) => ({
          type: 'text', messageId: flow.originalMessageId, text, replyInThread: flow.replyInThread,
        })),
      });
    }
    await sendResultNotification({
        runtime, botId: config.id, sessionId: session.id, afterCardId: progressCardMessageId,
      bot,
      replyToMessageId: flow.originalMessageId,
      target: { openId: flow.ownerOpenId, name: '' },
      text: '任务已完成，请查看上方结果。',
      replyInThread: flow.replyInThread,
    });
  } catch (error) {
    clearInterval(heartbeat);
    if (executionStore(runtime).get(`clarification:${flow.token}`)?.status === 'completed') {
      await cardUpdater.cancel();
      throw error;
    }
    const aborted = run.signal.aborted;
    await cardUpdater.finish(buildTaskCard({
      title: adapter.displayName,
      status: aborted ? 'cancelled' : 'failed',
      detail: aborted
        ? '任务已停止。你可以继续在当前话题里补充。'
        : '任务没有完成。请在当前话题里重试。',
      technicalDetail: aborted ? undefined : (error as Error).message,
      progress: progress.snapshot(),
    }));
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
