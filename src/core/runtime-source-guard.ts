import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_SOURCE_RESTART_MESSAGE = 'Agent OS 源码已更新，请重启服务后重试。';

const SNAPSHOT_VERSION = 'agent-os-runtime-source-v1';
const EXCLUDED_DIRECTORY_NAMES = new Set(['.git', 'data', 'dist', 'node_modules']);
const MODULE_PATH = fileURLToPath(import.meta.url);
const AGENT_OS_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PROCESS_TRACKS_DIST = relative(AGENT_OS_ROOT, MODULE_PATH).split(sep)[0] === 'dist';

export interface RuntimeSourceFileFingerprint {
  path: string;
  sha256: string;
  size: number;
}

export interface RuntimeSourceSnapshot {
  root: string;
  fingerprint: string;
  files: RuntimeSourceFileFingerprint[];
}

export interface RuntimeSourceComparison {
  changed: boolean;
  baselineFingerprint: string;
  currentFingerprint: string;
  added: string[];
  removed: string[];
  modified: string[];
}

export interface RuntimeSourceGuardLike {
  assertCurrent(): Promise<void>;
}

/**
 * 运行中的控制器代码与磁盘源码不一致时抛出。即使只是无法重新读取快照也 fail closed，
 * 因为此时控制器无法证明自己仍与当前源码一致。
 */
export class RuntimeSourceChangedError extends Error {
  readonly comparison?: RuntimeSourceComparison;

  constructor(comparison?: RuntimeSourceComparison, options?: ErrorOptions) {
    const paths = comparison
      ? [...comparison.added, ...comparison.removed, ...comparison.modified].slice(0, 12)
      : [];
    super(
      paths.length > 0
        ? `${RUNTIME_SOURCE_RESTART_MESSAGE} 变更文件：${paths.join('、')}`
        : RUNTIME_SOURCE_RESTART_MESSAGE,
      options,
    );
    this.name = 'RuntimeSourceChangedError';
    this.comparison = comparison;
  }
}

export function isRuntimeSourceChangedError(error: unknown): error is RuntimeSourceChangedError {
  return error instanceof RuntimeSourceChangedError;
}

/** 在进程加载时保存基线，后续技术步骤只与这份不可变基线比较。 */
export class RuntimeSourceGuard implements RuntimeSourceGuardLike {
  private constructor(
    readonly baseline: RuntimeSourceSnapshot,
    private readonly includeDist: boolean,
  ) {}

  static async capture(
    root = AGENT_OS_ROOT,
    options: { includeDist?: boolean } = {},
  ): Promise<RuntimeSourceGuard> {
    const includeDist = options.includeDist ?? false;
    return new RuntimeSourceGuard(
      await captureRuntimeSourceSnapshot(root, { includeDist }),
      includeDist,
    );
  }

  async compare(): Promise<RuntimeSourceComparison> {
    const current = await captureRuntimeSourceSnapshot(this.baseline.root, {
      includeDist: this.includeDist,
    });
    return compareRuntimeSourceSnapshots(this.baseline, current);
  }

  async assertCurrent(): Promise<void> {
    let comparison: RuntimeSourceComparison;
    try {
      comparison = await this.compare();
    } catch (cause) {
      throw new RuntimeSourceChangedError(undefined, { cause });
    }
    if (comparison.changed) throw new RuntimeSourceChangedError(comparison);
  }
}

/**
 * 仅覆盖会改变当前 Agent OS 控制逻辑/提示契约的仓库内文件：
 * - src 下的 TypeScript；
 * - skills 下的全部技能资产（包含各技能的 SKILL.md）；
 * - scripts 直属的 .mjs；
 * - package.json 与可选的 .env（只保存 hash，不保存内容）；
 * - 仅在 node dist/index.js 模式下额外覆盖 dist 树中的 JavaScript。
 *
 * 业务项目目录、data、dist、node_modules 和 .git 不进入快照。
 */
export async function captureRuntimeSourceSnapshot(
  root: string,
  options: { includeDist?: boolean } = {},
): Promise<RuntimeSourceSnapshot> {
  const normalizedRoot = resolve(root);
  const paths = await discoverRuntimeSourcePaths(normalizedRoot, options.includeDist === true);
  const files = await Promise.all(paths.map(async (path) => {
    const content = await readFile(join(normalizedRoot, ...path.split('/')));
    return {
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
      size: content.byteLength,
    };
  }));
  const hash = createHash('sha256').update(`${SNAPSHOT_VERSION}\0`);
  for (const file of files) {
    hash.update(file.path).update('\0').update(file.sha256).update('\0');
  }
  return {
    root: normalizedRoot,
    fingerprint: hash.digest('hex'),
    files,
  };
}

export function compareRuntimeSourceSnapshots(
  baseline: RuntimeSourceSnapshot,
  current: RuntimeSourceSnapshot,
): RuntimeSourceComparison {
  const baselineFiles = new Map(baseline.files.map((file) => [file.path, file.sha256]));
  const currentFiles = new Map(current.files.map((file) => [file.path, file.sha256]));
  const added = [...currentFiles.keys()]
    .filter((path) => !baselineFiles.has(path))
    .sort();
  const removed = [...baselineFiles.keys()]
    .filter((path) => !currentFiles.has(path))
    .sort();
  const modified = [...baselineFiles.entries()]
    .filter(([path, sha256]) => currentFiles.has(path) && currentFiles.get(path) !== sha256)
    .map(([path]) => path)
    .sort();
  return {
    changed: baseline.fingerprint !== current.fingerprint,
    baselineFingerprint: baseline.fingerprint,
    currentFingerprint: current.fingerprint,
    added,
    removed,
    modified,
  };
}

async function discoverRuntimeSourcePaths(root: string, includeDist: boolean): Promise<string[]> {
  const paths: string[] = [];
  await collectFiles(root, 'src', paths, (path) => path.endsWith('.ts'));
  if (includeDist) {
    await collectFiles(root, 'dist', paths, (path) => path.endsWith('.js'), true);
  }
  await collectFiles(root, 'skills', paths, () => true);
  await collectDirectFiles(root, 'scripts', paths, (path) => path.endsWith('.mjs'));
  if (await isRegularFile(join(root, 'package.json'))) paths.push('package.json');
  if (await isRegularFile(join(root, '.env'))) paths.push('.env');
  return [...new Set(paths)].sort();
}

async function collectFiles(
  root: string,
  directory: string,
  output: string[],
  include: (path: string) => boolean,
  allowExcludedRoot = false,
): Promise<void> {
  if (!allowExcludedRoot && EXCLUDED_DIRECTORY_NAMES.has(directory.split('/').at(-1) ?? '')) return;
  const absolute = join(root, ...directory.split('/'));
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORY_NAMES.has(entry.name)) {
        await collectFiles(root, path, output, include, allowExcludedRoot);
      }
    } else if (entry.isFile() && include(path)) {
      output.push(path);
    }
  }
}

async function collectDirectFiles(
  root: string,
  directory: string,
  output: string[],
  include: (path: string) => boolean,
): Promise<void> {
  const absolute = join(root, directory);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    if (entry.isFile() && include(path)) output.push(path);
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** 模块求值即完成进程基线捕获；dist 与 tsx 两种启动方式都会解析回仓库根目录。 */
export const processRuntimeSourceGuard = await RuntimeSourceGuard.capture(AGENT_OS_ROOT, {
  includeDist: PROCESS_TRACKS_DIST,
});
