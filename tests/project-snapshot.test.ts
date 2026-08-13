import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    await mkdir(join(root, '.turbo'));
    await writeFile(join(root, 'node_modules', 'package.js'), 'ignored');
    await writeFile(join(root, '.agent-os', 'gate.json'), 'ignored');
    await writeFile(join(root, '.turbo', 'cache.json'), 'ignored');
    await writeFile(join(root, '.DS_Store'), 'ignored');
    await writeFile(join(root, 'Thumbs.db'), 'ignored');
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

test('项目快照遵循 .gitignore，但仍包含被规则命中的已跟踪文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-gitignore-'));
  try {
    assert.equal(spawnSync('git', ['init', '--quiet', root]).status, 0);
    await writeFile(join(root, '.gitignore'), 'runtime-state/\ntracked.env\n');
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'runtime-state'));
    await writeFile(join(root, 'src', 'app.ts'), 'export const value = 1;\n');
    await writeFile(join(root, 'tracked.env'), 'TRACKED=before\n');
    assert.equal(spawnSync('git', ['-C', root, 'add', '.gitignore', 'src/app.ts', '-f', 'tracked.env']).status, 0);
    const initial = await fingerprintProject(root);

    await writeFile(join(root, 'runtime-state', 'workflows.json'), '{"status":"executing"}\n');
    const ignoredRuntimeState = await fingerprintProject(root);
    assert.equal(ignoredRuntimeState.fingerprint, initial.fingerprint);

    await writeFile(join(root, 'tracked.env'), 'TRACKED=after\n');
    const changedTrackedFile = await fingerprintProject(root);
    assert.notEqual(changedTrackedFile.fingerprint, initial.fingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('项目快照忽略本机读写权限，但保留可执行位语义', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-mode-'));
  try {
    const file = join(root, 'script.sh');
    await writeFile(file, '#!/bin/sh\nexit 0\n');
    await chmod(file, 0o644);
    const initial = await fingerprintProject(root);

    await chmod(file, 0o600);
    const localPermissionChange = await fingerprintProject(root);
    assert.equal(localPermissionChange.fingerprint, initial.fingerprint);

    await chmod(file, 0o755);
    const executableChange = await fingerprintProject(root);
    assert.notEqual(executableChange.fingerprint, initial.fingerprint);
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

test('fingerprint 与构建产物哈希不受进程 locale 影响', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-fingerprint-locale-'));
  try {
    await writeFile(join(root, 'z'), 'z');
    await writeFile(join(root, 'ä'), 'a-umlaut');
    const fingerprintScript = resolve(process.cwd(), 'scripts/fingerprint-project.mjs');
    const artifactScript = resolve(process.cwd(), 'scripts/hash-path.mjs');
    const run = (script: string, locale: string) => spawnSync(
      process.execPath,
      [script, root],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: locale } },
    );

    const enFingerprint = run(fingerprintScript, 'en_US.UTF-8');
    const svFingerprint = run(fingerprintScript, 'sv_SE.UTF-8');
    assert.equal(enFingerprint.status, 0, enFingerprint.stderr);
    assert.equal(svFingerprint.status, 0, svFingerprint.stderr);
    assert.equal(JSON.parse(enFingerprint.stdout).fingerprint, JSON.parse(svFingerprint.stdout).fingerprint);

    const enArtifact = run(artifactScript, 'en_US.UTF-8');
    const svArtifact = run(artifactScript, 'sv_SE.UTF-8');
    assert.equal(enArtifact.status, 0, enArtifact.stderr);
    assert.equal(svArtifact.status, 0, svArtifact.stderr);
    assert.equal(JSON.parse(enArtifact.stdout).sha256, JSON.parse(svArtifact.stdout).sha256);
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
