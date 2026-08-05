/**
 * 话题协作轮次持久化，避免进程重启后轮次错乱。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

const CollabRowSchema = z.object({
  topicKey: z.string().min(1),
  round: z.number().int().min(1).max(10),
  updatedAt: z.iso.datetime(),
});

export class JsonCollabStore {
  private readonly rounds = new Map<string, number>();
  private mutationQueue: Promise<void> = Promise.resolve();

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
    return this.enqueueMutation(async () => {
      const parsed = CollabRowSchema.parse({ topicKey, round, updatedAt: new Date().toISOString() });
      const previous = this.rounds.get(topicKey);
      this.rounds.set(topicKey, parsed.round);
      try {
        await this.persist();
      } catch (error) {
        if (this.rounds.get(topicKey) === parsed.round) {
          if (previous !== undefined) this.rounds.set(topicKey, previous);
          else this.rounds.delete(topicKey);
        }
        throw error;
      }
    });
  }

  /** 协作结束时清除该话题轮次。 */
  async clearRound(topicKey: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const previous = this.rounds.get(topicKey);
      if (previous === undefined) return;
      this.rounds.delete(topicKey);
      try {
        await this.persist();
      } catch (error) {
        if (!this.rounds.has(topicKey)) this.rounds.set(topicKey, previous);
        throw error;
      }
    });
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

    let rows: unknown;
    try {
      rows = JSON.parse(content);
    } catch (error) {
      throw new Error(`协作轮次文件不是有效 JSON: ${this.filePath}`, { cause: error });
    }
    if (!Array.isArray(rows)) {
      throw new Error(`协作轮次文件格式错误: ${this.filePath}`);
    }
    for (const [index, row] of rows.entries()) {
      const result = CollabRowSchema.safeParse(row);
      if (!result.success) {
        const issue = result.error.issues[0];
        throw new Error(
          `协作轮次文件第 ${index + 1} 条记录格式错误: ${issue?.path.join('.') || '(根)'} ${issue?.message ?? ''}`.trim(),
        );
      }
      if (this.rounds.has(result.data.topicKey)) {
        throw new Error(`协作轮次文件包含重复话题: ${result.data.topicKey}`);
      }
      this.rounds.set(result.data.topicKey, result.data.round);
    }
  }

  /** 使用唯一临时文件原子落盘；状态变更本身由 mutationQueue 串行化。 */
  private async persist(): Promise<void> {
    const payload = [...this.rounds.entries()].map(([topicKey, round]) => ({
      topicKey,
      round,
      updatedAt: new Date().toISOString(),
    }));
    const snapshot = JSON.stringify(payload, null, 2);
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
