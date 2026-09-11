import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isAbsolute, win32 } from 'node:path';
import { isTaskOwner, type OperatorIdentity } from './identity.js';
import type { CollaborationOrigin } from './collaboration.js';

const WorkspaceDocumentPathSchema = z.string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) => !isAbsolute(value) && !win32.isAbsolute(value)
      && !/^[a-z]:/i.test(value) && !value.includes('\\') && !value.includes('\0')
      && !value.split('/').includes('..'),
    '文档路径必须位于当前工作目录内',
  );

const ProductSpecBaseSchema = z.object({
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(500),
});

export const LarkDocumentUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && /(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)
    && /^\/(docx|wiki)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
}, 'documentUrl 必须是飞书/Lark 的 HTTPS Docx 或 Wiki 文档链接');

export const LocalProductSpecRequestSchema = ProductSpecBaseSchema.extend({
  deliveryMode: z.literal('local'),
  specPath: WorkspaceDocumentPathSchema,
  ticketsPath: WorkspaceDocumentPathSchema,
}).strict();

export const LarkProductSpecRequestSchema = ProductSpecBaseSchema.extend({
  deliveryMode: z.literal('lark-doc'),
  documentUrl: LarkDocumentUrlSchema,
}).strict();

export const ProductSpecRequestSchema = z.discriminatedUnion('deliveryMode', [
  LocalProductSpecRequestSchema,
  LarkProductSpecRequestSchema,
]);

export type ProductSpecRequest = z.infer<typeof ProductSpecRequestSchema>;
export type LocalProductSpecRequest = z.infer<
  typeof LocalProductSpecRequestSchema
>;

export interface ProductSpecFlow {
  token: string;
  taskId: string;
  botId: string;
  sessionId: string;
  sessionVersion?: number;
  ownerOpenId: string;
  ownerUnionId?: string;
  ownerBotId?: string;
  collaboration?: CollaborationOrigin;
  request: ProductSpecRequest;
  status: 'pending' | 'approved' | 'expired';
  approvedAt?: string;
  approvalMessageId?: string;
}

export interface CreateProductSpecFlowOptions {
  taskId: string;
  botId: string;
  sessionId: string;
  sessionVersion?: number;
  ownerOpenId: string;
  ownerUnionId?: string;
  ownerBotId?: string;
  collaboration?: CollaborationOrigin;
  request: ProductSpecRequest;
}

export function findProductSpecRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): ProductSpecRequest | undefined {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index];
    if (call?.toolName !== 'request_spec_approval') continue;
    const parsed = ProductSpecRequestSchema.safeParse(call.input);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export function isProductSpecOwner(
  flow: Pick<ProductSpecFlow, 'ownerOpenId' | 'ownerUnionId' | 'ownerBotId'>,
  operator: OperatorIdentity,
): boolean { return isTaskOwner(flow, operator); }

export class ProductSpecFlowStore {
  private readonly flows = new Map<string, ProductSpecFlow>();
  private readonly comments = new Map<string, number>();
  private readonly approvals = new Set<string>();

  reserveComment(token: string): (() => void) | undefined {
    if (this.get(token)?.status !== 'pending' || this.approvals.has(token)) return undefined;
    this.comments.set(token, (this.comments.get(token) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.comments.get(token) ?? 1) - 1;
      if (count) this.comments.set(token, count); else this.comments.delete(token);
    };
  }

  beginApproval(token: string): boolean {
    if (this.comments.has(token) || this.approvals.has(token)) return false;
    this.approvals.add(token);
    return true;
  }
  endApproval(token: string): void { this.approvals.delete(token); }

  private pruneHistory(): void {
    // Only settled records are bounded; a proposal still waiting for confirmation is never dropped.
    const finished = [...this.flows.values()].filter((f) => f.status !== 'pending');
    for (const flow of finished.slice(0, Math.max(0, finished.length - 1000))) this.flows.delete(flow.token);
  }

  constructor(initialFlows: ProductSpecFlow[] = []) {
    for (const flow of initialFlows) {
      this.flows.set(flow.token, flow);
    }
  }

  create(options: CreateProductSpecFlowOptions): ProductSpecFlow {
    for (const flow of this.flows.values()) {
      if (
        flow.taskId === options.taskId
        && flow.botId === options.botId
        && flow.status === 'pending'
      ) {
        flow.status = 'expired';
      }
    }
    this.pruneHistory();
    const flow: ProductSpecFlow = {
      token: randomUUID().replaceAll('-', ''),
      ...options,
      status: 'pending',
    };
    this.flows.set(flow.token, flow);
    return flow;
  }

  get(token: string): ProductSpecFlow | undefined {
    return this.flows.get(token);
  }

  forSession(sessionId: string): ProductSpecFlow[] {
    return [...this.flows.values()].filter((flow) => flow.sessionId === sessionId && flow.status === 'pending');
  }

  findPendingByDocument(
    botId: string,
    fileToken: string,
  ): ProductSpecFlow | undefined {
    for (const flow of this.flows.values()) {
      if (
        flow.botId === botId
        && flow.status === 'pending'
        && flow.request.deliveryMode === 'lark-doc'
        && documentToken(flow.request.documentUrl) === fileToken
      ) return flow;
    }
    return undefined;
  }

  approve(token: string, messageId?: string): ProductSpecFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== 'pending' || this.comments.has(token)) return undefined;
    flow.status = 'approved';
    flow.approvalMessageId = messageId;
    flow.approvedAt = new Date().toISOString();
    return flow;
  }

  protected snapshot(): ProductSpecFlow[] {
    return structuredClone([...this.flows.values()]);
  }

  protected restore(flows: ProductSpecFlow[]): void {
    this.flows.clear();
    for (const flow of flows) {
      this.flows.set(flow.token, flow);
    }
  }
}

function documentToken(documentUrl: string): string | undefined {
  const match = /^\/docx\/([A-Za-z0-9_-]+)\/?$/.exec(
    new URL(documentUrl).pathname,
  );
  return match?.[1];
}
