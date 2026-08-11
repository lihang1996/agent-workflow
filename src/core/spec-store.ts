import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

export const SpecStatusSchema = z.enum([
  'draft',
  'pending_confirmation',
  'confirmed',
  'published',
  'in_review',
  'changes_requested',
  'approved',
]);
export type SpecStatus = z.infer<typeof SpecStatusSchema>;

export const SpecCommentSchema = z.object({
  id: z.string().uuid(),
  authorOpenId: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(10_000),
  docCommentId: z.string().trim().min(1).max(500).optional(),
  resolved: z.boolean().default(false),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().optional(),
  documentResolvedAt: z.iso.datetime().optional(),
});
export type SpecComment = z.infer<typeof SpecCommentSchema>;
export type NewSpecComment = Pick<SpecComment, 'authorOpenId' | 'content'> & {
  docCommentId?: string;
};

export const ProductSpecSchema = z.object({
  // 兼容早期 8 位 ID；新记录使用完整 UUID。
  id: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(500_000),
  chatId: z.string().trim().min(1).max(200),
  topicId: z.string().trim().min(1).max(200),
  messageId: z.string().trim().min(1).max(200),
  ownerOpenId: z.string().trim().min(1).max(200),
  botId: z.string().trim().min(1).max(100),
  questionnaireId: z.string().trim().min(1).max(100).optional(),
  workflowId: z.string().uuid().optional(),
  projectId: z.string().trim().min(1).max(4_000).optional(),
  version: z.number().int().min(1).default(1),
  supersedesSpecId: z.string().trim().min(1).max(64).optional(),
  canonical: z.boolean().default(false),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  confirmationFeedback: z.string().trim().min(1).max(4_000).optional(),
  status: SpecStatusSchema,
  /** 由本地状态机在人工确认成功时写入；不得取 Agent 输出中的时间。 */
  approvedAt: z.iso.datetime().optional(),
  docId: z.string().trim().min(1).max(500).optional(),
  docUrl: z.url().refine(isFeishuDocumentUrl, '云文档地址必须是飞书 Docx HTTPS 地址').optional(),
  comments: z.array(SpecCommentSchema).max(2_000).default([]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).superRefine((spec, ctx) => {
  const commentIds = new Set<string>();
  const documentCommentIds = new Set<string>();
  spec.comments.forEach((comment, index) => {
    if (commentIds.has(comment.id)) {
      ctx.addIssue({ code: 'custom', path: ['comments', index, 'id'], message: `评论 ID 重复: ${comment.id}` });
    }
    commentIds.add(comment.id);
    if (comment.docCommentId) {
      if (documentCommentIds.has(comment.docCommentId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['comments', index, 'docCommentId'],
          message: `云文档评论 ID 重复: ${comment.docCommentId}`,
        });
      }
      documentCommentIds.add(comment.docCommentId);
    }
  });
  if (spec.docUrl && !spec.docId) {
    ctx.addIssue({ code: 'custom', path: ['docUrl'], message: '存在云文档地址时必须同时保存 docId' });
  }
  if (spec.canonical && !spec.projectId) {
    ctx.addIssue({ code: 'custom', path: ['projectId'], message: '规范 Spec 必须绑定项目标识' });
  }
  if ((spec.canonical || spec.status === 'approved') && !spec.contentHash) {
    ctx.addIssue({ code: 'custom', path: ['contentHash'], message: '已批准或 canonical Spec 必须包含内容 hash' });
  }
  if ((spec.canonical || spec.status === 'approved') && !spec.approvedAt) {
    ctx.addIssue({ code: 'custom', path: ['approvedAt'], message: '已批准或 canonical Spec 必须包含控制器批准时间' });
  }
  if (spec.contentHash && spec.contentHash !== hashSpecContent(spec.content)) {
    ctx.addIssue({ code: 'custom', path: ['contentHash'], message: 'Spec 内容与 contentHash 不一致' });
  }
});
export type ProductSpec = z.infer<typeof ProductSpecSchema>;

type SpecPatch = Partial<Omit<ProductSpec, 'id' | 'createdAt' | 'approvedAt'>>;

/** 产品 Spec 的本地事实源；飞书云文档仅作为发布副本。 */
export class JsonSpecStore {
  private readonly specs = new Map<string, ProductSpec>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  static async open(filePath: string): Promise<JsonSpecStore> {
    const store = new JsonSpecStore(filePath);
    await store.load();
    return store;
  }

  get(id: string): ProductSpec | undefined {
    return this.specs.get(id);
  }

  findByWorkflowId(workflowId: string): ProductSpec | undefined {
    return [...this.specs.values()]
      .filter((spec) => spec.workflowId === workflowId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  findCanonical(projectId: string): ProductSpec | undefined {
    return [...this.specs.values()].find((spec) => spec.projectId === projectId && spec.canonical);
  }

  listByTopic(chatId: string, topicId: string): ProductSpec[] {
    return [...this.specs.values()]
      .filter((spec) => spec.chatId === chatId && spec.topicId === topicId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  findByDocumentId(documentId: string): ProductSpec | undefined {
    return [...this.specs.values()].find((spec) => spec.docId === documentId);
  }

  listInReview(): ProductSpec[] {
    return [...this.specs.values()]
      .filter((spec) => spec.status === 'in_review' && !!spec.docId)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  listPendingDocumentResolution(): ProductSpec[] {
    return [...this.specs.values()]
      .filter((spec) => !!spec.docId && spec.comments.some((comment) =>
        comment.resolved && !!comment.docCommentId && !comment.documentResolvedAt))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  listPendingReviewRevision(): ProductSpec[] {
    return [...this.specs.values()]
      .filter((spec) => spec.status === 'changes_requested'
        && spec.comments.some((comment) => !comment.resolved))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  async create(input: Omit<
    ProductSpec,
    | 'id'
    | 'status'
    | 'comments'
    | 'createdAt'
    | 'updatedAt'
    | 'version'
    | 'canonical'
    | 'contentHash'
    | 'supersedesSpecId'
  > & {
    version?: number;
    canonical?: boolean;
    contentHash?: string;
    supersedesSpecId?: string;
  }): Promise<ProductSpec> {
    return this.enqueueMutation(async () => {
      if (input.workflowId && this.findByWorkflowId(input.workflowId)) {
        throw new Error(`工作流 ${input.workflowId} 已经关联产品 Spec`);
      }
      const now = new Date().toISOString();
      const projectId = input.projectId ?? `${input.chatId}:${input.topicId}`;
      const previous = [...this.specs.values()]
        .filter((candidate) => candidate.projectId === projectId)
        .sort((left, right) => right.version - left.version || right.updatedAt.localeCompare(left.updatedAt))[0];
      const spec = ProductSpecSchema.parse({
        ...input,
        projectId,
        id: randomUUID(),
        version: input.version ?? (previous?.version ?? 0) + 1,
        supersedesSpecId: input.supersedesSpecId ?? previous?.id,
        canonical: input.canonical ?? false,
        contentHash: input.contentHash ?? hashSpecContent(input.content),
        status: 'pending_confirmation',
        comments: [],
        createdAt: now,
        updatedAt: now,
      });
      await this.replaceAndPersist(spec.id, spec);
      return spec;
    });
  }

  async update(id: string, patch: SpecPatch): Promise<ProductSpec> {
    return this.enqueueMutation(async () => {
      const current = this.require(id);
      const now = new Date().toISOString();
      const contentChanged = patch.content !== undefined && patch.content !== current.content;
      const status = contentChanged && patch.status === undefined
        ? 'changes_requested'
        : (patch.status ?? current.status);
      if (contentChanged && status === 'approved') {
        throw new Error('Spec 正文变更与人工批准不能在同一次状态变更中完成');
      }
      const next = ProductSpecSchema.parse({
        ...current,
        ...patch,
        status,
        approvedAt: status === 'approved'
          ? (current.status === 'approved' ? current.approvedAt : now)
          : undefined,
        ...(contentChanged ? {
          version: current.version + 1,
          contentHash: hashSpecContent(patch.content as string),
          canonical: false,
        } : {}),
        updatedAt: now,
      });
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  async markCanonical(id: string): Promise<ProductSpec> {
    return this.enqueueMutation(async () => {
      const selected = this.require(id);
      if (!selected.projectId) throw new Error(`Spec ${id} 缺少项目标识，不能设为规范版本`);
      if (selected.status !== 'approved') throw new Error(`Spec ${id} 尚未批准，不能设为规范版本`);
      const previous = new Map(this.specs);
      const now = new Date().toISOString();
      for (const [specId, spec] of this.specs) {
        if (spec.projectId !== selected.projectId) continue;
        this.specs.set(specId, ProductSpecSchema.parse({
          ...spec,
          canonical: specId === id,
          approvedAt: specId === id ? (spec.approvedAt ?? now) : spec.approvedAt,
          updatedAt: specId === id ? now : spec.updatedAt,
        }));
      }
      try {
        await this.persist();
      } catch (error) {
        this.specs.clear();
        for (const [specId, spec] of previous) this.specs.set(specId, spec);
        throw error;
      }
      return this.require(id);
    });
  }

  async clearCanonical(id: string): Promise<ProductSpec> {
    return this.enqueueMutation(async () => {
      const current = this.require(id);
      if (!current.canonical) return current;
      const next = ProductSpecSchema.parse({ ...current, canonical: false, updatedAt: new Date().toISOString() });
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  /** 仅当状态仍符合预期时更新，供卡片回调与异步事件防重。 */
  async updateIfStatus(
    id: string,
    expected: SpecStatus | readonly SpecStatus[],
    patch: SpecPatch,
  ): Promise<ProductSpec | undefined> {
    return this.enqueueMutation(async () => {
      const current = this.require(id);
      const allowed = Array.isArray(expected) ? expected : [expected];
      if (!allowed.includes(current.status)) return undefined;
      const now = new Date().toISOString();
      const contentChanged = patch.content !== undefined && patch.content !== current.content;
      const status = contentChanged && patch.status === undefined
        ? 'changes_requested'
        : (patch.status ?? current.status);
      if (contentChanged && status === 'approved') {
        throw new Error('Spec 正文变更与人工批准不能在同一次状态变更中完成');
      }
      const next = ProductSpecSchema.parse({
        ...current,
        ...patch,
        status,
        approvedAt: status === 'approved'
          ? (current.status === 'approved' ? current.approvedAt : now)
          : undefined,
        ...(contentChanged ? {
          version: current.version + 1,
          contentHash: hashSpecContent(patch.content as string),
          canonical: false,
        } : {}),
        updatedAt: now,
      });
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  async addComment(
    id: string,
    authorOpenId: string,
    content: string,
    docCommentId?: string,
  ): Promise<ProductSpec> {
    return this.enqueueMutation(async () => {
      const spec = this.require(id);
      if (docCommentId) {
        const existing = spec.comments.find((comment) => comment.docCommentId === docCommentId);
        if (existing) return spec;
      }
      const comment = SpecCommentSchema.parse({
        id: randomUUID(),
        authorOpenId,
        content,
        ...(docCommentId ? { docCommentId } : {}),
        resolved: false,
        createdAt: new Date().toISOString(),
      });
      const next = ProductSpecSchema.parse({
        ...spec,
        comments: [...spec.comments, comment],
        status: 'changes_requested',
        updatedAt: new Date().toISOString(),
      });
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  /** 同一轮远端评审意见一次落盘，避免部分评论成功后中断。 */
  async addComments(id: string, inputs: readonly NewSpecComment[]): Promise<ProductSpec> {
    return this.enqueueMutation(async () => {
      const spec = this.require(id);
      const knownDocumentIds = new Set(spec.comments.flatMap((comment) =>
        comment.docCommentId ? [comment.docCommentId] : []));
      const additions: SpecComment[] = [];
      for (const input of inputs) {
        if (input.docCommentId && knownDocumentIds.has(input.docCommentId)) continue;
        const comment = SpecCommentSchema.parse({
          id: randomUUID(),
          authorOpenId: input.authorOpenId,
          content: input.content,
          ...(input.docCommentId ? { docCommentId: input.docCommentId } : {}),
          resolved: false,
          createdAt: new Date().toISOString(),
        });
        additions.push(comment);
        if (comment.docCommentId) knownDocumentIds.add(comment.docCommentId);
      }
      if (additions.length === 0) return spec;
      const next = ProductSpecSchema.parse({
        ...spec,
        comments: [...spec.comments, ...additions],
        status: 'changes_requested',
        updatedAt: new Date().toISOString(),
      });
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  async resolveComments(id: string, commentIds?: ReadonlySet<string>): Promise<ProductSpec> {
    return this.enqueueMutation(async () => {
      const spec = this.require(id);
      const now = new Date().toISOString();
      const next = ProductSpecSchema.parse({
        ...spec,
        comments: spec.comments.map((comment) => comment.resolved
          || (commentIds && !commentIds.has(comment.id))
          ? comment
          : { ...comment, resolved: true, resolvedAt: now }),
        updatedAt: now,
      });
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  async markDocumentCommentsResolved(id: string, commentIds: ReadonlySet<string>): Promise<ProductSpec> {
    return this.enqueueMutation(async () => {
      const spec = this.require(id);
      const now = new Date().toISOString();
      let changed = false;
      const comments = spec.comments.map((comment) => {
        if (!commentIds.has(comment.id) || comment.documentResolvedAt) return comment;
        changed = true;
        return { ...comment, documentResolvedAt: now };
      });
      if (!changed) return spec;
      const next = ProductSpecSchema.parse({ ...spec, comments, updatedAt: now });
      await this.replaceAndPersist(id, next);
      return next;
    });
  }

  private require(id: string): ProductSpec {
    const spec = this.specs.get(id);
    if (!spec) throw new Error(`Spec 不存在: ${id}`);
    return spec;
  }

  private async replaceAndPersist(id: string, next: ProductSpec): Promise<void> {
    const previous = this.specs.get(id);
    this.specs.set(id, next);
    try {
      await this.persist();
    } catch (error) {
      if (previous) this.specs.set(id, previous);
      else this.specs.delete(id);
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
      throw new Error(`Spec 文件不是有效 JSON: ${this.filePath}`, { cause: error });
    }
    if (!Array.isArray(rows)) throw new Error(`Spec 文件格式错误: ${this.filePath}`);
    for (const [index, row] of rows.entries()) {
      // v1 记录没有 approvedAt；用当时已持久化的 updatedAt 做一次确定性迁移，
      // 之后所有新批准都由状态机写入真实时间。
      const migrated = row && typeof row === 'object' && !Array.isArray(row)
        && ((row as Record<string, unknown>).status === 'approved'
          || (row as Record<string, unknown>).canonical === true)
        && !(row as Record<string, unknown>).approvedAt
        ? { ...(row as Record<string, unknown>), approvedAt: (row as Record<string, unknown>).updatedAt }
        : row;
      const parsed = ProductSpecSchema.safeParse(migrated);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(
          `Spec 文件第 ${index + 1} 条记录格式错误: ${issue?.path.join('.') || '(根)'} ${issue?.message ?? ''}`.trim(),
        );
      }
      if (this.specs.has(parsed.data.id)) throw new Error(`Spec 文件包含重复 ID: ${parsed.data.id}`);
      this.specs.set(parsed.data.id, parsed.data);
    }
    const canonicalProjects = new Set<string>();
    for (const spec of this.specs.values()) {
      if (!spec.canonical || !spec.projectId) continue;
      if (canonicalProjects.has(spec.projectId)) {
        throw new Error(`Spec 文件包含多个规范版本: ${spec.projectId}`);
      }
      canonicalProjects.add(spec.projectId);
    }
  }

  private async persist(): Promise<void> {
    const payload = JSON.stringify([...this.specs.values()], null, 2);
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

function hashSpecContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isFeishuDocumentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const trustedHost = host === 'feishu.cn'
      || host.endsWith('.feishu.cn')
      || host === 'larksuite.com'
      || host.endsWith('.larksuite.com');
    return url.protocol === 'https:' && trustedHost && url.pathname.startsWith('/docx/');
  } catch {
    return false;
  }
}
