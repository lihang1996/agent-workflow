import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

/**
 * 飞书用户身份。
 *
 * open_id 只在单个应用内稳定；user_id 在同一租户内稳定，union_id 在同一
 * 开发者的多个应用间稳定。权限判断必须优先使用后两者。
 */
export interface UserIdentity {
  openId?: string;
  userId?: string;
  unionId?: string;
}

export type IdentityInput = string | UserIdentity;

const IdentityAliasSchema = z.object({
  openId: z.string().trim().min(1).max(200),
  userId: z.string().trim().min(1).max(200).optional(),
  unionId: z.string().trim().min(1).max(200).optional(),
  updatedAt: z.iso.datetime(),
}).refine((row) => !!row.userId || !!row.unionId, {
  message: '身份别名至少需要 userId 或 unionId',
});

type IdentityAlias = z.infer<typeof IdentityAliasSchema>;

function normalize(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

export function normalizeIdentity(input: IdentityInput): UserIdentity {
  if (typeof input === 'string') return { openId: normalize(input) };
  return {
    openId: normalize(input.openId),
    userId: normalize(input.userId),
    unionId: normalize(input.unionId),
  };
}

function identityTokens(identity: UserIdentity): string[] {
  return [
    identity.openId ? `open:${identity.openId}` : '',
    identity.userId ? `user:${identity.userId}` : '',
    identity.unionId ? `union:${identity.unionId}` : '',
  ].filter(Boolean);
}

/**
 * 记录飞书签名事件中出现过的 open_id ↔ user_id/union_id 关系。
 *
 * 这个映射让旧记录（只保存了 open_id）也能在另一 Bot 的卡片回调中被同一
 * 用户控制。传入 filePath 时使用原子写入跨重启保存；测试可直接使用内存模式。
 */
export class IdentityRegistry {
  private aliases = new Map<string, IdentityAlias>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath?: string) {}

  static async open(filePath: string): Promise<IdentityRegistry> {
    const registry = new IdentityRegistry(filePath);
    await registry.load();
    return registry;
  }

  get size(): number {
    return this.aliases.size;
  }

  /** 只有携带稳定 ID 的可信飞书事件才值得写入别名表。 */
  async observe(input: IdentityInput): Promise<void> {
    const identity = normalizeIdentity(input);
    if (!identity.openId || (!identity.userId && !identity.unionId)) return;
    const openId = identity.openId;

    const operation = this.mutationQueue.then(async () => {
      const existing = this.aliases.get(openId);
      if (existing?.userId && identity.userId && existing.userId !== identity.userId) {
        throw new Error(`飞书身份冲突：open_id ${identity.openId} 对应了不同的 user_id`);
      }
      if (existing?.unionId && identity.unionId && existing.unionId !== identity.unionId) {
        throw new Error(`飞书身份冲突：open_id ${identity.openId} 对应了不同的 union_id`);
      }

      const next = IdentityAliasSchema.parse({
        openId,
        userId: identity.userId ?? existing?.userId,
        unionId: identity.unionId ?? existing?.unionId,
        updatedAt: new Date().toISOString(),
      });
      if (
        existing
        && existing.userId === next.userId
        && existing.unionId === next.unionId
      ) return;

      const aliases = new Map(this.aliases);
      aliases.set(next.openId, next);
      await this.persist(aliases);
      this.aliases = aliases;
    });
    this.mutationQueue = operation.catch(() => undefined);
    return operation;
  }

  /** 同一稳定 ID，或经已观察别名链可达，即视为同一个飞书用户。 */
  samePerson(left: IdentityInput, right: IdentityInput): boolean {
    const leftTokens = this.expandTokens(normalizeIdentity(left));
    if (leftTokens.size === 0) return false;
    const rightTokens = this.expandTokens(normalizeIdentity(right));
    return [...leftTokens].some((token) => rightTokens.has(token));
  }

  private expandTokens(identity: UserIdentity): Set<string> {
    const tokens = new Set(identityTokens(identity));
    if (tokens.size === 0) return tokens;
    let changed = true;
    while (changed) {
      changed = false;
      for (const alias of this.aliases.values()) {
        const aliasTokens = identityTokens(alias);
        if (!aliasTokens.some((token) => tokens.has(token))) continue;
        for (const token of aliasTokens) {
          if (tokens.has(token)) continue;
          tokens.add(token);
          changed = true;
        }
      }
    }
    return tokens;
  }

  private async load(): Promise<void> {
    if (!this.filePath) return;
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`飞书身份别名文件不是有效 JSON: ${this.filePath}`, { cause: error });
    }
    if (!Array.isArray(value)) throw new Error(`飞书身份别名文件格式错误: ${this.filePath}`);
    for (const [index, row] of value.entries()) {
      const parsed = IdentityAliasSchema.safeParse(row);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(
          `飞书身份别名文件第 ${index + 1} 条记录格式错误: ${issue?.path.join('.') || '(根)'} ${issue?.message ?? ''}`.trim(),
        );
      }
      if (this.aliases.has(parsed.data.openId)) {
        throw new Error(`飞书身份别名文件包含重复 open_id: ${parsed.data.openId}`);
      }
      this.aliases.set(parsed.data.openId, parsed.data);
    }
  }

  private async persist(aliases: Map<string, IdentityAlias>): Promise<void> {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    const rows = [...aliases.values()].sort((a, b) => a.openId.localeCompare(b.openId));
    try {
      await writeFile(temp, `${JSON.stringify(rows, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, this.filePath);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }
}
