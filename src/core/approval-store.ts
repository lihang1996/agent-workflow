import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const StoredMessageSchema = z.object({
  messageId: z.string().min(1),
  chatId: z.string().min(1),
  chatType: z.string(),
  rootId: z.string(),
  threadId: z.string(),
  senderOpenId: z.string(),
});
export type StoredMessage = z.infer<typeof StoredMessageSchema>;

export const ApprovalSchema = z.object({
  id: z.string().min(1),
  botId: z.string().min(1),
  ownerOpenId: z.string().min(1),
  action: z.enum(['task', 'pipeline', 'squad', 'review']),
  prompt: z.string().min(1),
  reason: z.string().min(1),
  message: StoredMessageSchema,
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  createdAt: z.string().min(1),
  decidedAt: z.string().optional(),
  decidedBy: z.string().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalSchema>;

export class JsonApprovalStore {
  private readonly approvals = new Map<string, ApprovalRequest>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  static async open(filePath: string): Promise<JsonApprovalStore> {
    const store = new JsonApprovalStore(filePath);
    await store.load();
    return store;
  }

  get(id: string): ApprovalRequest | undefined {
    return this.approvals.get(id);
  }

  async create(input: Omit<ApprovalRequest, 'id' | 'status' | 'createdAt'>): Promise<ApprovalRequest> {
    const approval: ApprovalRequest = {
      ...input,
      id: randomUUID().slice(0, 8),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.approvals.set(approval.id, approval);
    await this.persist();
    return approval;
  }

  async decide(id: string, status: 'approved' | 'rejected', decidedBy: string): Promise<ApprovalRequest> {
    const current = this.get(id);
    if (!current) throw new Error(`审批不存在: ${id}`);
    if (current.status !== 'pending') throw new Error(`审批已处理：${current.status}`);
    const next: ApprovalRequest = {
      ...current,
      status,
      decidedAt: new Date().toISOString(),
      decidedBy,
    };
    this.approvals.set(id, next);
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
    if (!Array.isArray(rows)) throw new Error(`审批文件格式错误: ${this.filePath}`);
    for (const row of rows) {
      const parsed = ApprovalSchema.safeParse(row);
      if (parsed.success) this.approvals.set(parsed.data.id, parsed.data);
    }
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
