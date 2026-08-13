import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { redactSecrets } from './log-inspection.js';

const StoredMessageSchema = z.object({
  messageId: z.string().trim().min(1).max(200),
  topicId: z.string().trim().min(1).max(200).optional(),
  chatId: z.string().trim().min(1).max(200),
  chatType: z.string().max(50),
  rootId: z.string().max(200),
  threadId: z.string().max(200),
  senderOpenId: z.string().trim().min(1).max(200),
});
export type StoredMessage = z.infer<typeof StoredMessageSchema>;

const TimestampSchema = z.string().min(1).refine(
  (value) => Number.isFinite(Date.parse(value)),
  '时间格式无效',
);

export const ApprovalSchema = z.object({
  id: z.string().trim().min(1).max(100),
  botId: z.string().trim().min(1).max(100),
  ownerOpenId: z.string().trim().min(1).max(200),
  action: z.enum(['task', 'pipeline', 'squad', 'review']),
  prompt: z.string().trim().min(1).max(100_000),
  reason: z.string().trim().min(1).max(2_000),
  message: StoredMessageSchema,
  status: z.enum([
    'pending',
    'approved',
    'rejected',
    'executing',
    'succeeded',
    'failed',
    'expired',
  ]),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema.optional(),
  decidedAt: TimestampSchema.optional(),
  decidedBy: z.string().trim().min(1).max(200).optional(),
  cardMessageId: z.string().trim().min(1).max(200).optional(),
  workflowId: z.string().uuid().optional(),
  scheduleJobId: z.string().trim().min(1).max(100).optional(),
  scheduleRunCount: z.number().int().min(1).optional(),
  executionAttempt: z.number().int().min(0).default(0),
  executionStartedAt: TimestampSchema.optional(),
  executionFinishedAt: TimestampSchema.optional(),
  executionError: z.string().max(2_000).optional(),
}).superRefine((approval, ctx) => {
  if (!!approval.scheduleJobId !== !!approval.scheduleRunCount) {
    ctx.addIssue({ code: 'custom', path: ['scheduleJobId'], message: '定时任务编号与运行轮次必须同时存在' });
  }
  if (approval.workflowId && approval.action !== 'pipeline' && approval.action !== 'squad') {
    ctx.addIssue({ code: 'custom', path: ['workflowId'], message: '只有团队工作流审批可以关联工作流' });
  }
  if (approval.status === 'pending' && approval.executionAttempt !== 0) {
    ctx.addIssue({ code: 'custom', path: ['executionAttempt'], message: '待审批记录不能包含执行轮次' });
  }
  if (approval.status === 'executing') {
    if (approval.executionAttempt < 1 || !approval.executionStartedAt) {
      ctx.addIssue({ code: 'custom', path: ['executionStartedAt'], message: '执行中审批必须包含有效执行轮次和开始时间' });
    }
    if (!approval.decidedAt || !approval.decidedBy) {
      ctx.addIssue({ code: 'custom', path: ['decidedAt'], message: '执行中审批必须包含审批人和审批时间' });
    }
  }
  if (approval.status === 'succeeded' || approval.status === 'failed') {
    if (approval.executionAttempt < 1 || !approval.executionFinishedAt) {
      ctx.addIssue({ code: 'custom', path: ['executionFinishedAt'], message: '执行终态必须包含执行轮次和完成时间' });
    }
  }
  if (approval.status === 'rejected' && (!approval.decidedAt || !approval.decidedBy)) {
    ctx.addIssue({ code: 'custom', path: ['decidedAt'], message: '拒绝记录必须包含审批人和审批时间' });
  }
});
export type ApprovalRequest = z.infer<typeof ApprovalSchema>;

export type ApprovalExecutionOutcome = 'succeeded' | 'failed';
export type ApprovalWorkflowState = 'running' | ApprovalExecutionOutcome;
export type ApprovalOwnerMatcher = (ownerOpenId: string, operatorOpenId: string) => boolean;

const DEFAULT_APPROVAL_TTL_MS = 30 * 60 * 1_000;

export interface ApprovalStoreOptions {
  now?: () => Date;
  ttlMs?: number;
}

export type ApprovalCreateInput = Pick<
  ApprovalRequest,
  'botId' | 'ownerOpenId' | 'action' | 'prompt' | 'reason' | 'message'
> & Partial<Pick<ApprovalRequest, 'scheduleJobId' | 'scheduleRunCount'>>;

/** 审批默认 30 分钟失效，避免旧卡在很久以后仍可放行。 */
export function parseApprovalTtlMs(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_APPROVAL_TTL_MS;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) {
    console.warn(`[配置] APPROVAL_TTL_MINUTES=${value} 非法，回退到 30 分钟`);
    return DEFAULT_APPROVAL_TTL_MS;
  }
  return Math.round(minutes * 60_000);
}

export class JsonApprovalStore {
  private readonly approvals = new Map<string, ApprovalRequest>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(private readonly filePath: string, options: ApprovalStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? parseApprovalTtlMs(process.env.APPROVAL_TTL_MINUTES);
  }

  static async open(filePath: string, options: ApprovalStoreOptions = {}): Promise<JsonApprovalStore> {
    const store = new JsonApprovalStore(filePath, options);
    await store.load();
    return store;
  }

  get(id: string): ApprovalRequest | undefined {
    return this.approvals.get(id);
  }

  list(): ApprovalRequest[] {
    return [...this.approvals.values()];
  }

  async create(input: ApprovalCreateInput): Promise<ApprovalRequest> {
    return this.enqueueMutation(async () => {
      const duplicate = this.findDuplicate(input);
      if (duplicate) return duplicate;
      const now = this.now();
      const approval = ApprovalSchema.parse({
        ...input,
        id: randomUUID(),
        status: 'pending',
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
        executionAttempt: 0,
      });
      await this.replaceAndPersist(approval.id, approval);
      return approval;
    });
  }

  /** 记录飞书审批卡 message_id，供异步执行结果回写原卡。 */
  async setCardMessageId(id: string, cardMessageId: string): Promise<ApprovalRequest> {
    return this.enqueueMutation(async () => {
      const normalized = cardMessageId.trim();
      if (!normalized) throw new Error('审批卡 message_id 不能为空');
      const current = this.require(id);
      if (current.cardMessageId === normalized) return current;
      if (current.cardMessageId) throw new Error('审批卡已经绑定，不能改绑到其它消息。');
      if (current.status !== 'pending') throw new Error(`审批当前状态为 ${current.status}，不能再绑定卡片。`);
      const next = ApprovalSchema.parse({ ...current, cardMessageId: normalized });
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  /** 拒绝待审批任务；负责人校验与状态切换在同一个临界区完成。 */
  async reject(
    id: string,
    decidedBy: string,
    ownerMatches?: ApprovalOwnerMatcher,
  ): Promise<ApprovalRequest> {
    return this.enqueueMutation(async () => {
      const current = this.requireOwner(id, decidedBy, ownerMatches);
      if (await this.expireCurrentIfNeeded(current)) throw new Error('审批已过期，请重新发起。');
      if (current.status !== 'pending') throw new Error(`审批已处理：${current.status}`);
      const now = this.now().toISOString();
      const next = ApprovalSchema.parse({
        ...current,
        status: 'rejected',
        decidedAt: now,
        decidedBy,
        executionFinishedAt: now,
      });
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  /**
   * 首次批准或失败重试都会原子进入 executing。
   * executionAttempt 用于阻止上一轮异步回调覆盖新一轮结果。
   */
  async beginExecution(
    id: string,
    decidedBy: string,
    ownerMatches?: ApprovalOwnerMatcher,
  ): Promise<ApprovalRequest> {
    return this.enqueueMutation(async () => {
      const current = this.requireOwner(id, decidedBy, ownerMatches);
      if (await this.expireCurrentIfNeeded(current)) throw new Error('审批已过期，请重新发起。');
      if (!current.cardMessageId) throw new Error('审批卡绑定缺失，请重新发起审批。');
      if (current.status !== 'pending' && current.status !== 'approved' && current.status !== 'failed') {
        throw new Error(`审批当前状态为 ${current.status}，不能重复执行。`);
      }
      const now = this.now().toISOString();
      const next = ApprovalSchema.parse({
        ...current,
        status: 'executing',
        decidedAt: current.decidedAt ?? now,
        decidedBy: current.decidedBy ?? decidedBy,
        executionAttempt: current.executionAttempt + 1,
        executionStartedAt: now,
        executionFinishedAt: undefined,
        executionError: undefined,
        workflowId: undefined,
      });
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  async attachWorkflow(
    id: string,
    executionAttempt: number,
    workflowId: string,
  ): Promise<ApprovalRequest> {
    return this.enqueueMutation(async () => {
      const current = this.require(id);
      if (current.status !== 'executing' || current.executionAttempt !== executionAttempt) {
        throw new Error(`审批 ${id} 已不属于当前执行轮次。`);
      }
      if (current.workflowId === workflowId) return current;
      if (current.workflowId) throw new Error(`审批 ${id} 已关联其它工作流。`);
      const next = ApprovalSchema.parse({ ...current, workflowId });
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  async finishExecution(
    id: string,
    executionAttempt: number,
    outcome: ApprovalExecutionOutcome,
    error?: string,
  ): Promise<ApprovalRequest> {
    return this.enqueueMutation(async () => {
      const current = this.require(id);
      // 旧轮次回调或已经落盘的终态直接忽略，保证完成操作幂等。
      if (current.executionAttempt !== executionAttempt || current.status !== 'executing') return current;
      const next = ApprovalSchema.parse({
        ...current,
        status: outcome,
        executionFinishedAt: this.now().toISOString(),
        executionError: outcome === 'failed' ? sanitizeApprovalError(error) : undefined,
      });
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  /** 审批卡发送失败时保留审计记录，但确保这条记录永远不能被批准。 */
  async expire(id: string, reason = '审批已失效'): Promise<ApprovalRequest> {
    return this.enqueueMutation(async () => {
      const current = this.require(id);
      if (!this.isAuthorizationOpen(current)) return current;
      return this.expireCurrent(current, reason);
    });
  }

  async expireStale(reason = '审批等待超时'): Promise<ApprovalRequest[]> {
    return this.enqueueMutation(async () => {
      const changed = [...this.approvals.values()]
        .filter((current) => this.isAuthorizationOpen(current) && this.isExpired(current))
        .map((current) => this.expiredRecord(current, reason));
      if (changed.length === 0) return [];
      await this.replaceManyAndPersist(changed);
      return changed;
    });
  }

  /**
   * 服务重启后：持久化工作流继续保持执行态；普通 CLI/评审则转失败，允许负责人重试。
   */
  async reconcileInterrupted(
    workflowState: (workflowId: string) => ApprovalWorkflowState | undefined,
  ): Promise<ApprovalRequest[]> {
    return this.enqueueMutation(async () => {
      const changed: ApprovalRequest[] = [];
      for (const current of this.approvals.values()) {
        if (this.isAuthorizationOpen(current) && !current.cardMessageId) {
          changed.push(this.expiredRecord(current, '审批卡绑定缺失，审批已失效。'));
          continue;
        }
        if (this.isAuthorizationOpen(current) && this.isExpired(current)) {
          changed.push(this.expiredRecord(current, '审批等待超时'));
          continue;
        }
        if (current.status === 'approved') {
          changed.push(ApprovalSchema.parse({
            ...current,
            status: 'failed',
            executionAttempt: Math.max(1, current.executionAttempt),
            executionStartedAt: current.executionStartedAt ?? current.decidedAt ?? current.createdAt,
            executionFinishedAt: this.now().toISOString(),
            executionError: '服务升级前的执行状态不完整，请确认后重试。',
          }));
          continue;
        }
        if (current.status !== 'executing') continue;
        const state = current.workflowId ? workflowState(current.workflowId) : undefined;
        if (state === 'running') continue;
        changed.push(ApprovalSchema.parse({
          ...current,
          status: state === 'succeeded' ? 'succeeded' : 'failed',
          executionFinishedAt: this.now().toISOString(),
          executionError: state === 'succeeded'
            ? undefined
            : state === 'failed'
              ? '关联工作流执行失败，请查看工作流消息后重试。'
              : '上次执行被服务重启中断，请确认后重试。',
        }));
      }
      if (changed.length > 0) await this.replaceManyAndPersist(changed);
      return changed;
    });
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
      throw new Error(`审批文件不是有效 JSON: ${this.filePath}`, { cause: error });
    }
    if (!Array.isArray(rows)) throw new Error(`审批文件格式错误: ${this.filePath}`);
    for (const [index, row] of rows.entries()) {
      const parsed = ApprovalSchema.safeParse(normalizeLegacyApprovalRow(row));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(
          `审批文件第 ${index + 1} 条记录格式错误: ${issue?.path.join('.') || '(根)'} ${issue?.message ?? ''}`.trim(),
        );
      }
      const createdAt = new Date(parsed.data.createdAt);
      const expiresAt = parsed.data.expiresAt
        ?? new Date(createdAt.getTime() + this.ttlMs).toISOString();
      const approval = ApprovalSchema.parse({ ...parsed.data, expiresAt });
      if (this.approvals.has(approval.id)) throw new Error(`审批文件包含重复 ID: ${approval.id}`);
      this.approvals.set(approval.id, approval);
    }
  }

  private require(id: string): ApprovalRequest {
    const current = this.approvals.get(id);
    if (!current) throw new Error(`审批不存在: ${id}`);
    return current;
  }

  private requireOwner(
    id: string,
    operatorOpenId: string,
    ownerMatches: ApprovalOwnerMatcher = (owner, operator) => owner === operator,
  ): ApprovalRequest {
    const current = this.require(id);
    if (!operatorOpenId || !ownerMatches(current.ownerOpenId, operatorOpenId)) {
      throw new Error('只有指定负责人可以处理该审批。');
    }
    return current;
  }

  private isExpired(approval: ApprovalRequest): boolean {
    if (!approval.expiresAt) return false;
    return new Date(approval.expiresAt).getTime() <= this.now().getTime();
  }

  private async expireCurrentIfNeeded(approval: ApprovalRequest): Promise<boolean> {
    if (!this.isAuthorizationOpen(approval) || !this.isExpired(approval)) return false;
    await this.expireCurrent(approval, '审批等待超时');
    return true;
  }

  private isAuthorizationOpen(approval: ApprovalRequest): boolean {
    return approval.status === 'pending' || approval.status === 'approved' || approval.status === 'failed';
  }

  private findDuplicate(input: ApprovalCreateInput): ApprovalRequest | undefined {
    return [...this.approvals.values()].find((approval) => {
      if (input.scheduleJobId && input.scheduleRunCount) {
        return approval.scheduleJobId === input.scheduleJobId
          && approval.scheduleRunCount === input.scheduleRunCount;
      }
      return !approval.scheduleJobId
        && approval.botId === input.botId
        && approval.action === input.action
        && approval.message.messageId === input.message.messageId;
    });
  }

  private expiredRecord(current: ApprovalRequest, reason: string): ApprovalRequest {
    return ApprovalSchema.parse({
      ...current,
      status: 'expired',
      executionFinishedAt: this.now().toISOString(),
      executionError: sanitizeApprovalError(reason),
    });
  }

  private async expireCurrent(current: ApprovalRequest, reason: string): Promise<ApprovalRequest> {
    const next = this.expiredRecord(current, reason);
    await this.replaceAndPersist(current.id, next);
    return next;
  }

  private async replaceAndPersist(id: string, next: ApprovalRequest): Promise<void> {
    const previous = this.approvals.get(id);
    this.approvals.set(id, next);
    try {
      await this.persist();
    } catch (error) {
      if (previous) this.approvals.set(id, previous);
      else this.approvals.delete(id);
      throw error;
    }
  }

  private async replaceManyAndPersist(nextRecords: ApprovalRequest[]): Promise<void> {
    const previous = new Map(this.approvals);
    for (const next of nextRecords) this.approvals.set(next.id, next);
    try {
      await this.persist();
    } catch (error) {
      this.approvals.clear();
      for (const [id, approval] of previous) this.approvals.set(id, approval);
      throw error;
    }
  }

  private async persist(): Promise<void> {
    const payload = JSON.stringify([...this.approvals.values()], null, 2);
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

function sanitizeApprovalError(error: string | undefined): string {
  return redactSecrets(error?.trim() || '执行失败').slice(0, 2_000);
}

function normalizeLegacyApprovalRow(row: unknown): unknown {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const record = row as Record<string, unknown>;
  // 早期版本可能把旧 approved 状态在重启时转成 attempt=0 的终态。
  // 终态不会再接收执行回调，迁移为首轮记录不会重新授权或重复执行。
  if (
    (record.status === 'succeeded' || record.status === 'failed')
    && (record.executionAttempt === undefined || record.executionAttempt === 0)
    && typeof record.executionFinishedAt === 'string'
  ) {
    return { ...record, executionAttempt: 1 };
  }
  return row;
}
