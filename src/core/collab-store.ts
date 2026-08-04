/**
 * 话题协作轮次持久化，避免进程重启后轮次错乱。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

const CollabRowSchema = z.object({
  topicKey: z.string().min(1),
  round: z.number().int().min(1).max(10),
  updatedAt: z.string().min(1),
});

export class JsonCollabStore {
  private readonly rounds = new Map<string, number>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /** 打开并加载已有轮次。 */
  static async open(filePath: string): Promise<JsonCollabStore> {
    const store = new JsonCollabStore(filePath);
    await store.load();
    return store;
  }

  get size(): number {
    return this.rounds.size;
  }

  /** 读取话题当前协作轮次。 */
  getRound(topicKey: string): number | undefined {
    return this.rounds.get(topicKey);
  }

  /** 写入/更新话题协作轮次。 */
  async setRound(topicKey: string, round: number): Promise<void> {
    this.rounds.set(topicKey, round);
    await this.persist();
  }

  /** 协作结束时清除该话题轮次。 */
  async clearRound(topicKey: string): Promise<void> {
    if (!this.rounds.delete(topicKey)) return;
    await this.persist();
  }

  /** 从磁盘恢复轮次表。 */
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
      throw new Error(`协作轮次文件格式错误: ${this.filePath}`);
    }
    for (const row of rows) {
      const result = CollabRowSchema.safeParse(row);
      if (!result.success) continue;
      this.rounds.set(result.data.topicKey, result.data.round);
    }
  }

  /** 串行落盘。 */
  private persist(): Promise<void> {
    const payload = [...this.rounds.entries()].map(([topicKey, round]) => ({
      topicKey,
      round,
      updatedAt: new Date().toISOString(),
    }));
    const snapshot = JSON.stringify(payload, null, 2);
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
