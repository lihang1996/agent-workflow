import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** Single-instance state writer. Stale or malformed locks fail closed.
 * Cleanup requires a stopped service and an explicit operator action. A directory
 * rename cannot compare the old owner atomically; automatic takeover has an ABA race.
 */

export interface DataDirLock {
  /** 释放锁（幂等）。仅在锁内容仍属于本进程（token+pid）时删除目录。 */
  release: () => void;
  /** 锁目录绝对路径（诊断用）。 */
  lockPath: string;
}

interface LockOwner {
  pid: number;
  /** 所有权 token（每次 acquire 唯一）：release 与接管的竞争判定依据。 */
  token: string;
  at: string;
}

const LOCK_DIR_NAME = '.agent-os-lock.d';

function readLockOwner(lockDir: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')) as Partial<LockOwner>;
    if (
      typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0
      && typeof parsed.token === 'string' && parsed.token.length > 0
      && typeof parsed.at === 'string'
    ) {
      return { pid: parsed.pid, token: parsed.token, at: parsed.at };
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

/** 把目录原子改名到唯一坟场名并删除（release 与接管共用；rename 失败即未得手）。 */
function moveDirToGraveyard(dir: string): boolean {
  const grave = `${dir}.grave-${randomUUID()}`;
  try {
    renameSync(dir, grave);
  } catch {
    return false; // 已被他人接管/删除（ENOENT/ENOTEMPTY 等）。
  }
  rmSync(grave, { recursive: true, force: true });
  return true;
}

export function acquireDataDirLock(dataDir: string, options: { now?: () => Date } = {}): DataDirLock {
  mkdirSync(dataDir, { recursive: true });
  const lockDir = join(dataDir, LOCK_DIR_NAME);
  const myToken = randomUUID();
  const myOwner: LockOwner = {
    pid: process.pid,
    token: myToken,
    at: (options.now ?? (() => new Date()))().toISOString(),
  };

  /**
   * 建一个带完整 owner 的 staging 目录并原子 rename 成 lockDir（claim）。
   * 返回 true = 持锁；false = lockDir 已被他人占据（竞争落败，可重试评估）。
   * 任何其他错误（磁盘满/权限）抛错并清理自建 staging。
   */
  const claimWithStaging = (): boolean => {
    const staging = `${lockDir}.staging-${randomUUID()}`;
    try {
      mkdirSync(staging, { recursive: false, mode: 0o700 });
    } catch (error) {
      throw error;
    }
    try {
      writeFileSync(join(staging, 'owner.json'), `${JSON.stringify(myOwner, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(staging, lockDir);
      return true;
    } catch (error) {
      try { rmSync(staging, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
      const code = (error as NodeJS.ErrnoException).code;
      // ENOTEMPTY/EEXIST/ENOTDIR：目标已被占据 = 竞争落败（正常路径）。
      if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR') return false;
      throw error;
    }
  };

  // 预检：锁目录已存在但 owner 不可读 = 损坏（正常协议不会产生无 owner 的
  // 锁目录；空目录会被 rename 静默替换，必须在此显式失败关闭）。
  if (existsSync(lockDir) && readLockOwner(lockDir) === undefined) {
    throw new Error(
      `data 目录锁存在但无法解析持有者（${lockDir}/owner.json）：无法判断是否另有实例运行，失败关闭。请人工确认后删除该目录再启动。`,
    );
  }

  if (!claimWithStaging()) {
    const holder = readLockOwner(lockDir);
    if (!holder) throw new Error(`data 目录锁损坏（${lockDir}），失败关闭。`);
    if (isProcessAlive(holder.pid)) {
      throw new Error(`另一实例运行中（pid=${holder.pid}，自 ${holder.at} 起持有 ${lockDir}）。`);
    }
    throw new Error(`data 目录存在陈旧锁（pid=${holder.pid}，${lockDir}），失败关闭；停止全部实例并核对台账后再由操作者清理。`);
  }

  let released = false;
  return {
    lockPath: lockDir,
    release: (): void => {
      if (released) return;
      released = true;
      // 只释放仍然属于本进程的锁（token+pid 双核对；被接管后不误删他人锁）。
      if (!existsSync(lockDir)) return;
      const current = readLockOwner(lockDir);
      if (!current || current.pid !== process.pid || current.token !== myToken) return;
      moveDirToGraveyard(lockDir);
    },
  };
}
