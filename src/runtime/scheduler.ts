/**
 * 定时任务调度器。
 *
 * /schedule 创建的定时任务存储在 data/schedules.json。
 * startScheduler() 启动 1 分钟间隔的轮询定时器，
 * 检查是否有到期任务需要执行。
 *
 * 支持的定时任务类型：
 * - 普通任务：到时间 @Bot 发消息
 * - 团队流水线：到时间启动 /pipeline
 * - 只读日志巡检：读日志尾部 → 分析异常
 *
 * 高风险动作仍走审批门：定时任务先发审批卡，
 * 人工确认后才真正执行。
 */

import type { ScheduledJob } from '../core/schedule-store.js';
import {
  buildLogInspectionPrompt,
  readLogTail,
  redactSecrets,
  sanitizeErrorForLog,
} from '../core/log-inspection.js';
import { highRiskReason, isHighRiskTask } from '../core/risk.js';
import type { IncomingMessage } from '../im/lark.js';
import type { AppContext } from './app-context.js';
import { startCliTask } from './cli-task.js';
import { reconcileWorkflowSchedules, runTeamPipeline } from './pipeline-runner.js';
import { requestHighRiskApproval } from './approval-runner.js';
import { expireStaleApprovals } from './approval-status.js';
import { ensureRunnableSession, truncate } from './sessions.js';

const TICK_MS = 15_000;

export type ScheduleExecutionResult =
  | { outcome: 'succeeded' }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'deferred' };

export type ScheduleJobExecutor = (
  ctx: AppContext,
  job: ScheduledJob,
) => Promise<ScheduleExecutionResult>;

/** 日志巡检只把受控路径交给宿主读取，不能把路径中的敏感词误当成待执行指令。 */
export function scheduleRequiresApproval(job: ScheduledJob): boolean {
  return job.kind !== 'log_inspection' && isHighRiskTask(job.prompt);
}

/** 启动后立即检查一次；之后按固定 tick 检查持久化任务。 */
export function startScheduler(ctx: AppContext): void {
  if (ctx.schedulerTimer) return;
  const tick = () => void runDueSchedules(ctx).catch((error) => {
    console.error('[定时任务] scheduler tick 异常:', safeScheduleError(error));
  });
  ctx.schedulerTimer = setInterval(tick, TICK_MS);
  ctx.schedulerTimer.unref?.();
  tick();
  console.log('[定时任务] scheduler 已启动');
}

export function stopScheduler(ctx: AppContext): void {
  if (!ctx.schedulerTimer) return;
  clearInterval(ctx.schedulerTimer);
  ctx.schedulerTimer = undefined;
  console.log('[定时任务] scheduler 已停止');
}

export async function runDueSchedules(
  ctx: AppContext,
  executeJob: ScheduleJobExecutor = runJob,
): Promise<void> {
  if (ctx.shuttingDown || ctx.schedulerRunning) return;
  ctx.schedulerRunning = true;
  try {
    await expireStaleApprovals(ctx).catch((error) => {
      console.error('[审批] 清理过期审批失败:', safeScheduleError(error));
    });
    await reconcileWorkflowSchedules(ctx).catch((error) => {
      console.error('[定时任务] 修复工作流结算失败:', safeScheduleError(error));
    });
    for (const job of ctx.schedules.listDue()) {
      if (ctx.shuttingDown) break;
      let claimed: ScheduledJob;
      try {
        // 先认领并推进下次时间，避免相邻 tick 重复触发同一任务。
        claimed = await ctx.schedules.claimRun(job.id);
      } catch (error) {
        console.warn(`[定时任务] ${job.id} 未能认领，可能已被暂停、删除或其它 tick 处理:`, safeScheduleError(error));
        continue;
      }
      try {
        const result = await executeJob(ctx, claimed);
        if (result.outcome === 'deferred') continue;
        await ctx.schedules.finishRun(
          claimed.id,
          result.outcome,
          result.outcome === 'skipped' ? result.reason : undefined,
          new Date(),
          claimed.runCount,
        );
      } catch (error) {
        const message = safeScheduleError(error);
        console.error(`[定时任务] ${job.id} 执行失败:`, message);
        const latest = ctx.schedules.get(claimed.id);
        if (latest?.lastStatus === 'running' && latest.runCount === claimed.runCount) {
          await ctx.schedules.finishRun(
            claimed.id,
            'failed',
            message,
            new Date(),
            claimed.runCount,
          ).catch((persistError) => {
            console.error(`[定时任务] ${claimed.id} 保存失败状态异常:`, safeScheduleError(persistError));
          });
        }
        const bot = ctx.botsById.get(job.botId);
        if (bot) {
          await bot.reply(
            job.message.messageId,
            `⚠️ 定时任务 ${job.id} 本次执行失败：${message}。系统会自动补偿重试。`,
            !!job.message.threadId || !!job.message.rootId,
          ).catch(() => undefined);
        }
      }
    }
  } finally {
    ctx.schedulerRunning = false;
  }
}

async function settleDeferredRun(
  ctx: AppContext,
  jobId: string,
  runCount: number,
  outcome: 'succeeded' | 'failed',
  error?: string,
): Promise<void> {
  const current = ctx.schedules.get(jobId);
  if (!current || current.lastStatus !== 'running' || current.runCount !== runCount) return;
  try {
    await ctx.schedules.finishRun(jobId, outcome, error, new Date(), runCount);
  } catch (persistError) {
    console.error(`[定时任务] ${jobId} 保存异步结果失败:`, safeScheduleError(persistError));
  }
}

async function runJob(ctx: AppContext, job: ScheduledJob): Promise<ScheduleExecutionResult> {
  const bot = ctx.botsById.get(job.botId);
  if (!bot) {
    const reason = `Bot ${job.botId} 未连接`;
    console.warn(`[定时任务] ${job.id} 跳过：${reason}`);
    return { outcome: 'skipped', reason };
  }
  const label = job.kind === 'log_inspection' ? '服务端日志巡检' : job.kind === 'pipeline' ? '团队交付流水线' : '定时任务';
  const kickoffId = await bot.reply(
    job.message.messageId,
    `⏰ ${label}已触发：${truncate(redactSecrets(job.prompt), 200)}`,
    !!job.message.threadId || !!job.message.rootId,
  );
  if (!kickoffId) throw new Error('飞书未返回定时任务启动消息 ID');
  const msg: IncomingMessage = {
    messageId: kickoffId,
    topicId: job.message.topicId
      || job.message.threadId
      || job.message.rootId
      || job.message.messageId,
    chatId: job.message.chatId,
    chatType: job.message.chatType,
    messageType: 'text',
    text: '',
    rootId: job.message.rootId,
    threadId: job.message.threadId,
    senderOpenId: job.message.senderOpenId,
    senderType: 'user',
    mentions: [],
    rawContent: JSON.stringify({ text: '' }),
  };

  // 日志任务的 prompt 是经过校验的文件路径，只执行宿主只读截取，不应把路径文本误判成待执行高风险指令。
  if (scheduleRequiresApproval(job)) {
    await requestHighRiskApproval(ctx, {
      bot,
      msg,
      prompt: job.prompt,
      action: job.kind === 'pipeline' ? 'pipeline' : 'task',
      reason: highRiskReason(job.prompt),
      scheduleJobId: job.id,
      scheduleRunCount: job.runCount,
    });
    return { outcome: 'deferred' };
  }

  if (job.kind === 'pipeline') {
    if (bot.id !== 'ceo') {
      throw new Error('pipeline 只能由 CEO Bot 发起');
    }
    await runTeamPipeline(ctx, {
      ceo: bot,
      msg,
      goal: job.prompt,
      scheduleJobId: job.id,
      scheduleRunCount: job.runCount,
    });
    return { outcome: 'deferred' };
  }

  const session = await ensureRunnableSession(ctx, bot, msg);
  if (!session) {
    await bot.reply(
      job.message.messageId,
      `⏭️ 定时任务 ${job.id} 跳过：${bot.name} 正在忙。`,
      !!job.message.threadId || !!job.message.rootId,
    );
    return { outcome: 'skipped', reason: `${bot.name} 正在忙` };
  }
  const prompt = job.kind === 'log_inspection'
    ? buildLogInspectionPrompt(job.prompt, await readLogTail(job.prompt))
    : job.prompt;
  await startCliTask(ctx, {
    bot,
    msg,
    session,
    prompt,
    executionPolicy: job.kind === 'log_inspection' ? 'input-only' : 'standard',
    onSuccess: async () => settleDeferredRun(ctx, job.id, job.runCount, 'succeeded'),
    onFailure: async (error) => settleDeferredRun(ctx, job.id, job.runCount, 'failed', error.message),
  });
  return { outcome: 'deferred' };
}

function safeScheduleError(error: unknown): string {
  return sanitizeErrorForLog(error);
}
