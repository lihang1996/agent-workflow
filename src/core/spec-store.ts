import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
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
  id: z.string().min(1),
  authorOpenId: z.string().min(1),
  content: z.string().min(1),
  docCommentId: z.string().optional(),
  resolved: z.boolean().default(false),
  createdAt: z.string().min(1),
  resolvedAt: z.string().optional(),
});
export type SpecComment = z.infer<typeof SpecCommentSchema>;

export const ProductSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  chatId: z.string().min(1),
  topicId: z.string().min(1),
  messageId: z.string().min(1),
  ownerOpenId: z.string().min(1),
  botId: z.string().min(1),
  questionnaireId: z.string().optional(),
  workflowId: z.string().uuid().optional(),
  status: SpecStatusSchema,
  docId: z.string().optional(),
  docUrl: z.string().url().optional(),
  comments: z.array(SpecCommentSchema).default([]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type ProductSpec = z.infer<typeof ProductSpecSchema>;

/** 产品 Spec 的本地事实源；飞书云文档仅作为发布副本。 */
export class JsonSpecStore {
  private readonly specs = new Map<string, ProductSpec>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  static async open(filePath: string): Promise<JsonSpecStore> {
    const store = new JsonSpecStore(filePath);
    await store.load();
    return store;
  }

  get(id: string): ProductSpec | undefined {
    return this.specs.get(id);
  }

  listByTopic(chatId: string, topicId: string): ProductSpec[] {
    return [...this.specs.values()]
      .filter((spec) => spec.chatId === chatId && spec.topicId === topicId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(input: Omit<ProductSpec, 'id' | 'status' | 'comments' | 'createdAt' | 'updatedAt'>): Promise<ProductSpec> {
    const now = new Date().toISOString();
    const spec: ProductSpec = {
      ...input,
      id: randomUUID().slice(0, 8),
      status: 'pending_confirmation',
      comments: [],
      createdAt: now,
      updatedAt: now,
    };
    this.specs.set(spec.id, spec);
    await this.persist();
    return spec;
  }

  async update(id: string, patch: Partial<Omit<ProductSpec, 'id' | 'createdAt'>>): Promise<ProductSpec> {
    const current = this.get(id);
    if (!current) throw new Error(`Spec 不存在: ${id}`);
    const next: ProductSpec = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.specs.set(id, ProductSpecSchema.parse(next));
    await this.persist();
    return next;
  }

  async addComment(id: string, authorOpenId: string, content: string): Promise<ProductSpec> {
    const spec = this.get(id);
    if (!spec) throw new Error(`Spec 不存在: ${id}`);
    const comment: SpecComment = {
      id: randomUUID().slice(0, 8),
      authorOpenId,
      content,
      resolved: false,
      createdAt: new Date().toISOString(),
    };
    return this.update(id, { comments: [...spec.comments, comment], status: 'changes_requested' });
  }

  async resolveComments(id: string): Promise<ProductSpec> {
    const spec = this.get(id);
    if (!spec) throw new Error(`Spec 不存在: ${id}`);
    const now = new Date().toISOString();
    return this.update(id, {
      comments: spec.comments.map((comment) => comment.resolved
        ? comment
        : { ...comment, resolved: true, resolvedAt: now }),
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
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error(`Spec 文件格式错误: ${this.filePath}`);
    for (const row of rows) {
      const parsed = ProductSpecSchema.safeParse(row);
      if (parsed.success) this.specs.set(parsed.data.id, parsed.data);
    }
  }

  private persist(): Promise<void> {
    const payload = JSON.stringify([...this.specs.values()], null, 2);
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
