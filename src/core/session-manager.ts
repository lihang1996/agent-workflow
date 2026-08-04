import { randomUUID } from 'node:crypto';
import type { CliId } from '../cli/types.js';
import type { SessionStore } from './session-store.js';

export type SessionStatus = 'creating' | 'active' | 'idle' | 'closed';

export interface Session {
  id: string;
  botId: string;
  threadId: string;
  chatId: string;
  cliId: CliId;
  cliSessionId?: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MessageAddress {
  messageId: string;
  chatId: string;
  threadId: string;
  rootId: string;
  botId: string;
}

export interface ResolvedSession {
  session: Session;
  isNew: boolean;
}

export interface SessionManagerOptions {
  now?: () => Date;
  createId?: () => string;
  store?: SessionStore;
  defaultCliId?: CliId;
}

const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  creating: ['active', 'closed'],
  active: ['idle', 'closed'],
  idle: ['active', 'closed'],
  closed: ['idle'], // /reopen
};

/** 话题 ID：优先 thread，其次 root，最后消息本身。 */
function topicIdOf(message: MessageAddress): string {
  return message.threadId || message.rootId || message.messageId;
}

/** 会话索引键：同一话题下按 bot 隔离。 */
function sessionKey(chatId: string, threadId: string, botId: string): string {
  return `${chatId}:${threadId}:${botId}`;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly store?: SessionStore;
  private readonly defaultCliId: CliId;

  constructor(options: SessionManagerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.store = options.store;
    this.defaultCliId = options.defaultCliId ?? 'claude';
  }

  /** 从持久化存储恢复会话管理器。 */
  static async open(options: SessionManagerOptions = {}): Promise<SessionManager> {
    const manager = new SessionManager(options);
    const restored = await options.store?.load() ?? [];
    for (const session of restored) {
      manager.sessions.set(
        sessionKey(session.chatId, session.threadId, session.botId),
        session,
      );
    }
    return manager;
  }

  get size(): number {
    return this.sessions.size;
  }

  /** 按会话 UUID 查找。 */
  get(sessionId: string): Session | undefined {
    return [...this.sessions.values()].find((session) => session.id === sessionId);
  }

  /** 解析或创建「话题 + Bot」对应的会话。 */
  async resolve(message: MessageAddress): Promise<ResolvedSession> {
    const threadId = topicIdOf(message);
    const key = sessionKey(message.chatId, threadId, message.botId);
    const existing = this.sessions.get(key);
    if (existing) return { session: existing, isNew: false };

    const now = this.now().toISOString();
    const session: Session = {
      id: this.createId(),
      botId: message.botId,
      threadId,
      chatId: message.chatId,
      cliId: this.defaultCliId,
      status: 'creating',
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(key, session);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
      throw error;
    }
    return { session, isNew: true };
  }

  /** 按状态机切换会话状态。 */
  async transition(sessionId: string, nextStatus: SessionStatus): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new Error(`会话 ${current.status} 不能切换到 ${nextStatus}`);
    }

    const updated: Session = {
      ...current,
      status: nextStatus,
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.chatId, updated.threadId, updated.botId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  /** 绑定 CLI 引擎侧 session id（用于 resume）。 */
  async setCliSessionId(sessionId: string, cliSessionId: string): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (!cliSessionId) throw new Error('CLI 会话 ID 不能为空');

    const updated: Session = {
      ...current,
      cliSessionId,
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.chatId, updated.threadId, updated.botId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  /** 切换执行引擎；会清空旧引擎的 CLI 会话，避免跨引擎 resume。 */
  async setCliId(sessionId: string, cliId: CliId): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (current.status === 'active') {
      throw new Error('任务执行中，无法切换引擎');
    }
    if (current.status === 'closed') {
      throw new Error('会话已关闭，请先 /reopen');
    }
    if (current.cliId === cliId) return current;

    const updated: Session = {
      ...current,
      cliId,
      cliSessionId: undefined,
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.chatId, updated.threadId, updated.botId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  /** 清理 CLI 上下文（下次任务会开新的引擎会话）；不关闭 Agent OS 会话。 */
  async clearCliContext(sessionId: string): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (current.status === 'active') {
      throw new Error('任务执行中，无法清理上下文');
    }
    if (current.status === 'closed') {
      throw new Error('会话已关闭，请先 /reopen');
    }
    if (!current.cliSessionId && current.status === 'idle') return current;

    const updated: Session = {
      ...current,
      cliSessionId: undefined,
      status: current.status === 'creating' ? 'creating' : 'idle',
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.chatId, updated.threadId, updated.botId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current);
      throw error;
    }
    return updated;
  }

  /** 清理同一话题下所有角色的 CLI 上下文（例如切换项目目录后）。 */
  async clearCliContextForTopic(chatId: string, threadId: string): Promise<number> {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.chatId !== chatId || session.threadId !== threadId) continue;
      if (session.status === 'active' || session.status === 'closed') continue;
      if (!session.cliSessionId) continue;
      await this.clearCliContext(session.id);
      count += 1;
    }
    return count;
  }

  /** 重新打开已关闭会话，并清空 CLI 上下文。 */
  async reopen(sessionId: string): Promise<Session> {
    const current = this.get(sessionId);
    if (!current) throw new Error(`会话不存在: ${sessionId}`);
    if (current.status !== 'closed') {
      throw new Error('当前会话未关闭，无需 reopen');
    }

    const reopened = await this.transition(sessionId, 'idle');
    const updated: Session = {
      ...reopened,
      cliSessionId: undefined,
      updatedAt: this.now().toISOString(),
    };
    const key = sessionKey(updated.chatId, updated.threadId, updated.botId);
    this.sessions.set(key, updated);
    try {
      await this.persist();
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, reopened);
      throw error;
    }
    return updated;
  }

  /** 删除所有已关闭会话，释放 sessions.json。 */
  async purgeClosed(): Promise<number> {
    const before = this.sessions.size;
    for (const [key, session] of [...this.sessions.entries()]) {
      if (session.status === 'closed') this.sessions.delete(key);
    }
    const removed = before - this.sessions.size;
    if (removed > 0) await this.persist();
    return removed;
  }

  /** 列出某话题下所有角色会话。 */
  listByTopic(chatId: string, threadId: string): Session[] {
    return [...this.sessions.values()]
      .filter((session) => session.chatId === chatId && session.threadId === threadId)
      .sort((a, b) => a.botId.localeCompare(b.botId));
  }

  /** 写入底层 SessionStore。 */
  private async persist(): Promise<void> {
    await this.store?.save([...this.sessions.values()]);
  }
}
