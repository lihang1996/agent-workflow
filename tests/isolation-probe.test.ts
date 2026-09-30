import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIsolatedProbe } from '../src/core/engine-runtime.js';
import { prepareIsolation, type IsolationSupplier } from '../src/core/isolation.js';

function temp(t: { after: (fn: () => void) => void }, prefix: string): string {
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

/** fixture preparer：unwrap sandbox 包装直跑 node（能力恒 passed + 探针 stub）。 */
function fixturePreparer(protectedRoot: string): IsolationSupplier {
  return (input) => prepareIsolation({
    input,
    harness: {
      capabilityStore: alwaysPassStore(),
      probeFixture: async () => ({ ok: true }),
      sandboxExecCommand: 'sandbox-exec-fixture',
      spawn: (command, args, spawnOptions) => {
        if (command !== 'sandbox-exec-fixture') return spawn(command, args, spawnOptions);
        const marker = args.indexOf('--');
        return spawn(args[marker + 1], args.slice(marker + 2), spawnOptions);
      },
      envBase: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    },
    protectedRoots: { version: 'fixture', roots: [protectedRoot] },
  });
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function readGrandchildPid(pidFile: string): Promise<number | undefined> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      if (Number.isFinite(pid) && pid > 0) return pid;
    } catch { /* 尚未写入 */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

// ---- 149 号 P1-3：defaultProbe 收尾门（经 runIsolatedProbe 参数化驱动同一代码路径）----

test('P1-3 probe：wrapper 先退、孙进程仍存活 → 收尾门终止孙进程后才返回（PID 级核验）', { timeout: 60_000 }, async (t) => {
  const protectedRoot = temp(t, 'agent-os-probe-pr-');
  const pidDir = temp(t, 'agent-os-probe-pid-');
  const grandchildScript = `
    const { writeFileSync } = require('node:fs');
    writeFileSync(${JSON.stringify(join(pidDir, 'gc.pid'))}, String(process.pid));
    setInterval(()=>{},60000);
  `;
  const wrapperScript = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });
    // 等孙进程落盘 PID 再退（避免 close→shutdown 在孙进程写文件前就杀组）。
    setTimeout(() => {
      process.stdout.write('probe-output\\n');
      process.exit(0);
    }, 800);
  `;
  const pending = runIsolatedProbe(process.execPath, ['-e', wrapperScript], fixturePreparer(protectedRoot));
  const grandchildPid = await readGrandchildPid(join(pidDir, 'gc.pid'));
  assert.ok(grandchildPid, '孙进程必须回传 PID');
  assert.ok(isPidAlive(grandchildPid), '孙进程在 wrapper 退出后仍存活');
  const result = await pending;
  assert.equal(result.ok, false, 'wrapper 先退而孙进程存活 ⇒ 失败关闭（wrapper 退出码不作数）');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(isPidAlive(grandchildPid), false, '孙进程必须被收尾门终止（kill(pid,0)=ESRCH，PID 级核验）');
});

test('P1-3 probe：超时（长驻 wrapper + 孙进程）→ 整组终止核验后失败返回', { timeout: 60_000 }, async (t) => {
  const protectedRoot = temp(t, 'agent-os-probe-pr-');
  const pidDir = temp(t, 'agent-os-probe-pid-');
  const grandchildScript = `
    const { writeFileSync } = require('node:fs');
    writeFileSync(${JSON.stringify(join(pidDir, 'gc.pid'))}, String(process.pid));
    setInterval(()=>{},60000);
  `;
  const wrapperScript = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });
    setInterval(()=>{},10000);
  `;
  const pending = runIsolatedProbe(process.execPath, ['-e', wrapperScript], fixturePreparer(protectedRoot));
  const grandchildPid = await readGrandchildPid(join(pidDir, 'gc.pid'));
  assert.ok(grandchildPid);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.ok(result.stderr.length > 0, '失败必须带原因');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(isPidAlive(grandchildPid), false, '超时竞态后孙进程必须全灭（PID 级核验）');
});

test('P1-3 probe：正常退出（无后代）→ ok 且探测工作区清理', { timeout: 60_000 }, async (t) => {
  const protectedRoot = temp(t, 'agent-os-probe-pr-');
  const result = await runIsolatedProbe(
    process.execPath, ['-e', 'process.stdout.write("v1.2.3\\n")'],
    fixturePreparer(protectedRoot),
  );
  assert.equal(result.ok, true);
  assert.match(result.stdout, /v1\.2\.3/);
  const leftovers = readdirSync(tmpdir()).filter((name) => name.startsWith('agent-os-iso-probe-ws-'));
  assert.equal(leftovers.length, 0, `正常路径的探测工作区必须清理，残留: ${leftovers.join(',')}`);
});

test('P1-3 probe：生产 preparer（本沙箱）失败关闭且不留工作区', { timeout: 60_000 }, async () => {
  // 生产 defaultProbe 不注入 preparer：能力库空（data/… 不存在）⇒ 失败关闭；
  // 从未 launch 的探测工作区必须清理（finally !launched 路径）。
  const result = await runIsolatedProbe(process.execPath, ['-e', 'process.stdout.write("x\\n")']);
  assert.equal(result.ok, false, '生产 preparer 必须失败关闭（能力库空/预检不可用）');
  const leftovers = readdirSync(tmpdir()).filter((name) => name.startsWith('agent-os-iso-probe-ws-'));
  assert.equal(leftovers.length, 0, `失败路径（从未 launch）不得遗留工作区: ${leftovers.join(',')}`);
});
