import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  JsonScheduleStore,
  type ScheduledJob,
  type ScheduleRunOutcome,
} from '../src/core/schedule-store.js';
import { JsonApprovalStore } from '../src/core/approval-store.js';
import { JsonWorkflowStore } from '../src/core/workflow-store.js';
import type { AppContext } from '../src/runtime/app-context.js';
import {
  finishApprovalExecution,
  reconcileApprovalExecutions,
  settleApprovalSchedule,
} from '../src/runtime/approval-status.js';
import { runDueSchedules } from '../src/runtime/scheduler.js';
import { resumeRecoverableWorkflows } from '../src/runtime/pipeline-runner.js';

function message() {
  return {
    messageId: 'om_message',
    chatId: 'oc_chat',
    chatType: 'group',
    rootId: 'om_root',
    threadId: '',
    senderOpenId: 'ou_owner',
  };
}

test('定时任务持久化运行状态、失败原因和补偿时间', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-schedule-state-'));
  const path = join(root, 'schedules.json');
  try {
    const store = await JsonScheduleStore.open(path);
    const created = await store.create({
      botId: 'dev', ownerOpenId: 'ou_owner', kind: 'task', prompt: '检查项目', intervalMs: 60_000, message: message(),
    });
    const firstStart = new Date(created.nextRunAt);
    const claimed = await store.claimRun(created.id, firstStart);
    assert.equal(claimed.lastStatus, 'running');
    assert.equal(claimed.runCount, 1);
    assert.equal(store.listDue(new Date(firstStart.getTime() + 120_000)).length, 0, '运行中的任务不能重入');

    const failedAt = new Date(firstStart.getTime() + 5_000);
    const failed = await store.finishRun(created.id, 'failed', 'CLI 启动失败', failedAt);
    assert.equal(failed.lastStatus, 'failed');
    assert.equal(failed.lastError, 'CLI 启动失败');
    assert.equal(failed.consecutiveFailures, 1);
    assert.equal(new Date(failed.nextRunAt).getTime(), failedAt.getTime() + 60_000);

    const retried = await store.claimRun(created.id, new Date(failed.nextRunAt));
    await store.finishRun(retried.id, 'succeeded', undefined, new Date(new Date(retried.lastRunAt!).getTime() + 2_000));
    const final = store.get(created.id)!;
    assert.equal(final.lastStatus, 'succeeded');
    assert.equal(final.consecutiveFailures, 0);
    assert.equal(final.lastError, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('服务重启会把执行中的定时任务改为失败并立即补偿', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-schedule-recover-'));
  const path = join(root, 'schedules.json');
  try {
    const store = await JsonScheduleStore.open(path);
    const created = await store.create({
      botId: 'dev', ownerOpenId: 'ou_owner', kind: 'task', prompt: '巡检', intervalMs: 60_000, message: message(),
    });
    await store.claimRun(created.id, new Date(created.nextRunAt));
    const beforeOpen = Date.now();
    const reopened = await JsonScheduleStore.open(path);
    const recovered = reopened.get(created.id)!;
    assert.equal(recovered.lastStatus, 'failed');
    assert.match(recovered.lastError ?? '', /服务重启中断/);
    assert.ok(new Date(recovered.nextRunAt).getTime() >= beforeOpen);
    assert.equal(reopened.listDue(new Date(Date.now() + 1_000)).length, 1);
    const restored = await reopened.restoreInterruptedRun(created.id, recovered.runCount);
    assert.equal(restored?.lastStatus, 'running');
    assert.equal(restored?.consecutiveFailures, 0);
    assert.equal(reopened.listDue(new Date(Date.now() + 1_000)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('单个定时任务失败不会阻断同一轮后续任务', async () => {
  const base = {
    botId: 'dev', ownerOpenId: 'ou_owner', kind: 'task' as const, prompt: '任务', intervalMs: 60_000,
    nextRunAt: new Date(0).toISOString(), lastStatus: 'idle' as const, runCount: 0, consecutiveFailures: 0,
    enabled: true, message: message(), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
  const jobs: ScheduledJob[] = [{ ...base, id: 'job-a' }, { ...base, id: 'job-b' }];
  const statuses = new Map<string, ScheduledJob>(jobs.map((job) => [job.id, job]));
  const finished: Array<[string, ScheduleRunOutcome]> = [];
  const schedules = {
    listDue: () => jobs,
    get: (id: string) => statuses.get(id),
    claimRun: async (id: string) => {
      const claimed = { ...statuses.get(id)!, lastStatus: 'running' as const, runCount: 1 };
      statuses.set(id, claimed);
      return claimed;
    },
    finishRun: async (id: string, outcome: ScheduleRunOutcome, error?: string) => {
      const next = { ...statuses.get(id)!, lastStatus: outcome, ...(error ? { lastError: error } : {}) };
      statuses.set(id, next);
      finished.push([id, outcome]);
      return next;
    },
  };
  const ctx = {
    shuttingDown: false,
    schedulerRunning: false,
    schedules,
    approvals: { expireStale: async () => [], list: () => [] },
    workflows: { list: () => [] },
    botsById: new Map(),
  } as unknown as AppContext;
  await runDueSchedules(ctx, async (_context, job) => {
    if (job.id === 'job-a') throw new Error('预期失败');
    return { outcome: 'succeeded' };
  });
  assert.deepEqual(finished, [['job-a', 'failed'], ['job-b', 'succeeded']]);
  assert.equal(ctx.schedulerRunning, false);
});

test('定时高风险任务等待真实审批结果后再结算', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-schedule-approval-'));
  try {
    const schedules = await JsonScheduleStore.open(join(root, 'schedules.json'));
    const approvals = await JsonApprovalStore.open(join(root, 'approvals.json'));
    const created = await schedules.create({
      botId: 'dev', ownerOpenId: 'ou_owner', kind: 'task', prompt: 'git push origin main', intervalMs: 60_000, message: message(),
    });
    const claimed = await schedules.claimRun(created.id, new Date(created.nextRunAt));
    const approval = await approvals.create({
      botId: 'dev', ownerOpenId: 'ou_owner', action: 'task', prompt: claimed.prompt,
      reason: '会向外部仓库推送内容', message: claimed.message,
      scheduleJobId: claimed.id, scheduleRunCount: claimed.runCount,
    });
    const executing = await approvals.beginExecution(approval.id, 'ou_owner');
    const ctx = { schedules, approvals, botsById: new Map() } as unknown as AppContext;
    await finishApprovalExecution(ctx, approval.id, executing.executionAttempt, 'succeeded');
    assert.equal(schedules.get(claimed.id)?.lastStatus, 'succeeded');

    const next = await schedules.claimRun(claimed.id, new Date(schedules.get(claimed.id)!.nextRunAt));
    const rejected = await approvals.create({
      botId: 'dev', ownerOpenId: 'ou_owner', action: 'task', prompt: next.prompt,
      reason: '会向外部仓库推送内容', message: next.message,
      scheduleJobId: next.id, scheduleRunCount: next.runCount,
    });
    const rejectedState = await approvals.reject(rejected.id, 'ou_owner');
    await settleApprovalSchedule(ctx, rejectedState, 'skipped', '负责人拒绝审批');
    assert.equal(schedules.get(next.id)?.lastStatus, 'skipped');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('重启后待审批定时任务保持占位，审批终态可修复跨存储结算', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-schedule-approval-restart-'));
  const schedulePath = join(root, 'schedules.json');
  const approvalPath = join(root, 'approvals.json');
  try {
    const initialSchedules = await JsonScheduleStore.open(schedulePath);
    const initialApprovals = await JsonApprovalStore.open(approvalPath);
    const job = await initialSchedules.create({
      botId: 'dev', ownerOpenId: 'ou_owner', kind: 'task', prompt: 'git push origin main', intervalMs: 60_000, message: message(),
    });
    const claimed = await initialSchedules.claimRun(job.id, new Date(job.nextRunAt));
    const approval = await initialApprovals.create({
      botId: 'dev', ownerOpenId: 'ou_owner', action: 'task', prompt: claimed.prompt,
      reason: '会向外部仓库推送内容', message: claimed.message,
      scheduleJobId: claimed.id, scheduleRunCount: claimed.runCount,
    });

    const schedules = await JsonScheduleStore.open(schedulePath);
    const approvals = await JsonApprovalStore.open(approvalPath);
    assert.equal(schedules.get(job.id)?.lastStatus, 'failed');
    const ctx = {
      schedules,
      approvals,
      workflows: { get: () => undefined, findByApproval: () => undefined },
      botsById: new Map(),
    } as unknown as AppContext;
    await reconcileApprovalExecutions(ctx);
    assert.equal(schedules.get(job.id)?.lastStatus, 'running');

    const executing = await approvals.beginExecution(approval.id, 'ou_owner');
    await approvals.finishExecution(approval.id, executing.executionAttempt, 'succeeded');
    await reconcileApprovalExecutions(ctx);
    assert.equal(schedules.get(job.id)?.lastStatus, 'succeeded');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('定时流水线按工作流真实终态结算并可跨重启修复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-scheduled-workflow-'));
  const schedulePath = join(root, 'schedules.json');
  try {
    const initialSchedules = await JsonScheduleStore.open(schedulePath);
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const job = await initialSchedules.create({
      botId: 'ceo', ownerOpenId: 'ou_owner', kind: 'pipeline', prompt: '整理文档', intervalMs: 60_000, message: message(),
    });
    const claimed = await initialSchedules.claimRun(job.id, new Date(job.nextRunAt));
    const workflow = await workflows.create({
      kind: 'team', name: '团队交付流水线', initiatorBotId: 'ceo', goal: claimed.prompt,
      stepIds: ['pm'], message: claimed.message,
      scheduleJobId: claimed.id, scheduleRunCount: claimed.runCount,
    });
    await workflows.update(workflow.id, { status: 'completed', nextStepIndex: 1 });

    const schedules = await JsonScheduleStore.open(schedulePath);
    assert.equal(schedules.get(job.id)?.lastStatus, 'failed');
    await resumeRecoverableWorkflows({
      workflows,
      schedules,
      botsById: new Map(),
    } as unknown as AppContext);
    assert.equal(schedules.get(job.id)?.lastStatus, 'succeeded');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
