import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { acquireDataDirLock } from '../src/core/data-lock.js';
import { writeJsonState } from '../src/core/json-state.js';

/**
 * A08（166 号返工）：data 目录单实例**目录原子锁**测试。
 * 核心用例：多个真实子进程以 barrier 同时竞争 dead-PID 锁，整个存活期间
 * 最多一个成功；接管/释放交错；损坏锁失败关闭；JSON 唯一临时文件。
 */

const CONTENDER = fileURLToPath(new URL('./fixtures/data-lock/contender.mts', import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEAD_PID = 99999999; // macOS pid 上限 99998（Linux 上限 4194304），必然无此进程。

function tempDataDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-data-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lockDirOf(dataDir: string): string {
  return join(dataDir, '.agent-os-lock.d');
}

/** 直接构造一把「死 PID 陈旧锁」（模拟上次崩溃残留）。 */
function writeStaleLock(dataDir: string, pid: number): void {
  const lockDir = lockDirOf(dataDir);
  mkdirSync(lockDir, { recursive: false, mode: 0o700 });
  writeFileSync(join(lockDir, 'owner.json'), `${JSON.stringify({
    pid, token: `stale-token-${pid}`, at: '2026-01-01T00:00:00.000Z',
  }, null, 2)}\n`);
}

function spawnContender(dataDir: string, gate: string, ready: string, holdMs: number) {
  return spawn(process.execPath, ['--import', 'tsx', CONTENDER, dataDir, gate, ready, String(holdMs)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: PROJECT_ROOT,
  });
}

function waitForFile(path: string, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (existsSync(path) || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 2);
  });
}

function collectOutput(child: ReturnType<typeof spawnContender>): Promise<string> {
  return new Promise((resolve) => {
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.once('close', () => resolve(output));
  });
}

test('acquire creates the lock directory with owner pid+token; same-process re-acquire rejected (A08)', (t) => {
  const dataDir = tempDataDir(t);
  const lock = acquireDataDirLock(dataDir);
  const lockDir = lockDirOf(dataDir);
  assert.ok(existsSync(lockDir), '锁是一个目录');
  assert.equal(lock.lockPath, lockDir);
  const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.ok(typeof owner.token === 'string' && owner.token.length >= 16, '唯一所有权 token');
  assert.ok(!Number.isNaN(Date.parse(owner.at)));

  // 同一存活进程再次抢锁：拒绝（另一实例运行中）。
  assert.throws(() => acquireDataDirLock(dataDir), /另一实例运行中/);
  lock.release();
  assert.equal(existsSync(lockDir), false, 'release 删除锁目录');
  // release 幂等。
  lock.release();
  // 释放后可重新获取。
  const again = acquireDataDirLock(dataDir);
  again.release();
});

test('stale locks are preserved and rejected until controlled operator cleanup (A08)', (t) => {
  const dataDir = tempDataDir(t);
  writeStaleLock(dataDir, DEAD_PID);
  const before = readFileSync(join(lockDirOf(dataDir), 'owner.json'), 'utf8');
  assert.throws(() => acquireDataDirLock(dataDir), /陈旧锁.*失败关闭/);
  assert.equal(readFileSync(join(lockDirOf(dataDir), 'owner.json'), 'utf8'), before);
});

test('takeover/release interleave: a released-then-retaken lock is never removed by the old holder (A08)', (t) => {
  const dataDir = tempDataDir(t);
  const first = acquireDataDirLock(dataDir);
  first.release();
  // 旧持有者的 release 已完成；新持有者接管（模拟：直接换 owner）。
  const second = acquireDataDirLock(dataDir);
  // 旧 lock 对象再次 release（迟到释放）：不得删除新持有者的锁。
  first.release();
  assert.ok(existsSync(lockDirOf(dataDir)), '迟到的旧 release 不得删除新持有者的锁');
  const owner = JSON.parse(readFileSync(join(lockDirOf(dataDir), 'owner.json'), 'utf8'));
  assert.equal(owner.pid, process.pid);
  second.release();
});

test('corrupt lock (unreadable owner) fails closed (A08)', (t) => {
  const dataDir = tempDataDir(t);
  const lockDir = lockDirOf(dataDir);
  mkdirSync(lockDir, { recursive: false, mode: 0o700 });
  writeFileSync(join(lockDir, 'owner.json'), 'not json at all');
  assert.throws(() => acquireDataDirLock(dataDir), /失败关闭/);
  // 空 owner（无文件）同样失败关闭。
  rmSync(join(lockDir, 'owner.json'));
  assert.throws(() => acquireDataDirLock(dataDir), /失败关闭/);
});

test('real multi-process barrier race on a dead-PID lock: all refuse without altering it (A08 166 号返工)', async (t) => {
  const dataDir = tempDataDir(t);
  const gate = join(dataDir, 'gate.txt');
  writeFileSync(gate, 'WAIT\n');
  writeStaleLock(dataDir, DEAD_PID);
  const before = readFileSync(join(lockDirOf(dataDir), 'owner.json'), 'utf8');

  const count = 3;
  const children = Array.from({ length: count }, (_, index) =>
    spawnContender(dataDir, gate, join(dataDir, `ready-${index}.txt`), 800));
  const outputs = children.map((child) => collectOutput(child));
  await Promise.all(Array.from({ length: count }, (_, index) => waitForFile(join(dataDir, `ready-${index}.txt`))));
  // 所有竞争者都已就位：放行栅栏，同时抢锁。
  writeFileSync(gate, 'GO\n');
  const results = await Promise.all(outputs);
  const winners = results.filter((output) => output.includes('WIN'));
  assert.equal(winners.length, 0,
    `陈旧锁竞争必须没有赢家（实际 ${winners.length}）：${JSON.stringify(results)}`);
  const losers = results.filter((output) => !output.includes('WIN'));
  assert.equal(losers.length, count);
  for (const loser of losers) {
    assert.match(loser, /LOSE:/, '输家必须显式拒绝');
  }
  // 全部子进程退出（赢家含 800ms 持锁 + release）后锁目录消失。
  assert.equal(readFileSync(join(lockDirOf(dataDir), 'owner.json'), 'utf8'), before);
  assert.equal(existsSync(lockDirOf(dataDir)), true, '陈旧锁保留供停止全部实例后的人工核对');
});

test('real multi-process race against a live holder: all contenders rejected (A08)', async (t) => {
  const dataDir = tempDataDir(t);
  const mine = acquireDataDirLock(dataDir);
  const gate = join(dataDir, 'gate.txt');
  writeFileSync(gate, 'WAIT\n');
  const children = [0, 1].map((index) => spawnContender(dataDir, gate, join(dataDir, `r-${index}.txt`), 0));
  const outputs = children.map((child) => collectOutput(child));
  await Promise.all([0, 1].map((index) => waitForFile(join(dataDir, `r-${index}.txt`))));
  writeFileSync(gate, 'GO\n');
  const results = await Promise.all(outputs);
  assert.ok(results.every((output) => output.includes('LOSE:')), `存活持有者必须让竞争者全部被拒：${JSON.stringify(results)}`);
  mine.release();
});

test('acquire fails (no partial state) when the data dir is unwritable (A08)', (t) => {
  const readOnlyDir = mkdtempSync(join(tmpdir(), 'agent-os-data-lock-ro-'));
  t.after(() => rmSync(readOnlyDir, { recursive: true, force: true }));
  chmodSync(readOnlyDir, 0o500);
  let threw = false;
  try {
    acquireDataDirLock(readOnlyDir);
  } catch {
    threw = true;
  }
  chmodSync(readOnlyDir, 0o700);
  assert.ok(threw, 'dataDir 不可写时 acquire 必须失败');
});

// ---- JSON 唯一临时文件（A08） -------------------------------------------------------

test('writeJsonState uses unique temp files and leaves no fixed .tmp behind (A08 166 号返工)', (t) => {
  const dir = tempDataDir(t);
  const target = join(dir, 'state.json');
  writeJsonState(target, { _v: 1, seed: 1 });
  writeJsonState(target, { _v: 1, seed: 2 });
  const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, [], '成功写入不残留任何临时文件（更不共用固定名）');
  // 源码级断言：不得出现固定临时文件名（行为级并发完整性见下一用例）。
  const source = readFileSync(join(PROJECT_ROOT, 'src/core/json-state.ts'), 'utf8');
  assert.ok(!source.includes('`${filePath}.tmp`'), '必须使用唯一临时文件名');
});

test('concurrent multi-process writeJsonState keeps the target file integral (A08 166 号返工)', async (t) => {
  const dir = tempDataDir(t);
  const target = join(dir, 'shared-state.json');
  writeJsonState(target, { _v: 1, writer: 'init', round: 0, pad: '' });
  const worker = Array.from({ length: 2 }, (_, index) => new Promise<void>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', [
      `import { writeJsonState } from ${JSON.stringify(join(PROJECT_ROOT, 'src/core/json-state.ts'))};`,
      `const target = ${JSON.stringify(target)};`,
      'const id = process.argv[1];',
      'for (let round = 0; round < 120; round += 1) {',
      '  writeJsonState(target, { _v: 1, writer: id, round, pad: "x".repeat(4096) });',
      '}',
      'process.stdout.write("done");',
    ].join('\n'), `w${index}`], { stdio: ['ignore', 'pipe', 'pipe'], cwd: PROJECT_ROOT });
    child.once('close', () => resolve());
  }));
  // 采样：并发期间目标文件必须始终是完整可解析的 JSON。
  let corruption: unknown = null;
  const sampler = setInterval(() => {
    try {
      const parsed = JSON.parse(readFileSync(target, 'utf8'));
      if (typeof parsed.round !== 'number') corruption = 'shape';
    } catch (error) {
      corruption = error;
    }
  }, 1);
  await Promise.all(worker);
  clearInterval(sampler);
  assert.equal(corruption, null, `并发写入期间文件必须保持完整（corruption=${String(corruption)}）`);
  const final = JSON.parse(readFileSync(target, 'utf8'));
  assert.equal(final._v, 1);
  assert.ok(typeof final.round === 'number', '最终内容是某个写者的完整写入');
  const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, [], '并发完成后不残留临时文件');
});
