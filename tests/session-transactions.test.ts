import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager, type Session } from '../src/core/session-manager.js';
import type { SessionStore } from '../src/core/session-store.js';
import { TeamRegistry } from '../src/core/team-registry.js';
import type { BotConfig } from '../src/core/bot-registry.js';
import type { AppRuntime } from '../src/app/runtime.js';
import { beginTask, releaseTask } from '../src/app/task-lifecycle.js';
import { isSessionBusy, withSessionMutation } from '../src/app/session-guard.js';

type SaveBehavior = 'succeed' | 'fail' | 'gate';

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface GateController {
  succeed: () => void;
  fail: () => void;
}

class ControlledSessionStore implements SessionStore {
  readonly saves: Session[][] = [];
  behavior: SaveBehavior = 'succeed';
  private gateController: GateController | undefined;

  constructor(private readonly rows: Session[] = []) {}

  async load(): Promise<Session[]> {
    return deepCopy(this.rows);
  }

  async save(sessions: Session[]): Promise<void> {
    if (this.behavior === 'fail') throw new Error('save failed');
    if (this.behavior === 'gate') {
      // The commit queue serializes saves, so at most one save is gated at a
      // time and gateController always refers to the currently paused save.
      // Its outcome is decided at release, not at entry, so a paused save can
      // still be made to fail after the test observes its in-flight draft.
      let succeed!: () => void;
      let fail!: () => void;
      const gate = new Promise<void>((resolve, reject) => {
        succeed = resolve;
        fail = () => reject(new Error('save failed'));
      });
      this.gateController = { succeed, fail };
      await gate;
    }
    this.saves.push(deepCopy(sessions));
  }

  release(): void {
    const controller = this.gateController;
    this.gateController = undefined;
    controller?.succeed();
  }

  releaseAsFailure(): void {
    const controller = this.gateController;
    this.gateController = undefined;
    controller?.fail();
  }

  latest(): Session[] {
    return deepCopy(this.saves.at(-1) ?? []);
  }
}

const owner = { ownerOpenId: 'owner', ownerUnionId: 'union-owner', ownerBotId: 'product' };

function runtimeFixture(sessions: SessionManager): AppRuntime {
  const config: BotConfig = {
    id: 'product',
    appId: 'fixture',
    appSecret: 'fixture',
    defaultCliId: 'claude',
    modelOverrides: {},
    role: '产品',
    skills: [],
    systemPrompt: '',
    workspaceDir: '/tmp/a',
    collaborationMaxRounds: 16,
  };
  return {
    sessions,
    teamRegistry: new TeamRegistry(config.id, [config]),
    activeRuns: new Map(),
    contextWindows: new Map(),
    botRuntimes: new Map(),
    processedCollaborationTurns: new Set(),
  sessionScratches: new Map(),
    collaborationInbox: { pending: () => [] } as unknown as AppRuntime['collaborationInbox'],
    clarificationFlows: { forSession: () => [] } as unknown as AppRuntime['clarificationFlows'],
    productSpecFlows: { forSession: () => [] } as unknown as AppRuntime['productSpecFlows'],
  };
}

const messageA = { messageId: 'a', chatId: 'chat', threadId: 'thread-a', rootId: 'root-a' };
const messageB = { messageId: 'b', chatId: 'chat', threadId: 'thread-b', rootId: 'root-b' };

test('a failed session save does not publish its draft or pollute another session commit', async () => {
  const store = new ControlledSessionStore();
  const sessions = new SessionManager({ store });
  const resolvedA = await sessions.resolve(messageA, 'claude', 'product', '/tmp/a');
  const resolvedB = await sessions.resolve(messageB, 'claude', 'product', '/tmp/b');

  // A is paused mid-save, then fails on release; B is queued behind A and must
  // still succeed without carrying A's unpublished draft into its own commit.
  store.behavior = 'gate';
  const first = sessions.transition(resolvedA.session.id, 'idle');
  await new Promise((resolve) => setImmediate(resolve));
  const second = sessions.setWorkspaceDir(resolvedB.session.id, '/tmp/b-changed');
  store.behavior = 'succeed';
  store.releaseAsFailure();
  await assert.rejects(first, /save failed/);
  await second;

  assert.equal(sessions.get(resolvedA.session.id)?.status, 'creating');
  assert.equal(sessions.get(resolvedB.session.id)?.workspaceDir, '/tmp/b-changed');
  const saved = store.latest();
  assert.equal(saved.find((session) => session.id === resolvedA.session.id)?.status, 'creating');
  assert.equal(saved.find((session) => session.id === resolvedB.session.id)?.workspaceDir, '/tmp/b-changed');
  assert.ok(!saved.some((session) => session.id === resolvedA.session.id && session.status === 'idle'));
});

test('reads do not expose unpublished drafts and the queue continues after a rejected save', async () => {
  const store = new ControlledSessionStore();
  const sessions = new SessionManager({ store });
  const { session } = await sessions.resolve(messageA, 'claude', 'product', '/tmp/a');
  await sessions.transition(session.id, 'idle');

  store.behavior = 'gate';
  const pending = sessions.setCliSessionId(session.id, 'draft-cli');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessions.get(session.id)?.cliSessionId, undefined);

  store.behavior = 'succeed';
  store.release();
  await pending;
  assert.equal(sessions.get(session.id)?.cliSessionId, 'draft-cli');

  store.behavior = 'fail';
  await assert.rejects(sessions.setCliSessionId(session.id, 'failed-cli'), /save failed/);
  assert.equal(sessions.get(session.id)?.cliSessionId, 'draft-cli');
  assert.equal(store.latest().find((row) => row.id === session.id)?.cliSessionId, 'draft-cli');

  store.behavior = 'succeed';
  await sessions.setCliSessionId(session.id, 'committed-cli');
  assert.equal(sessions.get(session.id)?.cliSessionId, 'committed-cli');
});

test('expectedVersion rejects stale writes without changing committed state', async () => {
  const store = new ControlledSessionStore();
  const sessions = new SessionManager({ store });
  const { session } = await sessions.resolve(messageA, 'claude', 'product', '/tmp/a');
  await sessions.transition(session.id, 'idle');
  await sessions.setCliSessionId(session.id, 'first');

  await assert.rejects(
    sessions.commitSessionChange({
      sessionId: session.id,
      expectedVersion: 1,
      mutate: (current) => ({ ...current, cliSessionId: 'stale' }),
    }),
    /上下文已经切换/,
  );
  assert.equal(sessions.get(session.id)?.cliSessionId, 'first');
  assert.equal(sessions.get(session.id)?.version, 0);
});

test('beginTask rejects concurrent starts and session mutations before awaiting persistence', async () => {
  const store = new ControlledSessionStore();
  const sessions = new SessionManager({ store });
  const runtime = runtimeFixture(sessions);
  const { session } = await sessions.resolve(messageA, 'claude', 'product', '/tmp/a');
  await sessions.transition(session.id, 'idle');

  const first = beginTask(runtime, session.id, owner, 0);
  await assert.rejects(beginTask(runtime, session.id, owner, 0), /正在执行|上下文已经切换/);
  await assert.rejects(withSessionMutation(runtime, session.id, async () => 'mutate'), /正在执行/);
  const controller = await first;

  await assert.rejects(beginTask(runtime, session.id, owner, 1), /正在执行|上下文已经切换/);
  await releaseTask(runtime, session.id, controller, () => {});
  assert.equal(runtime.activeRuns.has(session.id), false);
});

test('a mutation placeholder blocks new tasks even while session status is idle', async () => {
  const store = new ControlledSessionStore();
  const sessions = new SessionManager({ store });
  const runtime = runtimeFixture(sessions);
  const { session } = await sessions.resolve(messageA, 'claude', 'product', '/tmp/a');
  await sessions.transition(session.id, 'idle');

  let releaseMutation: (() => void) | undefined;
  const mutation = withSessionMutation(runtime, session.id, async () => {
    await new Promise<void>((resolve) => { releaseMutation = resolve; });
    return 'done';
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sessions.get(session.id)?.status, 'idle');
  assert.equal(isSessionBusy(runtime, session.id), true);
  await assert.rejects(beginTask(runtime, session.id, owner, 0), /正在执行|上下文已经切换/);
  await assert.rejects(withSessionMutation(runtime, session.id, async () => 'other'), /另一项修改/);

  releaseMutation?.();
  assert.equal(await mutation, 'done');
  assert.equal(isSessionBusy(runtime, session.id), false);
  const controller = await beginTask(runtime, session.id, owner, 0);
  await releaseTask(runtime, session.id, controller, () => {});
});

test('mutation placeholder is released even when the conditional commit fails', async () => {
  const store = new ControlledSessionStore();
  const sessions = new SessionManager({ store });
  const runtime = runtimeFixture(sessions);
  const { session } = await sessions.resolve(messageA, 'claude', 'product', '/tmp/a');
  await sessions.transition(session.id, 'idle');

  store.behavior = 'fail';
  await assert.rejects(
    withSessionMutation(runtime, session.id, () => sessions.setCliSessionId(session.id, 'failed')),
    /save failed/,
  );
  assert.equal(isSessionBusy(runtime, session.id), false);
  assert.equal(sessions.get(session.id)?.cliSessionId, undefined);
});

test('session status alone does not authorize modification while release is still active', async () => {
  const store = new ControlledSessionStore();
  const sessions = new SessionManager({ store });
  const runtime = runtimeFixture(sessions);
  const { session } = await sessions.resolve(messageA, 'claude', 'product', '/tmp/a');
  await sessions.transition(session.id, 'idle');
  const controller = await beginTask(runtime, session.id, owner, 0);

  store.behavior = 'gate';
  const released = releaseTask(runtime, session.id, controller, () => {});
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sessions.get(session.id)?.status, 'active');
  assert.equal(runtime.activeRuns.has(session.id), true);
  await assert.rejects(withSessionMutation(runtime, session.id, async () => 'mutate'), /正在执行/);

  store.behavior = 'succeed';
  store.release();
  await released;
  assert.equal(sessions.get(session.id)?.status, 'idle');
  assert.equal(isSessionBusy(runtime, session.id), false);
});
