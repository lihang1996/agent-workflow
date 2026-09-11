import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function readJsonState(filePath?: string): unknown {
  if (!filePath) return undefined;
  try { return JSON.parse(readFileSync(filePath, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
export function writeJsonState(filePath: string | undefined, value: unknown): void {
  if (!filePath) return;
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(`${filePath}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${filePath}.tmp`, filePath);
}
