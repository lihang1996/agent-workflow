import type { ThrottledCardUpdater } from '../im/card.js';
import type { Bot } from '../im/lark.js';
import type { TaskProgressTracker } from '../core/task-progress.js';

export type TerminalStatus = 'success' | 'failed' | 'interrupted';

export interface ActiveRun {
  controller: AbortController;
  ownerOpenId: string;
  /** 持久化流水线任务可在服务重启后从当前步骤恢复。 */
  workflowId?: string;
  cancelMode?: 'stop' | 'close';
  bot: Bot;
  cardId: string;
  cardTitle: string;
  cardUpdater: ThrottledCardUpdater;
  tracker: TaskProgressTracker;
  lastEventAt: number;
  heartbeat?: ReturnType<typeof setInterval>;
  terminalStatus?: TerminalStatus;
  /** 卡片已在回调响应里收尾，避免异步 patch 再盖一次。 */
  cardSettledByCallback?: boolean;
  interruptReason?: string;
  done: Promise<void>;
  resolveDone: () => void;
}
