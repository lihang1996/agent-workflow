import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

export interface TopicProject {
  chatId: string;
  threadId: string;
  workdir: string;
  updatedAt: string;
}

export interface TopicStore {
  getWorkdir(chatId: string, threadId: string): string | undefined;
  setWorkdir(chatId: string, threadId: string, workdir: string): Promise<TopicProject>;
  clearWorkdir(chatId: string, threadId: string): Promise<void>;
}

const TopicSchema = z.object({
  chatId: z.string().min(1),
  threadId: z.string().min(1),
  workdir: z.string().min(1),
  updatedAt: z.iso.datetime(),
});

/** 话题唯一键。 */
function topicKey(chatId: string, threadId: string): string {
  return `${chatId}:${threadId}`;
}

/** 话题级项目目录：同一话题下所有 Bot 共享。 */
export class JsonTopicStore implements TopicStore {
  private readonly topics = new Map<string, TopicProject>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /** 打开并加载话题目录表。 */
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

  /** 设置话题工作目录并落盘。 */
  async setWorkdir(chatId: string, threadId: string, workdir: string): Promise<TopicProject> {
    return this.enqueueMutation(async () => {
      const key = topicKey(chatId, threadId);
      const previous = this.topics.get(key);
      const project = TopicSchema.parse({
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

  /** 清除话题工作目录。 */
  async clearWorkdir(chatId: string, threadId: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const key = topicKey(chatId, threadId);
      const previous = this.topics.get(key);
      if (!previous) return;
      this.topics.delete(key);
      try {
        await this.persist();
      } catch (error) {
        if (!this.topics.has(key)) this.topics.set(key, previous);
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
        throw new Error(`话题文件包含重复目录绑定: ${result.data.chatId}/${result.data.threadId}`);
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
