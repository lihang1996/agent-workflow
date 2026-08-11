import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, readdir } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  '.agent-os',
  '.git',
  '.next',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

const DEFAULT_IGNORED_FILE_SUFFIXES = ['.log'];
const DEFAULT_MAX_ENTRIES = 50_000;

export interface ProjectSnapshotOptions {
  ignoredDirectories?: ReadonlySet<string>;
  ignoredFileSuffixes?: readonly string[];
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
  const ignoredFileSuffixes = options.ignoredFileSuffixes ?? DEFAULT_IGNORED_FILE_SUFFIXES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const hash = createHash('sha256');
  let entryCount = 0;

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      if (entry.isFile() && ignoredFileSuffixes.some((suffix) => entry.name.endsWith(suffix))) continue;

      entryCount += 1;
      if (entryCount > maxEntries) {
        throw new Error('Project snapshot exceeded the maximum of ' + maxEntries + ' entries.');
      }

      const absolutePath = resolve(directory, entry.name);
      const relativePath = portablePath(root, absolutePath);
      const stats = await lstat(absolutePath);

      if (stats.isSymbolicLink()) {
        const linkTarget = await readlink(absolutePath);
        hash.update('symlink\0' + relativePath + '\0' + linkTarget + '\0');
        continue;
      }

      if (stats.isDirectory()) {
        hash.update('directory\0' + relativePath + '\0' + stats.mode.toString(8) + '\0');
        await visit(absolutePath);
        continue;
      }

      if (stats.isFile()) {
        hash.update('file\0' + relativePath + '\0' + stats.mode.toString(8) + '\0');
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
      entries.sort((left, right) => left.name.localeCompare(right.name));
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
