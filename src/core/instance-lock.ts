/**
 * 单实例锁：进程退出时同步释放；启动时回收已死 PID 的残留锁。
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_LOCK_FILE = 'data/.agent-os.lock';

export class InstanceLockError extends Error {
  constructor(
    readonly lockFile: string,
    readonly pid?: number,
  ) {
    const pidHint = pid ? ` PID ${pid}` : '';
    super(`另一个 Agent OS 实例正在运行（${lockFile}${pidHint}）`);
    this.name = 'InstanceLockError';
  }
}

export interface InstanceLock {
  lockFile: string;
  pid: number;
  release: () => void;
}

/** kill(pid, 0) 探测进程是否仍在；EPERM 表示存在但无权发信号。 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLockPid(lockFile: string): number | undefined {
  try {
    const parsed = Number.parseInt(readFileSync(lockFile, 'utf8').trim(), 10);
    return Number.isInteger(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function removeLockFile(lockFile: string): void {
  try {
    unlinkSync(lockFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** 锁文件存在但 PID 已退出时删除，返回是否回收成功。 */
export function reclaimStaleLock(lockFile: string): boolean {
  if (!existsSync(lockFile)) return false;
  const pid = readLockPid(lockFile);
  if (pid !== undefined && isPidAlive(pid)) return false;
  removeLockFile(lockFile);
  return true;
}

/**
 * 以排他方式占用锁文件。进程 exit 时同步释放；Ctrl+C / 关终端后不会残留。
 * 若发现死进程留下的锁，自动接管。
 */
export function acquireInstanceLock(lockFile: string): InstanceLock {
  mkdirSync(dirname(lockFile), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockFile, 'wx');
      writeSync(fd, `${process.pid}\n`);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        process.off('exit', release);
        try { closeSync(fd); } catch { /* already closed */ }
        try { unlinkSync(lockFile); } catch { /* already gone */ }
      };
      process.on('exit', release);
      return { lockFile, pid: process.pid, release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = readLockPid(lockFile);
      if (pid !== undefined && isPidAlive(pid)) {
        throw new InstanceLockError(lockFile, pid);
      }
      console.warn(
        `[启动] 发现残留锁文件（${lockFile}，PID ${pid ?? '未知'} 已退出），已自动接管`,
      );
      removeLockFile(lockFile);
    }
  }

  throw new InstanceLockError(lockFile);
}
