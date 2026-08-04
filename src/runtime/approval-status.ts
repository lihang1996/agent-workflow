import type { ApprovalExecutionOutcome, ApprovalRequest } from '../core/approval-store.js';
import { buildApprovalCard } from '../im/workflow-card.js';
import type { AppContext } from './app-context.js';

/** 将持久化审批状态回写到最初的飞书审批卡。回写失败不能反向改变任务结果。 */
export async function updateApprovalCard(
  ctx: AppContext,
  approval: ApprovalRequest,
): Promise<void> {
  if (!approval.cardMessageId) return;
  const bot = ctx.botsById.get(approval.botId);
  if (!bot) return;
  try {
    await bot.updateCard(approval.cardMessageId, buildApprovalCard(approval));
  } catch (error) {
    console.error(`[审批] 更新卡片失败 id=${approval.id}:`, (error as Error).message);
  }
}

export async function finishApprovalExecution(
  ctx: AppContext,
  approvalId: string,
  executionAttempt: number,
  outcome: ApprovalExecutionOutcome,
  error?: string,
): Promise<ApprovalRequest> {
  const approval = await ctx.approvals.finishExecution(
    approvalId,
    executionAttempt,
    outcome,
    error,
  );
  if (approval.executionAttempt === executionAttempt && approval.status === outcome) {
    await settleApprovalSchedule(ctx, approval, outcome, error).catch((settleError) => {
      console.error(`[审批] ${approval.id} 定时任务结算失败:`, (settleError as Error).message);
    });
  }
  await updateApprovalCard(ctx, approval);
  return approval;
}

export async function settleApprovalSchedule(
  ctx: AppContext,
  approval: ApprovalRequest,
  outcome: 'succeeded' | 'failed' | 'skipped',
  error?: string,
): Promise<void> {
  if (!approval.scheduleJobId || !approval.scheduleRunCount) return;
  const job = ctx.schedules.get(approval.scheduleJobId);
  if (
    !job
    || job.lastStatus !== 'running'
    || job.runCount !== approval.scheduleRunCount
  ) return;
  await ctx.schedules.finishRun(
    job.id,
    outcome,
    outcome === 'succeeded' ? undefined : (error?.trim() || approval.executionError || '审批未执行'),
  );
}

/** scheduler 周期调用，保证无人处理的审批过期后不会永远占住定时任务。 */
export async function expireStaleApprovals(ctx: AppContext): Promise<void> {
  const expired = await ctx.approvals.expireStale();
  for (const approval of expired) {
    await settleApprovalSchedule(ctx, approval, 'skipped', approval.executionError).catch((error) => {
      console.error(`[审批] ${approval.id} 过期结算失败:`, (error as Error).message);
    });
    await updateApprovalCard(ctx, approval);
  }
  // 修复运行中“审批终态已保存、schedule 结果尚未保存”的短暂失败。
  for (const approval of ctx.approvals.list()) {
    const outcome = scheduleOutcomeFor(approval);
    if (!outcome) continue;
    await settleApprovalSchedule(ctx, approval, outcome, approval.executionError).catch((error) => {
      console.error(`[审批] ${approval.id} 定时任务补偿结算失败:`, (error as Error).message);
    });
  }
}

/** 服务重启后校准审批与持久化工作流，并刷新仍存在的审批卡。 */
export async function reconcileApprovalExecutions(ctx: AppContext): Promise<void> {
  const workflowState = (workflowId: string) => {
    const workflow = ctx.workflows.get(workflowId);
    if (!workflow) return undefined;
    if (workflow.status === 'completed') return 'succeeded' as const;
    if (workflow.status === 'failed') return 'failed' as const;
    return 'running' as const;
  };

  // 修复“工作流已落盘、审批关联尚未落盘”这一崩溃窗口，防止恢复后出现重复执行。
  for (const approval of ctx.approvals.list()) {
    if (approval.status !== 'executing' || approval.workflowId) continue;
    const workflow = ctx.workflows.findByApproval(approval.id, approval.executionAttempt);
    if (!workflow) continue;
    await ctx.approvals.attachWorkflow(approval.id, approval.executionAttempt, workflow.id);
  }

  // schedule store 会先把 running 标成“重启中断”；仍在等审批或有持久化工作流的轮次需要恢复占位。
  for (const approval of ctx.approvals.list()) {
    if (!approval.scheduleJobId || !approval.scheduleRunCount) continue;
    const durableWorkflow = approval.workflowId ? workflowState(approval.workflowId) : undefined;
    const shouldRestore = approval.status === 'pending'
      || approval.status === 'approved'
      || approval.status === 'succeeded'
      || approval.status === 'failed'
      || approval.status === 'rejected'
      || approval.status === 'expired'
      || (approval.status === 'executing' && durableWorkflow !== undefined);
    if (shouldRestore) {
      await ctx.schedules.restoreInterruptedRun(approval.scheduleJobId, approval.scheduleRunCount);
    }
  }

  const changed = await ctx.approvals.reconcileInterrupted(workflowState);
  for (const approval of changed) {
    await updateApprovalCard(ctx, approval);
  }

  // 覆盖“审批终态已落盘、定时任务结算尚未落盘”的崩溃窗口。
  for (const approval of ctx.approvals.list()) {
    const scheduleOutcome = scheduleOutcomeFor(approval);
    if (scheduleOutcome) {
      await settleApprovalSchedule(ctx, approval, scheduleOutcome, approval.executionError).catch((error) => {
        console.error(`[审批] ${approval.id} 重启结算失败:`, (error as Error).message);
      });
    }
  }
  if (changed.length > 0) console.log(`[审批] 已校准 ${changed.length} 条重启状态`);
}

function scheduleOutcomeFor(
  approval: ApprovalRequest,
): 'succeeded' | 'failed' | 'skipped' | undefined {
  if (approval.status === 'succeeded') return 'succeeded';
  if (approval.status === 'failed') return 'failed';
  if (approval.status === 'rejected' || approval.status === 'expired') return 'skipped';
  return undefined;
}
