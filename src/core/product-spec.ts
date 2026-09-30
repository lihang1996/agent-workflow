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

/**
 * T-020：架构是开发 Bot 的独立制品，输入 schema 与产品工具分离——只接收
 * 架构设计文档路径（designPath），**没有也不接受任何上游 PRD token/URL 字段**：
 * PRD→架构的上游关系只能由服务端交接引用（ArchitectureHandoff）建立，
 * CLI 自报的上游一律不采信。
 */
export const LocalArchitectureRequestSchema = ProductSpecBaseSchema.extend({
  deliveryMode: z.literal('local'),
  designPath: WorkspaceDocumentPathSchema,
}).strict();

export const LarkArchitectureRequestSchema = ProductSpecBaseSchema.extend({
  deliveryMode: z.literal('lark-doc'),
  documentUrl: LarkDocumentUrlSchema,
}).strict();

export const ArchitectureRequestSchema = z.discriminatedUnion('deliveryMode', [
  LocalArchitectureRequestSchema,
  LarkArchitectureRequestSchema,
]);

export type ArchitectureRequest = z.infer<typeof ArchitectureRequestSchema>;
export type LocalArchitectureRequest = z.infer<
  typeof LocalArchitectureRequestSchema
>;

/**
 * `request_architecture_review` 工具输入 = 架构请求 + 架构交接码。交接码是
 * 服务端在已批准 PRD 卡片上签发的随机 32 位十六进制 capability（唯一、单次
 * 使用、绑定创建者），**不是** CLI 可自报的上游 PRD token。
 */
export const ArchitectureReviewToolRequestSchema = z.discriminatedUnion('deliveryMode', [
  LocalArchitectureRequestSchema.extend({
    handoffToken: z.string().regex(/^[a-f0-9]{32}$/),
  }).strict(),
  LarkArchitectureRequestSchema.extend({
    handoffToken: z.string().regex(/^[a-f0-9]{32}$/),
  }).strict(),
]);

export type ArchitectureReviewToolRequest = z.infer<typeof ArchitectureReviewToolRequestSchema>;

export const ARCHITECTURE_REVIEW_TOOL_NAME = 'request_architecture_review';

export function findArchitectureRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): { request: ArchitectureRequest; handoffToken: string } | undefined {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index];
    if (call?.toolName !== ARCHITECTURE_REVIEW_TOOL_NAME) continue;
    const parsed = ArchitectureReviewToolRequestSchema.safeParse(call.input);
    if (parsed.success) {
      const { handoffToken, ...request } = parsed.data;
      return { request, handoffToken };
    }
  }
  return undefined;
}

export type ArtifactKind = 'prd' | 'architecture';

/**
 * 架构制品的上游绑定：全部字段在交接（handoff）创建/消费时由服务端从已批准
 * PRD flow 复制，持久化后不可由 CLI 侧输入改写。prdDigest 是绑定的 PRD 版本；
 * knowledgeRefs/knowledgeState 继承该 PRD 所用的多系统知识快照与上下文引用。
 */
export interface ArchitectureUpstream {
  prdToken: string;
  prdDigest: string;
  approvedAt?: string;
  approvalMessageId?: string;
  /** 交接创建时 PRD 的任务/会话——知识引用核验沿用 PRD 的台账绑定。 */
  prdTaskId: string;
  prdSessionId: string;
  knowledgeRefs: KnowledgeRef[];
  knowledgeState: KnowledgeUsageState | null;
}

export type ContentSource =
  | { kind: 'local'; path: string }
  | { kind: 'lark'; file_token: string };

/**
 * 服务端持有的多系统知识引用清单（T-018）：每项绑定单一 system 的固定快照
 * 与上下文，不能只用一个 knowledge_snapshot_ref 覆盖多个系统。引用内容由
 * 服务端预取台账核验，不采信模型自报。
 */
export interface KnowledgeRef {
  system_id: string;
  /** 服务端裁剪作用域（如 bot 角色），来自可信身份映射。 */
  scope: string;
  snapshot_ref: string;
  context_ref: string;
  /** 引用到的对象 ID（须 ⊆ 该次固定快照的现行对象集）。 */
  object_ids: string[];
  /** 对象 → revision 的服务端绑定；核验时逐项与台账比对。 */
  object_revisions?: Record<string, number>;
  requested_seed_ids?: string[];
}

export type KnowledgeUsageState =
  | 'ok'
  | 'new_project_no_baseline'
  | 'degraded'
  /**
   * 已有项目、预取成功但没有任何可作为现行事实的对象（搜索阶段零现行种子，
   * 或读回时 availability 重评全部降级）。与「完整可用」和「新项目无基准」
   * 都不混同：可持久化、可展示、G1 阻止普通审批（例外确认通道未开放）。
   */
  | 'no_current_objects';

export const ContentSourceSchema = z.union([
  z.object({ kind: z.literal('local'), path: z.string().min(1).max(240) }).strict(),
  z.object({ kind: z.literal('lark'), file_token: z.string().min(1).max(128) }).strict(),
]);

export const KnowledgeRefSchema = z.object({
  system_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  scope: z.string().min(1).max(64),
  snapshot_ref: z.string().min(1).max(200),
  context_ref: z.string().min(1).max(200),
  object_ids: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/)).min(1),
  object_revisions: z.record(
    z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/),
    z.number().int().nonnegative(),
  ).optional(),
  requested_seed_ids: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,199}$/)).optional(),
}).strict();

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
  request: ProductSpecRequest | ArchitectureRequest;
  status: 'pending' | 'approved' | 'expired' | 'invalidated';
  approvedAt?: string;
  approvalMessageId?: string;
  /** 制品种类；旧记录缺省视为 prd。 */
  artifact_kind?: ArtifactKind;
  /** 完整制品摘要（canonical-sha256-v1）；null/缺省 = 版本未绑定（旧记录），审批失败关闭。 */
  content_digest?: string | null;
  digest_algorithm?: 'canonical-sha256-v1';
  /** 摘要覆盖的来源清单（本地相对路径 / 飞书文档 token）。 */
  content_sources?: ContentSource[];
  /** 服务端持有的多系统知识引用清单；空 = 未使用知识预取。 */
  knowledge_refs?: KnowledgeRef[];
  /** 知识使用状态：新项目无基准与已有项目降级必须显式区分（AO-REQ-305）。 */
  knowledge_state?: KnowledgeUsageState | null;
  /**
   * 架构制品的上游 PRD 绑定（T-020）：服务端交接时复制，CLI 输入不可写。
   * PRD 摘要失效时按此字段级联失效相关架构。
   */
  upstream?: ArchitectureUpstream;
  invalidation_reason?: string;
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
  request: ProductSpecRequest | ArchitectureRequest;
  artifact_kind?: ArtifactKind;
  content_digest?: string | null;
  digest_algorithm?: 'canonical-sha256-v1';
  content_sources?: ContentSource[];
  knowledge_refs?: KnowledgeRef[];
  knowledge_state?: KnowledgeUsageState | null;
  upstream?: ArchitectureUpstream;
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
    // 只有被同任务新方案取代的 expired 记录可按数量裁剪。approved 记录是
    // 版本与摘要锚点（架构上游、编码授权、审计依据），invalidated 记录是
    // 失效审计依据——按数量删除会丢失可验证引用（work/30），保持保留。
    const expired = [...this.flows.values()].filter((f) => f.status === 'expired');
    for (const flow of expired.slice(0, Math.max(0, expired.length - 1000))) this.flows.delete(flow.token);
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
      // 新字段在创建点归一化，内存态与持久态同构；旧路径缺省 = 版本未绑定。
      artifact_kind: options.artifact_kind ?? 'prd',
      content_digest: options.content_digest ?? null,
      digest_algorithm: options.digest_algorithm ?? 'canonical-sha256-v1',
      content_sources: options.content_sources ?? [],
      knowledge_refs: options.knowledge_refs ?? [],
      knowledge_state: options.knowledge_state ?? null,
      ...(options.upstream ? { upstream: options.upstream } : {}),
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

  /**
   * 同一文档的全部 pending flow（评论路由用）：同一文档 URL 只允许对应唯一
   * 有效 pending flow；多条匹配时调用方必须失败关闭，不得静默取第一条。
   */
  listPendingByDocument(
    botId: string,
    fileToken: string,
  ): ProductSpecFlow[] {
    return [...this.flows.values()].filter(
      (flow) =>
        flow.botId === botId
        && flow.status === 'pending'
        && flow.request.deliveryMode === 'lark-doc'
        && documentToken(flow.request.documentUrl) === fileToken,
    );
  }

  /** 以 upstream PRD 绑定查找架构 flow（PRD 失效级联用）。 */
  listByUpstreamPrd(prdToken: string): ProductSpecFlow[] {
    return [...this.flows.values()].filter(
      (flow) => flow.upstream?.prdToken === prdToken,
    );
  }

  /**
   * 评论修订后的摘要重绑（T-019）：仅 pending flow 允许，且只接受一次完整
   * 回读成功后重算的摘要——「已核验版本」永远来自受控读取，而不是 CLI 自报。
   */
  rebindDigest(
    token: string,
    contentDigest: string,
    contentSources: ContentSource[],
  ): ProductSpecFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== 'pending') return undefined;
    flow.content_digest = contentDigest;
    flow.digest_algorithm = 'canonical-sha256-v1';
    flow.content_sources = contentSources;
    return flow;
  }

  approve(token: string, messageId?: string): ProductSpecFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status !== 'pending' || this.comments.has(token)) return undefined;
    flow.status = 'approved';
    flow.approvalMessageId = messageId;
    flow.approvedAt = new Date().toISOString();
    return flow;
  }

  /**
   * 制品失效（外部编辑/上游失效等）。批准后任何修改使旧摘要失效；本批仅提供
   * store 级原语与 G1 拒绝，定时监测与级联通知属 T-019（下一批）。
   */
  invalidate(token: string, reason: string): ProductSpecFlow | undefined {
    const flow = this.flows.get(token);
    if (!flow || flow.status === 'invalidated') return undefined;
    flow.status = 'invalidated';
    flow.invalidation_reason = reason;
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

/** 飞书文档 URL 的 docx token（wiki 链接先经 normalizeProductDocument 归一化）。 */
export function productDocumentToken(documentUrl: string): string | undefined {
  return documentToken(documentUrl);
}
