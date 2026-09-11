import type { Bot } from '../im/lark.js';
import {
  answerContinuation,
  answerNeedsContinuation,
  buildClarificationCard,
  buildProductSpecApprovalCard,
  buildTaskCard,
  splitLongText,
  ThrottledCardUpdater,
} from '../im/card.js';
import { buildBotPrompt, type BotConfig } from '../core/bot-registry.js';
import {
  findClarificationRequest,
  formatClarificationAnswers,
  type ClarificationFlow,
} from '../core/clarification.js';
import { TaskProgressTracker } from '../core/task-progress.js';
import { getCliAdapter } from '../cli/registry.js';
import { executeCli } from './cli-execution.js';
import { sendResultNotification } from './notification-service.js';
import { markSessionIdle } from './session-view.js';
import type { AppRuntime } from './runtime.js';
import { assertProductSpecDocuments } from './product-spec-documents.js';
import { findProductSpecRequest } from '../core/product-spec.js';
import { normalizeProductDocument } from './product-document-url.js';
import { ensureProductSpecSubmission } from './product-spec-submission.js';

export async function continueClarificationFlow(options: {
  runtime: AppRuntime;
  bot: Bot;
  config: BotConfig;
  flow: ClarificationFlow;
  run: AbortController;
  defaultDeliveryMode: 'local' | 'lark-doc';
  execute?: typeof executeCli;
}): Promise<void> {
  const { flow, run, runtime } = options;
  try {
    await executeClarification(options);
  } finally {
    if (runtime.activeRuns.get(flow.sessionId)?.controller === run) {
      runtime.activeRuns.delete(flow.sessionId);
      await markSessionIdle(runtime.sessions, flow.sessionId);
    }
  }
}

async function executeClarification(options: Parameters<typeof continueClarificationFlow>[0]): Promise<void> {
  const { bot, config, flow, run, runtime, defaultDeliveryMode } = options;
  const session = runtime.sessions.get(flow.sessionId);
  if (!session) throw new Error('需求澄清对应的会话已经失效');

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

  const cardUpdater = new ThrottledCardUpdater((card) =>
    bot.updateCard(progressCardMessageId, card)
  );
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
    const result = await (options.execute ?? executeCli)(
      adapter,
      buildBotPrompt(config, formatClarificationAnswers(flow), runtime.teamRegistry.contextFor(config.id), defaultDeliveryMode),
      session.workspaceDir,
      session.cliSessionId,
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
    );
    clearInterval(heartbeat);
    if (result.sessionId) {
      await runtime.sessions.setCliSessionId(session.id, result.sessionId);
    }
    if (result.stats?.contextWindowTokens) {
      runtime.contextWindows.set(session.id, result.stats.contextWindowTokens);
    }

    const nextRequest = adapter.appTools.includes('request_clarification')
      ? findClarificationRequest(result.toolCalls)
      : undefined;
    if (nextRequest) {
      const nextFlow = runtime.clarificationFlows.create({
        taskId: flow.taskId,
        botId: config.id,
        sessionId: session.id,
        ownerOpenId: flow.ownerOpenId,
        ownerUnionId: flow.ownerUnionId,
        ownerBotId: flow.ownerBotId,
        collaboration: flow.collaboration,
        originalMessageId: flow.originalMessageId,
        cardMessageId: progressCardMessageId,
        replyInThread: flow.replyInThread,
        request: nextRequest,
      });
      await cardUpdater.finish(buildClarificationCard({ flow: nextFlow }));
      await sendResultNotification({
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
      if (submission.result.sessionId) {
        await runtime.sessions.setCliSessionId(
          session.id,
          submission.result.sessionId,
        );
      }
      if (submission.result.stats?.contextWindowTokens) {
        runtime.contextWindows.set(
          session.id,
          submission.result.stats.contextWindowTokens,
        );
      }
      if (productSpecRequest.deliveryMode === 'local') {
        await assertProductSpecDocuments(session.workspaceDir, productSpecRequest);
      }
      const productSpecFlow = runtime.productSpecFlows.create({
        taskId: flow.taskId,
        botId: config.id,
        sessionId: session.id,
        ownerOpenId: flow.ownerOpenId,
        ownerUnionId: flow.ownerUnionId,
        ownerBotId: flow.ownerBotId,
        collaboration: flow.collaboration,
        request: productSpecRequest,
      });
      await cardUpdater.finish(buildProductSpecApprovalCard(productSpecFlow));
      runtime.clarificationFlows.delete(flow.token);
      await sendResultNotification({
        bot,
        replyToMessageId: flow.originalMessageId,
        target: { openId: flow.ownerOpenId, name: '' },
        text: '产品方案已生成，请查看上方确认卡。',
        replyInThread: flow.replyInThread,
      });
      return;
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
      for (const chunk of splitLongText(answerContinuation(result.answer))) {
        await bot.reply(flow.originalMessageId, chunk, flow.replyInThread);
      }
    }
    await sendResultNotification({
      bot,
      replyToMessageId: flow.originalMessageId,
      target: { openId: flow.ownerOpenId, name: '' },
      text: '任务已完成，请查看上方结果。',
      replyInThread: flow.replyInThread,
    });
  } catch (error) {
    clearInterval(heartbeat);
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
