import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Session } from './session-manager.js';

export interface SessionStore {
  load(): Promise<Session[]>;
  save(sessions: Session[]): Promise<void>;
}

const SessionSchema = z.object({
  id: z.string().trim().min(1).max(200),
  botId: z.string().trim().min(1).max(100).default('dev'),
  threadId: z.string().trim().min(1).max(200),
  chatId: z.string().trim().min(1).max(200),
  cliId: z.enum(['claude', 'codex']),
  cliSessionId: z.string().trim().min(1).max(500).optional(),
  status: z.enum(['creating', 'active', 'idle', 'closed']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** 启动时把中断残留的 creating/active 收成 idle。 */
function recoverInterruptedSession(session: Session): Session {
  if (session.status !== 'creating' && session.status !== 'active') return session;
  return { ...session, status: 'idle' };
}

export class JsonSessionStore implements SessionStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /** 加载会话；顺带修复异常中断状态。 */
  async load(): Promise<Session[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    let rows: unknown;
    try {
      rows = JSON.parse(content);
    } catch (error) {
      throw new Error(`会话文件不是有效 JSON: ${this.filePath}`, { cause: error });
    }
    if (!Array.isArray(rows)) {
      throw new Error(`会话文件格式错误: ${this.filePath}`);
    }

    const parsedSessions: Session[] = [];
    const ids = new Set<string>();
    const topicRoles = new Set<string>();
    let needsCleanup = false;
    for (const [index, row] of rows.entries()) {
      const result = SessionSchema.safeParse(row);
      if (!result.success) {
        const issue = result.error.issues[0];
        throw new Error(
          `会话文件第 ${index + 1} 条记录格式错误: ${issue?.path.join('.') || '(根)'} ${issue?.message ?? ''}`.trim(),
        );
      }

      if (ids.has(result.data.id)) throw new Error(`会话文件包含重复 ID: ${result.data.id}`);
      const topicRole = JSON.stringify([result.data.chatId, result.data.threadId, result.data.botId]);
      if (topicRoles.has(topicRole)) {
        throw new Error(`会话文件包含重复话题角色: ${result.data.chatId}/${result.data.threadId}/${result.data.botId}`);
      }
      ids.add(result.data.id);
      topicRoles.add(topicRole);
      parsedSessions.push(result.data);
    }
    const sessions = parsedSessions.map((session) => {
      const recovered = recoverInterruptedSession(session);
      if (recovered.status !== session.status) needsCleanup = true;
      return recovered;
    });
    if (needsCleanup) await this.save(sessions);
    return sessions;
  }

  /** 串行原子写入 sessions.json。 */
  save(sessions: Session[]): Promise<void> {
    const parsed = sessions.map((session) => SessionSchema.parse(session));
    assertUniqueSessions(parsed);
    const snapshot = JSON.stringify(parsed, null, 2);
    const write = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(tempPath, `${snapshot}\n`, 'utf8');
        await rename(tempPath, this.filePath);
      } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        throw error;
      }
    };

    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }
}

function assertUniqueSessions(sessions: Session[]): void {
  const ids = new Set<string>();
  const topicRoles = new Set<string>();
  for (const session of sessions) {
    if (ids.has(session.id)) throw new Error(`会话包含重复 ID: ${session.id}`);
    const topicRole = JSON.stringify([session.chatId, session.threadId, session.botId]);
    if (topicRoles.has(topicRole)) {
      throw new Error(`会话包含重复话题角色: ${session.chatId}/${session.threadId}/${session.botId}`);
    }
    ids.add(session.id);
    topicRoles.add(topicRole);
  }
}
