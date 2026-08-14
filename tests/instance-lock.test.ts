import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  acquireInstanceLock,
  InstanceLockError,
  isPidAlive,
  readLockPid,
  reclaimStaleLock,
} from '../src/core/instance-lock.js';

test('单实例锁写入当前 PID，释放后文件消失', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-lock-'));
  const lockFile = join(root, '.agent-os.lock');
  try {
    const lock = acquireInstanceLock(lockFile);
    assert.equal(existsSync(lockFile), true);
    assert.equal(readLockPid(lockFile), process.pid);
    lock.release();
    assert.equal(existsSync(lockFile), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('活着的 PID 占用锁时拒绝第二个实例', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-lock-live-'));
  const lockFile = join(root, '.agent-os.lock');
  try {
    const first = acquireInstanceLock(lockFile);
    assert.throws(() => acquireInstanceLock(lockFile), InstanceLockError);
    first.release();
    const second = acquireInstanceLock(lockFile);
    second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('残留锁且 PID 已退出时自动接管', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-lock-stale-'));
  const lockFile = join(root, '.agent-os.lock');
  try {
    writeFileSync(lockFile, '999999999\n');
    assert.equal(isPidAlive(999999999), false);
    assert.equal(reclaimStaleLock(lockFile), true);
    writeFileSync(lockFile, '999999999\n');
    const lock = acquireInstanceLock(lockFile);
    assert.equal(readFileSync(lockFile, 'utf8').trim(), String(process.pid));
    lock.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('残留锁且 PID 仍存活时不接管', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-lock-held-'));
  const lockFile = join(root, '.agent-os.lock');
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    assert.ok(child.pid);
    writeFileSync(lockFile, `${child.pid}\n`);
    assert.equal(isPidAlive(child.pid), true);
    assert.equal(reclaimStaleLock(lockFile), false);
    assert.throws(() => acquireInstanceLock(lockFile), (error: unknown) => {
      assert.ok(error instanceof InstanceLockError);
      assert.equal(error.pid, child.pid);
      return true;
    });
    assert.equal(existsSync(lockFile), true);
  } finally {
    child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
