import { randomUUID } from 'node:crypto';
import type { TaskOwner } from './identity.js';
import type { CliId } from '../cli/types.js';
import type { SessionStore } from './session-store.js';

export type SessionStatus = 'creating' | 'active' | 'idle' | 'closed';

export interface Session {
  version?: number;
  owner?: TaskOwner;
  id: string;
  botId: string;
  threadId: string;
  chatId: string;
  cliId: CliId;
  cliSessionId?: string;
  workspaceDir: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MessageAddress {
  messageId: string;
  chatId: string;
  threadId: string;
  rootId: string;
}

export interface ResolvedSession {
  session: Session;
  isNew: boolean;
}

export interface SessionManagerOptions {
  now?: () => Date;
  createId?: () => string;
  store?: SessionStore;
}

export interface SessionCommitOptions {
  sessionId: string;
  expectedVersion?: number;
  mutate: (current: Session) => Session | null;
}

const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  creating: ['active', 'idle', 'closed'],
  active: ['idle', 'closed'],
  idle: ['active', 'closed'],
  closed: [],
};

function topicIdOf(message: MessageAddress): string {
  return message.threadId || message.rootId || message.messageId;
}

function sessionKey(botId: string, chatId: string, threadId: string): string {
  return `${botId}:${chatId}:${threadId}`;
}

function cloneSession(session: Session): Session {
  return {
    ...session,
    ...(session.owner ? { owner: { ...session.owner } } : {}),
  };
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly store?: SessionStore;
  private commitQueue: Promise<void> = Promise.resolve();

  constructor(options: SessionManagerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.store = options.store;
  }

  static async open(
    options: SessionManagerOptions = {},
  ): Promise<SessionManager> {
    const manager = new SessionManager(options);
    const restored = (await options.store?.load()) ?? [];
    for (const session of restored) {
      manager.sessions.set(
        sessionKey(session.botId, session.chatId, session.threadId),
        cloneSession(session),
      );
    }
    return manager;
  }

  get size(): number {
    return this.sessions.size;
  }

  get(sessionId: string): Session | undefined {
    const session = [...this.sessions.values()].find(
      (candidate) => candidate.id === sessionId,
    );
    return session ? cloneSession(session) : undefined;
  }

  async resolve(
    message: MessageAddress,
    cliId: CliId = 'claude',
    botId = 'default',
    workspaceDir = process.cwd(),
  ): Promise<ResolvedSession> {
    const threadId = topicIdOf(message);
    const key = sessionKey(botId, message.chatId, threadId);
    return this.enqueue(async () => {
      const existing = this.sessions.get(key);
      if (existing) return { session: cloneSession(existing), isNew: false };

      const now = this.now().toISOString();
      const session: Session = {
        id: this.createId(),
        botId,
        threadId,
        chatId: message.chatId,
        cliId,
        workspaceDir,
        status: 'creating',
        version: 0,
        createdAt: now,
        updatedAt: now,
      };
      await this.commitDraft(key, session);
      return { session: cloneSession(session), isNew: true };
    });
  }

  async transition(
    sessionId: string,
    nextStatus: SessionStatus,
    owner?: TaskOwner,
    options: { expectedVersion?: number } = {},
  ): Promise<Session> {
    return this.commitSessionChange({
      sessionId,
      expectedVersion: options.expectedVersion,
      mutate: (current) => {
        if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
          throw new Error(`会话 ${current.status} 不能切换到 ${nextStatus}`);
        }
        return {
          ...current,
          status: nextStatus,
          ...(owner ? { owner } : {}),
          ...(nextStatus === 'closed' ? { version: (current.version ?? 0) + 1 } : {}),
          updatedAt: this.now().toISOString(),
        };
      },
    });
  }

  async setCliSessionId(
    sessionId: string,
    cliSessionId: string,
  ): Promise<Session> {
    if (!cliSessionId) throw new Error('CLI 会话 ID 不能为空');
    return this.updateCliSelection(sessionId, cliSessionId);
  }

  async clearCliSessionId(sessionId: string): Promise<Session> {
    return this.selectCliSessionId(sessionId, undefined);
  }

  async selectCliSessionId(sessionId: string, cliSessionId: string | undefined): Promise<Session> {
    return this.updateCliSelection(sessionId, cliSessionId, true);
  }

  async setWorkspaceDir(
    sessionId: string,
    workspaceDir: string,
  ): Promise<Session> {
    if (!workspaceDir) throw new Error('工作目录不能为空');
    return this.commitSessionChange({
      sessionId,
      mutate: (current) => {
        if (!['idle', 'creating'].includes(current.status)) throw new Error('当前会话不能切换工作目录');
        if (current.workspaceDir === workspaceDir) return null;

        const { cliSessionId: _previousCliSessionId, ...rest } = current;
        return {
          ...rest,
          workspaceDir,
          version: (current.version ?? 0) + 1,
          updatedAt: this.now().toISOString(),
        };
      },
    });
  }

  async commitSessionChange(options: SessionCommitOptions): Promise<Session> {
    const { sessionId, expectedVersion, mutate } = options;
    return this.enqueue(async () => {
      const current = this.findSession(sessionId);
      if (!current) throw new Error(`会话不存在: ${sessionId}`);
      if (expectedVersion !== undefined && (current.version ?? 0) !== expectedVersion) {
        throw new Error('会话上下文已经切换，本次修改已失效');
      }

      const mutated = mutate(cloneSession(current));
      if (!mutated) return cloneSession(current);

      const key = sessionKey(mutated.botId, mutated.chatId, mutated.threadId);
      const draft: Session = {
        ...cloneSession(mutated),
        version: mutated.version ?? current.version ?? 0,
      };
      await this.commitDraft(key, draft);
      return cloneSession(draft);
    });
  }

  private async updateCliSelection(
    sessionId: string,
    cliSessionId: string | undefined,
    switchContext = false,
  ): Promise<Session> {
    return this.commitSessionChange({
      sessionId,
      mutate: (current) => {
        if (switchContext && !['idle', 'creating'].includes(current.status)) throw new Error('当前会话不能切换上下文');
        return {
          ...current,
          cliSessionId,
          ...(switchContext ? { version: (current.version ?? 0) + 1 } : {}),
          updatedAt: this.now().toISOString(),
        };
      },
    });
  }

  private findSession(sessionId: string): Session | undefined {
    return [...this.sessions.values()].find((session) => session.id === sessionId);
  }

  private async commitDraft(
    key: string,
    draft: Session,
  ): Promise<void> {
    const snapshot = [...this.sessions.values()].map((session) => cloneSession(session));
    const index = snapshot.findIndex((session) => sessionKey(session.botId, session.chatId, session.threadId) === key);
    if (index >= 0) snapshot[index] = cloneSession(draft);
    else snapshot.push(cloneSession(draft));

    await this.store?.save(snapshot);
    this.sessions.set(key, cloneSession(draft));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.commitQueue.then(operation, operation);
    this.commitQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }
}
