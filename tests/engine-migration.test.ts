import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migratePersistedEngineToDefault } from '../src/core/engine-migration.js';
import { SessionManager } from '../src/core/session-manager.js';
import { JsonTopicStore } from '../src/core/topic-store.js';

test('DEFAULT_CLI 变更时对齐空闲话题和会话，再次启动不会覆盖 /engine 选择', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-engine-migration-'));
  try {
    const topics = await JsonTopicStore.open(join(root, 'topics.json'));
    const sessions = new SessionManager({
      defaultCliId: 'cursor',
      createId: (() => {
        let value = 0;
        return () => `mig-${++value}`;
      })(),
    });
    await topics.setCliId('oc', 'omt-old', 'codex');
    const idle = (await sessions.resolve({
      messageId: 'om-dev', chatId: 'oc', threadId: 'omt-old', rootId: '', botId: 'dev',
    })).session;
    await sessions.transition(idle.id, 'idle');
    await sessions.setCliId(idle.id, 'codex');
    await sessions.setCliSessionId(idle.id, 'codex-thread');

    const active = (await sessions.resolve({
      messageId: 'om-pm', chatId: 'oc', threadId: 'omt-busy', rootId: '', botId: 'pm',
    })).session;
    await sessions.transition(active.id, 'idle');
    await sessions.setCliId(active.id, 'claude');
    await sessions.transition(active.id, 'active');

    const markerPath = join(root, '.default-cli-migration.json');
    const first = await migratePersistedEngineToDefault({
      sessions,
      topics,
      defaultCliId: 'cursor',
      markerPath,
    });
    assert.equal(first.skipped, false);
    assert.equal(topics.getCliId('oc', 'omt-old'), 'cursor');
    assert.equal(sessions.get(idle.id)?.cliId, 'cursor');
    assert.equal(sessions.get(idle.id)?.cliSessionId, undefined);
    assert.equal(sessions.get(active.id)?.cliId, 'claude');
    assert.ok(first.deferred >= 1);

    await topics.setCliId('oc', 'omt-old', 'claude');
    await sessions.setCliId(idle.id, 'claude');
    const second = await migratePersistedEngineToDefault({
      sessions,
      topics,
      defaultCliId: 'cursor',
      markerPath,
    });
    assert.equal(second.skipped, true);
    assert.equal(topics.getCliId('oc', 'omt-old'), 'claude');
    assert.equal(sessions.get(idle.id)?.cliId, 'claude');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
