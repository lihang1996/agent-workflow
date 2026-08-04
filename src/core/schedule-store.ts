import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { StoredMessage } from './approval-store.js';

export const ScheduleKindSchema = z.enum(['task', 'pipeline', 'log_inspection']);
export type ScheduleKind = z.infer<typeof ScheduleKindSchema>;

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
  nextRunAt: z.string().min(1),
  lastRunAt: z.string().optional(),
  enabled: z.boolean(),
  message: StoredMessageSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
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

export class JsonScheduleStore {
  private readonly jobs = new Map<string, ScheduledJob>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  static async open(filePath: string): Promise<JsonScheduleStore> {
    const store = new JsonScheduleStore(filePath);
    await store.load();
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
    return [...this.jobs.values()].filter((job) => job.enabled && job.nextRunAt <= nowIso);
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
      id: randomUUID().slice(0, 8),
      nextRunAt: new Date(now.getTime() + input.intervalMs).toISOString(),
      enabled: true,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.jobs.set(job.id, job);
    await this.persist();
    return job;
  }

  async markRun(id: string, now = new Date()): Promise<ScheduledJob> {
    const current = this.get(id);
    if (!current) throw new Error(`定时任务不存在: ${id}`);
    const next: ScheduledJob = {
      ...current,
      lastRunAt: now.toISOString(),
      nextRunAt: new Date(now.getTime() + current.intervalMs).toISOString(),
      updatedAt: now.toISOString(),
    };
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
