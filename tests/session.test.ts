import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonActiveRunStore } from '../src/core/active-run-store.js';
import { SessionManager, type Session } from '../src/core/session-manager.js';
import { JsonSessionStore, type SessionStore } from '../src/core/session-store.js';
import { JsonTopicStore } from '../src/core/topic-store.js';
import type { AppContext } from '../src/runtime/app-context.js';
import { persistActiveRuns, reconcileOrphanedCards } from '../src/runtime/active-runs.js';
import { ensureRunnableSession } from '../src/runtime/sessions.js';
import { handleMessage } from '../src/runtime/message-handler.js';
import type { Bot, IncomingMessage } from '../src/im/lark.js';

function closedSession(): Session {
  return {
    id: 'session-1', botId: 'dev', chatId: 'oc', threadId: 'omt', cliId: 'claude',
    cliSessionId: 'cli-old', status: 'closed',
    createdAt: '2026-08-04T00:00:00.000Z', updatedAt: '2026-08-04T00:00:00.000Z',
  };
}

test('重开会话一次落盘并清空旧 CLI 上下文', async () => {
  const saves: Session[][] = [];
  const store: SessionStore = {
    load: async () => [closedSession()],
    save: async (sessions) => { saves.push(structuredClone(sessions)); },
  };
  const manager = await SessionManager.open({ store });
  const reopened = await manager.reopen('session-1');
  assert.equal(reopened.status, 'idle');
  assert.equal(reopened.cliSessionId, undefined);
  assert.equal(saves.length, 1);
  assert.equal(saves[0][0].cliSessionId, undefined);
});

test('会话落盘失败时恢复被清理的关闭会话', async () => {
  const store: SessionStore = {
    load: async () => [closedSession()],
    save: async () => { throw new Error('磁盘写入失败'); },
  };
  const manager = await SessionManager.open({ store });
  await assert.rejects(() => manager.purgeClosed(), /磁盘写入失败/);
  assert.equal(manager.size, 1);
  assert.equal(manager.get('session-1')?.status, 'closed');
});

test('并发会话变更不会把失败状态带入后一份快照', async () => {
  const saves: Session[][] = [];
  let failNext = false;
  const store: SessionStore = {
    load: async () => [],
    save: async (sessions) => {
      const snapshot = structuredClone(sessions);
      if (failNext) {
        failNext = false;
        throw new Error('模拟首笔写入失败');
      }
      saves.push(snapshot);
    },
  };
  const manager = await SessionManager.open({
    store,
    createId: (() => {
      let value = 0;
      return () => `session-${++value}`;
    })(),
  });
  const first = (await manager.resolve({
    messageId: 'om-1', chatId: 'oc', threadId: 'omt-1', rootId: '', botId: 'dev',
  })).session;
  const second = (await manager.resolve({
    messageId: 'om-2', chatId: 'oc', threadId: 'omt-2', rootId: '', botId: 'dev',
  })).session;

  failNext = true;
  const [firstResult, secondResult] = await Promise.allSettled([
    manager.transition(first.id, 'active'),
    manager.transition(second.id, 'active'),
  ]);

  assert.equal(firstResult.status, 'rejected');
  assert.equal(secondResult.status, 'fulfilled');
  assert.equal(manager.get(first.id)?.status, 'creating');
  assert.equal(manager.get(second.id)?.status, 'active');
  const persisted = saves.at(-1);
  assert.equal(persisted?.find((session) => session.id === first.id)?.status, 'creating');
  assert.equal(persisted?.find((session) => session.id === second.id)?.status, 'active');
});

test('内部触发消息沿用原话题会话而不是触发消息 ID', async () => {
  const sessions = new SessionManager({ createId: () => 'stable-session' });
  const ctx = { sessions } as unknown as AppContext;
  const bot = { id: 'dev' } as Bot;
  const base = {
    topicId: 'om-original-topic', chatId: 'oc', chatType: 'p2p', messageType: 'text', text: '',
    rootId: '', threadId: '', senderOpenId: 'ou', senderType: 'user', mentions: [], rawContent: '{}',
  };
  const first = await ensureRunnableSession(ctx, bot, {
    ...base, messageId: 'om-schedule-kickoff-1',
  } satisfies IncomingMessage);
  const second = await ensureRunnableSession(ctx, bot, {
    ...base, messageId: 'om-schedule-kickoff-2',
  } satisfies IncomingMessage);
  assert.equal(first?.threadId, 'om-original-topic');
  assert.equal(second?.id, first?.id);
});

test('新话题首条帮助命令结束后会话可继续执行任务', async () => {
  const sessions = new SessionManager({ createId: () => 'help-session' });
  const senderOpenId = process.env.OWNER_OPEN_ID?.trim()
    || process.env.AGENT_OS_ALLOWED_OPEN_IDS?.split(/[\s,]+/).find(Boolean)
    || 'ou_owner';
  const replies: string[] = [];
  const bot = {
    id: 'dev', name: '开发工程师', openId: 'ou_bot',
    reply: async (_messageId: string, text: string) => { replies.push(text); },
  } as unknown as Bot;
  const msg = {
    messageId: 'om-help', topicId: 'omt-help', chatId: 'oc-help', chatType: 'p2p',
    messageType: 'text', text: '/help', rawContent: '{"text":"/help"}',
    rootId: '', threadId: '', senderOpenId, senderType: 'user', mentions: [],
  } satisfies IncomingMessage;

  await handleMessage({ sessions } as unknown as AppContext, msg, bot);

  assert.equal(sessions.listByTopic(msg.chatId, msg.topicId)[0]?.status, 'idle');
  assert.match(replies[0] ?? '', /\/status/);
});

test('损坏会话记录会明确报错且不会被静默覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-session-invalid-'));
  const path = join(root, 'sessions.json');
  const original = JSON.stringify([closedSession(), { id: 'broken' }], null, 2);
  try {
    await writeFile(path, original);
    await assert.rejects(() => new JsonSessionStore(path).load(), /第 2 条记录格式错误/);
    assert.equal(await readFile(path, 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('重复会话记录会在恢复前拒绝且保留原文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-session-duplicate-'));
  const path = join(root, 'sessions.json');
  const duplicate = { ...closedSession(), status: 'active' as const };
  const original = JSON.stringify([duplicate, { ...duplicate, threadId: 'omt-2' }], null, 2);
  try {
    await writeFile(path, original);
    await assert.rejects(() => new JsonSessionStore(path).load(), /重复 ID/);
    assert.equal(await readFile(path, 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('进行中任务快照写入失败会向启动方报告', async () => {
  await assert.rejects(
    () => persistActiveRuns({
      activeRuns: new Map(),
      activeRunStore: { clear: async () => { throw new Error('快照目录只读'); } },
    } as unknown as AppContext),
    /快照目录只读/,
  );
});

test('重复进行中任务快照会阻止恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-active-run-duplicate-'));
  const path = join(root, 'active-runs.json');
  const run = {
    sessionId: 'session-1', botId: 'dev', cardId: 'om-card', cardTitle: '开发任务',
    progress: 30, detail: '执行中', activities: [], updatedAt: '2026-08-04T00:00:00.000Z',
  };
  try {
    await writeFile(path, JSON.stringify([run, { ...run, cardId: 'om-card-2' }]));
    await assert.rejects(() => new JsonActiveRunStore(path).load(), /重复会话/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('遗留任务卡刷新失败时保留快照供下次重试', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-active-run-'));
  const path = join(root, 'active-runs.json');
  try {
    const activeRunStore = new JsonActiveRunStore(path);
    const orphan = {
      sessionId: 'session-1', botId: 'dev', cardId: 'om-card', cardTitle: '开发任务',
      progress: 30, detail: '执行中', activities: [], updatedAt: '2026-08-04T00:00:00.000Z',
    };
    await activeRunStore.save([orphan]);
    const bot = { updateCard: async () => { throw new Error('飞书暂时不可用'); } };
    await reconcileOrphanedCards({
      activeRunStore,
      botsById: new Map([['dev', bot]]),
    } as unknown as AppContext);
    assert.deepEqual(await activeRunStore.load(), [orphan]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('话题目录落盘失败时回滚内存绑定', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-topic-rollback-'));
  try {
    const store = new JsonTopicStore(root); // 目标路径是目录，rename 必然失败。
    await assert.rejects(() => store.setWorkdir('oc', 'omt', root));
    assert.equal(store.size, 0);
    assert.equal(store.getWorkdir('oc', 'omt'), undefined);
  } finally {
    await rm(`${root}.tmp`, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('话题目录文件损坏时拒绝静默跳过', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-topic-invalid-'));
  const path = join(root, 'topics.json');
  try {
    await writeFile(path, JSON.stringify([{ chatId: 'oc' }]));
    await assert.rejects(() => JsonTopicStore.open(path), /第 1 条记录格式错误/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
