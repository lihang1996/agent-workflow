import type { Bot } from '../im/lark.js';
import {
  createAppContext,
  type AppContext,
  type CreateAppDeps,
} from './app-context.js';
import { reconcileOrphanedCards, shutdownActiveRuns } from './active-runs.js';
import { handleCardAction, handleMessage } from './message-handler.js';

export interface App {
  ctx: AppContext;
  botsById: Map<string, Bot>;
  handleMessage: (msg: import('../im/lark.js').IncomingMessage, bot: Bot) => Promise<void>;
  handleCardAction: (action: {
    operatorOpenId: string;
    messageId: string;
    value: Record<string, unknown>;
    formValue: Record<string, unknown>;
  }) => ReturnType<typeof handleCardAction>;
  reconcileOrphanedCards: () => Promise<void>;
  shutdownActiveRuns: (reason: string) => Promise<void>;
}

/** 组装运行时上下文并绑定消息/卡片处理器。 */
export function createApp(deps: CreateAppDeps): App {
  const ctx = createAppContext(deps);

  return {
    ctx,
    botsById: ctx.botsById,
    handleMessage: (msg, bot) => handleMessage(ctx, msg, bot),
    handleCardAction: (action) => handleCardAction(ctx, action),
    reconcileOrphanedCards: () => reconcileOrphanedCards(ctx),
    shutdownActiveRuns: (reason) => shutdownActiveRuns(ctx, reason),
  };
}

export type { AppContext, AppConfig, CreateAppDeps } from './app-context.js';
