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

async function runDueSchedules(ctx: AppContext): Promise<void> {
  if (ctx.shuttingDown || ctx.schedulerRunning) return;
  ctx.schedulerRunning = true;
  try {
    for (const job of ctx.schedules.listDue()) {
      // 先推进下次执行时间，避免任务本身耗时期间被重复触发。
      await ctx.schedules.markRun(job.id);
      await runJob(ctx, job);
    }
  } catch (error) {
    console.error('[定时任务] 调度失败:', (error as Error).message);
  } finally {
    ctx.schedulerRunning = false;
  }
}

async function runJob(ctx: AppContext, job: ScheduledJob): Promise<void> {
  const bot = ctx.botsById.get(job.botId);
  if (!bot) {
    console.warn(`[定时任务] ${job.id} 跳过：Bot ${job.botId} 未连接`);
    return;
  }
  const label = job.kind === 'log_inspection' ? '服务端日志巡检' : job.kind === 'pipeline' ? '团队交付流水线' : '定时任务';
  const kickoffId = await bot.sendText(job.message.chatId, `⏰ ${label}已触发：${job.prompt}`)
    .catch((error) => {
      console.error(`[定时任务] ${job.id} 无法发送启动消息:`, (error as Error).message);
      return undefined;
    });
  const msg: IncomingMessage = {
    messageId: kickoffId ?? job.message.messageId,
    chatId: job.message.chatId,
    chatType: job.message.chatType,
    messageType: 'text',
    text: '',
    rootId: job.message.rootId,
    threadId: job.message.threadId,
    senderOpenId: job.ownerOpenId,
    senderType: 'user',
    mentions: [],
    rawContent: JSON.stringify({ text: '' }),
  };

  if (isHighRiskTask(job.prompt)) {
    await requestHighRiskApproval(ctx, {
      bot,
      msg,
      prompt: job.prompt,
      action: job.kind === 'pipeline' ? 'pipeline' : 'task',
      reason: highRiskReason(job.prompt),
    });
    return;
  }

  if (job.kind === 'pipeline') {
    if (bot.id !== 'ceo') {
      console.warn(`[定时任务] ${job.id} 跳过：pipeline 只能由 CEO Bot 发起`);
      return;
    }
    await runTeamPipeline(ctx, { ceo: bot, msg, goal: job.prompt });
    return;
  }

  const session = await ensureRunnableSession(ctx, bot, msg);
  if (!session) {
    await bot.sendText(job.message.chatId, `⏭️ 定时任务 ${job.id} 跳过：${bot.name} 正在忙。`);
    return;
  }
  const prompt = job.kind === 'log_inspection'
    ? buildLogInspectionPrompt(job.prompt, await readLogTail(job.prompt))
    : job.prompt;
  await startCliTask(ctx, { bot, msg, session, prompt });
}
