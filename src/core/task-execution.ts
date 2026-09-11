import { z } from 'zod';
import type { CliRunResult } from '../cli/types.js';
import { readJsonState, writeJsonState } from './json-state.js';

const RecordSchema = z.object({
  id: z.string(), sessionId: z.string(), botId: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'interrupted']),
  result: z.object({ answer: z.string(), sessionId: z.string().optional(),
    toolCalls: z.array(z.object({ toolUseId: z.string(), toolName: z.string(), input: z.unknown() })).optional(),
    stats: z.record(z.string(), z.number().optional()).optional(),
  }).optional(),
  error: z.string().optional(),
});
export type TaskExecution = Omit<z.infer<typeof RecordSchema>, 'result'> & { result?: CliRunResult };

/** Completed results are independent of delivery. Interrupted work is never replayed automatically. */
export class TaskExecutionStore {
  private rows = new Map<string, TaskExecution>();
  constructor(private readonly filePath?: string) {
    for (const row of z.array(RecordSchema).parse(readJsonState(filePath) ?? [])) {
      this.rows.set(row.id, row.status === 'running' ? { ...row, status: 'interrupted', error: '执行中断，结果不确定，请检查后继续。' } : row);
    }
  }
  get(id: string): TaskExecution | undefined { return structuredClone(this.rows.get(id)); }
  forSession(sessionId: string): TaskExecution | undefined {
    return [...this.rows.values()].filter((row) => row.sessionId === sessionId).at(-1);
  }
  start(id: string, sessionId: string, botId: string): void {
    this.save({ id, sessionId, botId, status: 'running' });
  }
  complete(id: string, result: CliRunResult): void {
    const row = this.rows.get(id);
    if (!row) throw new Error('任务执行记录不存在');
    this.save({ ...row, status: 'completed', result });
  }
  fail(id: string, error: unknown): void {
    const row = this.rows.get(id);
    if (row) this.save({ ...row, status: 'failed', error: error instanceof Error ? error.message : String(error) });
  }
  private save(row: TaskExecution): void {
    const previous = new Map(this.rows);
    this.rows.set(row.id, structuredClone(row));
    const settled = [...this.rows.values()].filter((r) => r.status === 'completed' || r.status === 'failed');
    for (const old of settled.slice(0, Math.max(0, settled.length - 1000))) this.rows.delete(old.id);
    try { writeJsonState(this.filePath, [...this.rows.values()]); }
    catch (error) { this.rows = previous; throw error; }
  }
}
