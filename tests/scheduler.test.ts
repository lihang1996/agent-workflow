import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import {
  resumeRecoverableWorkflows,
  runTeamPipeline,
} from '../src/runtime/pipeline-runner.js';

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

test('定时任务创建幂等且并发只认领一个运行轮次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-schedule-concurrency-'));
  try {
    const store = await JsonScheduleStore.open(join(root, 'schedules.json'));
    const input = {
      botId: 'dev', ownerOpenId: 'ou_owner', kind: 'task' as const,
      prompt: '检查项目', intervalMs: 60_000, message: message(),
    };
    const [first, duplicate] = await Promise.all([store.create(input), store.create(input)]);
    assert.equal(duplicate.id, first.id);
    assert.equal(store.listByTopic('oc_chat', 'om_root').length, 1);
    const dueAt = new Date(first.nextRunAt);
    const claims = await Promise.allSettled([
      store.claimRun(first.id, dueAt),
      store.claimRun(first.id, dueAt),
    ]);
    assert.equal(claims.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(store.get(first.id)?.runCount, 1);
    assert.equal(store.get(first.id)?.lastStatus, 'running');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('定时任务忽略旧轮次结果且执行中不能删除', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-schedule-stale-result-'));
  try {
    const store = await JsonScheduleStore.open(join(root, 'schedules.json'));
    const job = await store.create({
      botId: 'dev', ownerOpenId: 'ou_owner', kind: 'task', prompt: '检查项目', intervalMs: 60_000,
      message: { ...message(), messageId: 'om_stale' },
    });
    const first = await store.claimRun(job.id, new Date(job.nextRunAt));
    const failed = await store.finishRun(first.id, 'failed', '首次失败', new Date(), first.runCount);
    const second = await store.claimRun(failed.id, new Date(failed.nextRunAt));
    await assert.rejects(
      store.finishRun(second.id, 'succeeded', undefined, new Date(), first.runCount),
      /运行轮次已变化/,
    );
    await assert.rejects(store.remove(second.id), /执行，不能删除/);
    assert.equal(store.get(second.id)?.lastStatus, 'running');
    await store.finishRun(second.id, 'succeeded', undefined, new Date(), second.runCount);
    assert.equal(await store.remove(second.id), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('定时任务落盘失败回滚，损坏或重复记录阻止启动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-schedule-validation-'));
  try {
    const unwritableTarget = join(root, 'target-directory');
    await mkdir(unwritableTarget);
    const brokenStore = new JsonScheduleStore(unwritableTarget);
    await assert.rejects(brokenStore.create({
      botId: 'dev', ownerOpenId: 'ou_owner', kind: 'task', prompt: '检查项目', intervalMs: 60_000,
      message: { ...message(), messageId: 'om_rollback' },
    }));
    assert.equal(brokenStore.listByTopic('oc_chat', 'om_root').length, 0);

    const path = join(root, 'schedules.json');
    await writeFile(path, '{bad json');
    await assert.rejects(JsonScheduleStore.open(path), /不是有效 JSON/);

    const validStore = await JsonScheduleStore.open(join(root, 'valid.json'));
    const job = await validStore.create({
      botId: 'dev', ownerOpenId: 'ou_owner', kind: 'task', prompt: '检查项目', intervalMs: 60_000,
      message: { ...message(), messageId: 'om_duplicate' },
    });
    const rows = JSON.parse(await readFile(join(root, 'valid.json'), 'utf8'));
    await writeFile(path, JSON.stringify([job, ...rows]));
    await assert.rejects(JsonScheduleStore.open(path), /重复 ID/);
    await writeFile(path, JSON.stringify([{ ...job, intervalMs: 1 }]));
    await assert.rejects(JsonScheduleStore.open(path), /第 1 条记录格式错误/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    await approvals.setCardMessageId(approval.id, 'om_card_first_run');
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
    await approvals.setCardMessageId(rejected.id, 'om_card_second_run');
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
    await initialApprovals.setCardMessageId(approval.id, 'om_card_restart');

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

test('定时团队流水线把运行轮次写入持久化工作流', async () => {
  let createdInput: Record<string, unknown> | undefined;
  const workflow = {
    id: '6b4ca8b5-b1f3-48e4-839f-9007ce250aa1',
    kind: 'team' as const,
    name: '团队交付流水线',
    initiatorBotId: 'ceo',
    goal: '整理文档',
    stepIds: ['summary'] as const,
    nextStepIndex: 0,
    priorOutputs: {},
    status: 'ready' as const,
    executionPolicy: 'standard' as const,
    scheduleJobId: 'job-pipeline',
    scheduleRunCount: 3,
    message: message(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const workflows = {
    create: async (input: Record<string, unknown>) => {
      createdInput = input;
      return workflow;
    },
    get: () => workflow,
    update: async () => ({ ...workflow, status: 'failed' as const }),
    updateIfStatus: async () => ({ ...workflow, status: 'failed' as const }),
  };
  const ceo = {
    id: 'ceo',
    name: 'CEO助手',
    reply: async () => { throw new Error('停止在工作流创建之后'); },
  };
  const ctx = {
    shuttingDown: false,
    pipelineSteps: [{ id: 'summary', botId: 'ceo', title: '交付汇总' }],
    botsById: new Map([['ceo', ceo]]),
    workflows,
    schedules: { get: () => undefined },
  } as unknown as AppContext;
  const msg = {
    ...message(),
    messageType: 'text', text: '', senderType: 'user', mentions: [], rawContent: '{"text":""}',
  };

  await assert.rejects(
    () => runTeamPipeline(ctx, {
      ceo: ceo as never,
      msg,
      goal: '整理文档',
      scheduleJobId: 'job-pipeline',
      scheduleRunCount: 3,
    }),
    /停止在工作流创建之后/,
  );
  assert.equal(createdInput?.scheduleJobId, 'job-pipeline');
  assert.equal(createdInput?.scheduleRunCount, 3);
});
