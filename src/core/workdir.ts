import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CliId } from '../cli/types.js';

/** 校验路径存在且为目录，返回绝对路径。 */
export async function assertWorkdir(path: string): Promise<string> {
  const absolute = resolve(path);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new Error(`工作目录不存在: ${absolute}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`路径不是目录: ${absolute}`);
  }
  return absolute;
}

/** 优先级：话题项目目录 > Bot 默认目录 > 引擎/全局默认 > cwd */
export function resolveWorkdir(options: {
  topicWorkdir?: string;
  botWorkdir?: string;
  cliId: CliId;
}): string {
  if (options.topicWorkdir) return resolve(options.topicWorkdir);
  if (options.botWorkdir) return resolve(options.botWorkdir);
  if (options.cliId === 'codex') {
    return resolve(process.env.CODEX_WORKDIR ?? process.env.CLAUDE_WORKDIR ?? process.cwd());
  }
  return resolve(process.env.CLAUDE_WORKDIR ?? process.cwd());
}
