import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { CliId } from '../cli/types.js';

export interface TopicSettings {
  chatId: string;
  threadId: string;
  workdir?: string;
  cliId?: CliId;
  updatedAt: string;
}

export interface TopicStore {
  getWorkdir(chatId: string, threadId: string): string | undefined;
  setWorkdir(chatId: string, threadId: string, workdir: string): Promise<TopicSettings>;
  clearWorkdir(chatId: string, threadId: string): Promise<void>;
  getCliId(chatId: string, threadId: string): CliId | undefined;
  setCliId(chatId: string, threadId: string, cliId: CliId): Promise<TopicSettings>;
}

const TopicSchema = z.object({
  chatId: z.string().min(1),
  threadId: z.string().min(1),
  workdir: z.string().min(1).optional(),
  cliId: z.enum(['claude', 'codex']).optional(),
  updatedAt: z.iso.datetime(),
}).refine((topic) => !!topic.workdir || !!topic.cliId, {
  message: '话题设置必须至少包含 workdir 或 cliId',
});

/** 话题唯一键。 */
function topicKey(chatId: string, threadId: string): string {
  return `${chatId}:${threadId}`;
}

/** 话题级共享设置：同一话题下所有 Bot 共用项目目录与执行引擎。 */
export class JsonTopicStore implements TopicStore {
  private readonly topics = new Map<string, TopicSettings>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /** 打开并加载话题设置表。 */
  static async open(filePath: string): Promise<JsonTopicStore> {
    const store = new JsonTopicStore(filePath);
    await store.load();
    return store;
  }

  get size(): number {
    return this.topics.size;
  }

  /** 读取话题绑定的工作目录。 */
  getWorkdir(chatId: string, threadId: string): string | undefined {
    return this.topics.get(topicKey(chatId, threadId))?.workdir;
  }

  /** 读取话题统一执行引擎。 */
  getCliId(chatId: string, threadId: string): CliId | undefined {
    return this.topics.get(topicKey(chatId, threadId))?.cliId;
  }

  /** 设置话题工作目录并落盘。 */
  async setWorkdir(chatId: string, threadId: string, workdir: string): Promise<TopicSettings> {
    return this.enqueueMutation(async () => {
      const key = topicKey(chatId, threadId);
      const previous = this.topics.get(key);
      const project = TopicSchema.parse({
        ...previous,
        chatId,
        threadId,
        workdir,
        updatedAt: new Date().toISOString(),
      });
      this.topics.set(key, project);
      try {
        await this.persist();
      } catch (error) {
        if (this.topics.get(key) === project) {
          if (previous) this.topics.set(key, previous);
          else this.topics.delete(key);
        }
        throw error;
      }
      return project;
    });
  }

  /** 设置话题统一执行引擎，并保留已经绑定的项目目录。 */
  async setCliId(chatId: string, threadId: string, cliId: CliId): Promise<TopicSettings> {
    return this.enqueueMutation(async () => {
      const key = topicKey(chatId, threadId);
      const previous = this.topics.get(key);
      const settings = TopicSchema.parse({
        ...previous,
        chatId,
        threadId,
        cliId,
        updatedAt: new Date().toISOString(),
      });
      this.topics.set(key, settings);
      try {
        await this.persist();
      } catch (error) {
        if (this.topics.get(key) === settings) {
          if (previous) this.topics.set(key, previous);
          else this.topics.delete(key);
        }
        throw error;
      }
      return settings;
    });
  }

  /** 清除话题工作目录。 */
  async clearWorkdir(chatId: string, threadId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const key = topicKey(chatId, threadId);
      const previous = this.topics.get(key);
      if (!previous?.workdir) return;
      const next = previous.cliId
        ? TopicSchema.parse({
          ...previous,
          workdir: undefined,
          updatedAt: new Date().toISOString(),
        })
        : undefined;
      if (next) this.topics.set(key, next);
      else this.topics.delete(key);
      try {
        await this.persist();
      } catch (error) {
        if (next ? this.topics.get(key) === next : !this.topics.has(key)) {
          this.topics.set(key, previous);
        }
        throw error;
      }
    });
  }

  /** 从磁盘恢复。 */
  private async load(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    let rows: unknown;
    try {
      rows = JSON.parse(content);
    } catch (error) {
      throw new Error(`话题文件不是有效 JSON: ${this.filePath}`, { cause: error });
    }
    if (!Array.isArray(rows)) {
      throw new Error(`话题文件格式错误: ${this.filePath}`);
    }

    for (const [index, row] of rows.entries()) {
      const result = TopicSchema.safeParse(row);
      if (!result.success) {
        const issue = result.error.issues[0];
        throw new Error(
          `话题文件第 ${index + 1} 条记录格式错误: ${issue?.path.join('.') || '(根)'} ${issue?.message ?? ''}`.trim(),
        );
      }
      const key = topicKey(result.data.chatId, result.data.threadId);
      if (this.topics.has(key)) {
        throw new Error(`话题文件包含重复设置: ${result.data.chatId}/${result.data.threadId}`);
      }
      this.topics.set(key, result.data);
    }
  }

  /** 串行落盘。 */
  private async persist(): Promise<void> {
    const snapshot = JSON.stringify([...this.topics.values()], null, 2);
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, `${snapshot}\n`, 'utf8');
      await rename(tempPath, this.filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}
