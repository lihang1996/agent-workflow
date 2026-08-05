/**
 * 进行中任务卡片快照：进程被热重启 / 强杀后，下次启动可把飞书卡片收成「已中断」。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

const ActiveRunSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  botId: z.string().trim().min(1).max(100),
  cardId: z.string().trim().min(1).max(200),
  cardTitle: z.string().trim().min(1).max(200),
  progress: z.number().min(0).max(100),
  detail: z.string().max(2_000),
  activities: z.array(z.string().max(500)).max(20).default([]),
  updatedAt: z.iso.datetime(),
});

export type PersistedActiveRun = z.infer<typeof ActiveRunSchema>;

export class JsonActiveRunStore {
  private operationQueue: Promise<void> = Promise.resolve();

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
    const sessionIds = new Set<string>();
    const cardIds = new Set<string>();
    for (const [index, row] of rows.entries()) {
      const result = ActiveRunSchema.safeParse(row);
      if (!result.success) {
        const issue = result.error.issues[0];
        throw new Error(
          `进行中任务文件第 ${index + 1} 条记录格式错误: ${issue?.path.join('.') || '(根)'} ${issue?.message ?? ''}`.trim(),
        );
      }
      if (sessionIds.has(result.data.sessionId)) {
        throw new Error(`进行中任务文件包含重复会话: ${result.data.sessionId}`);
      }
      if (cardIds.has(result.data.cardId)) {
        throw new Error(`进行中任务文件包含重复卡片: ${result.data.cardId}`);
      }
      sessionIds.add(result.data.sessionId);
      cardIds.add(result.data.cardId);
      runs.push(result.data);
    }
    return runs;
  }

  /** 串行写入当前进行中任务快照。 */
  save(runs: PersistedActiveRun[]): Promise<void> {
    const parsed = runs.map((run) => ActiveRunSchema.parse(run));
    assertUniqueRuns(parsed);
    const snapshot = JSON.stringify(parsed, null, 2);
    const write = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(tempPath, `${snapshot}\n`, 'utf8');
        await rename(tempPath, this.filePath);
      } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        throw error;
      }
    };
    return this.enqueueOperation(write);
  }

  /** 清空快照文件（无进行中任务时）。 */
  clear(): Promise<void> {
    return this.enqueueOperation(async () => {
      try {
        await unlink(this.filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
  }

  private enqueueOperation(operation: () => Promise<void>): Promise<void> {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

function assertUniqueRuns(runs: PersistedActiveRun[]): void {
  const sessionIds = new Set<string>();
  const cardIds = new Set<string>();
  for (const run of runs) {
    if (sessionIds.has(run.sessionId)) throw new Error(`进行中任务包含重复会话: ${run.sessionId}`);
    if (cardIds.has(run.cardId)) throw new Error(`进行中任务包含重复卡片: ${run.cardId}`);
    sessionIds.add(run.sessionId);
    cardIds.add(run.cardId);
  }
}
