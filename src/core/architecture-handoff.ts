import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { isTaskOwner, type OperatorIdentity } from './identity.js';
import type { ProductSpecFlow, ProductSpecFlowStore } from './product-spec.js';

/**
 * T-020：PRD→开发架构的显式交接引用（13 号 C2 / work/30）。
 *
 * 背景：`IncomingMessage` 没有可信 flowToken，另一会话不能靠 thread/task hash
 * 猜测关联 PRD；CLI 自报的上游 token/URL 一律不可信。因此上游关系只能由
 * 服务端签发：**用户在已批准 PRD 的确认卡上点击「转架构设计」**（卡片回调携带
 * 服务端签发的 flowToken，不可伪造），服务端据此创建本交接记录。
 *
 * 交接码（token）是 32 位随机十六进制 capability：
 * - 唯一、单次使用（consume 后不可重放）、绑定创建者（PRD owner）；
 * - 开发 Bot 提交架构设计时必须在工具调用中携带，服务端查库核验——
 *   零个候选（未知/已消费/已关闭/owner 不符）失败关闭，不挑「看起来像」的；
 * - 交接 ≠ 架构批准 ≠ 编码授权：三个状态彼此独立，本模块只做交接。
 *
 * A07（Codex 深度审查批）：增加文件持久化（JSON + tmp+rename 原子写，模式
 * 对齐 product-spec-store），重启后交接码不丢、已消费状态可恢复。构造参数
 * filePath 缺省 = 纯内存（兼容既有测试与纯内存用法；生产入口在 index.ts 传
 * data/architecture-handoffs.json——不把「默认路径」留给无参构造，避免测试
 * 在仓库工作目录读写生产文件）。坏文件在构造处失败关闭（对齐既有 store）。
 * 记录无有效期字段（capability 以状态机 open/consumed/closed 失效），无需
 * 恢复期过期校验；若未来增加 expiresAt，恢复处须校验。
 *
 * 创建协议：open→reserved（稳定 flowToken + 操作摘要）→consumed。
 * 预留持久化在 flow 创建之前，匹配重试幂等恢复；旧 consumed 无预留身份仍拒绝。
 */
export interface ArchitectureHandoff {
  token: string;
  prdToken: string;
  /** 交接锚定的 PRD 版本摘要；消费时必须与 PRD flow 当前绑定摘要一致。 */
  prdDigest: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  /** 交接创建时 PRD 的任务/会话（知识引用核验沿用 PRD 的台账绑定）。 */
  prdTaskId: string;
  prdSessionId: string;
  createdAt: string;
  status: 'open' | 'reserved' | 'consumed' | 'closed';
  reservationDigest?: string;
  consumedAt?: string;
  consumedByTaskId?: string;
  /**
   * A07（166 号返工）：消费后绑定的架构 flow token（审计用；消费先于 flow
   * 创建，绑定失败不影响「同一交接码最多一个有效 flow」的不变量）。
   */
  flowToken?: string;
}

/** A07：持久化记录 schema（strict；坏行在加载处失败关闭）。 */
const HandoffRecordSchema = z.object({
  token: z.string().min(1),
  prdToken: z.string().min(1),
  prdDigest: z.string().regex(/^[0-9a-f]{64}$/),
  ownerOpenId: z.string().min(1),
  ownerUnionId: z.string().min(1).optional(),
  prdTaskId: z.string().min(1),
  prdSessionId: z.string().min(1),
  createdAt: z.string().min(1),
  status: z.enum(['open', 'reserved', 'consumed', 'closed']),
  reservationDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  consumedAt: z.string().min(1).optional(),
  consumedByTaskId: z.string().min(1).optional(),
  flowToken: z.string().min(1).optional(),
}).strict();

export interface CreateArchitectureHandoffOptions {
  prdToken: string;
  prdDigest: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  prdTaskId: string;
  prdSessionId: string;
  now?: () => Date;
}

export class ArchitectureHandoffStore {
  private readonly handoffs = new Map<string, ArchitectureHandoff>();

  constructor(private readonly filePath?: string) {
    this.load();
  }

  /** A07：缺文件 = 空库；坏文件/坏行抛错失败关闭（不静默剔除）。 */
  private load(): void {
    if (!this.filePath) return;
    let content: string;
    try {
      content = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const rows: unknown = JSON.parse(content);
    if (!Array.isArray(rows)) {
      throw new Error(`架构交接台账文件格式错误: ${this.filePath}`);
    }
    for (const row of rows) {
      const result = HandoffRecordSchema.safeParse(row);
      if (!result.success) {
        throw new Error(`架构交接台账记录无效: ${this.filePath}: ${result.error.message}`);
      }
      this.handoffs.set(result.data.token, result.data);
    }
  }

  /**
   * A07（166 号返工）：tmp+rename 原子写，**唯一临时文件名**（固定 .tmp 在
   * 并发写下互相破坏，见 json-state.ts 同批修复）；失败清理自建临时文件。
   */
  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify([...this.handoffs.values()], null, 2)}\n`, 'utf8');
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try { rmSync(temporaryPath, { force: true }); } catch { /* 尽力清理 */ }
      throw error;
    }
  }

  /**
   * A07（166 号返工）：快照是**深拷贝**（structuredClone）——旧实现 new Map
   * 只复制容器，consume/close 原地改字段后持久化失败装回的还是同一批已改
   * 对象（内存 consumed、磁盘 open）。配合下面的不可变更新（状态迁移生成
   * 新记录对象），失败回滚后内存与磁盘逐字段一致。
   */
  private mutate<T>(operation: () => T): T {
    const previous = new Map(structuredClone([...this.handoffs]) as [string, ArchitectureHandoff][]);
    try {
      const result = operation();
      this.persist();
      return result;
    } catch (error) {
      this.handoffs.clear();
      for (const [key, value] of previous) this.handoffs.set(key, value);
      throw error;
    }
  }

  /** 返回克隆（外部拿到引用也改不到存储内的记录）。 */
  get(token: string): ArchitectureHandoff | undefined {
    const found = this.handoffs.get(token);
    return found ? structuredClone(found) : undefined;
  }

  /** 同一 PRD 同时只保留一个 open 交接：重复点击幂等返回既有交接。 */
  openFor(prdToken: string): ArchitectureHandoff | undefined {
    const found = [...this.handoffs.values()].find(
      (handoff) => handoff.prdToken === prdToken && ['open', 'reserved'].includes(handoff.status),
    );
    return found ? structuredClone(found) : undefined;
  }

  create(options: CreateArchitectureHandoffOptions): ArchitectureHandoff {
    return this.mutate(() => {
      const existing = this.openFor(options.prdToken);
      if (existing) return existing;
      const now = (options.now ?? (() => new Date()))();
      const handoff: ArchitectureHandoff = {
        token: randomUUID().replaceAll('-', ''),
        prdToken: options.prdToken,
        prdDigest: options.prdDigest,
        ownerOpenId: options.ownerOpenId,
        ...(options.ownerUnionId ? { ownerUnionId: options.ownerUnionId } : {}),
        prdTaskId: options.prdTaskId,
        prdSessionId: options.prdSessionId,
        createdAt: now.toISOString(),
        status: 'open',
      };
      this.handoffs.set(handoff.token, handoff);
      return structuredClone(handoff);
    });
  }

  /**
   * 消费交接（A07 166 号返工：**消费先于 flow 创建**——见 architecture-flow）：
   * 只有 open 且 owner 匹配的交接可被消费；消费动作单次有效，**不可变更新**
   * （生成新记录对象）。返回 undefined = 无有效候选，失败关闭。
   */
  consume(
    token: string,
    consumer: { taskId: string; ownerOpenId: string },
    now?: () => Date,
  ): ArchitectureHandoff | undefined {
    return this.mutate(() => {
      const handoff = this.handoffs.get(token);
      if (!handoff || handoff.status !== 'open') return undefined;
      if (handoff.ownerOpenId !== consumer.ownerOpenId) return undefined;
      const consumed: ArchitectureHandoff = {
        ...handoff,
        status: 'consumed',
        consumedAt: (now ?? (() => new Date()))().toISOString(),
        consumedByTaskId: consumer.taskId,
      };
      this.handoffs.set(token, consumed);
      return structuredClone(consumed);
    });
  }

  /** Durable intent before flow persistence; matching retries reuse the same token. */
  reserveCreation(token: string, consumer: { taskId: string; ownerOpenId: string; digest: string }): ArchitectureHandoff | undefined {
    return this.mutate(() => {
      const handoff = this.handoffs.get(token);
      if (!handoff || handoff.ownerOpenId !== consumer.ownerOpenId || handoff.status === 'closed') return undefined;
      if (handoff.status !== 'open') {
        return handoff.consumedByTaskId === consumer.taskId
          && handoff.reservationDigest === consumer.digest && handoff.flowToken
          ? structuredClone(handoff) : undefined;
      }
      const reserved: ArchitectureHandoff = { ...handoff, status: 'reserved',
        consumedByTaskId: consumer.taskId, reservationDigest: consumer.digest,
        flowToken: randomUUID().replaceAll('-', '') };
      this.handoffs.set(token, reserved);
      return structuredClone(reserved);
    });
  }

  /**
   * A07（166 号返工）：为已消费交接绑定 flow token（审计）。绑定失败只警告
   * 不回滚消费——「同一交接码最多一个有效 flow」由消费先行保证，与本绑定
   * 无关；调用方据此可继续交付确认卡。
   */
  markFlowCreated(token: string, flowToken: string): ArchitectureHandoff | undefined {
    return this.mutate(() => {
      const handoff = this.handoffs.get(token);
      if (!handoff || !['reserved', 'consumed'].includes(handoff.status) || (handoff.flowToken && handoff.flowToken !== flowToken)) return undefined;
      const updated: ArchitectureHandoff = { ...handoff, status: 'consumed', consumedAt: handoff.consumedAt ?? new Date().toISOString(), flowToken };
      this.handoffs.set(token, updated);
      return structuredClone(updated);
    });
  }

  /** PRD 失效级联：关闭该 PRD 的全部 open 交接（不可变更新），返回关闭数量。 */
  closeForPrd(prdToken: string): number {
    return this.mutate(() => {
      let closed = 0;
      for (const [token, handoff] of this.handoffs) {
        if (handoff.prdToken === prdToken && ['open', 'reserved'].includes(handoff.status)) {
          this.handoffs.set(token, { ...handoff, status: 'closed' });
          closed += 1;
        }
      }
      return closed;
    });
  }
}

/**
 * 从已批准 PRD 打开架构交接（卡片动作路径）。失败关闭条件：
 * - PRD 不存在 / 不是 prd 制品 / 未批准 / 未绑定摘要（旧记录）；
 *   （零个或多个候选上游都拒绝——token 精确查库天然唯一，仍显式断言。）
 * - 操作者不是 PRD owner。
 */
export function openArchitectureHandoff(options: {
  flows: Pick<ProductSpecFlowStore, 'get'>;
  handoffs: ArchitectureHandoffStore;
  prdToken: string;
  operator: OperatorIdentity;
  now?: () => Date;
}): ArchitectureHandoff {
  const flow = options.flows.get(options.prdToken);
  if (!flow) throw new Error('找不到这份产品方案，无法创建架构交接。');
  if ((flow.artifact_kind ?? 'prd') !== 'prd') {
    throw new Error('只有产品方案（PRD）可以作为架构设计的上游，架构制品不能再次交接。');
  }
  if (flow.status !== 'approved') {
    throw new Error('产品方案尚未确认（或已失效），不能转架构设计。');
  }
  if (flow.content_digest == null) {
    throw new Error('这份确认记录没有绑定内容摘要（旧记录），不能作为架构上游；需重新生成方案并确认。');
  }
  if (!isTaskOwner(flow, options.operator)) {
    throw new Error('只有任务发起人可以把这份方案转交架构设计。');
  }
  return options.handoffs.create({
    prdToken: flow.token,
    prdDigest: flow.content_digest,
    ownerOpenId: flow.ownerOpenId,
    ...(flow.ownerUnionId ? { ownerUnionId: flow.ownerUnionId } : {}),
    prdTaskId: flow.taskId,
    prdSessionId: flow.sessionId,
    ...(options.now ? { now: options.now } : {}),
  });
}

/** 校验交接并解析唯一上游 PRD（零个或多个候选一律失败关闭）。 */
export function resolveHandoffUpstream(options: {
  flows: Pick<ProductSpecFlowStore, 'get'>;
  handoffs: Pick<ArchitectureHandoffStore, 'get'>;
  handoffToken: string;
}): { handoff: ArchitectureHandoff; prd: ProductSpecFlow } {
  const handoff = options.handoffs.get(options.handoffToken);
  if (!handoff || handoff.status === 'closed' || (handoff.status !== 'open' && !handoff.reservationDigest)) {
    throw new Error('架构交接码无效（不存在、已使用或已关闭）：需在已确认的产品方案卡片上重新发起架构交接。');
  }
  const candidates = [options.flows.get(handoff.prdToken)].filter(
    (flow): flow is ProductSpecFlow =>
      !!flow
      && (flow.artifact_kind ?? 'prd') === 'prd'
      && flow.status === 'approved'
      && flow.content_digest != null
      && flow.content_digest === handoff.prdDigest,
  );
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length === 0
        ? '架构交接对应的上游产品方案已失效或版本变化（无有效候选），需重新确认 PRD 后再次交接。'
        : '架构交接解析到多个候选上游产品方案，失败关闭。',
    );
  }
  return { handoff, prd: candidates[0] };
}
