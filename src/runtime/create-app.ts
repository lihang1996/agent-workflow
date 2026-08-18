/**
 * App 工厂：组装运行时上下文 + 绑定消息/卡片处理器 + 事件状态机。
 *
 * 这个文件是 index.ts 和运行时模块之间的桥梁。
 * index.ts 调用 createApp() 得到一个 App 对象，
 * 然后把 App.handleMessage / App.handleCardAction 绑定到飞书 Bot 的事件回调。
 *
 * App 对象做了一层事件状态机保护：
 * - 'recovering' → 拒绝新事件，提示"正在恢复"
 * - 'ready'      → 正常处理
 * - 'stopping'   → 拒绝新事件，提示"正在停止"
 */

// ─── 类型导入 ───
import type { Bot, CardAction } from '../im/lark.js';
import {
  createAppContext,
  type AppContext,
  type CreateAppDeps,
} from './app-context.js';

// ─── 运行时模块导入 ───

// 孤儿卡收尾 + 停机收尾
import { reconcileOrphanedCards, shutdownActiveRuns } from './active-runs.js';

// 消息路由 + 卡片按钮回调（核心入口）
import { handleCardAction, handleMessage } from './message-handler.js';

// 定时任务调度器
import { startScheduler, stopScheduler } from './scheduler.js';

// 流水线恢复（重启后继续跑 executing 状态的 workflow）
import { resumeRecoverableWorkflows } from './pipeline-runner.js';

// 审批执行恢复
import { reconcileApprovalExecutions } from './approval-status.js';

// 飞书云文档评论同步
import {
  handleDocumentComment,
  startSpecReviewSync,
  stopSpecReviewSync,
} from './spec-review.js';

/**
 * App 对象：对外暴露的统一接口。
 * index.ts 只和这个对象交互，不直接调用 runtime 内部模块。
 */
export interface App {
  /** 运行时上下文（依赖容器） */
  ctx: AppContext;

  /** 已连接的飞书 Bot 映射：Map<botId, Bot> */
  botsById: Map<string, Bot>;

  /** 飞书消息回调：收到用户消息时调用 */
  handleMessage: (msg: import('../im/lark.js').IncomingMessage, bot: Bot) => Promise<void>;

  /** 飞书卡片按钮回调：用户点击卡片按钮时调用 */
  handleCardAction: (action: CardAction) => ReturnType<typeof handleCardAction>;

  /** 收尾上次遗留的任务卡片 */
  reconcileOrphanedCards: () => Promise<void>;

  /** 停机时收尾所有进行中任务 */
  shutdownActiveRuns: (reason: string) => Promise<void>;

  /** 启动定时任务轮询 */
  startScheduler: () => void;

  /** 停止定时任务轮询 */
  stopScheduler: () => void;

  /** 启动云文档评论定时同步 */
  startSpecReviewSync: () => void;

  /** 停止云文档评论定时同步 */
  stopSpecReviewSync: () => void;

  /** 飞书云文档新增评论回调 */
  handleDocumentComment: (
    event: import('../im/lark.js').DocumentCommentEvent,
    bot: Bot,
  ) => Promise<void>;

  /** 恢复可重试的交付流水线 */
  resumeRecoverableWorkflows: () => Promise<void>;

  /** 恢复中断的审批执行 */
  reconcileApprovalExecutions: () => Promise<void>;

  /** 标记就绪：recovering → ready */
  markReady: () => void;

  /** 暂停事件处理：→ stopping（停机时调用） */
  pauseEventHandling: () => void;

  /** 断开所有飞书 Bot WS 长连接 */
  disconnectBots: () => void;

  /** 是否已就绪 */
  isReady: () => boolean;
}

/**
 * 组装运行时上下文并绑定消息/卡片处理器。
 *
 * @param deps - 从 index.ts 传入的所有 Store 和配置
 * @returns App 对象
 *
 * 内部做了两层事情：
 * 1. 调用 createAppContext() 组装 ctx
 * 2. 创建事件状态机，在 ready 之前拒绝新事件
 */
export function createApp(deps: CreateAppDeps): App {
  // 组装运行时上下文（依赖容器）
  const ctx = createAppContext(deps);

  /**
   * 事件状态机：
   * - 'recovering' → 启动恢复阶段，拒绝新消息/卡片操作
   * - 'ready'      → 正常接收处理
   * - 'stopping'   → 停机阶段，拒绝新事件
   *
   * 这个状态机保证：
   * 1. 恢复期间（孤儿卡收尾、工作流恢复）不会并发处理新用户消息
   * 2. 停机期间（SIGINT 后）不会启动新任务
   */
  let eventState: 'recovering' | 'ready' | 'stopping' = 'recovering';

  /** 防止 disconnectBots 被调用多次 */
  let botsDisconnected = false;

  return {
    // 依赖容器
    ctx,

    // Bot 注册表引用（和 ctx.botsById 是同一个 Map）
    botsById: ctx.botsById,

    /**
     * 飞书消息回调。
     *
     * 如果不在 ready 状态：
     * - stopping → 回复"正在停止"
     * - recovering → 回复"正在恢复"
     * 在 ready 状态 → 调用 runtime/message-handler.ts 的 handleMessage
     *
     * @param msg  - 飞书消息（包含 messageId, chatId, text, mentions 等）
     * @param bot  - 收到消息的飞书 Bot 实例
     */
    handleMessage: async (msg, bot) => {
      if (eventState !== 'ready') {
        // 非就绪状态：回复提示，不处理
        const text = eventState === 'stopping'
          ? 'Agent OS 正在停止，暂不接收新任务。'
          : 'Agent OS 正在恢复会话和工作流，请稍后重新发送。';
        // replyInThread：如果在话题中就回复在话题里
        await bot.reply(msg.messageId, text, !!msg.threadId || !!msg.rootId);
        return;
      }
      // 就绪：交给 message-handler 处理（命令路由 + 自然语言分发）
      await handleMessage(ctx, msg, bot);
    },

    /**
     * 飞书卡片按钮回调。
     *
     * 如果不在 ready 状态 → 返回 warning toast，不处理。
     * 在 ready 状态 → 调用 runtime/message-handler.ts 的 handleCardAction
     * （处理：停止任务、审批、Spec 确认、问卷提交、阻塞重试等）
     */
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

    // 收尾上次遗留的任务卡片（孤儿卡）
    reconcileOrphanedCards: () => reconcileOrphanedCards(ctx),

    // 停机时收尾所有进行中任务
    shutdownActiveRuns: (reason) => shutdownActiveRuns(ctx, reason),

    // 定时任务
    startScheduler: () => startScheduler(ctx),
    stopScheduler: () => stopScheduler(ctx),

    // 云文档评论同步
    startSpecReviewSync: () => startSpecReviewSync(ctx),
    stopSpecReviewSync: () => stopSpecReviewSync(ctx),

    /**
     * 飞书云文档新增评论回调。
     * 只在 ready 状态处理，避免恢复期间并发。
     */
    handleDocumentComment: async (event, bot) => {
      if (eventState !== 'ready') return;
      await handleDocumentComment(ctx, event, bot);
    },

    // 恢复可重试的交付流水线
    resumeRecoverableWorkflows: () => resumeRecoverableWorkflows(ctx),

    // 恢复中断的审批执行
    reconcileApprovalExecutions: () => reconcileApprovalExecutions(ctx),

    /**
     * 标记就绪：recovering → ready。
     * index.ts 在完成所有恢复操作后调用。
     */
    markReady: () => {
      if (eventState === 'recovering') eventState = 'ready';
    },

    /**
     * 暂停事件处理：→ stopping。
     * shutdownAndExit() 在断开 Bot 前调用。
     */
    pauseEventHandling: () => { eventState = 'stopping'; },

    /**
     * 断开所有飞书 Bot WS 长连接。
     * 幂等：多次调用只执行一次。
     * 停机时先 disconnect 再收尾任务，避免收尾期间又收到新事件。
     */
    disconnectBots: () => {
      if (botsDisconnected) return;
      botsDisconnected = true;
      let closed = 0;
      for (const bot of ctx.botsById.values()) {
        try {
          bot.disconnect(); // 关闭 WSClient（飞书 SDK 的 close({ force: true })）
          closed += 1;
        } catch (error) {
          console.error(`[飞书] 断开 bot=${bot.id} 失败:`, error instanceof Error ? error.message : String(error));
        }
      }
      if (closed > 0) console.log(`[飞书] 已断开 ${closed} 个 Bot 长连接`);
    },

    /** 是否已就绪 */
    isReady: () => eventState === 'ready',
  };
}

// 重新导出类型，方便外部导入
export type { AppContext, AppConfig, CreateAppDeps } from './app-context.js';
