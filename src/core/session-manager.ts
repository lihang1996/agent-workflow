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
  topicId?: string;
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
  closed: [],
};

/** 话题 ID：优先 thread，其次 root，最后消息本身。 */
function topicIdOf(message: MessageAddress): string {
  return message.topicId?.trim() || message.threadId || message.rootId || message.messageId;
}

/** 会话索引键：同一话题下按 bot 隔离。 */
function sessionKey(chatId: string, threadId: string, botId: string): string {
  return `${chatId}:${threadId}:${botId}`;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private mutationQueue: Promise<void> = Promise.resolve();
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
    const restoredIds = new Set<string>();
    for (const session of restored) {
      const key = sessionKey(session.chatId, session.threadId, session.botId);
      if (restoredIds.has(session.id)) throw new Error(`会话文件包含重复 ID: ${session.id}`);
      if (manager.sessions.has(key)) {
        throw new Error(`会话文件包含重复话题角色: ${session.chatId}/${session.threadId}/${session.botId}`);
      }
      restoredIds.add(session.id);
      manager.sessions.set(key, session);
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
    return this.enqueueMutation(async () => {
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
    });
  }

  /** 按状态机切换会话状态。 */
  async transition(sessionId: string, nextStatus: SessionStatus): Promise<Session> {
    return this.enqueueMutation(async () => {
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
    });
  }

  /** 绑定 CLI 引擎侧 session id（用于 resume）。 */
  async setCliSessionId(sessionId: string, cliSessionId: string): Promise<Session> {
    return this.enqueueMutation(async () => {
      const current = this.get(sessionId);
      if (!current) throw new Error(`会话不存在: ${sessionId}`);
      if (!cliSessionId.trim()) throw new Error('CLI 会话 ID 不能为空');

      const updated: Session = {
        ...current,
        cliSessionId: cliSessionId.trim(),
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
    });
  }

  /** 切换执行引擎；会清空旧引擎的 CLI 会话，避免跨引擎 resume。 */
  async setCliId(sessionId: string, cliId: CliId): Promise<Session> {
    return this.enqueueMutation(async () => {
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
    });
  }

  /** 清理 CLI 上下文（下次任务会开新的引擎会话）；不关闭 Agent OS 会话。 */
  async clearCliContext(sessionId: string): Promise<Session> {
    return this.enqueueMutation(async () => {
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
    });
  }

  /** 清理同一话题下所有角色的 CLI 上下文（例如切换项目目录后）。 */
  async clearCliContextForTopic(chatId: string, threadId: string): Promise<number> {
    return this.enqueueMutation(async () => {
      const changes: Array<{ key: string; previous: Session; next: Session }> = [];
      for (const [key, session] of this.sessions) {
        if (session.chatId !== chatId || session.threadId !== threadId) continue;
        if (session.status === 'active' || session.status === 'closed') continue;
        if (!session.cliSessionId) continue;
        const next: Session = {
          ...session,
          cliSessionId: undefined,
          status: session.status === 'creating' ? 'creating' : 'idle',
          updatedAt: this.now().toISOString(),
        };
        changes.push({ key, previous: session, next });
        this.sessions.set(key, next);
      }
      if (changes.length === 0) return 0;
      try {
        await this.persist();
      } catch (error) {
        for (const change of changes) {
          if (this.sessions.get(change.key) === change.next) {
            this.sessions.set(change.key, change.previous);
          }
        }
        throw error;
      }
      return changes.length;
    });
  }

  /** 重新打开已关闭会话，并清空 CLI 上下文。 */
  async reopen(sessionId: string): Promise<Session> {
    return this.enqueueMutation(async () => {
      const current = this.get(sessionId);
      if (!current) throw new Error(`会话不存在: ${sessionId}`);
      if (current.status !== 'closed') {
        throw new Error('当前会话未关闭，无需 reopen');
      }

      const updated: Session = {
        ...current,
        cliSessionId: undefined,
        status: 'idle',
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
    });
  }

  /** 删除所有已关闭会话，释放 sessions.json。 */
  async purgeClosed(): Promise<number> {
    return this.enqueueMutation(async () => {
      const removedEntries: Array<[string, Session]> = [];
      for (const [key, session] of [...this.sessions.entries()]) {
        if (session.status !== 'closed') continue;
        removedEntries.push([key, session]);
        this.sessions.delete(key);
      }
      if (removedEntries.length === 0) return 0;
      try {
        await this.persist();
      } catch (error) {
        for (const [key, session] of removedEntries) {
          if (!this.sessions.has(key)) this.sessions.set(key, session);
        }
        throw error;
      }
      return removedEntries.length;
    });
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

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}
