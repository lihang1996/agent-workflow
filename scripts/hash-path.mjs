#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const requestedPath = process.argv[2];
if (!requestedPath) {
  process.stderr.write('usage: hash-path.mjs <file-or-directory>\n');
  process.exit(64);
}

const root = resolve(requestedPath);
const rootStats = await lstat(root);
const hash = createHash('sha256');
let entryCount = 0;
const maxEntries = 100_000;

const hashFile = async (filePath) => {
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolvePromise);
    stream.on('error', rejectPromise);
  });
};

const portablePath = (path) => {
  const rel = relative(root, path).split(sep).join('/');
  return rel || '.';
};

const visit = async (path, suppliedStats) => {
  const stats = suppliedStats ?? await lstat(path);
  entryCount += 1;
  if (entryCount > maxEntries) {
    throw new Error(`Build hash exceeded the maximum of ${maxEntries} entries.`);
  }
  const name = portablePath(path);
  if (stats.isSymbolicLink()) {
    hash.update(`symlink\0${name}\0${await readlink(path)}\0`);
    return;
  }
  if (stats.isDirectory()) {
    hash.update(`directory\0${name}\0${stats.mode.toString(8)}\0`);
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) await visit(resolve(path, entry.name));
    return;
  }
  if (stats.isFile()) {
    hash.update(`file\0${name}\0${stats.mode.toString(8)}\0`);
    await hashFile(path);
    hash.update('\0');
    return;
  }
  throw new Error(`Unsupported build artifact type: ${path}`);
};

await visit(root, rootStats);
process.stdout.write(`${JSON.stringify({
  algorithm: 'sha256',
  path: root,
  sha256: hash.digest('hex'),
  entryCount,
})}\n`);
