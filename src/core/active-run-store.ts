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
  updatedAt: z.iso.datetime(),
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

    let rows: unknown;
    try {
      rows = JSON.parse(content);
    } catch (error) {
      throw new Error(`进行中任务文件不是有效 JSON: ${this.filePath}`, { cause: error });
    }
    if (!Array.isArray(rows)) throw new Error(`进行中任务文件格式错误: ${this.filePath}`);

    const runs: PersistedActiveRun[] = [];
    for (const [index, row] of rows.entries()) {
      const result = ActiveRunSchema.safeParse(row);
      if (!result.success) {
        const issue = result.error.issues[0];
        throw new Error(
          `进行中任务文件第 ${index + 1} 条记录格式错误: ${issue?.path.join('.') || '(根)'} ${issue?.message ?? ''}`.trim(),
        );
      }
      runs.push(result.data);
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
