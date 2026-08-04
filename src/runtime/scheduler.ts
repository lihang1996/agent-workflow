import type { ScheduledJob } from '../core/schedule-store.js';
import { buildLogInspectionPrompt, readLogTail } from '../core/log-inspection.js';
import { highRiskReason, isHighRiskTask } from '../core/risk.js';
import type { IncomingMessage } from '../im/lark.js';
import type { AppContext } from './app-context.js';
import { startCliTask } from './cli-task.js';
import { runTeamPipeline } from './pipeline-runner.js';
import { requestHighRiskApproval } from './approval-runner.js';
import { ensureRunnableSession } from './sessions.js';

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
  ctx.schedulerTimer = setInterval(() => void runDueSchedules(ctx), TICK_MS);
  ctx.schedulerTimer.unref?.();
  void runDueSchedules(ctx);
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
    for (const job of ctx.schedules.listDue()) {
      let claimed: ScheduledJob | undefined;
      try {
        // 先认领并推进下次时间，避免相邻 tick 重复触发同一任务。
        claimed = await ctx.schedules.claimRun(job.id);
        const result = await executeJob(ctx, claimed);
        if (result.outcome === 'deferred') continue;
        await ctx.schedules.finishRun(
          claimed.id,
          result.outcome,
          result.outcome === 'skipped' ? result.reason : undefined,
        );
      } catch (error) {
        const message = (error as Error).message;
        console.error(`[定时任务] ${job.id} 执行失败:`, message);
        if (claimed && ctx.schedules.get(claimed.id)?.lastStatus === 'running') {
          await ctx.schedules.finishRun(claimed.id, 'failed', message).catch((persistError) => {
            console.error(`[定时任务] ${claimed!.id} 保存失败状态异常:`, (persistError as Error).message);
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
  outcome: 'succeeded' | 'failed',
  error?: string,
): Promise<void> {
  const current = ctx.schedules.get(jobId);
  if (!current || current.lastStatus !== 'running') return;
  try {
    await ctx.schedules.finishRun(jobId, outcome, error);
  } catch (persistError) {
    console.error(`[定时任务] ${jobId} 保存异步结果失败:`, (persistError as Error).message);
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
    `⏰ ${label}已触发：${job.prompt}`,
    !!job.message.threadId || !!job.message.rootId,
  );
  if (!kickoffId) throw new Error('飞书未返回定时任务启动消息 ID');
  const msg: IncomingMessage = {
    messageId: kickoffId,
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
    });
    return { outcome: 'succeeded' };
  }

  if (job.kind === 'pipeline') {
    if (bot.id !== 'ceo') {
      throw new Error('pipeline 只能由 CEO Bot 发起');
    }
    await runTeamPipeline(ctx, { ceo: bot, msg, goal: job.prompt });
    return { outcome: 'succeeded' };
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
    onSuccess: async () => settleDeferredRun(ctx, job.id, 'succeeded'),
    onFailure: async (error) => settleDeferredRun(ctx, job.id, 'failed', error.message),
  });
  return { outcome: 'deferred' };
}
