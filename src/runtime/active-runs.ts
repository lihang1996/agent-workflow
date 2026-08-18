/**
 * 活跃任务管理：快照持久化 + 孤儿卡收尾 + 停机收尾。
 *
 * 被 index.ts（启动恢复）和 cli-task.ts（运行时）调用：
 * - snapshotActiveRuns()：导出未成功结束的任务快照
 * - flushPersistActiveRuns()：防抖落盘到 data/active-runs.json
 * - schedulePersistActiveRuns()：安排延迟落盘（800ms 防抖）
 * - reconcileOrphanedCards()：启动时收尾遗留的「运行中」卡（tsx watch 热重启）
 * - shutdownActiveRuns()：停机时中断所有 CLI + 刷中断卡
 * - finishInterruptedRun()：写中断终态卡
 * - freezeRunCard() / interruptedCard()：卡片冻结/中断态
 */

import { buildTaskCard } from '../im/card.js';
import type { PersistedActiveRun } from '../core/active-run-store.js';
import { sanitizeErrorForLog } from '../core/log-inspection.js';
import type { AppContext } from './app-context.js';
import type { ActiveRun } from './types.js';
import { markSessionIdle } from './sessions.js';

/** 导出未成功结束的进行中任务快照。 */
export function snapshotActiveRuns(ctx: AppContext): PersistedActiveRun[] {
  const now = new Date().toISOString();
  return [...ctx.activeRuns.entries()]
    .filter(([, run]) => !run.terminalStatus)
    .map(([sessionId, run]) => {
      const snap = run.tracker.snapshot();
      return {
        sessionId,
        botId: run.bot.id,
        cardId: run.cardId,
        cardTitle: run.cardTitle,
        ...(run.workflowId ? { workflowId: run.workflowId } : {}),
        progress: Math.min(90, Math.round(snap.elapsedMs / 1_000)),
        detail: snap.current,
        activities: snap.activities.slice(0, 5).map((a) => a.label),
        updatedAt: now,
      };
    });
}

/** 立即写入 active-runs.json。 */
export async function persistActiveRuns(ctx: AppContext): Promise<void> {
  const runs = snapshotActiveRuns(ctx);
  if (runs.length === 0) await ctx.activeRunStore.clear();
  else await ctx.activeRunStore.save(runs);
}

/** 防抖落盘，避免每个工具事件都写磁盘。 */
export function schedulePersistActiveRuns(ctx: AppContext): void {
  if (ctx.persistTimer) return;
  ctx.persistTimer = setTimeout(() => {
    ctx.persistTimer = undefined;
    void persistActiveRuns(ctx).catch(logPersistError);
  }, ctx.activeRunPersistDebounceMs);
  ctx.persistTimer.unref?.();
}

/** 取消防抖并立刻落盘（发卡/收尾时用）。 */
export async function flushPersistActiveRuns(ctx: AppContext): Promise<void> {
  if (ctx.persistTimer) {
    clearTimeout(ctx.persistTimer);
    ctx.persistTimer = undefined;
  }
  await persistActiveRuns(ctx);
}

/** 构造「已中断」失败/取消卡片。 */
export function interruptedCard(run: ActiveRun, detail: string, recoverable = false) {
  return buildTaskCard({
    title: run.cardTitle,
    status: recoverable ? 'blocked' : 'cancelled',
    detail,
    progress: run.tracker.snapshot(),
  });
}

/** 把进行中任务卡片刷成取消；已成功的跳过。 */
export async function finishInterruptedRun(
  run: ActiveRun,
  detail: string,
  recoverable = false,
): Promise<void> {
  if (run.terminalStatus) return;
  run.terminalStatus = 'interrupted';
  try {
    await run.cardUpdater.finish(interruptedCard(run, detail, recoverable));
  } catch {
    try {
      await run.bot.updateCard(run.cardId, interruptedCard(run, detail, recoverable));
    } catch {
      await run.cardUpdater.cancel();
    }
  }
}

/** 启动时收尾上次遗留的任务卡片。 */
export async function reconcileOrphanedCards(ctx: AppContext): Promise<void> {
  const orphans = await ctx.activeRunStore.load();
  if (orphans.length === 0) return;

  console.log(`[任务] 发现 ${orphans.length} 张上次未收尾的任务卡片，正在标记为中断…`);
  const remaining: PersistedActiveRun[] = [];
  for (const orphan of orphans) {
    const bot = ctx.botsById.get(orphan.botId);
    if (!bot) {
      console.warn(`[任务] 无法收尾卡片 bot=${orphan.botId} card=${orphan.cardId}（Bot 未连接）`);
      remaining.push(orphan);
      continue;
    }
    try {
      const recoverable = !!orphan.workflowId;
      await bot.updateCard(orphan.cardId, buildTaskCard({
        title: orphan.cardTitle,
        status: recoverable ? 'blocked' : 'cancelled',
        detail: recoverable
          ? '上次服务异常退出；持久化流水线会自动恢复，并从当前步骤重新执行。'
          : '上次服务异常退出，任务已中断',
      }));
      console.log(`[任务] 已收尾遗留卡片 bot=${orphan.botId} card=${orphan.cardId}`);
    } catch (error) {
      remaining.push(orphan);
      console.error(
        `[任务] 收尾遗留卡片失败 bot=${orphan.botId} card=${orphan.cardId}:`,
        sanitizeErrorForLog(error),
      );
    }
  }
  if (remaining.length === 0) await ctx.activeRunStore.clear();
  else {
    await ctx.activeRunStore.save(remaining);
    console.warn(`[任务] 仍有 ${remaining.length} 张遗留卡片待下次启动重试收尾`);
  }
}

/** SIGTERM/异常退出时中断未完成任务并刷卡。 */
export async function shutdownActiveRuns(ctx: AppContext, reason: string): Promise<void> {
  if (ctx.shuttingDown) return;
  ctx.shuttingDown = true;
  const entries = [...ctx.activeRuns.entries()];
  if (entries.length === 0) {
    await flushPersistActiveRuns(ctx).catch(logPersistError);
    return;
  }

  const toInterrupt = entries.filter(([, run]) => !run.terminalStatus);
  console.log(
    `[任务] 停机收尾：共 ${entries.length} 个任务，中断 ${toInterrupt.length} 个（已有终态 ${entries.length - toInterrupt.length} 个跳过）`,
  );
  for (const [, run] of toInterrupt) {
    run.interruptReason = run.workflowId
      ? `${reason}；持久化流水线会在服务恢复后从当前步骤重新执行。`
      : reason;
    run.controller.abort();
  }

  await Promise.race([
    Promise.all(entries.map(([, run]) => run.done)),
    new Promise<void>((resolve) => setTimeout(resolve, ctx.shutdownGraceMs)),
  ]);

  for (const [sessionId, run] of entries) {
    if (run.heartbeat) clearInterval(run.heartbeat);
    if (!run.terminalStatus) {
      await finishInterruptedRun(
        run,
        run.interruptReason ?? reason,
        !!run.workflowId,
      );
    }
    ctx.activeRuns.delete(sessionId);
    try {
      await markSessionIdle(ctx, sessionId);
    } catch (error) {
      console.error('[会话] 停机收尾失败:', sanitizeErrorForLog(error));
    }
    run.resolveDone();
  }
  await flushPersistActiveRuns(ctx).catch(logPersistError);
}

/** 立刻停掉进度刷新，避免与卡片回调响应抢 patch。 */
export function freezeRunCard(run: ActiveRun): void {
  if (run.heartbeat) {
    clearInterval(run.heartbeat);
    run.heartbeat = undefined;
  }
  void run.cardUpdater.cancel();
}

function logPersistError(error: unknown): void {
  console.error('[任务] 持久化进行中卡片失败:', sanitizeErrorForLog(error));
}
