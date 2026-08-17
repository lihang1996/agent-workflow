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
import {
  interruptedCard,
  persistActiveRuns,
  reconcileOrphanedCards,
  shutdownActiveRuns,
  snapshotActiveRuns,
} from '../src/runtime/active-runs.js';
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

test('同一 Bot 的不同逻辑角色使用独立 CLI 会话', async () => {
  const sessions = new SessionManager({
    createId: (() => {
      let value = 0;
      return () => `role-session-${++value}`;
    })(),
  });
  const ctx = { sessions } as unknown as AppContext;
  const qa = { id: 'qa' } as Bot;
  const reviewer = { id: 'reviewer' } as Bot;
  const msg = {
    messageId: 'om-1', topicId: 'omt', chatId: 'oc', chatType: 'group', messageType: 'text',
    text: '', rootId: '', threadId: 'omt', senderOpenId: 'ou', senderType: 'user', mentions: [], rawContent: '{}',
  } satisfies IncomingMessage;

  const qaSession = await ensureRunnableSession(ctx, qa, msg, { logicalRole: 'qa' });
  const auditSession = await ensureRunnableSession(ctx, qa, msg, { logicalRole: 'runtime_auditor' });
  const reviewSession = await ensureRunnableSession(ctx, reviewer, msg, { logicalRole: 'reviewer' });
  const finalSession = await ensureRunnableSession(ctx, reviewer, msg, { logicalRole: 'final_reviewer' });

  assert.equal(qaSession?.logicalRole, 'qa');
  assert.equal(auditSession?.logicalRole, 'runtime_auditor');
  assert.equal(reviewSession?.logicalRole, 'reviewer');
  assert.equal(finalSession?.logicalRole, 'final_reviewer');
  assert.notEqual(qaSession?.id, auditSession?.id);
  assert.notEqual(reviewSession?.id, finalSession?.id);
  assert.equal(sessions.listByTopic('oc', 'omt').length, 4);
});

test('话题统一引擎会让尚未创建的角色直接使用 Codex', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-topic-engine-new-role-'));
  try {
    const topics = await JsonTopicStore.open(join(root, 'topics.json'));
    await topics.setCliId('oc', 'omt', 'codex');
    const sessions = new SessionManager({
      createId: () => 'pm-codex-session',
      defaultCliId: 'claude',
    });
    const ctx = { sessions, topics } as unknown as AppContext;
    const bot = { id: 'pm' } as Bot;
    const session = await ensureRunnableSession(ctx, bot, {
      messageId: 'om-1', topicId: 'omt', chatId: 'oc', chatType: 'p2p', messageType: 'text',
      text: '', rootId: '', threadId: '', senderOpenId: 'ou', senderType: 'user', mentions: [], rawContent: '{}',
    });

    assert.equal(session?.cliId, 'codex');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('话题引擎批量切换现有角色并清空旧引擎上下文', async () => {
  const sessions = new SessionManager({
    createId: (() => {
      let value = 0;
      return () => `topic-session-${++value}`;
    })(),
    defaultCliId: 'claude',
  });
  const address = (botId: string, topicId = 'omt') => ({
    messageId: `om-${botId}`, chatId: 'oc', threadId: topicId, rootId: '', botId,
  });
  const ceo = (await sessions.resolve(address('ceo'))).session;
  const pm = (await sessions.resolve(address('pm'))).session;
  const otherTopic = (await sessions.resolve(address('dev', 'omt-other'))).session;
  await sessions.setCliSessionId(ceo.id, 'claude-ceo-context');
  await sessions.setCliSessionId(pm.id, 'claude-pm-context');

  const result = await sessions.setCliIdForTopic('oc', 'omt', 'codex');

  assert.equal(result.matched, 2);
  assert.equal(result.updated, 2);
  assert.equal(result.clearedContexts, 2);
  assert.deepEqual(new Set(result.updatedSessionIds), new Set([ceo.id, pm.id]));
  assert.equal(sessions.get(ceo.id)?.cliId, 'codex');
  assert.equal(sessions.get(ceo.id)?.cliSessionId, undefined);
  assert.equal(sessions.get(pm.id)?.cliId, 'codex');
  assert.equal(sessions.get(pm.id)?.cliSessionId, undefined);
  assert.equal(sessions.get(otherTopic.id)?.cliId, 'claude');
});

test('正在执行的旧引擎角色延后到下次解析时对齐', async () => {
  const sessions = new SessionManager({ createId: () => 'active-pm', defaultCliId: 'claude' });
  const address = { messageId: 'om', chatId: 'oc', threadId: 'omt', rootId: '', botId: 'pm' };
  const pm = (await sessions.resolve(address)).session;
  await sessions.transition(pm.id, 'active');

  const update = await sessions.setCliIdForTopic('oc', 'omt', 'codex');
  assert.deepEqual(update.deferredBotIds, ['pm']);
  assert.equal(sessions.get(pm.id)?.cliId, 'claude');

  await sessions.transition(pm.id, 'idle');
  const resolved = await sessions.resolve(address, 'codex');
  assert.equal(resolved.session.cliId, 'codex');
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

test('同一 Bot 不同逻辑角色可以同时落盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-session-logical-role-'));
  const path = join(root, 'sessions.json');
  try {
    const store = new JsonSessionStore(path);
    const qa = closedSession();
    const audit = {
      ...closedSession(),
      id: 'session-audit',
      botId: 'qa',
      logicalRole: 'runtime_auditor',
      cliSessionId: 'cli-audit',
    };
    await store.save([qa, audit]);
    const loaded = await store.load();
    assert.equal(loaded.length, 2);
    assert.equal(loaded.find((session) => session.id === 'session-audit')?.logicalRole, 'runtime_auditor');
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

test('持久化流水线遇到服务重启时展示为可恢复阻塞，而不是用户取消', async () => {
  const workflowId = '11111111-1111-4111-8111-111111111111';
  const progress = {
    current: '评审中', elapsedMs: 1_000, toolCount: 1, completedCount: 1, activities: [],
  };
  const card = interruptedCard({
    workflowId,
    cardTitle: '代码评审 · Codex',
    tracker: { snapshot: () => progress },
  } as unknown as import('../src/runtime/types.js').ActiveRun,
  '服务已停止（SIGTERM）；持久化流水线会自动恢复。', true) as any;
  assert.equal(card.header.template, 'orange');
  assert.match(card.header.title.content, /已阻塞/);
  assert.doesNotMatch(card.header.title.content, /已取消/);

  const ctx = {
    activeRuns: new Map([['session-workflow', {
      workflowId,
      bot: { id: 'reviewer' },
      cardId: 'om-workflow',
      cardTitle: '代码评审 · Codex',
      tracker: { snapshot: () => progress },
    }]]),
  } as unknown as AppContext;
  assert.equal(snapshotActiveRuns(ctx)[0].workflowId, workflowId);
});

test('停机收尾等待终态任务续跑，但不会把失败终态重绘为取消', async () => {
  let resolveDone = () => {};
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const activeRuns = new Map([
    ['session-success', { terminalStatus: 'success' as const, done, resolveDone }],
    ['session-failed', { terminalStatus: 'failed' as const, done, resolveDone }],
  ]);
  const ctx = {
    shuttingDown: false,
    activeRuns,
    shutdownGraceMs: 1_000,
    sessions: new SessionManager(),
    activeRunStore: { clear: async () => undefined },
  } as unknown as AppContext;
  assert.deepEqual(snapshotActiveRuns(ctx), []);
  let settled = false;
  const shutdown = shutdownActiveRuns(ctx, '测试停机').then(() => { settled = true; });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  resolveDone();
  await shutdown;
  assert.equal(settled, true);
  assert.equal(activeRuns.size, 0);
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

test('话题引擎设置在绑定和清除项目目录后仍然保留', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-topic-engine-persist-'));
  const path = join(root, 'topics.json');
  try {
    const topics = await JsonTopicStore.open(path);
    await topics.setCliId('oc', 'omt', 'codex');
    assert.equal(topics.getWorkdir('oc', 'omt'), undefined);
    await topics.setWorkdir('oc', 'omt', '/tmp/project');
    assert.equal(topics.getCliId('oc', 'omt'), 'codex');
    await topics.clearWorkdir('oc', 'omt');
    assert.equal(topics.getWorkdir('oc', 'omt'), undefined);
    assert.equal(topics.getCliId('oc', 'omt'), 'codex');

    const reopened = await JsonTopicStore.open(path);
    assert.equal(reopened.getCliId('oc', 'omt'), 'codex');
    assert.equal(reopened.getWorkdir('oc', 'omt'), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('/engine codex 会统一切换同一话题的所有现有角色', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-engine-command-'));
  try {
    const topics = await JsonTopicStore.open(join(root, 'topics.json'));
    const sessions = new SessionManager({
      createId: (() => {
        let value = 0;
        return () => `engine-session-${++value}`;
      })(),
      defaultCliId: 'claude',
    });
    const pm = (await sessions.resolve({
      messageId: 'om-pm', chatId: 'oc-engine', threadId: 'omt-engine', rootId: '', botId: 'pm',
    })).session;
    await sessions.transition(pm.id, 'idle');
    const replies: string[] = [];
    const bot = {
      id: 'ceo', name: 'CEO', openId: 'ou_bot',
      reply: async (_messageId: string, text: string) => { replies.push(text); },
    } as unknown as Bot;
    const senderOpenId = process.env.OWNER_OPEN_ID?.trim()
      || process.env.AGENT_OS_ALLOWED_OPEN_IDS?.split(/[\s,]+/).find(Boolean)
      || 'ou_owner';
    const msg = {
      messageId: 'om-engine', topicId: 'omt-engine', chatId: 'oc-engine', chatType: 'p2p',
      messageType: 'text', text: '/engine codex', rawContent: '{"text":"/engine codex"}',
      rootId: '', threadId: '', senderOpenId, senderType: 'user', mentions: [],
    } satisfies IncomingMessage;
    const ctx = {
      sessions,
      topics,
      contextWindows: new Map(),
    } as unknown as AppContext;

    await handleMessage(ctx, msg, bot);

    assert.equal(topics.getCliId(msg.chatId, msg.topicId), 'codex');
    assert.equal(sessions.get(pm.id)?.cliId, 'codex');
    assert.equal(sessions.listByTopic(msg.chatId, msg.topicId)
      .find((candidate) => candidate.botId === 'ceo')?.cliId, 'codex');
    assert.match(replies[0] ?? '', /本话题统一切换到 Codex/);
    assert.match(replies[0] ?? '', /尚未创建的产品、架构、开发、评审、测试/);
  } finally {
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
