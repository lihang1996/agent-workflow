/**
 * 进行中任务卡片快照：进程被热重启 / 强杀后，下次启动可把飞书卡片收成「已中断」。
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

const ActiveRunSchema = z.object({
  sessionId: z.string().min(1),
  botId: z.string().min(1),
  cardId: z.string().min(1),
  cardTitle: z.string().min(1),
  progress: z.number().min(0).max(100),
  detail: z.string(),
  activities: z.array(z.string()).default([]),
  updatedAt: z.string().min(1),
});

export type PersistedActiveRun = z.infer<typeof ActiveRunSchema>;

export class JsonActiveRunStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /** 读取上次未收尾的任务卡片。 */
  async load(): Promise<PersistedActiveRun[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const rows: unknown = JSON.parse(content);
    if (!Array.isArray(rows)) return [];

    const runs: PersistedActiveRun[] = [];
    for (const row of rows) {
      const result = ActiveRunSchema.safeParse(row);
      if (result.success) runs.push(result.data);
    }
    return runs;
  }

  /** 串行写入当前进行中任务快照。 */
  save(runs: PersistedActiveRun[]): Promise<void> {
    const snapshot = JSON.stringify(runs, null, 2);
    const write = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.tmp`;
      await writeFile(tempPath, `${snapshot}\n`, 'utf8');
      await rename(tempPath, this.filePath);
    };
    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }

  /** 清空快照文件（无进行中任务时）。 */
  async clear(): Promise<void> {
    await this.save([]);
    try {
      await unlink(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
