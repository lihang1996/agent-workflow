import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, relative, sep } from 'node:path';

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  '.agent-os',
  '.astro',
  '.git',
  '.next',
  '.output',
  '.parcel-cache',
  '.svelte-kit',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

const DEFAULT_IGNORED_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const DEFAULT_IGNORED_FILE_SUFFIXES = ['.log'];
const DEFAULT_MAX_ENTRIES = 50_000;
const MAX_GIT_IGNORE_OUTPUT_BYTES = 8 * 1024 * 1024;
const GIT_IGNORE_TIMEOUT_MS = 5_000;

export interface ProjectSnapshotOptions {
  ignoredDirectories?: ReadonlySet<string>;
  ignoredFileNames?: ReadonlySet<string>;
  ignoredFileSuffixes?: readonly string[];
  respectGitIgnore?: boolean;
  maxEntries?: number;
}

export interface ProjectSnapshot {
  algorithm: 'sha256';
  fingerprint: string;
  projectRoot: string;
  entryCount: number;
}

export interface PathArtifactHash {
  algorithm: 'sha256';
  path: string;
  sha256: string;
  entryCount: number;
}

function portablePath(projectRoot: string, absolutePath: string): string {
  return relative(projectRoot, absolutePath).split(sep).join('/');
}

function compareEntryNames(left: { name: string }, right: { name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/** Git 只跟踪文件的可执行语义；本机 read/write 权限变化不应让源码快照漂移。 */
function projectFileMode(mode: number): 'regular' | 'executable' {
  return (mode & 0o111) === 0 ? 'regular' : 'executable';
}

/** Git 忽略路径结果：区分成功、git 不可用和超时/错误。 */
interface GitIgnoreResult {
  paths: ReadonlySet<string>;
  /** git 不可用或超时时为 true；调用方应知道 fingerprint 可能包含 gitignored 文件。 */
  degraded: boolean;
}

async function gitIgnoredPaths(projectRoot: string): Promise<GitIgnoreResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-per-directory=.gitignore', '--directory', '-z', '--', '.'],
      { cwd: projectRoot, stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_IGNORE_TIMEOUT_MS },
    );
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (result: GitIgnoreResult) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_GIT_IGNORE_OUTPUT_BYTES) {
        child.kill();
        // P1 修复：不再静默返回空集，标记 degraded 让调用方知道结果不完整。
        finish({ paths: new Set(), degraded: true });
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', () => finish({ paths: new Set(), degraded: true }));
    child.on('close', (code) => {
      if (code !== 0 || outputBytes > MAX_GIT_IGNORE_OUTPUT_BYTES) {
        finish({ paths: new Set(), degraded: true });
        return;
      }
      const paths = Buffer.concat(chunks)
        .toString('utf8')
        .split('\0')
        .map((path) => path.replace(/^\.\//, ''))
        .filter(Boolean);
      finish({ paths: new Set(paths), degraded: false });
    });
  });
}

function isIgnoredGitPath(relativePath: string, ignoredPaths: ReadonlySet<string>): boolean {
  if (ignoredPaths.has(relativePath) || ignoredPaths.has(relativePath + '/')) return true;
  let separatorIndex = relativePath.lastIndexOf('/');
  while (separatorIndex >= 0) {
    const parent = relativePath.slice(0, separatorIndex + 1);
    if (ignoredPaths.has(parent)) return true;
    separatorIndex = relativePath.lastIndexOf('/', separatorIndex - 1);
  }
  return false;
}

async function hashFile(hash: ReturnType<typeof createHash>, filePath: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolvePromise);
    stream.on('error', rejectPromise);
  });
}

export async function fingerprintProject(
  projectRoot: string,
  options: ProjectSnapshotOptions = {},
): Promise<ProjectSnapshot> {
  const root = resolve(projectRoot);
  const ignoredDirectories = options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES;
  const ignoredFileNames = options.ignoredFileNames ?? DEFAULT_IGNORED_FILE_NAMES;
  const ignoredFileSuffixes = options.ignoredFileSuffixes ?? DEFAULT_IGNORED_FILE_SUFFIXES;
  const gitIgnoreResult = options.respectGitIgnore === false
    ? { paths: new Set<string>(), degraded: false }
    : await gitIgnoredPaths(root);
  const ignoredGitPaths = gitIgnoreResult.paths;
  if (gitIgnoreResult.degraded) {
    console.warn('[fingerprint] git ignore 获取降级，fingerprint 可能包含 gitignored 文件');
  }
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const hash = createHash('sha256');
  let entryCount = 0;

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort(compareEntryNames);

    for (const entry of entries) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      if (entry.isFile() && ignoredFileNames.has(entry.name)) continue;
      if (entry.isFile() && ignoredFileSuffixes.some((suffix) => entry.name.endsWith(suffix))) continue;

      const absolutePath = resolve(directory, entry.name);
      const relativePath = portablePath(root, absolutePath);
      if (isIgnoredGitPath(relativePath, ignoredGitPaths)) continue;

      entryCount += 1;
      if (entryCount > maxEntries) {
        throw new Error('Project snapshot exceeded the maximum of ' + maxEntries + ' entries.');
      }

      const stats = await lstat(absolutePath);

      if (stats.isSymbolicLink()) {
        const linkTarget = await readlink(absolutePath);
        hash.update('symlink\0' + relativePath + '\0' + linkTarget + '\0');
        continue;
      }

      if (stats.isDirectory()) {
        hash.update('directory\0' + relativePath + '\0');
        await visit(absolutePath);
        continue;
      }

      if (stats.isFile()) {
        hash.update('file\0' + relativePath + '\0' + projectFileMode(stats.mode) + '\0');
        await hashFile(hash, absolutePath);
        hash.update('\0');
      }
    }
  }

  await visit(root);
  return {
    algorithm: 'sha256',
    fingerprint: hash.digest('hex'),
    projectRoot: root,
    entryCount,
  };
}

/** 与 scripts/hash-path.mjs 完全一致地哈希一个文件或目录，供控制器复核构建产物。 */
export async function hashPathArtifact(
  requestedPath: string,
  maxEntries = 100_000,
): Promise<PathArtifactHash> {
  const root = resolve(requestedPath);
  const rootStats = await lstat(root);
  const hash = createHash('sha256');
  let entryCount = 0;

  const portableArtifactPath = (absolutePath: string): string => {
    const rel = relative(root, absolutePath).split(sep).join('/');
    return rel || '.';
  };

  const visit = async (path: string, suppliedStats?: Awaited<ReturnType<typeof lstat>>): Promise<void> => {
    const stats = suppliedStats ?? await lstat(path);
    entryCount += 1;
    if (entryCount > maxEntries) {
      throw new Error('Build hash exceeded the maximum of ' + maxEntries + ' entries.');
    }
    const name = portableArtifactPath(path);
    if (stats.isSymbolicLink()) {
      hash.update('symlink\0' + name + '\0' + await readlink(path) + '\0');
      return;
    }
    if (stats.isDirectory()) {
      hash.update('directory\0' + name + '\0' + stats.mode.toString(8) + '\0');
      const entries = await readdir(path, { withFileTypes: true });
      entries.sort(compareEntryNames);
      for (const entry of entries) await visit(resolve(path, entry.name));
      return;
    }
    if (stats.isFile()) {
      hash.update('file\0' + name + '\0' + stats.mode.toString(8) + '\0');
      await hashFile(hash, path);
      hash.update('\0');
      return;
    }
    throw new Error('Unsupported build artifact type: ' + path);
  };

  await visit(root, rootStats);
  return {
    algorithm: 'sha256',
    path: root,
    sha256: hash.digest('hex'),
    entryCount,
  };
}
