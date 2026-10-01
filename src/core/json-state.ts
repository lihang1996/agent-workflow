import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname } from 'node:path';

export function readJsonState(filePath?: string): unknown {
  if (!filePath) return undefined;
  try { return JSON.parse(readFileSync(filePath, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * 原子 JSON 写入（tmp+rename）。
 * A08（166 号返工）：临时文件名必须**唯一**——固定 `<file>.tmp` 在多进程/并发
 * 写入下会互相截断、误 rename 他人的半成品；唯一名 + 失败清理保证任一写入
 * 要么完整落盘要么整体失败（状态失败回滚的底座）。
 */
export function writeJsonState(filePath: string | undefined, value: unknown): void {
  if (!filePath) return;
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporaryPath, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporaryPath, filePath);
    const directoryFd = openSync(dirname(filePath), 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch (error) {
    try { rmSync(temporaryPath, { force: true }); } catch { /* 尽力清理自建临时文件 */ }
    throw error;
  }
}
