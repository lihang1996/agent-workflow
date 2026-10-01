import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';
import { CollaborationOriginSchema } from './collaboration.js';
import {
  ContentSourceSchema,
  KnowledgeRefSchema,
  ProductSpecRequestSchema,
  ArchitectureRequestSchema,
  ProductSpecFlowStore,
  type ContentSource,
  type CreateProductSpecFlowOptions,
  type ProductSpecFlow,
} from './product-spec.js';

/**
 * W5 迁移：旧记录缺新字段时读入补默认（artifact_kind="prd"、content_digest=null、
 * status 保持）；含 digest=null 的 approved 旧记录不得用于授权编码（G2 拒绝，
 * 见 artifact-digest.ts 的 assertArtifactAuthorizable）。未知 status 值在枚举
 * 校验处失败关闭，不会以坏行静默剔除。
 */
const ArchitectureUpstreamSchema = z.object({
  prdToken: z.string().min(1).max(128),
  prdDigest: z.string().regex(/^[0-9a-f]{64}$/),
  approvedAt: z.iso.datetime().optional(),
  approvalMessageId: z.string().min(1).optional(),
  prdTaskId: z.string().min(1),
  prdSessionId: z.string().min(1),
  knowledgeRefs: z.array(KnowledgeRefSchema).default([]),
  knowledgeState: z
    .enum(['ok', 'new_project_no_baseline', 'degraded', 'no_current_objects'])
    .nullish()
    .default(null),
}).strict();
const ProductSpecFlowSchema = z.object({
  sessionVersion: z.number().int().nonnegative().default(0),
  token: z.string().min(1),
  taskId: z.string().min(1),
  botId: z.string().min(1),
  sessionId: z.string().min(1),
  ownerOpenId: z.string().min(1),
  ownerUnionId: z.string().min(1).optional(),
  ownerBotId: z.string().optional(),
  approvalMessageId: z.string().optional(),
  collaboration: CollaborationOriginSchema.optional(),
  request: z.union([ProductSpecRequestSchema, ArchitectureRequestSchema]),
  status: z.enum(['pending', 'approved', 'expired', 'invalidated']),
  approvedAt: z.iso.datetime().optional(),
  artifact_kind: z.enum(['prd', 'architecture']).default('prd'),
  content_digest: z.string().regex(/^[0-9a-f]{64}$/).nullish().default(null),
  digest_algorithm: z.literal('canonical-sha256-v1').default('canonical-sha256-v1'),
  content_sources: z.array(ContentSourceSchema).default([]),
  knowledge_refs: z.array(KnowledgeRefSchema).default([]),
  knowledge_state: z
    .enum(['ok', 'new_project_no_baseline', 'degraded', 'no_current_objects'])
    .nullish()
    .default(null),
  invalidation_reason: z.string().min(1).max(200).optional(),
  upstream: ArchitectureUpstreamSchema.optional(),
});

export class JsonProductSpecFlowStore extends ProductSpecFlowStore {
  constructor(private readonly filePath: string) {
    super(loadFlows(filePath));
  }

  override create(options: CreateProductSpecFlowOptions): ProductSpecFlow {
    return this.mutate(() => super.create(options));
  }

  override createWithToken(token: string, options: CreateProductSpecFlowOptions): ProductSpecFlow {
    // Call the base operation inside one persistence transaction. Its this.create
    // uses this store's write guard; the outer snapshot still restores all state.
    return this.mutate(() => super.createWithToken(token, options));
  }

  override approve(token: string, messageId?: string): ProductSpecFlow | undefined {
    return this.mutate(() => super.approve(token, messageId));
  }

  override invalidate(token: string, reason: string): ProductSpecFlow | undefined {
    return this.mutate(() => super.invalidate(token, reason));
  }

  override rebindDigest(
    token: string,
    contentDigest: string,
    contentSources: ContentSource[],
  ): ProductSpecFlow | undefined {
    return this.mutate(() => super.rebindDigest(token, contentDigest, contentSources));
  }

  private mutate<T>(operation: () => T): T {
    const previous = this.snapshot();
    try {
      const result = operation();
      this.persist();
      return result;
    } catch (error) {
      this.restore(previous);
      throw error;
    }
  }

  /**
   * A08（166 号返工）：唯一临时文件名（固定 .tmp 在并发写下互相破坏）+
   * 失败清理；snapshot 深拷贝保证 mutate 回滚的是完整旧状态。
   */
  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporaryPath,
        `${JSON.stringify(this.snapshot(), null, 2)}\n`,
        'utf8',
      );
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try { rmSync(temporaryPath, { force: true }); } catch { /* 尽力清理 */ }
      throw error;
    }
  }
}

function loadFlows(filePath: string): ProductSpecFlow[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rows: unknown = JSON.parse(content);
  if (!Array.isArray(rows)) {
    throw new Error(`产品方案状态文件格式错误: ${filePath}`);
  }
  return rows.flatMap((row) => {
    const result = ProductSpecFlowSchema.safeParse(row);
    if (!result.success) throw new Error(`产品方案状态记录无效: ${filePath}: ${result.error.message}`);
    return [{ ...result.data, ownerBotId: result.data.ownerBotId ?? result.data.collaboration?.fromBotId ?? result.data.botId }];
  });
}
