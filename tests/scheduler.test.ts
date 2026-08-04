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
import type { AppContext } from '../src/runtime/app-context.js';
import { runDueSchedules } from '../src/runtime/scheduler.js';

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
    botsById: new Map(),
  } as unknown as AppContext;
  await runDueSchedules(ctx, async (_context, job) => {
    if (job.id === 'job-a') throw new Error('预期失败');
    return { outcome: 'succeeded' };
  });
  assert.deepEqual(finished, [['job-a', 'failed'], ['job-b', 'succeeded']]);
  assert.equal(ctx.schedulerRunning, false);
});
