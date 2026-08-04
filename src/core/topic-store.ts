import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
  private writeQueue: Promise<void> = Promise.resolve();

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
    const project: TopicProject = {
      chatId,
      threadId,
      workdir,
      updatedAt: new Date().toISOString(),
    };
    this.topics.set(topicKey(chatId, threadId), project);
    await this.persist();
    return project;
  }

  /** 清除话题工作目录。 */
  async clearWorkdir(chatId: string, threadId: string): Promise<void> {
    if (!this.topics.delete(topicKey(chatId, threadId))) return;
    await this.persist();
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

    const rows: unknown = JSON.parse(content);
    if (!Array.isArray(rows)) {
      throw new Error(`话题文件格式错误: ${this.filePath}`);
    }

    for (const row of rows) {
      const result = TopicSchema.safeParse(row);
      if (!result.success) continue;
      this.topics.set(topicKey(result.data.chatId, result.data.threadId), result.data);
    }
  }

  /** 串行落盘。 */
  private persist(): Promise<void> {
    const snapshot = JSON.stringify([...this.topics.values()], null, 2);
    const write = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      await writeFile(tempPath, `${snapshot}\n`, 'utf8');
      await rename(tempPath, this.filePath);
    };
    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }
}
