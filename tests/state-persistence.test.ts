import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchitectureHandoffStore } from '../src/core/architecture-handoff.js';
import {
  loadSessionScratchBindings,
  requireSessionScratchBinding,
  SessionScratchBindingStore,
  SESSION_SCRATCH_MAX_AGE_MS,
  type SessionScratchBinding,
} from '../src/core/isolation.js';

/**
 * A07：架构交接台账与会话 scratch 绑定的持久化/恢复测试。
 * 166 号返工新增：write/rename 失败注入（全字段回滚比较）、工作区 realpath
 * 身份恢复核验、legacy 无身份记录丢弃。
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
  const store = new ArchitectureHandoffStore();
  const handoff = store.create({
    prdToken: 'prd-mem',
    prdDigest: FAKE_DIGEST,
    ownerOpenId: 'ou_owner',
    prdTaskId: 'task-m',
    prdSessionId: 'session-m',
  });
  assert.ok(store.get(handoff.token));
});

// ---- A07（166 号返工）：写失败回滚 = 全字段比较 --------------------------------------

test('consume persist-write failure rolls back every in-memory field (A07 166 号返工)', (t) => {
  const dir = tempDir(t, 'agent-os-handoff-wf-');
  const filePath = join(dir, 'handoffs.json');
  const store = new ArchitectureHandoffStore(filePath);
  const handoff = store.create({
    prdToken: 'prd-1', prdDigest: FAKE_DIGEST, ownerOpenId: 'ou_owner',
    prdTaskId: 'task-1', prdSessionId: 'session-1',
  });
  const before = JSON.stringify(store.get(handoff.token));
  chmodSync(dir, 0o500); // tmp 写失败（write 阶段）。
  assert.throws(() => store.consume(handoff.token, { taskId: 'task-2', ownerOpenId: 'ou_owner' }));
  chmodSync(dir, 0o700);
  // 全字段回滚：内存与失败前逐字段一致（status/consumedAt/consumedByTaskId）。
  assert.equal(JSON.stringify(store.get(handoff.token)), before, '内存记录必须完整回滚');
  // 磁盘从未写入消费状态：重启恢复仍 open，且与内存一致。
  const reopened = new ArchitectureHandoffStore(filePath);
  assert.equal(reopened.get(handoff.token)?.status, 'open');
  assert.equal(store.get(handoff.token)?.status, 'open');
  // 回滚后可重新消费（写入恢复正常）。
  const consumed = store.consume(handoff.token, { taskId: 'task-2b', ownerOpenId: 'ou_owner' });
  assert.equal(consumed?.status, 'consumed');
});

test('consume persist-rename failure rolls back in-memory state (A07 166 号返工)', (t) => {
  const dir = tempDir(t, 'agent-os-handoff-rf-');
  const filePath = join(dir, 'handoffs.json');
  const store = new ArchitectureHandoffStore(filePath);
  const handoff = store.create({
    prdToken: 'prd-1', prdDigest: FAKE_DIGEST, ownerOpenId: 'ou_owner',
    prdTaskId: 'task-1', prdSessionId: 'session-1',
  });
  const before = JSON.stringify(store.get(handoff.token));
  // rename 阶段失败：目标路径换成目录（tmp 写入成功，rename 撞目录报错）。
  rmSync(filePath);
  mkdirSync(filePath);
  assert.throws(() => store.consume(handoff.token, { taskId: 'task-2', ownerOpenId: 'ou_owner' }));
  assert.equal(JSON.stringify(store.get(handoff.token)), before, 'rename 失败也必须全字段回滚');
  // 失败后写入的临时文件已清理（目录里只有被我们换成的目录本身）。
  assert.deepEqual(
    readdirSorted(dir).filter((name) => name.endsWith('.tmp')),
    [],
    '失败路径必须清理自建临时文件',
  );
  rmSync(filePath, { recursive: true, force: true });
});

test('closeForPrd persist failure rolls back every record (A07 166 号返工)', (t) => {
  const dir = tempDir(t, 'agent-os-handoff-close-');
  const filePath = join(dir, 'handoffs.json');
  const store = new ArchitectureHandoffStore(filePath);
  const h1 = store.create({
    prdToken: 'prd-1', prdDigest: FAKE_DIGEST, ownerOpenId: 'ou_owner',
    prdTaskId: 'task-1', prdSessionId: 'session-1',
  });
  const before = JSON.stringify(store.get(h1.token));
  chmodSync(dir, 0o500);
  assert.throws(() => store.closeForPrd('prd-1'));
  chmodSync(dir, 0o700);
  assert.equal(JSON.stringify(store.get(h1.token)), before, '关闭失败必须回滚（仍 open）');
  assert.equal(new ArchitectureHandoffStore(filePath).get(h1.token)?.status, 'open');
});

function readdirSorted(dir: string): string[] {
  return readdirSync(dir).sort();
}

test('returned handoff records are clones: external mutation cannot corrupt the store (A07 166 号返工)', (t) => {
  const filePath = join(tempDir(t, 'agent-os-handoff-clone-'), 'handoffs.json');
  const store = new ArchitectureHandoffStore(filePath);
  const handoff = store.create({
    prdToken: 'prd-1', prdDigest: FAKE_DIGEST, ownerOpenId: 'ou_owner',
    prdTaskId: 'task-1', prdSessionId: 'session-1',
  });
  handoff.status = 'consumed'; // 外部改克隆不影响存储。
  assert.equal(store.get(handoff.token)?.status, 'open');
  assert.equal(store.openFor('prd-1')?.status, 'open');
});

// ---- 会话 scratch 绑定持久化与恢复核验（A07-②） -------------------------------------

function buildWorkspace(t: { after: (fn: () => void) => void }): {
  workspaceDir: string;
  workspaceReal: string;
  scratchRelative: string;
  scratchIdentity: string;
  taskKey: string;
} {
  const workspaceDir = tempDir(t, 'agent-os-scratch-ws-');
  const scratchRelative = `.aos-scratch-task-${Date.now().toString(36)}`;
  const scratchDir = join(workspaceDir, scratchRelative);
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  const stat = statSync(scratchDir);
  return {
    workspaceDir,
    workspaceReal: realpathSync(workspaceDir),
    scratchRelative,
    scratchIdentity: `${stat.dev}:${stat.ino}`,
    taskKey: 'task-1',
  };
}

function bindingOf(workspace: ReturnType<typeof buildWorkspace>): SessionScratchBinding {
  return {
    relative: workspace.scratchRelative,
    taskKey: workspace.taskKey,
    at: Date.now(),
    workspaceRealpath: workspace.workspaceReal,
    scratchIdentity: workspace.scratchIdentity,
  };
}

test('session scratch binding: create, restore in a new instance, still valid (A07)', (t) => {
  const workspace = buildWorkspace(t);
  const { workspaceDir, workspaceReal, scratchRelative, taskKey } = workspace;
  const filePath = join(tempDir(t, 'agent-os-scratch-'), 'session-scratches.json');

  const first = loadSessionScratchBindings({
    filePath,
    resolveWorkspaceDir: () => workspaceDir,
  });
  const binding = bindingOf(workspace);
  first.set('session-1', binding);
  assert.ok(existsSync(filePath), 'set 必须落盘');

  // 新实例恢复：realpath 存在、身份一致、taskKey 与最近任务一致、未过期。
  const restored = loadSessionScratchBindings({
    filePath,
    resolveWorkspaceDir: () => workspaceDir,
    taskKeyOf: () => taskKey,
  });
  assert.deepEqual(restored.get('session-1'), binding);
  assert.equal(requireSessionScratchBinding({
    scratches: restored,
    sessionId: 'session-1',
    taskKey,
    workspaceRealpath: workspaceReal,
  }), scratchRelative);
});

test('session scratch binding is dropped when the scratch directory is gone (A07)', (t) => {
  const workspace = buildWorkspace(t);
  const { workspaceDir, scratchRelative, taskKey } = workspace;
  const filePath = join(tempDir(t, 'agent-os-scratch-'), 'session-scratches.json');
  const first = loadSessionScratchBindings({ filePath, resolveWorkspaceDir: () => workspaceDir });
  first.set('session-1', bindingOf(workspace));

  rmSync(join(workspaceDir, scratchRelative), { recursive: true, force: true });
  const restored = loadSessionScratchBindings({
    filePath,
    resolveWorkspaceDir: () => workspaceDir,
    taskKeyOf: () => taskKey,
  });
  assert.equal(restored.get('session-1'), undefined, '目录已删 ⇒ 恢复时绑定被丢弃');
  const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.deepEqual(persisted.entries, {});
});

test('session scratch binding is dropped when expired or taskKey drifts (A07)', (t) => {
  const workspace = buildWorkspace(t);
  const { workspaceDir } = workspace;
  const filePath = join(tempDir(t, 'agent-os-scratch-'), 'session-scratches.json');
  const first = loadSessionScratchBindings({ filePath, resolveWorkspaceDir: () => workspaceDir });
  first.set('session-stale', {
    ...bindingOf(workspace),
    taskKey: 'task-old',
    at: Date.now() - SESSION_SCRATCH_MAX_AGE_MS - 1_000,
  });
  first.set('session-drift', {
    ...bindingOf(workspace),
    taskKey: 'task-old',
  });

  const restored = loadSessionScratchBindings({
    filePath,
    resolveWorkspaceDir: () => workspaceDir,
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
  store.set('session-esc', {
    relative: '../outside.txt', taskKey: 'task-1', at: Date.now(),
    workspaceRealpath: realpathSync(workspaceDir), scratchIdentity: '0:0',
  });
  // set 落盘了坏形状，但恢复核对必须丢弃（安全拒绝，不冒充可用）。
  const restored = loadSessionScratchBindings({
    filePath,
    resolveWorkspaceDir: () => workspaceDir,
    taskKeyOf: () => 'task-1',
  });
  assert.equal(restored.get('session-esc'), undefined);
});

test('session scratch binding resolve uses realpath (workspace symlinked) (A07)', (t) => {
  const workspace = buildWorkspace(t);
  const { workspaceReal, taskKey } = workspace;
  const linkDir = tempDir(t, 'agent-os-scratch-link-');
  const linkedWorkspace = join(linkDir, 'ws-link');
  symlinkSync(workspaceReal, linkedWorkspace, 'dir');
  const filePath = join(tempDir(t, 'agent-os-scratch-'), 'session-scratches.json');

  const first = loadSessionScratchBindings({
    filePath,
    resolveWorkspaceDir: () => linkedWorkspace,
  });
  first.set('session-link', bindingOf(workspace));
  const restored = loadSessionScratchBindings({
    filePath,
    resolveWorkspaceDir: () => linkedWorkspace,
    taskKeyOf: () => taskKey,
  });
  assert.ok(restored.get('session-link'), '经符号链接进入的同一真实工作区应恢复成功');
});

// ---- A07（166 号返工）：工作区身份 + legacy 记录 + 写失败不落内存 ---------------------

test('binding restores only into the same workspace realpath; same-name dir elsewhere is rejected (A07 166 号返工)', (t) => {
  const workspace = buildWorkspace(t);
  const { workspaceDir, scratchRelative, taskKey } = workspace;
  const otherWorkspace = tempDir(t, 'agent-os-scratch-other-');
  // 另一个工作区出现**同名** scratch 目录：不是同一个 scratch。
  mkdirSync(join(otherWorkspace, scratchRelative), { recursive: true });
  const filePath = join(tempDir(t, 'agent-os-scratch-'), 'session-scratches.json');
  const first = loadSessionScratchBindings({ filePath, resolveWorkspaceDir: () => workspaceDir });
  first.set('session-1', bindingOf(workspace));

  // 注意顺序：不匹配工作区的恢复会按既有语义把「被丢弃的绑定」落盘清除，
  // 因此先验证原工作区可恢复，再用文件副本验证跨工作区拒绝。
  const restoredHome = loadSessionScratchBindings({
    filePath,
    resolveWorkspaceDir: () => workspaceDir,
    taskKeyOf: () => taskKey,
  });
  assert.ok(restoredHome.get('session-1'), '原工作区正常恢复');

  const copyPath = join(tempDir(t, 'agent-os-scratch-copy-'), 'session-scratches.json');
  mkdirSync(join(copyPath, '..'), { recursive: true });
  writeFileSync(copyPath, readFileSync(filePath, 'utf8'));
  const restoredElsewhere = loadSessionScratchBindings({
    filePath: copyPath,
    resolveWorkspaceDir: () => otherWorkspace,
    taskKeyOf: () => taskKey,
  });
  assert.equal(restoredElsewhere.get('session-1'), undefined,
    '换工作区后同名目录不得恢复授权关联（目录身份不一致）');

  // 删后同名重建（新目录 inode）：不能仅凭同名目录再次出现就恢复授权关联。
  rmSync(join(workspaceDir, scratchRelative), { recursive: true, force: true });
  mkdirSync(join(workspaceDir, scratchRelative), { mode: 0o700 });
  const restoredRebuilt = loadSessionScratchBindings({
    filePath,
    resolveWorkspaceDir: () => workspaceDir,
    taskKeyOf: () => taskKey,
  });
  assert.equal(restoredRebuilt.get('session-1'), undefined,
    '同名重建目录的 inode 不同 ⇒ 目录身份不一致 ⇒ 绑定被丢弃');
});

test('legacy bindings without workspaceRealpath are dropped on restore (A07 166 号返工)', (t) => {
  const { workspaceDir, scratchRelative, taskKey } = buildWorkspace(t);
  const filePath = join(tempDir(t, 'agent-os-scratch-'), 'session-scratches.json');
  // 手写旧格式（无 workspaceRealpath）：无法核验身份 ⇒ 丢弃。
  writeFileSync(filePath, `${JSON.stringify({
    _v: 1,
    entries: {
      'session-legacy': { relative: scratchRelative, taskKey, at: Date.now() },
    },
  }, null, 2)}\n`);
  const restored = loadSessionScratchBindings({
    filePath,
    resolveWorkspaceDir: () => workspaceDir,
    taskKeyOf: () => taskKey,
  });
  assert.equal(restored.get('session-legacy'), undefined, 'legacy 无身份记录不可恢复');
});

test('requireSessionScratchBinding rejects cross-workspace use of a binding (A07 166 号返工)', (t) => {
  const { workspaceReal, scratchRelative, taskKey } = buildWorkspace(t);
  const scratches = new Map<string, SessionScratchBinding>([['session-1', {
    relative: scratchRelative, taskKey, at: Date.now(), workspaceRealpath: workspaceReal,
  }]]);
  assert.equal(requireSessionScratchBinding({
    scratches, sessionId: 'session-1', taskKey, workspaceRealpath: workspaceReal,
  }), scratchRelative);
  assert.throws(() => requireSessionScratchBinding({
    scratches, sessionId: 'session-1', taskKey, workspaceRealpath: join(workspaceReal, '..', 'other-ws'),
  }), /工作区身份与当前工作区不一致/);
});

test('scratch set/delete/clear persist failures leave memory identical to disk (A07 166 号返工)', (t) => {
  const dir = tempDir(t, 'agent-os-scratch-fail-');
  const filePath = join(dir, 'session-scratches.json');
  const store = new SessionScratchBindingStore(filePath, new Map());
  const bindingA: SessionScratchBinding = {
    relative: '.aos-scratch-a', taskKey: 'task-a', at: Date.now(), workspaceRealpath: '/tmp/ws-a',
  };

  // set 失败：内存不得留下未落盘的绑定。
  chmodSync(dir, 0o500);
  assert.throws(() => store.set('session-1', bindingA));
  chmodSync(dir, 0o700);
  assert.equal(store.get('session-1'), undefined, 'set 失败不得留下内存绑定');
  assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')).entries, {}, '磁盘与内存一致（无绑定）');

  // delete 失败：内存与磁盘都保留原绑定。
  store.set('session-1', bindingA);
  const onDiskBefore = readFileSync(filePath, 'utf8');
  chmodSync(dir, 0o500);
  assert.throws(() => store.delete('session-1'));
  chmodSync(dir, 0o700);
  assert.ok(store.get('session-1'), 'delete 失败 ⇒ 内存保留');
  assert.equal(readFileSync(filePath, 'utf8'), onDiskBefore, 'delete 失败 ⇒ 磁盘保留');

  // clear 失败：内存与磁盘都保留。
  chmodSync(dir, 0o500);
  assert.throws(() => store.clear());
  chmodSync(dir, 0o700);
  assert.ok(store.get('session-1'), 'clear 失败 ⇒ 内存保留');
  assert.equal(readFileSync(filePath, 'utf8'), onDiskBefore, 'clear 失败 ⇒ 磁盘保留');

  // 恢复正常后 delete 成功且两侧一致。
  store.delete('session-1');
  assert.equal(store.get('session-1'), undefined);
  assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')).entries, {});
});
