import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { CLI_IDS } from '../cli/types.js';
import { ModelSelectionSchema } from './model-selection.js';
import type { Session } from './session-manager.js';

export interface SessionStore {
  load(): Promise<Session[]>;
  save(sessions: Session[]): Promise<void>;
}

const SessionSchema = z.object({
  version: z.number().int().nonnegative().default(0),
  owner: z.object({ ownerOpenId: z.string(), ownerUnionId: z.string().optional(), ownerBotId: z.string().optional() }).optional(),
  id: z.string().min(1),
  botId: z.string().min(1),
  threadId: z.string().min(1),
  chatId: z.string().min(1),
  cliId: z.enum(CLI_IDS),
  cliSessionId: z.string().min(1).optional(),
  // 旧记录没有该字段：按「模型绑定不可核验」读取（缺失≠原生默认），不在加载层补造。
  cliModelSelection: ModelSelectionSchema.optional(),
  workspaceDir: z.string().min(1),
  status: z.enum(['creating', 'active', 'idle', 'closed']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

function recoverInterruptedSession(session: Session): Session {
  if (session.status !== 'creating' && session.status !== 'active')
    return session;
  return { ...session, status: 'idle' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function migrateLegacySession(
  row: unknown,
  legacyBotId: string,
  defaultWorkspaces: Readonly<Record<string, string>>,
): { candidate: unknown; migrated: boolean } {
  if (!isRecord(row)) return { candidate: row, migrated: false };

  const needsBotId = !('botId' in row);
  const needsWorkspace = !('workspaceDir' in row);
  if (!needsBotId && !needsWorkspace) {
    return { candidate: row, migrated: false };
  }

  const candidate: Record<string, unknown> = { ...row };
  if (needsBotId) candidate.botId = legacyBotId;
  const botId =
    typeof candidate.botId === 'string' ? candidate.botId : legacyBotId;
  if (needsWorkspace) {
    candidate.workspaceDir = defaultWorkspaces[botId] ?? process.cwd();
  }
  return { candidate, migrated: true };
}

export class JsonSessionStore implements SessionStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly legacyBotId = 'default',
    private readonly defaultWorkspaces: Readonly<Record<string, string>> = {},
  ) {}

  async load(): Promise<Session[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const rows: unknown = JSON.parse(content);
    if (!Array.isArray(rows)) {
      throw new Error(`会话文件格式错误: ${this.filePath}`);
    }

    const sessions: Session[] = [];
    let needsCleanup = false;
    for (const row of rows) {
      const { candidate, migrated } = migrateLegacySession(
        row,
        this.legacyBotId,
        this.defaultWorkspaces,
      );
      const result = SessionSchema.safeParse(candidate);
      if (!result.success) {
        needsCleanup = true;
        continue;
      }
      if (migrated) needsCleanup = true;

      const recovered = recoverInterruptedSession(result.data);
      if (recovered.status !== result.data.status) needsCleanup = true;
      sessions.push(recovered);
    }
    if (needsCleanup) await this.save(sessions);
    return sessions;
  }

  save(sessions: Session[]): Promise<void> {
    const snapshot = JSON.stringify(sessions, null, 2);
    const write = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      // A08（166 号返工）：唯一临时文件名（固定 .tmp 在并发写下互相破坏）+
      // 失败清理自建临时文件。
      const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(tempPath, `${snapshot}\n`, 'utf8');
        await rename(tempPath, this.filePath);
      } catch (error) {
        try { await rm(tempPath, { force: true }); } catch { /* 尽力清理 */ }
        throw error;
      }
    };

    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }
}
