/**
 * A08（166 号返工）多进程锁竞争者：等待栅栏放行后抢 data 目录锁，
 * 输出 WIN（并持锁 holdMs 后 release）或 LOSE:<原因>。
 * 由 tests/data-lock.test.ts 以 `node --import tsx` 真实子进程驱动。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { acquireDataDirLock } from '../../../src/core/data-lock.js';

const [dataDir, gate, ready, holdMsText] = process.argv.slice(2) as [string, string, string, string];
if (!dataDir || !gate || !ready) {
  process.stderr.write('usage: contender.mts <dataDir> <gate> <ready> [holdMs]\n');
  process.exit(2);
}
const holdMs = Number(holdMsText) || 0;

writeFileSync(ready, 'READY\n');
// 自旋栅栏：父进程写 GO 后同时放行（不 sleep，最大化竞争窗口重叠）。
const deadline = Date.now() + 30_000;
for (;;) {
  let go = false;
  try {
    go = readFileSync(gate, 'utf8').trim() === 'GO';
  } catch {
    go = false;
  }
  if (go || Date.now() > deadline) break;
}

try {
  const lock = acquireDataDirLock(dataDir);
  process.stdout.write('WIN');
  if (holdMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  }
  lock.release();
} catch (error) {
  process.stdout.write(`LOSE:${(error as Error).message}`);
}
