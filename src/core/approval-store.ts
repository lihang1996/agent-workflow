import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { redactSecrets } from './log-inspection.js';

const StoredMessageSchema = z.object({
  messageId: z.string().min(1),
  chatId: z.string().min(1),
  chatType: z.string(),
  rootId: z.string(),
  threadId: z.string(),
  senderOpenId: z.string(),
});
export type StoredMessage = z.infer<typeof StoredMessageSchema>;

const TimestampSchema = z.string().min(1).refine(
  (value) => Number.isFinite(Date.parse(value)),
  '时间格式无效',
);

export const ApprovalSchema = z.object({
  id: z.string().min(1),
  botId: z.string().min(1),
  ownerOpenId: z.string().min(1),
  action: z.enum(['task', 'pipeline', 'squad', 'review']),
  prompt: z.string().min(1),
  reason: z.string().min(1),
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
  decidedBy: z.string().optional(),
  cardMessageId: z.string().min(1).optional(),
  workflowId: z.string().uuid().optional(),
  scheduleJobId: z.string().min(1).optional(),
  scheduleRunCount: z.number().int().min(1).optional(),
  executionAttempt: z.number().int().min(0).default(0),
  executionStartedAt: TimestampSchema.optional(),
  executionFinishedAt: TimestampSchema.optional(),
  executionError: z.string().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalSchema>;

export type ApprovalExecutionOutcome = 'succeeded' | 'failed';
export type ApprovalWorkflowState = 'running' | ApprovalExecutionOutcome;

const DEFAULT_APPROVAL_TTL_MS = 30 * 60 * 1_000;

export interface ApprovalStoreOptions {
  now?: () => Date;
  ttlMs?: number;
}

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
  private writeQueue: Promise<void> = Promise.resolve();
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

  async create(input: Omit<
    ApprovalRequest,
    | 'id'
    | 'status'
    | 'createdAt'
    | 'expiresAt'
    | 'executionAttempt'
    | 'executionStartedAt'
    | 'executionFinishedAt'
    | 'executionError'
  >): Promise<ApprovalRequest> {
    const now = this.now();
    const approval: ApprovalRequest = {
      ...input,
      id: randomUUID(),
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      executionAttempt: 0,
    };
    this.approvals.set(approval.id, approval);
    await this.persist();
    return approval;
  }

  /** 记录飞书审批卡 message_id，供异步执行结果回写原卡。 */
  async setCardMessageId(id: string, cardMessageId: string): Promise<ApprovalRequest> {
    if (!cardMessageId.trim()) throw new Error('审批卡 message_id 不能为空');
    const current = this.get(id);
    if (!current) throw new Error(`审批不存在: ${id}`);
    const next: ApprovalRequest = {
      ...current,
      cardMessageId,
    };
    this.approvals.set(id, next);
    await this.persist();
    return next;
  }

  /** 拒绝待审批任务；负责人校验与状态切换在同一个临界区完成。 */
  async reject(id: string, decidedBy: string): Promise<ApprovalRequest> {
    const current = this.requireOwner(id, decidedBy);
    const expired = await this.expireIfNeeded(current);
    if (expired) throw new Error('审批已过期，请重新发起。');
    if (current.status !== 'pending') throw new Error(`审批已处理：${current.status}`);
    const now = this.now().toISOString();
    const next: ApprovalRequest = {
      ...current,
      status: 'rejected',
      decidedAt: now,
      decidedBy,
      executionFinishedAt: now,
    };
    this.approvals.set(id, next);
    await this.persist();
    return next;
  }

  /**
   * 首次批准或失败重试都会原子进入 executing。
   * executionAttempt 用于阻止上一轮异步回调覆盖新一轮结果。
   */
  async beginExecution(id: string, decidedBy: string): Promise<ApprovalRequest> {
    const current = this.requireOwner(id, decidedBy);
    const expired = await this.expireIfNeeded(current);
    if (expired) throw new Error('审批已过期，请重新发起。');
    if (current.status !== 'pending' && current.status !== 'approved' && current.status !== 'failed') {
      throw new Error(`审批当前状态为 ${current.status}，不能重复执行。`);
    }
    const now = this.now().toISOString();
    const next: ApprovalRequest = {
      ...current,
      status: 'executing',
      decidedAt: current.decidedAt ?? now,
      decidedBy: current.decidedBy ?? decidedBy,
      executionAttempt: current.executionAttempt + 1,
      executionStartedAt: now,
      executionFinishedAt: undefined,
      executionError: undefined,
      workflowId: undefined,
    };
    this.approvals.set(id, next);
    await this.persist();
    return next;
  }

  async attachWorkflow(
    id: string,
    executionAttempt: number,
    workflowId: string,
  ): Promise<ApprovalRequest> {
    const current = this.get(id);
    if (!current) throw new Error(`审批不存在: ${id}`);
    if (current.status !== 'executing' || current.executionAttempt !== executionAttempt) {
      throw new Error(`审批 ${id} 已不属于当前执行轮次。`);
    }
    const next = ApprovalSchema.parse({ ...current, workflowId });
    this.approvals.set(id, next);
    await this.persist();
    return next;
  }

  async finishExecution(
    id: string,
    executionAttempt: number,
    outcome: ApprovalExecutionOutcome,
    error?: string,
  ): Promise<ApprovalRequest> {
    const current = this.get(id);
    if (!current) throw new Error(`审批不存在: ${id}`);
    // 旧轮次回调或已经落盘的终态直接忽略，保证完成操作幂等。
    if (current.executionAttempt !== executionAttempt || current.status !== 'executing') return current;
    const next: ApprovalRequest = {
      ...current,
      status: outcome,
      executionFinishedAt: this.now().toISOString(),
      executionError: outcome === 'failed' ? sanitizeApprovalError(error) : undefined,
    };
    this.approvals.set(id, next);
    await this.persist();
    return next;
  }

  /** 审批卡发送失败时保留审计记录，但确保这条记录永远不能被批准。 */
  async expire(id: string, reason = '审批已失效'): Promise<ApprovalRequest> {
    const current = this.get(id);
    if (!current) throw new Error(`审批不存在: ${id}`);
    if (!this.isAuthorizationOpen(current)) return current;
    const next: ApprovalRequest = {
      ...current,
      status: 'expired',
      executionFinishedAt: this.now().toISOString(),
      executionError: sanitizeApprovalError(reason),
    };
    this.approvals.set(id, next);
    await this.persist();
    return next;
  }

  async expireStale(reason = '审批等待超时'): Promise<ApprovalRequest[]> {
    const changed: ApprovalRequest[] = [];
    for (const current of this.approvals.values()) {
      if (!this.isAuthorizationOpen(current) || !this.isExpired(current)) continue;
      const next: ApprovalRequest = {
        ...current,
        status: 'expired',
        executionFinishedAt: this.now().toISOString(),
        executionError: sanitizeApprovalError(reason),
      };
      this.approvals.set(next.id, next);
      changed.push(next);
    }
    if (changed.length > 0) await this.persist();
    return changed;
  }

  /**
   * 服务重启后：持久化工作流继续保持执行态；普通 CLI/评审则转失败，允许负责人重试。
   */
  async reconcileInterrupted(
    workflowState: (workflowId: string) => ApprovalWorkflowState | undefined,
  ): Promise<ApprovalRequest[]> {
    const changed: ApprovalRequest[] = [];
    for (const current of this.approvals.values()) {
      if (this.isAuthorizationOpen(current) && this.isExpired(current)) {
        const next = await this.expire(current.id, '审批等待超时');
        changed.push(next);
        continue;
      }
      if (current.status === 'approved') {
        const next: ApprovalRequest = {
          ...current,
          status: 'failed',
          executionFinishedAt: this.now().toISOString(),
          executionError: '服务升级前的执行状态不完整，请确认后重试。',
        };
        this.approvals.set(next.id, next);
        changed.push(next);
        continue;
      }
      if (current.status !== 'executing') continue;
      const state = current.workflowId ? workflowState(current.workflowId) : undefined;
      if (state === 'running') continue;
      const next: ApprovalRequest = {
        ...current,
        status: state === 'succeeded' ? 'succeeded' : 'failed',
        executionFinishedAt: this.now().toISOString(),
        executionError: state === 'succeeded'
          ? undefined
          : state === 'failed'
            ? '关联工作流执行失败，请查看工作流消息后重试。'
            : '上次执行被服务重启中断，请确认后重试。',
      };
      this.approvals.set(next.id, next);
      changed.push(next);
    }
    if (changed.length > 0) await this.persist();
    return changed;
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
    if (!Array.isArray(rows)) throw new Error(`审批文件格式错误: ${this.filePath}`);
    for (const row of rows) {
      const parsed = ApprovalSchema.safeParse(row);
      if (!parsed.success) continue;
      const createdAt = new Date(parsed.data.createdAt);
      const expiresAt = parsed.data.expiresAt
        ?? new Date(createdAt.getTime() + this.ttlMs).toISOString();
      this.approvals.set(parsed.data.id, { ...parsed.data, expiresAt });
    }
  }

  private requireOwner(id: string, operatorOpenId: string): ApprovalRequest {
    const current = this.get(id);
    if (!current) throw new Error(`审批不存在: ${id}`);
    if (!operatorOpenId || current.ownerOpenId !== operatorOpenId) {
      throw new Error('只有指定负责人可以处理该审批。');
    }
    return current;
  }

  private isExpired(approval: ApprovalRequest): boolean {
    if (!approval.expiresAt) return false;
    return new Date(approval.expiresAt).getTime() <= this.now().getTime();
  }

  private async expireIfNeeded(approval: ApprovalRequest): Promise<boolean> {
    if (!this.isAuthorizationOpen(approval) || !this.isExpired(approval)) return false;
    await this.expire(approval.id, '审批等待超时');
    return true;
  }

  private isAuthorizationOpen(approval: ApprovalRequest): boolean {
    return approval.status === 'pending' || approval.status === 'approved' || approval.status === 'failed';
  }

  private persist(): Promise<void> {
    const payload = JSON.stringify([...this.approvals.values()], null, 2);
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

function sanitizeApprovalError(error: string | undefined): string {
  return redactSecrets(error?.trim() || '执行失败').slice(0, 2_000);
}
