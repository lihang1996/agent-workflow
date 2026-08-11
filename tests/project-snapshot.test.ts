import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fingerprintProject, hashPathArtifact } from '../src/core/project-snapshot.js';

test('项目快照对真实变更敏感并忽略依赖、门禁产物和日志', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-snapshot-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'app.ts'), 'export const value = 1;\n');
    const initial = await fingerprintProject(root);

    await mkdir(join(root, 'node_modules'));
    await mkdir(join(root, '.agent-os'));
    await writeFile(join(root, 'node_modules', 'package.js'), 'ignored');
    await writeFile(join(root, '.agent-os', 'gate.json'), 'ignored');
    await writeFile(join(root, 'debug.log'), 'ignored');
    const ignoredArtifacts = await fingerprintProject(root);
    assert.equal(ignoredArtifacts.fingerprint, initial.fingerprint);

    await writeFile(join(root, 'src', 'app.ts'), 'export const value = 2;\n');
    const changed = await fingerprintProject(root);
    assert.notEqual(changed.fingerprint, initial.fingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('提供给 Agent 的 fingerprint 命令与控制器快照算法完全一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-fingerprint-cli-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'app.ts'), 'export const value = 1;\n');
    const expected = await fingerprintProject(root);
    const result = spawnSync(
      process.execPath,
      [resolve(process.cwd(), 'scripts/fingerprint-project.mjs'), root],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('构建产物哈希命令对文件内容敏感且结果可复现', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-build-hash-'));
  try {
    await mkdir(join(root, 'dist'));
    const artifact = join(root, 'dist', 'app.js');
    await writeFile(artifact, 'export const value = 1;\n');
    const command = [resolve(process.cwd(), 'scripts/hash-path.mjs'), join(root, 'dist')];
    const first = spawnSync(process.execPath, command, { encoding: 'utf8' });
    const repeated = spawnSync(process.execPath, command, { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(JSON.parse(first.stdout).sha256, JSON.parse(repeated.stdout).sha256);
    assert.deepEqual(JSON.parse(first.stdout), await hashPathArtifact(join(root, 'dist')));

    await writeFile(artifact, 'export const value = 2;\n');
    const changed = spawnSync(process.execPath, command, { encoding: 'utf8' });
    assert.equal(changed.status, 0, changed.stderr);
    assert.notEqual(JSON.parse(changed.stdout).sha256, JSON.parse(first.stdout).sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
