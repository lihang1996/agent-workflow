import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchitectureHandoffStore } from '../src/core/architecture-handoff.js';
import {
  loadSessionScratchBindings,
  requireSessionScratchBinding,
  SESSION_SCRATCH_MAX_AGE_MS,
  type SessionScratchBinding,
} from '../src/core/isolation.js';

/**
 * A07：架构交接台账与会话 scratch 绑定的持久化/恢复测试。
 */

function tempDir(t: { after: (fn: () => void) => void }, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FAKE_DIGEST = 'a'.repeat(64);

// ---- 架构交接台账持久化（A07-①） ---------------------------------------------------

test('architecture handoffs survive store recreation (A07)', (t) => {
  const filePath = join(tempDir(t, 'agent-os-handoff-'), 'handoffs.json');
  const first = new ArchitectureHandoffStore(filePath);
  const handoff = first.create({
    prdToken: 'prd-1',
    prdDigest: FAKE_DIGEST,
    ownerOpenId: 'ou_owner',
    prdTaskId: 'task-1',
    prdSessionId: 'session-1',
  });
  assert.ok(existsSync(filePath), 'create 必须落盘');

  // 新实例（模拟重启）：交接码恢复，状态与绑定一致。
  const second = new ArchitectureHandoffStore(filePath);
  const restored = second.get(handoff.token);
  assert.ok(restored);
  assert.equal(restored.prdToken, 'prd-1');
  assert.equal(restored.status, 'open');
  assert.equal(second.openFor('prd-1')?.token, handoff.token);

  // 消费后再次恢复：单次使用状态可恢复（不可重放）。
  const consumed = second.consume(handoff.token, { taskId: 'task-2', ownerOpenId: 'ou_owner' });
  assert.ok(consumed);
  assert.equal(consumed.status, 'consumed');
  const third = new ArchitectureHandoffStore(filePath);
  assert.equal(third.get(handoff.token)?.status, 'consumed');
  assert.equal(third.consume(handoff.token, { taskId: 'task-3', ownerOpenId: 'ou_owner' }), undefined);
});

test('architecture handoff store fails closed on corrupt files (A07)', (t) => {
  const dir = tempDir(t, 'agent-os-handoff-');
  const badJson = join(dir, 'bad.json');
  writeFileSync(badJson, '{ not json');
  assert.throws(() => new ArchitectureHandoffStore(badJson));

  const badRow = join(dir, 'bad-row.json');
  writeFileSync(badRow, JSON.stringify([{ token: 'x', broken: true }]));
  assert.throws(() => new ArchitectureHandoffStore(badRow), /架构交接台账记录无效/);
});

test('architecture handoff store without filePath stays in-memory (A07 compatibility)', () => {
  const store = new ArchitectureHandoffStore();  const handoff = store.create({
    prdToken: 'prd-mem',
    prdDigest: FAKE_DIGEST,
    ownerOpenId: 'ou_owner',
    prdTaskId: 'task-m',
    prdSessionId: 'session-m',
  });
  assert.ok(store.get(handoff.token));
});

// ---- 会话 scratch 绑定持久化与恢复核验（A07-②） -------------------------------------

function buildWorkspace(t: { after: (fn: () => void) => void }): {
  workspaceDir: string;
  scratchRelative: string;
  taskKey: string;
} {
  const workspaceDir = tempDir(t, 'agent-os-scratch-ws-');
  const scratchRelative = `.aos-scratch-task-${Date.now().toString(36)}`;
  mkdirSync(join(workspaceDir, scratchRelative), { recursive: true, mode: 0o700 });
  return { workspaceDir, scratchRelative, taskKey: 'task-1' };
}

test('session scratch binding: create, restore in a new instance, still valid (A07)', (t) => {
  const { workspaceDir, scratchRelative, taskKey } = buildWorkspace(t);
  const filePath = join(tempDir(t, 'agent-os-scratch-'), 'session-scratches.json');

  const first = loadSessionScratchBindings({
    filePath,
    resolveWorkspaceDir: () => workspaceDir,
  });
  const binding: SessionScratchBinding = { relative: scratchRelative, taskKey, at: Date.now() };
  first.set('session-1', binding);
  assert.ok(existsSync(filePath), 'set 必须落盘');

  // 新实例恢复：realpath 存在、taskKey 与最近任务一致、未过期 ⇒ 绑定有效。
  const restored = loadSessionScratchBindings({
    filePath,
    resolveWorkspaceDir: () => workspaceDir,
    taskKeyOf: () => taskKey,
  });
  assert.deepEqual(restored.get('session-1'), binding);
  // 恢复后的表与制品提交门相容。
  assert.equal(requireSessionScratchBinding({
    scratches: restored,
    sessionId: 'session-1',
    taskKey,
  }), scratchRelative);
});

test('session scratch binding is dropped when the scratch directory is gone (A07)', (t) => {
  const { workspaceDir, scratchRelative, taskKey } = buildWorkspace(t);
  const filePath = join(tempDir(t, 'agent-os-scratch-'), 'session-scratches.json');
  const first = loadSessionScratchBindings({ filePath, resolveWorkspaceDir: () => workspaceDir });
  first.set('session-1', { relative: scratchRelative, taskKey, at: Date.now() });

  rmSync(join(workspaceDir, scratchRelative), { recursive: true, force: true });
  const restored = loadSessionScratchBindings({
    filePath,
    resolveWorkspaceDir: () => workspaceDir,
    taskKeyOf: () => taskKey,
  });
  assert.equal(restored.get('session-1'), undefined, '目录已删 ⇒ 恢复时绑定被丢弃');
  // 丢弃结果落盘：文件里也不再有条目。
  const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.deepEqual(persisted.entries, {});
});

test('session scratch binding is dropped when expired or taskKey drifts (A07)', (t) => {
  const { workspaceDir, scratchRelative } = buildWorkspace(t);
  const filePath = join(tempDir(t, 'agent-os-scratch-'), 'session-scratches.json');
  const first = loadSessionScratchBindings({ filePath, resolveWorkspaceDir: () => workspaceDir });
  first.set('session-stale', { relative: scratchRelative, taskKey: 'task-old', at: Date.now() - SESSION_SCRATCH_MAX_AGE_MS - 1_000 });
  first.set('session-drift', { relative: scratchRelative, taskKey: 'task-old', at: Date.now() });

  const restored = loadSessionScratchBindings({
    filePath,
    resolveWorkspaceDir: () => workspaceDir,
    // 会话最近任务已变为 task-new：task-old 的绑定属于跨任务残留 ⇒ 丢弃。
    taskKeyOf: (sessionId) => (sessionId === 'session-stale' ? undefined : 'task-new'),
  });
  assert.equal(restored.get('session-stale'), undefined, '过期绑定被丢弃');
  assert.equal(restored.get('session-drift'), undefined, 'taskKey 不匹配的绑定被丢弃');
});

test('session scratch binding is dropped when relative escapes the workspace (A07)', (t) => {
  const workspaceDir = tempDir(t, 'agent-os-scratch-ws-');
  const filePath = join(tempDir(t, 'agent-os-scratch-'), 'session-scratches.json');
  writeFileSync(join(workspaceDir, 'outside.txt'), 'x');
  const store = loadSessionScratchBindings({
    filePath,
    resolveWorkspaceDir: () => workspaceDir,
  });
  store.set('session-esc', { relative: '../outside.txt', taskKey: 'task-1', at: Date.now() });
  // set 落盘了坏形状，但恢复核对必须丢弃（安全拒绝，不冒充可用）。
  const restored = loadSessionScratchBindings({
    filePath,
    resolveWorkspaceDir: () => workspaceDir,
    taskKeyOf: () => 'task-1',
  });
  assert.equal(restored.get('session-esc'), undefined);
});

test('session scratch binding resolve uses realpath (workspace symlinked) (A07)', (t) => {
  const { workspaceDir, scratchRelative, taskKey } = buildWorkspace(t);
  const linkDir = tempDir(t, 'agent-os-scratch-link-');
  const linkedWorkspace = join(linkDir, 'ws-link');
  symlinkSync(realpathSync(workspaceDir), linkedWorkspace, 'dir');
  const filePath = join(tempDir(t, 'agent-os-scratch-'), 'session-scratches.json');

  const first = loadSessionScratchBindings({
    filePath,
    resolveWorkspaceDir: () => linkedWorkspace,
  });
  first.set('session-link', { relative: scratchRelative, taskKey, at: Date.now() });
  const restored = loadSessionScratchBindings({
    filePath,
    resolveWorkspaceDir: () => linkedWorkspace,
    taskKeyOf: () => taskKey,
  });
  assert.ok(restored.get('session-link'), '经符号链接进入的同一真实工作区应恢复成功');
});
