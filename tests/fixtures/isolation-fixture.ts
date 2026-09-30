import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prepareIsolation,
  type IsolationProtectedRoots,
  type IsolationSupplier,
} from '../../src/core/isolation.js';

/**
 * G-W6b-FIX 测试专用隔离 supplier（**仅测试**，不得进入 src/）：
 * - 受保护根 = 每次调用自造的临时假根，不触碰真实 KB；
 * - 能力库 = 恒定 passed（fixture 模拟「该环境键 canary 已通过」，只对受控
 *   fake 命令有意义，不构成任何真实隔离证据）；
 * - fixture 写探针 = 恒定 ok（真实 sandbox-exec 预检由 tests/isolation.test.ts
 *   用 preflightFixtureProbe 实测，本会话宿主沙箱内不可嵌套时诚实 skip）；
 * - spawn = **测试专用解包**：收到 `sandbox-exec-fixture -p <profile> -- <cmd>`
 *   时剥掉包装直接运行 <cmd>——因为测试进程本身已在宿主沙箱内，无法嵌套
 *   sandbox-exec；这只让 runCli/executeRun 的链路逻辑（参数、事件、基线、
 *   差异判读）可测，**不执行也不证明任何真实隔离**。
 */
export const FIXTURE_SANDBOX_COMMAND = 'sandbox-exec-fixture';

export function createFixtureIsolationSupplier(): {
  supplier: IsolationSupplier;
  protectedRoots: IsolationProtectedRoots;
  cleanup: () => void;
} {
  const fakeRoot = mkdtempSync(join(tmpdir(), 'agent-os-iso-fixture-root-'));
  const protectedRoots: IsolationProtectedRoots = {
    version: 'fixture-1',
    roots: [fakeRoot],
  };
  const supplier: IsolationSupplier = (input) => prepareIsolation({
    input,
    harness: {
      // A03：条目必填 evidenceRef/expiresAt——fixture 用远期过期时间模拟
      // 「该环境键 canary 已通过且未过期」（仅对受控 fake 命令有意义）。
      capabilityStore: {
        lookup: () => ({
          read: 'passed',
          write: 'passed',
          evidenceRef: 'fixture://capability-stub',
          expiresAt: '9999-12-31T23:59:59.000Z',
        }),
      },
      probeFixture: async () => ({ ok: true }),
      sandboxExecCommand: FIXTURE_SANDBOX_COMMAND,
      spawn: (command, args, options) => {
        if (command !== FIXTURE_SANDBOX_COMMAND) {
          return spawn(command, args, options);
        }
        const marker = args.indexOf('--');
        if (marker < 0 || args[0] !== '-p') {
          throw new Error('fixture 解包 spawn 收到意外的 sandbox 参数形状');
        }
        const realCommand = args[marker + 1];
        const realArgs = args.slice(marker + 2);
        return spawn(realCommand, realArgs, options);
      },
      envBase: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
    },
    protectedRoots,
  });
  return {
    supplier,
    protectedRoots,
    cleanup: () => rmSync(fakeRoot, { recursive: true, force: true }),
  };
}
