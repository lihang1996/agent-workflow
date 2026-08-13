import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { DEFAULT_PIPELINE_STEPS, DELIVERY_SQUAD_STEPS } from './pipeline.js';
import { GateRunSchema, QualityPolicySchema, type GateRun } from './quality-gates.js';

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
  /** 步骤显式 [RESULT:blocked]，等人纠正目录/前置条件后再重跑同一步 */
  'awaiting_step_unblock',
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
  stepIds: z.array(z.enum([
    'pm',
    'architect',
    'dev',
    'review',
    'qa',
    'runtime_audit',
    'final_review',
    'summary',
  ])).min(1).max(20),
  nextStepIndex: z.number().int().min(0),
  priorOutputs: z.record(
    z.string().trim().min(1).max(100),
    z.string().max(500_000),
  ),
  status: WorkflowStatusSchema,
  executionPolicy: z.enum(['standard', 'approved']).default('standard'),
  qualityPolicy: QualityPolicySchema.default('legacy'),
  projectRoot: z.string().trim().min(1).max(4_000).optional(),
  projectFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  gateRuns: z.array(GateRunSchema).max(1_000).default([]),
  /** clean 表示无开放 finding/waiver；conditional 表示带已披露残余风险完成。 */
  completionDisposition: z.enum(['clean', 'conditional']).optional(),
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
  const requiredSteps = workflow.kind === 'squad' ? DELIVERY_SQUAD_STEPS : DEFAULT_PIPELINE_STEPS;
  const legacySquadSteps = ['architect', 'dev', 'review', 'qa'];
  if (workflow.qualityPolicy === 'gated' && !workflow.projectRoot) {
    ctx.addIssue({ code: 'custom', path: ['projectRoot'], message: '门禁工作流必须绑定项目根目录' });
  }
  if (
    workflow.qualityPolicy === 'gated'
    && workflow.stepIds.join(',') !== requiredSteps.map((step) => step.id).join(',')
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['stepIds'],
      message: '门禁工作流必须按规范顺序完整执行，不能裁剪或重排',
    });
  }
  if (
    workflow.kind === 'squad'
    && workflow.qualityPolicy === 'legacy'
    && workflow.stepIds.join(',') !== legacySquadSteps.join(',')
    && workflow.stepIds.join(',') !== DELIVERY_SQUAD_STEPS.map((step) => step.id).join(',')
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['stepIds'],
      message: '内部交付小队必须按规范顺序完整执行',
    });
  }
  if (workflow.nextStepIndex > workflow.stepIds.length) {
    ctx.addIssue({ code: 'custom', path: ['nextStepIndex'], message: '下一步骤索引超出流水线长度' });
  }
  if (workflow.status === 'completed' && workflow.nextStepIndex !== workflow.stepIds.length) {
    ctx.addIssue({ code: 'custom', path: ['nextStepIndex'], message: '已完成工作流必须推进到最后一个步骤之后' });
  }
  const allowedPriorOutputKeys = new Set([
    ...workflow.stepIds,
    'canonical_spec',
    'clarification',
    'previous_spec',
    'confirmation_feedback',
    'review_comment_ids',
    'fingerprint_drift',
    'quality_fix_request',
    'blocked_workdir',
    'test_resource_authorized',
    'dev_environment_autocorrect',
    'runtime_source_changed',
    ...workflow.stepIds.map((stepId) => `blocked_${stepId}`),
  ]);
  for (const key of Object.keys(workflow.priorOutputs)) {
    if (!allowedPriorOutputKeys.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['priorOutputs', key], message: '未知的流水线上下文字段' });
    }
  }
  const runIds = new Set<string>();
  const attempts = new Map<string, number>();
  workflow.gateRuns.forEach((run, index) => {
    if (runIds.has(run.id)) {
      ctx.addIssue({ code: 'custom', path: ['gateRuns', index, 'id'], message: 'GateRun ID 不能重复' });
    }
    runIds.add(run.id);
    if (!workflow.stepIds.includes(run.stepId as WorkflowStepId)) {
      ctx.addIssue({ code: 'custom', path: ['gateRuns', index, 'stepId'], message: 'GateRun 步骤不属于当前工作流' });
    }
    const expectedAttempt = (attempts.get(run.gateId) ?? 0) + 1;
    if (run.attempt !== expectedAttempt) {
      ctx.addIssue({
        code: 'custom',
        path: ['gateRuns', index, 'attempt'],
        message: `GateRun ${run.gateId} 尝试序号必须连续，期望 ${expectedAttempt}`,
      });
    }
    attempts.set(run.gateId, expectedAttempt);
    if (workflow.qualityPolicy === 'gated' && !run.projectFingerprint) {
      ctx.addIssue({ code: 'custom', path: ['gateRuns', index, 'projectFingerprint'], message: '门禁记录必须绑定项目 fingerprint' });
    }
  });
  if (!!workflow.approvalId !== !!workflow.approvalAttempt) {
    ctx.addIssue({ code: 'custom', path: ['approvalId'], message: '审批编号与执行轮次必须同时存在' });
  }
  if (!!workflow.scheduleJobId !== !!workflow.scheduleRunCount) {
    ctx.addIssue({ code: 'custom', path: ['scheduleJobId'], message: '定时任务编号与运行轮次必须同时存在' });
  }
});
export type DeliveryWorkflow = z.infer<typeof DeliveryWorkflowSchema>;
type WorkflowStepId = DeliveryWorkflow['stepIds'][number];

/** 手工重试不能复用已经结算的高风险授权，也不能重放某次定时运行。 */
export function assertManualWorkflowRetryAllowed(
  workflow: Pick<DeliveryWorkflow, 'approvalId' | 'executionPolicy' | 'scheduleJobId'>,
): void {
  if (workflow.approvalId || workflow.executionPolicy === 'approved') {
    throw new Error('该工作流绑定高风险审批，不能用 /workflow retry 复用旧授权；请在审批卡按规则重试，授权过期时重新发起审批。');
  }
  if (workflow.scheduleJobId) {
    throw new Error('该工作流属于定时运行，不能手工重放本轮；请由定时任务的补偿/下一轮机制继续。');
  }
}

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
    // P1 修复：加入 awaiting_questions，使问卷答案已落库但工作流未恢复的状态可自愈。
    return [...this.workflows.values()].filter((workflow) =>
      workflow.status === 'ready' || workflow.status === 'executing' || workflow.status === 'awaiting_questions');
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
    | 'qualityPolicy'
    | 'gateRuns'
    | 'projectFingerprint'
    | 'completionDisposition'
  > & {
    executionPolicy?: DeliveryWorkflow['executionPolicy'];
    qualityPolicy?: DeliveryWorkflow['qualityPolicy'];
    gateRuns?: GateRun[];
    projectFingerprint?: string;
  }): Promise<DeliveryWorkflow> {
    return this.enqueueMutation(async () => {
      const now = new Date().toISOString();
      const workflow = DeliveryWorkflowSchema.parse({
        ...input,
        id: randomUUID(),
        status: 'ready',
        executionPolicy: input.executionPolicy ?? 'standard',
        qualityPolicy: input.qualityPolicy ?? 'legacy',
        gateRuns: input.gateRuns ?? [],
        nextStepIndex: 0,
        priorOutputs: {},
        createdAt: now,
        updatedAt: now,
      });
      const launchKey = workflowLaunchKey(workflow);
      const existing = [...this.workflows.values()].find((candidate) =>
        workflowLaunchKey(candidate) === launchKey);
      if (existing) return existing;
      this.assertNoTechnicalDeliveryConflict(workflow);
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
      this.assertNoTechnicalDeliveryConflict(next);
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
      this.assertNoTechnicalDeliveryConflict(next);
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  /**
   * 从产品确认节点原子取得项目级技术交付租约并切到 ready。
   * beforePersist 用于在同一工作流锁内切换 canonical Spec；外部写入失败时不会推进工作流。
   */
  async activateTechnicalDelivery(
    id: string,
    expected: WorkflowStatus | readonly WorkflowStatus[],
    patch: WorkflowPatch = {},
    beforePersist?: () => Promise<void>,
  ): Promise<DeliveryWorkflow | undefined> {
    return this.enqueueMutation(async () => {
      const current = this.require(id);
      const allowed = Array.isArray(expected) ? expected : [expected];
      if (!allowed.includes(current.status)) return undefined;
      const next = DeliveryWorkflowSchema.parse({
        ...current,
        ...patch,
        status: 'ready',
        updatedAt: new Date().toISOString(),
      });
      this.assertNoTechnicalDeliveryConflict(next);
      await beforePersist?.();
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
      this.assertNoTechnicalDeliveryConflict(next);
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  /**
   * 开发把纯环境运行态缺证误报为 blocked 时，仅允许一次原子纠偏重试。
   * marker 检查、阻塞证据落库和 executing -> ready 在同一个写锁内完成，
   * 因而重复/迟到回调不能启动第二次自动重试。
   */
  async retryCurrentDevEnvironmentBlockOnce(
    id: string,
    stepIndex: number,
    instruction: string,
    blockedAnswer: string,
  ): Promise<DeliveryWorkflow | undefined> {
    return this.enqueueMutation(async () => {
      const current = this.require(id);
      if (
        current.status !== 'executing'
        || current.nextStepIndex !== stepIndex
        || current.stepIds[stepIndex] !== 'dev'
        || current.priorOutputs.dev_environment_autocorrect !== undefined
      ) return undefined;
      const next = DeliveryWorkflowSchema.parse({
        ...current,
        status: 'ready',
        priorOutputs: {
          ...current.priorOutputs,
          blocked_dev: blockedAnswer,
          dev_environment_autocorrect: instruction,
        },
        error: undefined,
        updatedAt: new Date().toISOString(),
      });
      this.assertNoTechnicalDeliveryConflict(next);
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  /**
   * 新进程确认控制器源码与自身基线一致后，原子清理源码漂移阻塞并重跑同一步。
   * 独立方法避免普通环境/目录重试误删该 marker。
   */
  async resumeCurrentRuntimeSourceBlock(
    id: string,
    stepIndex: number,
    stepId: WorkflowStepId,
  ): Promise<DeliveryWorkflow | undefined> {
    return this.enqueueMutation(async () => {
      const current = this.require(id);
      if (
        current.status !== 'awaiting_step_unblock'
        || current.nextStepIndex !== stepIndex
        || current.stepIds[stepIndex] !== stepId
        || current.priorOutputs.runtime_source_changed === undefined
      ) return undefined;
      const priorOutputs = { ...current.priorOutputs };
      delete priorOutputs.runtime_source_changed;
      delete priorOutputs[`blocked_${stepId}`];
      const next = DeliveryWorkflowSchema.parse({
        ...current,
        status: 'ready',
        priorOutputs,
        error: undefined,
        updatedAt: new Date().toISOString(),
      });
      this.assertNoTechnicalDeliveryConflict(next);
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
    options: { gateRun?: GateRun; projectFingerprint?: string } = {},
  ): Promise<DeliveryWorkflow | undefined> {
    return this.enqueueMutation(async () => {
      const current = this.require(id);
      if (
        current.status !== 'executing'
        || current.nextStepIndex !== stepIndex
        || current.stepIds[stepIndex] !== stepId
      ) return undefined;
      const nextPriorOutputs = { ...current.priorOutputs };
      // 一次性开发环境纠偏只属于当前 dev 闭环。成功推进后清掉 marker 与旧阻塞正文，
      // 避免后续 QA 代码修复退回 dev 时读取陈旧提示，并为新一轮 dev 提供独立额度。
      if (stepId === 'dev') {
        delete nextPriorOutputs.dev_environment_autocorrect;
        delete nextPriorOutputs.blocked_dev;
      }
      nextPriorOutputs[stepId] = answer;
      const next = DeliveryWorkflowSchema.parse({
        ...current,
        status: 'ready',
        nextStepIndex: stepIndex + 1,
        priorOutputs: nextPriorOutputs,
        gateRuns: options.gateRun ? [...current.gateRuns, options.gateRun] : current.gateRuns,
        projectFingerprint: options.projectFingerprint ?? current.projectFingerprint,
        error: undefined,
        updatedAt: new Date().toISOString(),
      });
      this.assertNoTechnicalDeliveryConflict(next);
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  /** 保存门禁尝试但不推进步骤；供失败、阻塞和证据链断裂场景审计。 */
  async recordGateAttempt(
    id: string,
    stepIndex: number,
    stepId: WorkflowStepId,
    gateRun: GateRun,
    projectFingerprint?: string,
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
        gateRuns: [...current.gateRuns, gateRun],
        projectFingerprint: projectFingerprint ?? current.projectFingerprint,
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
      this.assertNoExecutingProjectConflict(current);
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

  private assertNoTechnicalDeliveryConflict(candidate: DeliveryWorkflow): void {
    if (!isActiveTechnicalDelivery(candidate)) return;
    const conflict = [...this.workflows.values()].find((workflow) =>
      workflow.id !== candidate.id
      && workflow.projectRoot === candidate.projectRoot
      && isActiveTechnicalDelivery(workflow));
    if (conflict) throw projectConflictError(candidate, conflict);
  }

  private assertNoExecutingProjectConflict(candidate: DeliveryWorkflow): void {
    if (!isActiveTechnicalDelivery(candidate)) return;
    // 旧版本可能已留下多份 ready 记录：允许第一个原子 claim，后续记录看到 executing/blocked
    // 租约后 fail closed；新记录在 create/activate 阶段已经禁止冲突。
    const conflict = [...this.workflows.values()].find((workflow) =>
      workflow.id !== candidate.id
      && workflow.projectRoot === candidate.projectRoot
      && isActiveTechnicalDelivery(workflow)
      && (workflow.status === 'executing' || workflow.status === 'awaiting_step_unblock'));
    if (conflict) throw projectConflictError(candidate, conflict);
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
    try {
      await writeFile(temp, `${payload}\n`, 'utf8');
      await rename(temp, this.filePath);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

function isActiveTechnicalDelivery(workflow: DeliveryWorkflow): boolean {
  if (workflow.qualityPolicy !== 'gated' || !workflow.projectRoot) return false;
  if (workflow.status !== 'ready'
    && workflow.status !== 'executing'
    && workflow.status !== 'awaiting_step_unblock') return false;
  const pmIndex = workflow.stepIds.indexOf('pm');
  return pmIndex < 0 || workflow.nextStepIndex > pmIndex;
}

function projectConflictError(candidate: DeliveryWorkflow, conflict: DeliveryWorkflow): Error {
  return new Error(
    `项目 ${candidate.projectRoot} 已有技术交付工作流 ${conflict.id}（${conflict.status}）占用；`
    + '为避免并发改代码、canonical Spec 切换和证据污染，请先完成或终止该工作流。',
  );
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
