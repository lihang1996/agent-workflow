#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const ignoredDirectories = new Set([
  '.agent-os', '.git', '.next', '.venv', '__pycache__',
  'build', 'coverage', 'dist', 'node_modules', 'target',
]);
const ignoredFileSuffixes = ['.log'];
const maxEntries = 50_000;

const requestedRoot = process.argv[2];
if (!requestedRoot) {
  process.stderr.write('usage: fingerprint-project.mjs <project-root>\n');
  process.exit(64);
}

const root = resolve(requestedRoot);
const hash = createHash('sha256');
let entryCount = 0;

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
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    if (entry.isFile() && ignoredFileSuffixes.some((suffix) => entry.name.endsWith(suffix))) continue;
    entryCount += 1;
    if (entryCount > maxEntries) {
      throw new Error(`Project snapshot exceeded the maximum of ${maxEntries} entries.`);
    }
    const absolutePath = resolve(directory, entry.name);
    const relativePath = relative(root, absolutePath).split(sep).join('/');
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      hash.update(`symlink\0${relativePath}\0${await readlink(absolutePath)}\0`);
      continue;
    }
    if (stats.isDirectory()) {
      hash.update(`directory\0${relativePath}\0${stats.mode.toString(8)}\0`);
      await visit(absolutePath);
      continue;
    }
    if (stats.isFile()) {
      hash.update(`file\0${relativePath}\0${stats.mode.toString(8)}\0`);
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
