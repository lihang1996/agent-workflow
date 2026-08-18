/**
 * 工作目录解析。
 *
 * 工作目录优先级（高 → 低）：
 * 1. 话题目录（/workdir 绑定，全角色共享）
 * 2. BOT_*_WORKDIR（Bot 级默认）
 * 3. CLAUDE_WORKDIR / CODEX_WORKDIR / CURSOR_WORKDIR（引擎级默认）
 * 4. process.cwd()
 *
 * assertWorkdir() 校验路径在 AGENT_OS_ALLOWED_ROOTS 白名单内，
 * 防止从自然语言误猜路径。流水线不自动绑定目录。
 */

import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { CliId } from '../cli/types.js';

/** 从可信配置中读取 Agent 可访问的根目录。 */
export async function allowedFilesystemRoots(): Promise<string[]> {
  const configured = [
    process.cwd(),
    process.env.CLAUDE_WORKDIR,
    process.env.CODEX_WORKDIR,
    process.env.CURSOR_WORKDIR,
    ...(process.env.AGENT_OS_ALLOWED_ROOTS?.split(/[\n,]+/) ?? []),
    ...Object.entries(process.env)
      .filter(([key]) => /^BOT_[A-Z0-9_]+_WORKDIR$/.test(key))
      .map(([, value]) => value),
  ]
    .map((value) => value?.trim() ?? '')
    .filter(Boolean);

  const roots = new Set<string>();
  for (const path of configured) {
    try {
      roots.add(await realpath(resolve(path)));
    } catch {
      // 无效的可选配置由实际使用点给出更具体的错误。
    }
  }
  return [...roots];
}

function isInsideRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** 校验路径已解析符号链接，且没有逃出可信根目录。 */
export async function assertAllowedPath(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const roots = await allowedFilesystemRoots();
  if (!roots.some((root) => isInsideRoot(canonical, root))) {
    throw new Error(
      `路径不在 Agent OS 允许范围内: ${canonical}\n`
      + '请通过 AGENT_OS_ALLOWED_ROOTS 显式配置可信根目录。',
    );
  }
  return canonical;
}

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
  return assertAllowedPath(absolute);
}

/** 优先级：话题项目目录 > Bot 默认目录 > 引擎/全局默认 > cwd */
export function resolveWorkdir(options: {
  topicWorkdir?: string;
  botWorkdir?: string;
  cliId: CliId;
}): string {
  if (options.topicWorkdir) return resolve(options.topicWorkdir);
  if (options.botWorkdir) return resolve(options.botWorkdir);
  const engineWorkdir = options.cliId === 'codex'
    ? process.env.CODEX_WORKDIR
    : options.cliId === 'cursor'
      ? process.env.CURSOR_WORKDIR
      : process.env.CLAUDE_WORKDIR;
  return resolve(engineWorkdir ?? process.env.CLAUDE_WORKDIR ?? process.cwd());
}
