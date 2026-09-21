import { beginTask } from './task-lifecycle.js';
import { canManageSession, flowMatchesSession } from './session-guard.js';
import type { CardAction, CardActionResponse } from '../im/lark.js';
import {
  buildClarificationCard,
  buildClarificationContinuingCard,
  buildClarificationRetryCard,
  buildProductSpecApprovedCard,
  buildProductSpecExpiredCard,
  buildResumeCard,
} from '../im/card.js';
import type {
  BotConfig,
  ProductDeliveryMode,
} from '../core/bot-registry.js';
import { isClarificationOwner } from '../core/clarification.js';
import { isProductSpecOwner } from '../core/product-spec.js';
import { requestTaskAbort } from '../core/task-abort.js';
import { getCliAdapter } from '../cli/registry.js';
import { listNativeCliSessions } from '../cli/native-sessions.js';
import { continueClarificationFlow } from './clarification-runner.js';
import type { AppRuntime } from './runtime.js';

export function createCardActionHandler(options: {
  runtime: AppRuntime;
  config: BotConfig;
  defaultProductDeliveryMode: ProductDeliveryMode;
  continueFlow?: typeof continueClarificationFlow;
}): (action: CardAction) => Promise<CardActionResponse | undefined> {
  const { runtime, config, defaultProductDeliveryMode } = options;
  return async (action) => {
    if (action.value.action === 'approve_product_spec') {
      const flowToken = typeof action.value.flowToken === 'string'
        ? action.value.flowToken
        : '';
      const flow = runtime.productSpecFlows.get(flowToken);
      if (!flow || flow.botId !== config.id || !action.messageId) {
        return { toast: { type: 'error', content: '这份产品方案已经失效。' } };
      }
      if (flow.status === 'expired' || (flow.status === 'pending' && !flowMatchesSession(flow, runtime.sessions.get(flow.sessionId)))) {
        return {
          toast: { type: 'warning', content: '这份产品方案已经失效。' },
          card: {
            type: 'raw',
            data: buildProductSpecExpiredCard(flow),
          },
        };
      }
      if (!isProductSpecOwner(flow, { ...action, operatorBotId: config.id })) {
        return { toast: { type: 'warning', content: '只有任务发起人可以确认。' } };
      }
      if (flow.status === 'approved') {
        return { toast: { type: 'info', content: '产品方案已经确认。' }, card: { type: 'raw', data: buildProductSpecApprovedCard(flow) } };
      }
      if (runtime.sessions.get(flow.sessionId)?.status === 'active') {
        return { toast: { type: 'warning', content: '产品会话仍在修改方案，请完成后再确认。' } };
      }
      if (!runtime.productSpecFlows.beginApproval(flowToken)) {
        return { toast: { type: 'warning', content: '评论修改仍在处理中，请稍后确认。' } };
      }
      try {
        // 确认即终点：只记录状态，后续实现由用户自行 @ 开发。
        const approved = runtime.productSpecFlows.approve(flowToken, action.messageId);
        if (!approved) {
          return { toast: { type: 'warning', content: '方案状态已经更新。' } };
        }
        return {
          toast: { type: 'success', content: '产品方案已确认。' },
          card: {
            type: 'raw',
            data: buildProductSpecApprovedCard(approved),
          },
        };
      } finally {
        runtime.productSpecFlows.endApproval(flowToken);
      }
    }

    if (action.value.action === 'answer_clarification') {
      const flowToken = typeof action.value.flowToken === 'string'
        ? action.value.flowToken
        : '';
      const questionId = typeof action.value.questionId === 'string'
        ? action.value.questionId
        : '';
      const flow = runtime.clarificationFlows.get(flowToken);
      if (!flow || flow.botId !== config.id || !action.messageId) {
        return { toast: { type: 'error', content: '这组澄清问题已经失效。' } };
      }
      if (!isClarificationOwner(flow, { ...action, operatorBotId: config.id })) {
        return { toast: { type: 'warning', content: '只有任务发起人可以回答。' } };
      }

      const currentSession = runtime.sessions.get(flow.sessionId);
      if (!currentSession || !flowMatchesSession(flow, currentSession)) {
        return { toast: { type: 'error', content: '对应的 CLI 会话已经失效。' } };
      }
      if (currentSession.status === 'active') {
        return { toast: { type: 'warning', content: '当前会话仍在执行，请稍后重试。' } };
      }
      const complete = flow.currentIndex >= flow.request.questions.length;
      const question = flow.request.questions[complete ? flow.request.questions.length - 1 : flow.currentIndex];
      if (!question || question.id !== questionId) {
        return { toast: { type: 'warning', content: '问题已经更新，请按当前卡片作答。' } };
      }

      const decisionMode = action.value.decisionMode === 'current'
        || action.value.decisionMode === 'remaining'
        ? action.value.decisionMode
        : undefined;
      let answered;
      if (complete) {
        answered = { flow, complete: true };
      } else if (decisionMode) {
        answered = runtime.clarificationFlows.answerWithRecommendation(
          flowToken,
          decisionMode === 'remaining',
        );
      } else {
        const custom = action.value.custom === true;
        const optionId = typeof action.value.optionId === 'string'
          ? action.value.optionId
          : '';
        const selectedOption = question.options.find(
          (option) => option.id === optionId,
        );
        const customAnswer = typeof action.formValue.custom_answer === 'string'
          ? action.formValue.custom_answer.trim()
          : '';
        const answer = custom ? customAnswer : selectedOption?.label ?? '';
        if (!answer) {
          return {
            toast: {
              type: 'warning',
              content: custom ? '请先输入你的答案。' : '这个选项已经失效。',
            },
          };
        }
        answered = runtime.clarificationFlows.answer(
          flowToken,
          questionId,
          answer,
        );
      }
      if (!answered) {
        return { toast: { type: 'warning', content: '答案没有保存，请重试。' } };
      }
      if (!answered.complete) {
        return {
          toast: { type: 'success', content: '已记录，继续下一题。' },
          card: {
            type: 'raw',
            data: buildClarificationCard({ flow: answered.flow }),
          },
        };
      }

      const session = runtime.sessions.get(answered.flow.sessionId);
      const botRuntime = runtime.botRuntimes.get(config.id);
      if (!session || !botRuntime || session.status === 'closed') {
        return { toast: { type: 'error', content: '对应的 CLI 会话已经失效。' } };
      }
      if (session.status === 'active') {
        return { toast: { type: 'warning', content: '当前会话仍在执行，请稍后重试。' } };
      }

      try {
        const run = await beginTask(runtime, session.id, answered.flow, answered.flow.sessionVersion ?? 0);
        // Keep the answered flow durable until its continuation succeeds.
        queueMicrotask(() => {
          void (options.continueFlow ?? continueClarificationFlow)({
            runtime,
            bot: botRuntime.bot,
            config,
            flow: answered.flow,
            run,
            defaultDeliveryMode: defaultProductDeliveryMode,
          }).catch(async (error) => {
            console.error('[澄清] 继续执行失败:', (error as Error).message);
            if (runtime.clarificationFlows.get(flowToken)) {
              await botRuntime.bot.updateCard(action.messageId, buildClarificationRetryCard(answered.flow)).catch(console.error);
            }
            await botRuntime.bot.reply(answered.flow.originalMessageId, '继续整理失败，答案已保留。请点击重新整理，或在话题中发送补充信息重试。', answered.flow.replyInThread).catch(console.error);
          }).catch(console.error);
        });
        return {
          toast: { type: 'success', content: '答案已收到。' },
          card: {
            type: 'raw',
            data: buildClarificationContinuingCard(answered.flow),
          },
        };
      } catch (error) {
        return { toast: { type: 'error', content: (error as Error).message } };
      }
    }

    if (action.value.action === 'resume_cli_session') {
      const agentSessionId = typeof action.value.agentSessionId === 'string'
        ? action.value.agentSessionId
        : '';
      const cliSessionId = typeof action.value.cliSessionId === 'string'
        ? action.value.cliSessionId
        : '';
      const session = runtime.sessions.get(agentSessionId);
      if (!session || session.botId !== config.id || !cliSessionId) {
        return { toast: { type: 'error', content: '这条会话记录已经失效。' } };
      }
      if (!canManageSession(runtime, session.id, { ...action, operatorBotId: config.id })) {
        return { toast: { type: 'warning', content: '只有任务发起人可以切换会话。' } };
      }
      if (session.status === 'active') {
        return { toast: { type: 'warning', content: '当前任务结束后才能切换会话。' } };
      }
      if (session.status === 'closed') {
        return { toast: { type: 'warning', content: '当前话题的会话已经关闭。' } };
      }
      const cliAdapter = getCliAdapter(session.cliId);
      if (cliAdapter.id === 'cursor' || cliAdapter.id === 'zcode') {
        return { toast: { type: 'error', content: `${cliAdapter.displayName} 暂不支持此操作` } };
      }
      try {
        const nativeSessions = await listNativeCliSessions({
          adapter: cliAdapter,
          cwd: session.workspaceDir,
        });
        if (!nativeSessions.some((item) => item.id === cliSessionId)) {
          return {
            toast: { type: 'error', content: '这个 CLI 会话已经不在当前工作目录中。' },
          };
        }
        const current = runtime.sessions.get(session.id);
        if (!current || (current.version ?? 0) !== (session.version ?? 0)
          || !canManageSession(runtime, session.id, { ...action, operatorBotId: config.id })) {
          throw new Error('会话已变化，请重新选择');
        }
        const updated = await runtime.sessions.selectCliSessionId(
          session.id,
          cliSessionId,
        );
        return {
          toast: { type: 'success', content: '已切换到选中的历史会话。' },
          card: {
            type: 'raw',
            data: buildResumeCard({
              agentSessionId: updated.id,
              cliName: cliAdapter.displayName,
              currentCliSessionId: updated.cliSessionId,
              sessions: nativeSessions,
            }),
          },
        };
      } catch (error) {
        return { toast: { type: 'error', content: (error as Error).message } };
      }
    }

    if (action.value.action !== 'abort_task') return undefined;
    const sessionId = typeof action.value.sessionId === 'string'
      ? action.value.sessionId
      : '';
    const outcome = requestTaskAbort(
      runtime.activeRuns,
      sessionId,
      action.operatorOpenId,
      action.operatorUnionId,
      config.id,
    );
    if (outcome === 'not_found') {
      return { toast: { type: 'info', content: '任务已经结束，无需再次停止。' } };
    }
    if (outcome === 'forbidden') {
      return { toast: { type: 'warning', content: '无法识别操作者，无法停止任务。' } };
    }
    if (outcome === 'already_stopping') {
      return { toast: { type: 'info', content: '正在停止任务，请稍候。' } };
    }
    return { toast: { type: 'success', content: '已发送停止指令。' } };
  };
}
