import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertGroupFullyExited,
  isProcessGroupAlive,
  isZombieState,
  launchIsolated,
  listProcessGroup,
  parseProcessGroupListing,
  prepareIsolation,
  requireSessionScratchBinding,
  settleGroupAfterExit,
  terminateIsolatedChild,
  type IsolationProtectedRoots,
} from '../src/core/isolation.js';

function temp(t: { after: (fn: () => void) => void }, prefix = 'agent-os-isoproc-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function alwaysPassStore() {
  // A03：能力条目必填 evidenceRef/expiresAt；fixture 以远期时间表示未过期。
  return {
    lookup: () => ({
      read: 'passed' as const,
      write: 'passed' as const,
      evidenceRef: 'fixture://capability-stub',
      expiresAt: '9999-12-31T23:59:59.000Z',
    }),
  };
}

function fixtureHarnessRoots(root: string): IsolationProtectedRoots {
  return { version: 'fixture', roots: [join(root, 'protected')] };
}

// ---- kill(-pgid,0) 核验（不依赖 ps；宿主沙箱内可用） ------------------------------

test('isProcessGroupAlive: alive group detected, exited group ESRCH', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* 已退 */ } });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const alive = isProcessGroupAlive(child.pid!);
  assert.deepEqual(alive, { ok: true, alive: true });
  process.kill(-child.pid!, 'SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const gone = isProcessGroupAlive(child.pid!);
  assert.deepEqual(gone, { ok: true, alive: false });
  assert.doesNotThrow(() => assertGroupFullyExited(child.pid!));
});

test('terminateIsolatedChild kills the whole group including grandchildren (wrapper exit is not proof)', { timeout: 30_000 }, async (t) => {
  // 孙进程 sleep 30s：只杀 wrapper 时它会存活；整组终止后必须全部退出。
  const grandchildScript = 'setInterval(()=>{},1000); setTimeout(()=>{},30000);';
  const childScript = `
    const { spawn } = require('node:child_process');
    const gc = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });
    process.stdout.write(String(gc.pid));
    setInterval(()=>{},1000);
  `;
  const child = spawn(process.execPath, ['-e', childScript], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* 已退 */ } });
  const grandchildPid = await new Promise<number>((resolve) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      const pid = Number(chunk.toString().trim());
      if (Number.isFinite(pid) && pid > 0) resolve(pid);
    });
  });
  const beforeTerminate = isProcessGroupAlive(child.pid!);
  assert.equal(beforeTerminate.ok && beforeTerminate.alive, true);
  const outcome = await terminateIsolatedChild(child, { termGraceMs: 1_500, killGraceMs: 1_500 });
  assert.equal(outcome.outcome, 'terminated');
  assert.equal(outcome.groupAliveAfter, false);
  // 孙进程一并退出（kill(-pid,0) ESRCH）。
  await new Promise((resolve) => setTimeout(resolve, 200));
  let grandchildGone = false;
  try {
    process.kill(grandchildPid, 0);
  } catch (error) {
    grandchildGone = (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  assert.equal(grandchildGone, true, '孙进程必须随进程组一起退出');
  assert.doesNotThrow(() => assertGroupFullyExited(child.pid!));
});

test('assertGroupFullyExited fails closed when group members survive', async (t) => {
  const childScript = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    process.stdout.write('x');
  `;
  const child = spawn(process.execPath, ['-e', childScript], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* 已退 */ } });
  await new Promise<void>((resolve) => child.stdout!.once('data', () => setTimeout(resolve, 250)));
  // 杀 wrapper（模拟只杀直接子进程的错误做法）→ 组内孙进程仍在 → 核验失败关闭。
  try { process.kill(child.pid!, 'SIGKILL'); } catch { /* ignore */ }
  await new Promise((resolve) => child.once('close', resolve));
  assert.throws(() => assertGroupFullyExited(child.pid!), /仍有存活后代/);
  await terminateIsolatedChild(child, { termGraceMs: 1_000, killGraceMs: 1_000 });
});

// ---- 正常退出后的组收尾：宽限 / 升级终止 / 僵尸排除（2026-10-07 误杀回归） --------

test('settleGroupAfterExit: 辅助进程滞后有序退出 ⇒ 宽限窗口内判 settled，不丢弃已完成结果', { timeout: 15_000 }, async (t) => {
  // 复现线上竞态：组长（wrapper/CLI 主进程）立即退出，孙进程 0.6s 后自行退出。
  // 曾经的一次瞬时核验会把这个窗口当「有存活后代」判失败。
  const child = spawn('sh', ['-c', 'sleep 0.6 & exit 0'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* 已退 */ } });
  await new Promise((resolve) => child.once('close', resolve));
  const outcome = await settleGroupAfterExit(child.pid, { graceMs: 3_000, termGraceMs: 1_000, killGraceMs: 1_000 });
  assert.equal(outcome.outcome, 'settled');
  assert.doesNotThrow(() => assertGroupFullyExited(child.pid!));
});

test('settleGroupAfterExit: 宽限耗尽仍有存活 ⇒ 升级整组终止后 settled', { timeout: 15_000 }, async (t) => {
  // 孙进程 sleep 30s 不会自己退：宽限耗尽后必须整组终止并核验干净，而不是判失败。
  const child = spawn('sh', ['-c', 'sleep 30 & exit 0'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* 已退 */ } });
  await new Promise((resolve) => child.once('close', resolve));
  const outcome = await settleGroupAfterExit(child.pid, { graceMs: 300, termGraceMs: 1_000, killGraceMs: 1_000 });
  assert.equal(outcome.outcome, 'settled');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(isProcessGroupAlive(child.pid!), { ok: true, alive: false });
});

test('parseProcessGroupListing: state/command 解析与僵尸识别（command 含空格）', () => {
  const stdout = [
    '  123 123 S node /usr/local/bin/foo --bar baz',
    '  124 123 Z (helper)',
    '  999 777 R other-group proc',
    '',
  ].join('\n');
  assert.deepEqual(parseProcessGroupListing(stdout, 123), [
    { pid: 123, state: 'S', command: 'node /usr/local/bin/foo --bar baz' },
    { pid: 124, state: 'Z', command: '(helper)' },
  ]);
  assert.equal(isZombieState('Z'), true);
  assert.equal(isZombieState('Z+'), true);
  assert.equal(isZombieState('S'), false);
  assert.equal(isZombieState('R'), false);
});

test('listProcessGroup: 存活成员枚举出 state 与命令行（诊断详情可用）', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* 已退 */ } });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const snapshot = listProcessGroup(child.pid!);
  assert.equal(snapshot.ok, true);
  const leader = snapshot.members.find((member) => member.pid === child.pid);
  assert.ok(leader, '组长必须出现在枚举结果中');
  assert.ok(!isZombieState(leader.state));
  assert.ok(leader.command.length > 0);
});

// ---- 能力先于 scratch + 失败清理（119 号 P1-1） ------------------------------------

test('prepare creates no workspace scratch when capability missing; cleans up own scratch on later failure', async (t) => {
  const workspace = temp(t);
  const roots = fixtureHarnessRoots(temp(t));
  const before = readdirSync(workspace);
  // 1) 无能力证据：先失败关闭，工作区零痕迹。
  await assert.rejects(prepareIsolation({
    input: { taskId: 'task-x', purpose: 'task', command: 'node', cwd: workspace },
    harness: { capabilityStore: { lookup: () => undefined }, probeFixture: async () => ({ ok: true }), envBase: { PATH: process.env.PATH } },
    protectedRoots: roots,
  }), /读写隔离未验证/);
  assert.deepEqual(readdirSync(workspace), before, '能力缺失时不得留下 scratch');

  // 2) 能力通过但后续步骤失败（探针失败）：只清理本次自建 scratch。
  await assert.rejects(prepareIsolation({
    input: { taskId: 'task-y', purpose: 'task', command: 'node', cwd: workspace },
    harness: { capabilityStore: alwaysPassStore(), probeFixture: async () => ({ ok: false, reason: 'fixture 探针失败' }), envBase: { PATH: process.env.PATH } },
    protectedRoots: roots,
  }), /隔离预检失败/);
  assert.deepEqual(readdirSync(workspace), before, '失败路径必须清理本次自建 scratch');

  // 3) 成功路径保留 scratch 供任务使用。
  const prepared = await prepareIsolation({
    input: { taskId: 'task-z', purpose: 'task', command: 'node', cwd: workspace },
    harness: { capabilityStore: alwaysPassStore(), probeFixture: async () => ({ ok: true }), envBase: { PATH: process.env.PATH } },
    protectedRoots: roots,
    gitStatus: async () => undefined,
  });
  assert.ok(existsSync(prepared.context.scratchDir));
  assert.ok(prepared.scratchRelative!.startsWith('.aos-scratch-'));
});

// ---- sessionScratches 绑定门（119 号 P1-4） ----------------------------------------

test('requireSessionScratchBinding: missing / cross-task / stale all fail closed', () => {
  const map = new Map<string, { relative: string; taskKey: string; at: number }>();
  assert.throws(() => requireSessionScratchBinding({ scratches: map, sessionId: 's1', taskKey: 't1' }), /没有经隔离建立的任务 scratch/);
  map.set('s1', { relative: '.fx', taskKey: 't1', at: Date.now() });
  assert.equal(requireSessionScratchBinding({ scratches: map, sessionId: 's1', taskKey: 't1' }), '.fx');
  assert.throws(() => requireSessionScratchBinding({ scratches: map, sessionId: 's1', taskKey: 't2' }), /跨任务引用被拒/);
  const stale = new Map([['s1', { relative: '.fx', taskKey: 't1', at: Date.now() - 25 * 60 * 60 * 1000 }]]);
  assert.throws(() => requireSessionScratchBinding({ scratches: stale, sessionId: 's1', taskKey: 't1' }), /已过期/);
});

// ---- launchIsolated 经 fixture 解包 spawn 的组语义冒烟（无 sandbox-exec 依赖） ------

test('launchIsolated children run in their own process group (detached)', { timeout: 30_000 }, async (t) => {
  const root = temp(t);
  mkdirSync(join(root, 'protected'), { recursive: true });
  const prepared = await prepareIsolation({
    input: { taskId: 'grp-1', purpose: 'probe', command: process.execPath, cwd: root },
    harness: {
      capabilityStore: alwaysPassStore(),
      probeFixture: async () => ({ ok: true }),
      sandboxExecCommand: 'sandbox-exec-fixture',
      spawn: (command, args, options) => {
        if (command !== 'sandbox-exec-fixture') return spawn(command, args, options);
        const marker = args.indexOf('--');
        return spawn(args[marker + 1], args.slice(marker + 2), options);
      },
      envBase: { PATH: process.env.PATH },
    },
    protectedRoots: fixtureHarnessRoots(root),
  });
  const child = launchIsolated(prepared, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* 已退 */ } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(isProcessGroupAlive(child.pid!), { ok: true, alive: true });
  const outcome = await terminateIsolatedChild(child, { termGraceMs: 1_000, killGraceMs: 1_000 });
  assert.equal(outcome.outcome, 'terminated');
  assert.equal(outcome.groupAliveAfter, false);
});
