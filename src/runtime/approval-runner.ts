/**
 * 高风险审批执行器。
 *
 * 当 isHighRiskTask() 检测到高风险操作时：
 * 1. requestHighRiskApproval()：发审批卡到飞书
 * 2. 用户点「批准」→ executeApprovedAction()：以 approved 策略重跑 CLI
 * 3. 用户点「拒绝」→ 标记失败，不执行
 *
 * 审批安全：
 * - assertOwnedBy()：只认 OWNER_OPEN_ID（多 Bot 场景跨应用拒绝同一用户）
 * - approvedScope：只放行原请求命中的风险类别（防「批准 git push」被扩大成删除数据）
 * - 高风险类别：production-change / destructive-change / external-publish 等
 * - 审批通过后 settleApprovalSchedule()：回写定时任务的真实终态
 */

import type { ApprovalRequest } from '../core/approval-store.js';
import { assertOwnedBy } from '../core/access.js';
import { normalizeIdentity, type IdentityInput } from '../core/identity-registry.js';
import { sanitizeErrorForLog } from '../core/log-inspection.js';
import type { IncomingMessage, Bot } from '../im/lark.js';
import { buildApprovalCard } from '../im/workflow-card.js';
import type { AppContext } from './app-context.js';
import { startCliTask } from './cli-task.js';
import { runDeliverySquad, runTeamPipeline } from './pipeline-runner.js';
import { runCollabReview } from './collab-runner.js';
import { ensureRunnableSession, topicIdOf } from './sessions.js';
import { finishApprovalExecution, updateApprovalCard } from './approval-status.js';

export async function requestHighRiskApproval(
  ctx: AppContext,
  options: {
    bot: Bot;
    msg: IncomingMessage;
    prompt: string;
    action: ApprovalRequest['action'];
    reason: string;
    scheduleJobId?: string;
    scheduleRunCount?: number;
  },
): Promise<ApprovalRequest> {
  const ownerOpenId = process.env.OWNER_OPEN_ID?.trim() || options.msg.senderOpenId;
  const approval = await ctx.approvals.create({
    botId: options.bot.id,
    ownerOpenId,
    action: options.action,
    prompt: options.prompt,
    reason: options.reason,
    scheduleJobId: options.scheduleJobId,
    scheduleRunCount: options.scheduleRunCount,
    message: {
      messageId: options.msg.messageId,
      topicId: topicIdOf(options.msg),
      chatId: options.msg.chatId,
      chatType: options.msg.chatType,
      rootId: options.msg.rootId,
      threadId: options.msg.threadId,
      senderOpenId: options.msg.senderOpenId,
    },
  });
  // 飞书可能重投同一条消息；已有审批（含终态）不能重复发卡或重新授权。
  if (approval.cardMessageId || approval.status !== 'pending') return approval;
  try {
    const cardMessageId = await options.bot.replyCard(
      options.msg.messageId,
      buildApprovalCard(approval),
      !!options.msg.threadId || !!options.msg.rootId,
    );
    if (!cardMessageId) throw new Error('飞书未返回审批卡 message_id');
    return await ctx.approvals.setCardMessageId(approval.id, cardMessageId);
  } catch (error) {
    const message = safeApprovalError(error);
    try {
      await ctx.approvals.expire(approval.id, `审批卡发送失败：${message}`);
    } catch (stateError) {
      throw new Error(
        `审批卡发送失败：${message}；审批失效状态保存失败：${safeApprovalError(stateError)}`,
        { cause: error },
      );
    }
    throw new Error(`审批卡发送失败：${message}`, { cause: error });
  }
}

function safeApprovalError(error: unknown): string {
  return sanitizeErrorForLog(error);
}

/**
 * 原子认领一次审批执行并恢复原始动作。
 * CLI/协作完成后通过回调落终态；同步启动失败会立即转为 failed，卡片可重试。
 */
export async function executeApprovedAction(
  ctx: AppContext,
  approvalId: string,
  operator: IdentityInput,
): Promise<ApprovalRequest> {
  const pending = ctx.approvals.get(approvalId);
  if (!pending) throw new Error(`审批不存在: ${approvalId}`);
  const operatorOpenId = normalizeIdentity(operator).openId;
  if (!operatorOpenId) throw new Error('审批回调缺少操作人的 open_id。');
  // 配置负责人变更后，旧负责人不能继续使用尚未处理的历史卡片。
  assertOwnedBy(pending.ownerOpenId, operator, ctx.identities);
  const approval = await ctx.approvals.beginExecution(
    approvalId,
    operatorOpenId,
    (ownerOpenId) => {
      try {
        assertOwnedBy(ownerOpenId, operator, ctx.identities);
        return true;
      } catch {
        return false;
      }
    },
  );
  await updateApprovalCard(ctx, approval);
  try {
    await runApprovedAction(ctx, approval);
    return ctx.approvals.get(approval.id) ?? approval;
  } catch (error) {
    return finishApprovalExecution(
      ctx,
      approval.id,
      approval.executionAttempt,
      'failed',
      (error as Error).message,
    );
  }
}

/** 审批通过后恢复原始动作；执行仍会复用原话题、原工作目录与会话。 */
async function runApprovedAction(ctx: AppContext, approval: ApprovalRequest): Promise<void> {
  const bot = ctx.botsById.get(approval.botId);
  if (!bot) throw new Error(`执行 Bot 未连接：${approval.botId}`);
  const scheduledMessage = approval.scheduleJobId
    ? ctx.schedules.get(approval.scheduleJobId)?.message
    : undefined;
  const msg: IncomingMessage = {
    messageId: approval.message.messageId,
    topicId: approval.message.topicId
      || scheduledMessage?.topicId
      || scheduledMessage?.threadId
      || scheduledMessage?.rootId
      || scheduledMessage?.messageId,
    chatId: approval.message.chatId,
    chatType: approval.message.chatType,
    messageType: 'text',
    text: '',
    rootId: approval.message.rootId,
    threadId: approval.message.threadId,
    senderOpenId: approval.message.senderOpenId,
    senderType: 'user',
    mentions: [],
    rawContent: JSON.stringify({ text: '' }),
  };
  if (approval.action === 'pipeline') {
    if (bot.id !== 'ceo') throw new Error('团队流水线必须由 CEO Bot 执行。');
    await runTeamPipeline(ctx, {
      ceo: bot,
      msg,
      goal: approval.prompt,
      executionPolicy: 'approved',
      approvalId: approval.id,
      approvalAttempt: approval.executionAttempt,
    });
    return;
  }
  if (approval.action === 'squad') {
    if (bot.id !== 'dev' && bot.id !== 'ceo') {
      throw new Error('内部交付小队必须由开发工程师或 CEO Bot 执行。');
    }
    await runDeliverySquad(ctx, {
      initiator: bot,
      msg,
      goal: approval.prompt,
      executionPolicy: 'approved',
      approvalId: approval.id,
      approvalAttempt: approval.executionAttempt,
    });
    return;
  }
  if (approval.action === 'review') {
    await runCollabReview(ctx, {
      initiator: bot,
      msg,
      task: approval.prompt,
      round: 1,
      allowFixes: false,
      executionPolicy: 'approved',
      approvedScope: approval.prompt,
      onComplete: async () => {
        await finishApprovalExecution(ctx, approval.id, approval.executionAttempt, 'succeeded');
      },
      onFailure: async (error) => {
        await finishApprovalExecution(ctx, approval.id, approval.executionAttempt, 'failed', error.message);
      },
    });
    return;
  }
  const session = await ensureRunnableSession(ctx, bot, msg);
  if (!session) throw new Error(`${bot.name} 正在执行其他任务，请稍后重新审批。`);
  await startCliTask(ctx, {
    bot,
    msg,
    session,
    prompt: approval.prompt,
    downloadResources: false,
    executionPolicy: 'approved',
    approvedScope: approval.prompt,
    onSuccess: async () => {
      await finishApprovalExecution(ctx, approval.id, approval.executionAttempt, 'succeeded');
    },
    onFailure: async (error) => {
      await finishApprovalExecution(ctx, approval.id, approval.executionAttempt, 'failed', error.message);
    },
  });
}
