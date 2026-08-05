import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { DELIVERY_SQUAD_STEPS } from './pipeline.js';

const WorkflowMessageSchema = z.object({
  messageId: z.string().trim().min(1).max(200),
  topicId: z.string().trim().min(1).max(200).optional(),
  chatId: z.string().trim().min(1).max(200),
  chatType: z.string().max(50),
  rootId: z.string().max(200),
  threadId: z.string().max(200),
  senderOpenId: z.string().trim().min(1).max(200),
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
  name: z.string().trim().min(1).max(100),
  initiatorBotId: z.string().trim().min(1).max(100),
  goal: z.string().trim().min(1).max(100_000),
  stepIds: z.array(z.enum(['pm', 'architect', 'dev', 'review', 'qa', 'summary'])).min(1).max(20),
  nextStepIndex: z.number().int().min(0),
  priorOutputs: z.record(z.string(), z.string()),
  status: WorkflowStatusSchema,
  executionPolicy: z.enum(['standard', 'approved']).default('standard'),
  message: WorkflowMessageSchema,
  // 兼容升级前的 8 位审批编号；新审批本身使用完整 UUID。
  approvalId: z.string().trim().min(1).max(100).optional(),
  approvalAttempt: z.number().int().min(1).optional(),
  scheduleJobId: z.string().trim().min(1).max(100).optional(),
  scheduleRunCount: z.number().int().min(1).optional(),
  questionnaireId: z.string().trim().min(1).max(100).optional(),
  specId: z.string().trim().min(1).max(100).optional(),
  error: z.string().max(10_000).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).superRefine((workflow, ctx) => {
  if (new Set(workflow.stepIds).size !== workflow.stepIds.length) {
    ctx.addIssue({ code: 'custom', path: ['stepIds'], message: '流水线步骤不能重复' });
  }
  if (
    workflow.kind === 'squad'
    && workflow.stepIds.join(',') !== DELIVERY_SQUAD_STEPS.map((step) => step.id).join(',')
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['stepIds'],
      message: '内部交付小队必须按“架构、开发、评审、QA”完整执行',
    });
  }
  if (workflow.nextStepIndex > workflow.stepIds.length) {
    ctx.addIssue({ code: 'custom', path: ['nextStepIndex'], message: '下一步骤索引超出流水线长度' });
  }
  if (!!workflow.approvalId !== !!workflow.approvalAttempt) {
    ctx.addIssue({ code: 'custom', path: ['approvalId'], message: '审批编号与执行轮次必须同时存在' });
  }
  if (!!workflow.scheduleJobId !== !!workflow.scheduleRunCount) {
    ctx.addIssue({ code: 'custom', path: ['scheduleJobId'], message: '定时任务编号与运行轮次必须同时存在' });
  }
});
export type DeliveryWorkflow = z.infer<typeof DeliveryWorkflowSchema>;
type WorkflowStepId = DeliveryWorkflow['stepIds'][number];

type WorkflowPatch = Partial<Omit<DeliveryWorkflow, 'id' | 'createdAt'>>;

export class JsonWorkflowStore {
  private readonly workflows = new Map<string, DeliveryWorkflow>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  static async open(filePath: string): Promise<JsonWorkflowStore> {
    const store = new JsonWorkflowStore(filePath);
    await store.load();
    return store;
  }

  get(id: string): DeliveryWorkflow | undefined {
    return this.workflows.get(id);
  }

  findByApproval(approvalId: string, approvalAttempt: number): DeliveryWorkflow | undefined {
    return [...this.workflows.values()].find((workflow) =>
      workflow.approvalId === approvalId && workflow.approvalAttempt === approvalAttempt);
  }

  findBySchedule(scheduleJobId: string, scheduleRunCount: number): DeliveryWorkflow | undefined {
    return [...this.workflows.values()].find((workflow) =>
      workflow.scheduleJobId === scheduleJobId && workflow.scheduleRunCount === scheduleRunCount);
  }

  list(): DeliveryWorkflow[] {
    return [...this.workflows.values()];
  }

  listRecoverable(): DeliveryWorkflow[] {
    return [...this.workflows.values()].filter((workflow) =>
      workflow.status === 'ready' || workflow.status === 'executing');
  }

  async create(input: Omit<
    DeliveryWorkflow,
    | 'id'
    | 'status'
    | 'nextStepIndex'
    | 'priorOutputs'
    | 'createdAt'
    | 'updatedAt'
    | 'executionPolicy'
  > & { executionPolicy?: DeliveryWorkflow['executionPolicy'] }): Promise<DeliveryWorkflow> {
    return this.enqueueMutation(async () => {
      const now = new Date().toISOString();
      const workflow = DeliveryWorkflowSchema.parse({
        ...input,
        id: randomUUID(),
        status: 'ready',
        executionPolicy: input.executionPolicy ?? 'standard',
        nextStepIndex: 0,
        priorOutputs: {},
        createdAt: now,
        updatedAt: now,
      });
      const launchKey = workflowLaunchKey(workflow);
      const existing = [...this.workflows.values()].find((candidate) =>
        workflowLaunchKey(candidate) === launchKey);
      if (existing) return existing;
      await this.replaceAndPersist(workflow.id, workflow);
      return workflow;
    });
  }

  async update(id: string, patch: WorkflowPatch): Promise<DeliveryWorkflow> {
    return this.enqueueMutation(async () => {
      const current = this.require(id);
      const next = DeliveryWorkflowSchema.parse({
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      });
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  /** 仅当状态仍符合预期时更新，避免确认、评审和异步回调互相覆盖。 */
  async updateIfStatus(
    id: string,
    expected: WorkflowStatus | readonly WorkflowStatus[],
    patch: WorkflowPatch,
  ): Promise<DeliveryWorkflow | undefined> {
    return this.enqueueMutation(async () => {
      const current = this.require(id);
      const allowed = Array.isArray(expected) ? expected : [expected];
      if (!allowed.includes(current.status)) return undefined;
      const next = DeliveryWorkflowSchema.parse({
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      });
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  /** 仅当前执行步骤仍匹配时切换状态，隔离迟到的 CLI/协作回调。 */
  async updateIfCurrentStep(
    id: string,
    stepIndex: number,
    stepId: WorkflowStepId,
    patch: WorkflowPatch,
  ): Promise<DeliveryWorkflow | undefined> {
    return this.enqueueMutation(async () => {
      const current = this.require(id);
      if (
        current.status !== 'executing'
        || current.nextStepIndex !== stepIndex
        || current.stepIds[stepIndex] !== stepId
      ) return undefined;
      const next = DeliveryWorkflowSchema.parse({
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      });
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  /** 原子记录当前步骤产出并推进一次，重复成功回调不会跨过后续步骤。 */
  async completeCurrentStep(
    id: string,
    stepIndex: number,
    stepId: WorkflowStepId,
    answer: string,
  ): Promise<DeliveryWorkflow | undefined> {
    return this.enqueueMutation(async () => {
      const current = this.require(id);
      if (
        current.status !== 'executing'
        || current.nextStepIndex !== stepIndex
        || current.stepIds[stepIndex] !== stepId
      ) return undefined;
      const next = DeliveryWorkflowSchema.parse({
        ...current,
        status: 'ready',
        nextStepIndex: stepIndex + 1,
        priorOutputs: { ...current.priorOutputs, [stepId]: answer },
        error: undefined,
        updatedAt: new Date().toISOString(),
      });
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  /** 原子认领一个 ready 工作流，避免按钮重放/异步回调并发启动同一步骤。 */
  async claimReady(id: string): Promise<DeliveryWorkflow | undefined> {
    return this.enqueueMutation(async () => {
      const current = this.require(id);
      if (current.status !== 'ready') return undefined;
      const next = DeliveryWorkflowSchema.parse({
        ...current,
        status: 'executing',
        error: undefined,
        updatedAt: new Date().toISOString(),
      });
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  private require(id: string): DeliveryWorkflow {
    const workflow = this.workflows.get(id);
    if (!workflow) throw new Error(`工作流不存在: ${id}`);
    return workflow;
  }

  private async replaceAndPersist(id: string, next: DeliveryWorkflow): Promise<void> {
    const previous = this.workflows.get(id);
    this.workflows.set(id, next);
    try {
      await this.persist();
    } catch (error) {
      if (previous) this.workflows.set(id, previous);
      else this.workflows.delete(id);
      throw error;
    }
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let rows: unknown;
    try {
      rows = JSON.parse(raw);
    } catch (error) {
      throw new Error(`工作流文件不是有效 JSON: ${this.filePath}`, { cause: error });
    }
    if (!Array.isArray(rows)) throw new Error(`工作流文件格式错误: ${this.filePath}`);
    const launchKeys = new Set<string>();
    for (const [index, row] of rows.entries()) {
      const parsed = DeliveryWorkflowSchema.safeParse(row);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(
          `工作流文件第 ${index + 1} 条记录格式错误: ${issue?.path.join('.') || '(根)'} ${issue?.message ?? ''}`.trim(),
        );
      }
      if (this.workflows.has(parsed.data.id)) throw new Error(`工作流文件包含重复 ID: ${parsed.data.id}`);
      const launchKey = workflowLaunchKey(parsed.data);
      if (launchKeys.has(launchKey)) throw new Error(`工作流文件包含重复启动记录: ${launchKey}`);
      launchKeys.add(launchKey);
      this.workflows.set(parsed.data.id, parsed.data);
    }
  }

  private async persist(): Promise<void> {
    const payload = JSON.stringify([...this.workflows.values()], null, 2);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${payload}\n`, 'utf8');
    await rename(temp, this.filePath);
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

function workflowLaunchKey(workflow: {
  kind: DeliveryWorkflow['kind'];
  initiatorBotId: string;
  message: DeliveryWorkflow['message'];
  approvalId?: string;
  approvalAttempt?: number;
  scheduleJobId?: string;
  scheduleRunCount?: number;
}): string {
  if (workflow.approvalId && workflow.approvalAttempt) {
    return JSON.stringify(['approval', workflow.approvalId, workflow.approvalAttempt]);
  }
  if (workflow.scheduleJobId && workflow.scheduleRunCount) {
    return JSON.stringify(['schedule', workflow.scheduleJobId, workflow.scheduleRunCount]);
  }
  return JSON.stringify([
    'message',
    workflow.message.chatId,
    workflow.message.messageId,
    workflow.initiatorBotId,
    workflow.kind,
  ]);
}
