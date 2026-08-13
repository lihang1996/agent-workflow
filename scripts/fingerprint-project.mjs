#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';

const ignoredDirectories = new Set([
  '.agent-os', '.astro', '.git', '.next', '.output', '.parcel-cache',
  '.svelte-kit', '.turbo', '.venv', '__pycache__',
  'build', 'coverage', 'dist', 'node_modules', 'target',
]);
const ignoredFileNames = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const ignoredFileSuffixes = ['.log'];
const maxEntries = 50_000;
const maxGitIgnoreOutputBytes = 8 * 1024 * 1024;
const gitIgnoreTimeoutMs = 5_000;

const requestedRoot = process.argv[2];
if (!requestedRoot) {
  process.stderr.write('usage: fingerprint-project.mjs <project-root>\n');
  process.exit(64);
}

const root = resolve(requestedRoot);
const hash = createHash('sha256');
let entryCount = 0;

const compareEntryNames = (left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
const projectFileMode = (mode) => (mode & 0o111) === 0 ? 'regular' : 'executable';

const gitIgnoredPaths = await new Promise((resolvePromise) => {
  const child = spawn(
    'git',
    ['ls-files', '--others', '--ignored', '--exclude-per-directory=.gitignore', '--directory', '-z', '--', '.'],
    { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], timeout: gitIgnoreTimeoutMs },
  );
  const chunks = [];
  let outputBytes = 0;
  let settled = false;
  const finish = (paths) => {
    if (settled) return;
    settled = true;
    resolvePromise(paths);
  };
  child.stdout.on('data', (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > maxGitIgnoreOutputBytes) {
      child.kill();
      finish(new Set());
      return;
    }
    chunks.push(chunk);
  });
  child.on('error', () => finish(new Set()));
  child.on('close', (code) => {
    if (code !== 0 || outputBytes > maxGitIgnoreOutputBytes) {
      finish(new Set());
      return;
    }
    const paths = Buffer.concat(chunks)
      .toString('utf8')
      .split('\0')
      .map((path) => path.replace(/^\.\//, ''))
      .filter(Boolean);
    finish(new Set(paths));
  });
});

const isIgnoredGitPath = (relativePath) => {
  if (gitIgnoredPaths.has(relativePath) || gitIgnoredPaths.has(`${relativePath}/`)) return true;
  let separatorIndex = relativePath.lastIndexOf('/');
  while (separatorIndex >= 0) {
    const parent = relativePath.slice(0, separatorIndex + 1);
    if (gitIgnoredPaths.has(parent)) return true;
    separatorIndex = relativePath.lastIndexOf('/', separatorIndex - 1);
  }
  return false;
};

const hashFile = async (filePath) => {
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolvePromise);
    stream.on('error', rejectPromise);
  });
};

const visit = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort(compareEntryNames);
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    if (entry.isFile() && ignoredFileNames.has(entry.name)) continue;
    if (entry.isFile() && ignoredFileSuffixes.some((suffix) => entry.name.endsWith(suffix))) continue;
    const absolutePath = resolve(directory, entry.name);
    const relativePath = relative(root, absolutePath).split(sep).join('/');
    if (isIgnoredGitPath(relativePath)) continue;
    entryCount += 1;
    if (entryCount > maxEntries) {
      throw new Error(`Project snapshot exceeded the maximum of ${maxEntries} entries.`);
    }
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      hash.update(`symlink\0${relativePath}\0${await readlink(absolutePath)}\0`);
      continue;
    }
    if (stats.isDirectory()) {
      hash.update(`directory\0${relativePath}\0`);
      await visit(absolutePath);
      continue;
    }
    if (stats.isFile()) {
      hash.update(`file\0${relativePath}\0${projectFileMode(stats.mode)}\0`);
      await hashFile(absolutePath);
      hash.update('\0');
    }
  }
};

await visit(root);
process.stdout.write(`${JSON.stringify({
  algorithm: 'sha256',
  fingerprint: hash.digest('hex'),
  projectRoot: root,
  entryCount,
})}\n`);
