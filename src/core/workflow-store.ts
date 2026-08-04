import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

const WorkflowMessageSchema = z.object({
  messageId: z.string().min(1),
  chatId: z.string().min(1),
  chatType: z.string(),
  rootId: z.string(),
  threadId: z.string(),
  senderOpenId: z.string().min(1),
});

export const WorkflowStatusSchema = z.enum([
  'ready',
  'executing',
  'awaiting_questions',
  'awaiting_spec_confirmation',
  'awaiting_doc_review',
  'completed',
  'failed',
]);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

export const DeliveryWorkflowSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['team', 'squad']),
  name: z.string().min(1),
  initiatorBotId: z.string().min(1),
  goal: z.string().min(1),
  stepIds: z.array(z.enum(['pm', 'architect', 'dev', 'review', 'qa', 'summary'])).min(1),
  nextStepIndex: z.number().int().min(0),
  priorOutputs: z.record(z.string(), z.string()),
  status: WorkflowStatusSchema,
  message: WorkflowMessageSchema,
  questionnaireId: z.string().optional(),
  specId: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type DeliveryWorkflow = z.infer<typeof DeliveryWorkflowSchema>;

export class JsonWorkflowStore {
  private readonly workflows = new Map<string, DeliveryWorkflow>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  static async open(filePath: string): Promise<JsonWorkflowStore> {
    const store = new JsonWorkflowStore(filePath);
    await store.load();
    return store;
  }

  get(id: string): DeliveryWorkflow | undefined {
    return this.workflows.get(id);
  }

  listRecoverable(): DeliveryWorkflow[] {
    return [...this.workflows.values()].filter((workflow) =>
      workflow.status === 'ready' || workflow.status === 'executing');
  }

  async create(input: Omit<DeliveryWorkflow, 'id' | 'status' | 'nextStepIndex' | 'priorOutputs' | 'createdAt' | 'updatedAt'>): Promise<DeliveryWorkflow> {
    const now = new Date().toISOString();
    const workflow: DeliveryWorkflow = {
      ...input,
      id: randomUUID(),
      status: 'ready',
      nextStepIndex: 0,
      priorOutputs: {},
      createdAt: now,
      updatedAt: now,
    };
    this.workflows.set(workflow.id, workflow);
    await this.persist();
    return workflow;
  }

  async update(
    id: string,
    patch: Partial<Omit<DeliveryWorkflow, 'id' | 'createdAt'>>,
  ): Promise<DeliveryWorkflow> {
    const current = this.get(id);
    if (!current) throw new Error(`工作流不存在: ${id}`);
    const next = DeliveryWorkflowSchema.parse({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    this.workflows.set(id, next);
    await this.persist();
    return next;
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
    if (!Array.isArray(rows)) throw new Error(`工作流文件格式错误: ${this.filePath}`);
    for (const row of rows) {
      const parsed = DeliveryWorkflowSchema.safeParse(row);
      if (parsed.success) this.workflows.set(parsed.data.id, parsed.data);
    }
  }

  private persist(): Promise<void> {
    const payload = JSON.stringify([...this.workflows.values()], null, 2);
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
