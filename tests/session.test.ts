import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonActiveRunStore } from '../src/core/active-run-store.js';
import { SessionManager, type Session } from '../src/core/session-manager.js';
import { JsonSessionStore, type SessionStore } from '../src/core/session-store.js';
import type { AppContext } from '../src/runtime/app-context.js';
import { reconcileOrphanedCards } from '../src/runtime/active-runs.js';

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
