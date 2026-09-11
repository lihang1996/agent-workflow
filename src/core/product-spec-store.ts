import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { CollaborationOriginSchema } from './collaboration.js';
import {
  ProductSpecRequestSchema,
  ProductSpecFlowStore,
  type CreateProductSpecFlowOptions,
  type ProductSpecFlow,
} from './product-spec.js';

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
  request: ProductSpecRequestSchema,
  status: z.enum(['pending', 'approved', 'expired']),
  approvedAt: z.iso.datetime().optional(),
});

export class JsonProductSpecFlowStore extends ProductSpecFlowStore {
  constructor(private readonly filePath: string) {
    super(loadFlows(filePath));
  }

  override create(options: CreateProductSpecFlowOptions): ProductSpecFlow {
    return this.mutate(() => super.create(options));
  }

  override approve(token: string, messageId?: string): ProductSpecFlow | undefined {
    return this.mutate(() => super.approve(token, messageId));
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

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(this.snapshot(), null, 2)}\n`,
      'utf8',
    );
    renameSync(temporaryPath, this.filePath);
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
