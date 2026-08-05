import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
});
export type SpecComment = z.infer<typeof SpecCommentSchema>;

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
  status: SpecStatusSchema,
  docId: z.string().trim().min(1).max(500).optional(),
  docUrl: z.url().refine((value) => value.startsWith('https://'), '云文档地址必须使用 HTTPS').optional(),
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
});
export type ProductSpec = z.infer<typeof ProductSpecSchema>;

type SpecPatch = Partial<Omit<ProductSpec, 'id' | 'createdAt'>>;

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

  async create(input: Omit<ProductSpec, 'id' | 'status' | 'comments' | 'createdAt' | 'updatedAt'>): Promise<ProductSpec> {
    return this.enqueueMutation(async () => {
      if (input.workflowId && this.findByWorkflowId(input.workflowId)) {
        throw new Error(`工作流 ${input.workflowId} 已经关联产品 Spec`);
      }
      const now = new Date().toISOString();
      const spec = ProductSpecSchema.parse({
        ...input,
        id: randomUUID(),
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
      const next = ProductSpecSchema.parse({
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      });
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
      const next = ProductSpecSchema.parse({
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
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
      const parsed = ProductSpecSchema.safeParse(row);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(
          `Spec 文件第 ${index + 1} 条记录格式错误: ${issue?.path.join('.') || '(根)'} ${issue?.message ?? ''}`.trim(),
        );
      }
      if (this.specs.has(parsed.data.id)) throw new Error(`Spec 文件包含重复 ID: ${parsed.data.id}`);
      this.specs.set(parsed.data.id, parsed.data);
    }
  }

  private async persist(): Promise<void> {
    const payload = JSON.stringify([...this.specs.values()], null, 2);
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
