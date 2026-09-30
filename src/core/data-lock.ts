import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A08（Codex 深度审查批）：data 目录单实例锁。
 *
 * 多个 agent-os 进程同时跑会共写 data/ 下的台账（sessions、task-executions、
 * authorizations…），既有 store 都是「整文件读改写」，并发即互相覆盖。启动时
 * 用 `data/.lock`（O_EXCL 创建，写 pid+时间戳）保证单实例：
 * - 锁文件不存在 ⇒ 创建成功，持锁；
 * - 已存在 ⇒ 读出持有者 pid，`process.kill(pid, 0)` 纯探活：
 *   - ESRCH（进程已死）⇒ 抢占式接管（上次崩溃残留的陈旧锁，重写为本进程）；
 *   - 存活（含 EPERM——目标存在但无权发信号）⇒ 抛错「另一实例运行中」；
 * - 锁文件存在但读不出 pid（损坏/手写）⇒ 失败关闭（人工删除后可启动）。
 *
 * release：删除锁文件前核对内容仍是本进程 pid（被接管后不误删他人锁），
 * 幂等，供 exit/SIGINT/SIGTERM 处理器调用。
 */

export interface DataDirLock {
  /** 释放锁（幂等）。仅在锁内容仍是本进程 pid 时删除文件。 */
  release: () => void;
  /** 锁文件绝对路径（诊断用）。 */
  lockPath: string;
}

interface LockPayload {
  pid: number;
  at: string;
}

function readLockPayload(lockPath: string): LockPayload | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockPayload>;
    if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && typeof parsed.at === 'string') {
      return { pid: parsed.pid, at: parsed.at };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 纯 syscall 探活：ESRCH = 已死；其余（含 EPERM）按存活处理（失败关闭）。 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}

export function acquireDataDirLock(dataDir: string, options: { now?: () => Date } = {}): DataDirLock {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, '.lock');
  const payload = (): string => `${JSON.stringify({
    pid: process.pid,
    at: (options.now ?? (() => new Date()))().toISOString(),
  } satisfies LockPayload, null, 2)}\n`;

  try {
    // O_EXCL 语义（'wx'）：独占创建，已存在即 EEXIST。
    writeFileSync(lockPath, payload(), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const holder = readLockPayload(lockPath);
    if (!holder) {
      throw new Error(
        `data 目录锁文件存在但无法解析（${lockPath}）：无法判断是否另有实例运行，失败关闭。请人工确认后删除该文件再启动。`,
      );
    }
    if (isProcessAlive(holder.pid)) {
      throw new Error(
        `另一实例运行中（pid=${holder.pid}，自 ${holder.at} 起持有 ${lockPath}）：data 目录同时只允许一个 agent-os 进程。`,
      );
    }
    // 持有者进程已死（上次崩溃残留）：抢占式接管，重写锁内容为本进程。
    writeFileSync(lockPath, payload(), { mode: 0o600 });
  }

  let released = false;
  return {
    lockPath,
    release: (): void => {
      if (released) return;
      released = true;
      // 只删仍然属于本进程的锁（被接管后不误删他人锁）。
      const current = readLockPayload(lockPath);
      if (!current || current.pid !== process.pid) return;
      try {
        unlinkSync(lockPath);
      } catch {
        // 锁已被他人删除/接管：退出路径上忽略。
      }
    },
  };
}
