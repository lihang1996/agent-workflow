import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { StoredMessage } from './approval-store.js';

export const ScheduleKindSchema = z.enum(['task', 'pipeline', 'log_inspection']);
export type ScheduleKind = z.infer<typeof ScheduleKindSchema>;
export const ScheduleRunStatusSchema = z.enum(['idle', 'running', 'succeeded', 'failed', 'skipped']);
export type ScheduleRunStatus = z.infer<typeof ScheduleRunStatusSchema>;
export type ScheduleRunOutcome = Exclude<ScheduleRunStatus, 'idle' | 'running'>;

const StoredMessageSchema = z.object({
  messageId: z.string().min(1),
  chatId: z.string().min(1),
  chatType: z.string(),
  rootId: z.string(),
  threadId: z.string(),
  senderOpenId: z.string(),
});

export const ScheduleSchema = z.object({
  id: z.string().min(1),
  botId: z.string().min(1),
  ownerOpenId: z.string().min(1),
  kind: ScheduleKindSchema,
  prompt: z.string().min(1),
  intervalMs: z.number().int().min(60_000),
  nextRunAt: z.string().datetime(),
  lastRunAt: z.string().datetime().optional(),
  lastFinishedAt: z.string().datetime().optional(),
  lastStatus: ScheduleRunStatusSchema.default('idle'),
  lastError: z.string().optional(),
  runCount: z.number().int().min(0).default(0),
  consecutiveFailures: z.number().int().min(0).default(0),
  enabled: z.boolean(),
  message: StoredMessageSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ScheduledJob = z.infer<typeof ScheduleSchema>;

/** 解析 `15m` / `1h` / `2d`；定时任务最小粒度为一分钟。 */
export function parseScheduleInterval(value: string): number | undefined {
  const match = /^(\d+)\s*(m|h|d)$/i.exec(value.trim());
  if (!match) return undefined;
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count < 1) return undefined;
  const unit = match[2].toLowerCase();
  const multiplier = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  const result = count * multiplier;
  return result <= 365 * 86_400_000 ? result : undefined;
}

export function formatScheduleInterval(intervalMs: number): string {
  if (intervalMs % 86_400_000 === 0) return `${intervalMs / 86_400_000}d`;
  if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000}h`;
  return `${intervalMs / 60_000}m`;
}

export function formatScheduleRunStatus(status: ScheduleRunStatus): string {
  return {
    idle: '尚未执行',
    running: '执行中',
    succeeded: '成功',
    failed: '失败',
    skipped: '已跳过',
  }[status];
}

export class JsonScheduleStore {
  private readonly jobs = new Map<string, ScheduledJob>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  static async open(filePath: string): Promise<JsonScheduleStore> {
    const store = new JsonScheduleStore(filePath);
    await store.load();
    await store.recoverInterruptedRuns();
    return store;
  }

  get(id: string): ScheduledJob | undefined {
    return this.jobs.get(id);
  }

  listByTopic(chatId: string, topicId: string): ScheduledJob[] {
    return [...this.jobs.values()]
      .filter((job) => job.message.chatId === chatId && (job.message.threadId || job.message.rootId || job.message.messageId) === topicId)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  }

  listDue(now = new Date()): ScheduledJob[] {
    const nowIso = now.toISOString();
    return [...this.jobs.values()]
      .filter((job) => job.enabled && job.lastStatus !== 'running' && job.nextRunAt <= nowIso)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  }

  async create(input: {
    botId: string;
    ownerOpenId: string;
    kind: ScheduleKind;
    prompt: string;
    intervalMs: number;
    message: StoredMessage;
  }): Promise<ScheduledJob> {
    const now = new Date();
    const job: ScheduledJob = {
      ...input,
      id: randomUUID(),
      nextRunAt: new Date(now.getTime() + input.intervalMs).toISOString(),
      lastStatus: 'idle',
      runCount: 0,
      consecutiveFailures: 0,
      enabled: true,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.jobs.set(job.id, job);
    await this.persist();
    return job;
  }

  /** 原子认领一次到期任务并提前推进 nextRunAt，防止调度 tick 重复启动。 */
  async claimRun(id: string, now = new Date()): Promise<ScheduledJob> {
    const current = this.get(id);
    if (!current) throw new Error(`定时任务不存在: ${id}`);
    if (!current.enabled) throw new Error(`定时任务已暂停: ${id}`);
    if (current.lastStatus === 'running') throw new Error(`定时任务正在执行: ${id}`);
    if (current.nextRunAt > now.toISOString()) throw new Error(`定时任务尚未到期: ${id}`);
    const next: ScheduledJob = {
      ...current,
      lastRunAt: now.toISOString(),
      lastStatus: 'running',
      lastError: undefined,
      runCount: current.runCount + 1,
      nextRunAt: new Date(now.getTime() + current.intervalMs).toISOString(),
      updatedAt: now.toISOString(),
    };
    this.jobs.set(id, next);
    await this.persist();
    return next;
  }

  /** 记录本次触发结果；失败/跳过会在不超过 5 分钟后补偿重试。 */
  async finishRun(
    id: string,
    outcome: ScheduleRunOutcome,
    error?: string,
    now = new Date(),
  ): Promise<ScheduledJob> {
    const current = this.get(id);
    if (!current) throw new Error(`定时任务不存在: ${id}`);
    if (current.lastStatus !== 'running') throw new Error(`定时任务当前未在执行: ${id}`);
    const failed = outcome !== 'succeeded';
    const failures = failed ? current.consecutiveFailures + 1 : 0;
    const regularNext = new Date(current.nextRunAt).getTime();
    const nextRunAt = failed
      ? new Date(now.getTime() + Math.min(current.intervalMs, 5 * 60_000)).toISOString()
      : new Date(Math.max(regularNext, now.getTime() + current.intervalMs)).toISOString();
    const next = ScheduleSchema.parse({
      ...current,
      lastStatus: outcome,
      lastFinishedAt: now.toISOString(),
      lastError: error?.trim() || undefined,
      consecutiveFailures: failures,
      nextRunAt,
      updatedAt: now.toISOString(),
    });
    this.jobs.set(id, next);
    await this.persist();
    return next;
  }

  /**
   * 审批/持久化工作流可跨服务重启等待：撤销 open() 对这一轮的通用中断标记，
   * 恢复原 runCount 和常规 nextRunAt，避免 scheduler 重复发起同一高风险任务。
   */
  async restoreInterruptedRun(id: string, runCount: number): Promise<ScheduledJob | undefined> {
    const current = this.get(id);
    if (!current || current.runCount !== runCount) return undefined;
    if (current.lastStatus === 'running') return current;
    if (
      current.lastStatus !== 'failed'
      || !current.lastError?.startsWith('上次执行被服务重启中断')
      || !current.lastRunAt
    ) return undefined;
    const regularNext = new Date(new Date(current.lastRunAt).getTime() + current.intervalMs).toISOString();
    const next = ScheduleSchema.parse({
      ...current,
      lastStatus: 'running',
      lastFinishedAt: undefined,
      lastError: undefined,
      consecutiveFailures: Math.max(0, current.consecutiveFailures - 1),
      nextRunAt: regularNext,
      updatedAt: new Date().toISOString(),
    });
    this.jobs.set(id, next);
    await this.persist();
    return next;
  }

  async setEnabled(id: string, enabled: boolean): Promise<ScheduledJob> {
    const current = this.get(id);
    if (!current) throw new Error(`定时任务不存在: ${id}`);
    const next: ScheduledJob = {
      ...current,
      enabled,
      nextRunAt: enabled ? new Date(Date.now() + current.intervalMs).toISOString() : current.nextRunAt,
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(id, next);
    await this.persist();
    return next;
  }

  async remove(id: string): Promise<boolean> {
    const removed = this.jobs.delete(id);
    if (removed) await this.persist();
    return removed;
  }

  private async recoverInterruptedRuns(now = new Date()): Promise<void> {
    const interrupted = [...this.jobs.values()].filter((job) => job.lastStatus === 'running');
    if (interrupted.length === 0) return;
    for (const job of interrupted) {
      this.jobs.set(job.id, ScheduleSchema.parse({
        ...job,
        lastStatus: 'failed',
        lastFinishedAt: now.toISOString(),
        lastError: '上次执行被服务重启中断，已安排补偿重试。',
        consecutiveFailures: job.consecutiveFailures + 1,
        nextRunAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }));
    }
    await this.persist();
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error(`定时任务文件格式错误: ${this.filePath}`);
    for (const row of rows) {
      const parsed = ScheduleSchema.safeParse(row);
      if (parsed.success) this.jobs.set(parsed.data.id, parsed.data);
    }
  }

  private persist(): Promise<void> {
    const payload = JSON.stringify([...this.jobs.values()], null, 2);
    const write = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.tmp`;
      await writeFile(temp, `${payload}\n`, 'utf8');
      await rename(temp, this.filePath);
    };
    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }
}
