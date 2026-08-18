/**
 * 运行时类型定义。
 *
 * 这个文件定义了运行时最核心的数据结构 ActiveRun，
 * 它代表"一个正在执行的 CLI 任务"的全部运行时状态。
 * 每个 ActiveRun 对应一张飞书任务卡片。
 */

// ─── 类型导入（仅类型，不产生运行时代码） ───

// 卡片更新器：带节流的飞书卡片 patch 工具
import type { ThrottledCardUpdater } from '../im/card.js';

// 飞书 Bot 实例：包含 reply/updateCard 等方法
import type { Bot } from '../im/lark.js';

// 任务进度追踪器：记录工具调用历史、活动列表、耗时
import type { TaskProgressTracker } from '../core/task-progress.js';

/**
 * 任务终态：
 * - 'success'   → CLI 正常完成 + 语义校验通过，卡片显示绿色
 * - 'failed'    → CLI 出错或门禁校验失败，卡片显示红色
 * - 'interrupted' → 用户点"停止任务"或服务停机，卡片显示灰色/橙色
 *
 * 一旦设置了 terminalStatus，后续的进度 patch 会被丢弃（避免覆盖终态卡）。
 */
export type TerminalStatus = 'success' | 'failed' | 'interrupted';

/**
 * ActiveRun：一个正在运行的 CLI 任务的完整运行时状态。
 *
 * 生命周期：
 * 1. startCliTask() 创建 ActiveRun，存入 ctx.activeRuns（Map<sessionId, ActiveRun>）
 * 2. CLI 执行期间，流式事件不断更新 cardUpdater 和 tracker
 * 3. 完成后设置 terminalStatus，写终态卡，从 activeRuns 删除
 * 4. 如果服务停机，shutdownActiveRuns() 遍历所有 ActiveRun 做收尾
 *
 * 并发安全：
 * - controller.abort() 可以中断 CLI 子进程
 * - done Promise 让外部等待任务真正结束（停机收尾用 Promise.all 等所有任务）
 */
export interface ActiveRun {
  /** AbortController：调用 .abort() 会触发 CLI 子进程被 kill */
  controller: AbortController;

  /** 任务发起人的飞书 open_id（用于权限判断：只有发起人能停止任务） */
  ownerOpenId: string;

  /**
   * 如果这个任务属于一条持久化交付流水线，这里存工作流 ID。
   * 服务重启后可以通过 workflowId 找回流水线，从当前步骤恢复。
   * 普通聊天任务没有 workflowId。
   */
  workflowId?: string;

  /**
   * 取消模式：
   * - 'stop' → 用户点了"停止任务"，会暂停流水线（不自动续跑）
   * - 'close' → 用户发了 /close，关闭会话
   * 区分这两种模式是为了给卡片显示不同的提示文案。
   */
  cancelMode?: 'stop' | 'close';

  /** 执行此任务的飞书 Bot 实例 */
  bot: Bot;

  /** 任务卡片在飞书的 message_id（用于 updateCard 更新进度） */
  cardId: string;

  /** 卡片标题，如"开发工程师 · Claude Code" */
  cardTitle: string;

  /**
   * 节流卡片更新器。
   * push() 会合并多次更新（避免每个工具事件都调飞书 API）。
   * finish() 会取消节流并立刻写入终态卡。
   * 终态设置后，非 final 的 push 会被丢弃。
   */
  cardUpdater: ThrottledCardUpdater;

  /** 进度追踪器：记录工具调用、活动列表、已用时间、上下文 token 数 */
  tracker: TaskProgressTracker;

  /** 最后一次收到 CLI 事件的时间戳（用于空闲超时检测） */
  lastEventAt: number;

  /**
   * 心跳定时器：每 15 秒推送一次进度卡片（即使没有新工具事件）。
   * unref() 让它不阻止进程退出。
   * 终态/停机时 clearInterval 清掉。
   */
  heartbeat?: ReturnType<typeof setInterval>;

  /**
   * 终态标记。设置后：
   * 1. 节流器不再接受非 final 的 push
   * 2. finally 块会把 ActiveRun 从 activeRuns 删除
   */
  terminalStatus?: TerminalStatus;

  /**
   * 卡片已在卡片按钮回调响应里收尾。
   *
   * 场景：用户点"停止任务"→ handleCardAction 在回调里直接写了中断卡。
   * 如果不设这个标记，CLI catch 块的异步 patch 会再覆盖一张卡片。
   * 设为 true 后，catch 块跳过卡片写入。
   */
  cardSettledByCallback?: boolean;

  /** 中断原因文案（显示在卡片上） */
  interruptReason?: string;

  /**
   * 任务完成的 Promise。
   * 在 startCliTask 的 finally 块里 resolveDone() 标记完成。
   * 停机收尾时 Promise.all 等所有 ActiveRun.done 结束。
   */
  done: Promise<void>;

  /** resolve 函数，在任务结束时调用 */
  resolveDone: () => void;
}
