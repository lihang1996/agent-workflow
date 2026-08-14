import type { Bot, CardAction } from '../im/lark.js';
import {
  createAppContext,
  type AppContext,
  type CreateAppDeps,
} from './app-context.js';
import { reconcileOrphanedCards, shutdownActiveRuns } from './active-runs.js';
import { handleCardAction, handleMessage } from './message-handler.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { resumeRecoverableWorkflows } from './pipeline-runner.js';
import { reconcileApprovalExecutions } from './approval-status.js';
import {
  handleDocumentComment,
  startSpecReviewSync,
  stopSpecReviewSync,
} from './spec-review.js';

export interface App {
  ctx: AppContext;
  botsById: Map<string, Bot>;
  handleMessage: (msg: import('../im/lark.js').IncomingMessage, bot: Bot) => Promise<void>;
  handleCardAction: (action: CardAction) => ReturnType<typeof handleCardAction>;
  reconcileOrphanedCards: () => Promise<void>;
  shutdownActiveRuns: (reason: string) => Promise<void>;
  startScheduler: () => void;
  stopScheduler: () => void;
  startSpecReviewSync: () => void;
  stopSpecReviewSync: () => void;
  handleDocumentComment: (
    event: import('../im/lark.js').DocumentCommentEvent,
    bot: Bot,
  ) => Promise<void>;
  resumeRecoverableWorkflows: () => Promise<void>;
  reconcileApprovalExecutions: () => Promise<void>;
  markReady: () => void;
  pauseEventHandling: () => void;
  disconnectBots: () => void;
  isReady: () => boolean;
}

/** 组装运行时上下文并绑定消息/卡片处理器。 */
export function createApp(deps: CreateAppDeps): App {
  const ctx = createAppContext(deps);
  let eventState: 'recovering' | 'ready' | 'stopping' = 'recovering';
  let botsDisconnected = false;

  return {
    ctx,
    botsById: ctx.botsById,
    handleMessage: async (msg, bot) => {
      if (eventState !== 'ready') {
        const text = eventState === 'stopping'
          ? 'Agent OS 正在停止，暂不接收新任务。'
          : 'Agent OS 正在恢复会话和工作流，请稍后重新发送。';
        await bot.reply(msg.messageId, text, !!msg.threadId || !!msg.rootId);
        return;
      }
      await handleMessage(ctx, msg, bot);
    },
    handleCardAction: (action) => {
      if (eventState !== 'ready') {
        return Promise.resolve({
          toast: {
            type: 'warning' as const,
            content: eventState === 'stopping'
              ? '系统正在停止，请勿继续操作。'
              : '系统正在恢复，请稍后再试。',
          },
        });
      }
      return handleCardAction(ctx, action);
    },
    reconcileOrphanedCards: () => reconcileOrphanedCards(ctx),
    shutdownActiveRuns: (reason) => shutdownActiveRuns(ctx, reason),
    startScheduler: () => startScheduler(ctx),
    stopScheduler: () => stopScheduler(ctx),
    startSpecReviewSync: () => startSpecReviewSync(ctx),
    stopSpecReviewSync: () => stopSpecReviewSync(ctx),
    handleDocumentComment: async (event, bot) => {
      if (eventState !== 'ready') return;
      await handleDocumentComment(ctx, event, bot);
    },
    resumeRecoverableWorkflows: () => resumeRecoverableWorkflows(ctx),
    reconcileApprovalExecutions: () => reconcileApprovalExecutions(ctx),
    markReady: () => {
      if (eventState === 'recovering') eventState = 'ready';
    },
    pauseEventHandling: () => { eventState = 'stopping'; },
    disconnectBots: () => {
      if (botsDisconnected) return;
      botsDisconnected = true;
      let closed = 0;
      for (const bot of ctx.botsById.values()) {
        try {
          bot.disconnect();
          closed += 1;
        } catch (error) {
          console.error(`[飞书] 断开 bot=${bot.id} 失败:`, error instanceof Error ? error.message : String(error));
        }
      }
      if (closed > 0) console.log(`[飞书] 已断开 ${closed} 个 Bot 长连接`);
    },
    isReady: () => eventState === 'ready',
  };
}

export type { AppContext, AppConfig, CreateAppDeps } from './app-context.js';
