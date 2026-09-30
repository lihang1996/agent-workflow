import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDataDirLock } from '../src/core/data-lock.js';

/**
 * A08：data 目录单实例锁测试。
 */

function tempDataDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-data-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('acquire writes pid+timestamp; a second acquire in a live process is rejected (A08)', (t) => {
  const dataDir = tempDataDir(t);
  const lock = acquireDataDirLock(dataDir);
  const lockPath = join(dataDir, '.lock');
  assert.ok(existsSync(lockPath));
  const payload = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(payload.pid, process.pid);
  assert.ok(typeof payload.at === 'string' && !Number.isNaN(Date.parse(payload.at)));

  // 同一存活进程再次抢锁：拒绝（另一实例运行中）。
  assert.throws(() => acquireDataDirLock(dataDir), /另一实例运行中/);
  lock.release();
  assert.equal(existsSync(lockPath), false, 'release 删除锁文件');
});

test('a stale lock held by a dead process is taken over (A08)', (t) => {
  const dataDir = tempDataDir(t);
  const lockPath = join(dataDir, '.lock');
  // macOS pid 上限 99998（Linux 上限 4194304），99999999 必然无此进程 ⇒ ESRCH。
  const deadPid = 99999999;
  writeFileSync(lockPath, `${JSON.stringify({ pid: deadPid, at: '2026-01-01T00:00:00.000Z' })}\n`);
  const lock = acquireDataDirLock(dataDir);
  const payload = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(payload.pid, process.pid, '死锁被抢占式接管并重写');
  lock.release();
  assert.equal(existsSync(lockPath), false);
});

test('a lock held by a real dead child process is taken over (A08)', (t) => {
  const dataDir = tempDataDir(t);
  const lockPath = join(dataDir, '.lock');
  // 真实进程路径：spawn 一个立即退出的进程（spawnSync 会收尸，之后 kill(pid,0) = ESRCH）。
  // spawnSync 的 pid 在部分 Node 版本为 0/缺失，此时退回固定死 pid（99999999）。
  const exited = spawnSync('/bin/true');
  const candidate = exited.pid && exited.pid > 0 ? exited.pid : 99999999;
  let confirmedDead = false;
  try {
    process.kill(candidate, 0);
  } catch (error) {
    confirmedDead = (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
  const deadPid = confirmedDead ? candidate : 99999999;
  writeFileSync(lockPath, `${JSON.stringify({ pid: deadPid, at: '2026-01-01T00:00:00.000Z' })}\n`);
  const lock = acquireDataDirLock(dataDir);
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid);
  lock.release();
});

test('release is idempotent and never removes another holder\'s lock (A08)', (t) => {
  const dataDir = tempDataDir(t);
  const lock = acquireDataDirLock(dataDir);
  const lockPath = join(dataDir, '.lock');
  lock.release();
  // 二次 release 幂等：文件不存在也不抛错。
  lock.release();

  // 重新获取后把文件改成他人锁（模拟被接管），release 不得误删。
  const second = acquireDataDirLock(dataDir);
  writeFileSync(lockPath, `${JSON.stringify({ pid: 99999999, at: '2026-01-01T00:00:00.000Z' })}\n`);
  second.release();
  assert.equal(existsSync(lockPath), true, '他人的锁不得被本进程 release 删除');
});

test('corrupt lock file fails closed (A08)', (t) => {
  const dataDir = tempDataDir(t);
  const lockPath = join(dataDir, '.lock');
  writeFileSync(lockPath, 'not json at all');
  assert.throws(() => acquireDataDirLock(dataDir), /失败关闭/);
});
