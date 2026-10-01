import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertArtifactRequestWithinScratch,
  assertNarrowAllowedPaths,
  assertTaskDiffClean,
  buildIsolationProfile,
  buildTaskEnv,
  createProductionIsolationPreparer,
  createTaskScratch,
  launchIsolated,
  loadProtectedRoots,
  prepareIsolation,
  preflightFixtureProbe,
  resolveExecutableLiteralPath,
  type IsolationProtectedRoots,
} from '../src/core/isolation.js';
import {
  computeBinaryContentSha256,
  computeBinaryFingerprint,
  computeIsolationCapabilityIdentity,
  protectedRootsDigest,
  type IsolationCapabilityReader,
} from '../src/core/isolation-capability.js';
import { spawnCli } from '../src/cli/spawn-cli.js';

const DIAGNOSTIC_CHILD = fileURLToPath(new URL('./fixtures/isolation/diagnostic-child.mjs', import.meta.url));

function temp(t: { after: (fn: () => void) => void }, prefix = 'agent-os-iso-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** G-W6b-FIX 假根构造器（唯一 mkdtemp，全部自造内容）。 */
function buildFixtureRoot(t: { after: (fn: () => void) => void }): {
  root: string;
  protectedRoot: string;
  scratch: string;
  workspace: string;
  sentinelValue: string;
} {
  const root = temp(t, 'agent-os-iso-root-');
  const protectedRoot = join(root, 'fake-kb-private');
  const scratch = join(root, 'scratch');
  const workspace = join(root, 'protected-workspace');
  mkdirSync(join(protectedRoot, 'kb'), { recursive: true });
  mkdirSync(scratch, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(protectedRoot, 'kb', 'sentinel.txt'), 'SENTINEL-unique');
  writeFileSync(join(protectedRoot, '.config-kb'), 'fake_kb_config_token');
  mkdirSync(join(root, 'fake-other-system', 'artifacts'), { recursive: true });
  writeFileSync(join(root, 'fake-credentials.env'), 'FAKE_SECRET=SENTINEL-cred');
  mkdirSync(join(root, 'pruned-copy'), { recursive: true });
  writeFileSync(join(root, 'pruned-copy', 'context.md'), 'pruned');
  writeFileSync(join(workspace, 'existing.txt'), 'workspace file');
  return { root, protectedRoot, scratch, workspace, sentinelValue: 'SENTINEL-unique' };
}

function alwaysPassStore() {
  // A03：能力条目必填 evidenceRef/expiresAt；fixture 以远期时间表示未过期。
  return {
    lookup: () => ({
      read: 'passed' as const,
      write: 'passed' as const,
      evidenceRef: 'fixture://capability-stub',
      expiresAt: '9999-12-31T23:59:59.000Z',
    }),
  };
}

// ---- profile 纯函数 ------------------------------------------------------------

test('profile is a pure function with literal subpaths only (no regex, no NUL)', () => {
  const profile = buildIsolationProfile({
    scratchRealpath: '/ws/scratch dir',
    allowedPathRealpaths: ['/ws/src/module a'],
    protectedRootRealpaths: ['/private/var/kb-root'],
  });
  assert.match(profile, /\(allow default\)/);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.ok(!profile.includes('^'), 'subpath 不得出现正则锚点');
  assert.match(profile, /subpath "\/ws\/scratch dir"/);
  assert.match(profile, /subpath "\/ws\/src\/module a"/);
  assert.match(profile, /\(deny file-read-data \(subpath "\/private\/var\/kb-root"\)\)/);
  assert.throws(() => buildIsolationProfile({
    scratchRealpath: '/ws/bad\npath',
    allowedPathRealpaths: [],
    protectedRootRealpaths: [],
  }), /NUL|换行/);
});

// ---- 窄允许路径 ----------------------------------------------------------------

test('narrow allowed paths reject root-equivalents and missing leaves', (t) => {
  const workspace = temp(t);
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'real'), { recursive: true });
  symlinkSync(join(workspace, 'real'), join(workspace, 'alias'));
  // TMPDIR 可能经符号链接（macOS /var → /private/var）：期望值与函数同口径
  // 做 realpath 归一化，断言不依赖运行环境的 TMPDIR 形态。
  assert.deepEqual(
    assertNarrowAllowedPaths({ workspaceDir: workspace, allowedRelatives: ['src'] }),
    [{ relative: 'src', realpath: realpathSync(join(workspace, 'src')) }],
  );
  // 别名折叠为真实路径。
  assert.equal(
    assertNarrowAllowedPaths({ workspaceDir: workspace, allowedRelatives: ['alias'] })[0]!.relative,
    'real',
  );
  for (const bad of ['.', '', '/abs', 'a/../b', 'missing/leaf', 'alias/missing']) {
    assert.throws(
      () => assertNarrowAllowedPaths({ workspaceDir: workspace, allowedRelatives: [bad] }),
      Error,
      `应拒绝: ${bad}`,
    );
  }
});

test('artifact requests must sit inside the task scratch subtree (guard-level, incl. realpath branch)', (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'agent-os-scratch-guard-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  // 词面分支：未存在的路径仅靠规范化/前缀检查拒绝。
  assert.doesNotThrow(() => assertArtifactRequestWithinScratch(
    { deliveryMode: 'local', specPath: '.aos-scratch-x/spec.md', ticketsPath: '.aos-scratch-x/tickets' },
    '.aos-scratch-x',
    workspace,
  ));
  assert.throws(() => assertArtifactRequestWithinScratch(
    { deliveryMode: 'local', specPath: 'spec.md' },
    '.aos-scratch-x',
    workspace,
  ), /任务 scratch/);
  assert.throws(() => assertArtifactRequestWithinScratch(
    { deliveryMode: 'local', designPath: '../design.md' },
    '.aos-scratch-x',
    workspace,
  ), /越界段|任务 scratch/);
  assert.throws(() => assertArtifactRequestWithinScratch(
    { deliveryMode: 'local', designPath: '.aos-scratch-x/../outside.md' },
    '.aos-scratch-x',
    workspace,
  ), /越界段|必须位于任务 scratch/, 'scratch/../outside 必须被拒（138 号 P1-4）');
  // realpath 分支（149 号 P1-6）：路径已存在且是 scratch 内 symlink 指向
  // 外部——**本 guard 自身**必须拒绝（不依赖后续 snapshot）。
  mkdirSync(join(workspace, '.aos-scratch-x'), { recursive: true });
  writeFileSync(join(workspace, 'outside-target.md'), '# 外部\n');
  symlinkSync(join(workspace, 'outside-target.md'), join(workspace, '.aos-scratch-x', 'link.md'));
  assert.throws(() => assertArtifactRequestWithinScratch(
    { deliveryMode: 'local', specPath: '.aos-scratch-x/link.md', ticketsPath: '.aos-scratch-x/tickets' },
    '.aos-scratch-x',
    workspace,
  ), /symlink 逃逸/, 'guard 自身的 realpath 分支必须拒绝 scratch 内 symlink 逃逸');
  // scratch 内合法已存在文件通过。
  writeFileSync(join(workspace, '.aos-scratch-x', 'spec.md'), '# s\n');
  assert.doesNotThrow(() => assertArtifactRequestWithinScratch(
    { deliveryMode: 'local', specPath: '.aos-scratch-x/spec.md' },
    '.aos-scratch-x',
    workspace,
  ));
  // 非本地交付不受此门约束（飞书 U-3 另行 blocked）。
  assert.doesNotThrow(() => assertArtifactRequestWithinScratch(
    { deliveryMode: 'lark-doc' },
    '.aos-scratch-x',
    workspace,
  ));
});

// ---- scratch 与任务环境 ----------------------------------------------------------

test('task scratch is unique, 0700, inside workspace realpath; env is allowlist-only', (t) => {
  const workspace = temp(t);
  const first = createTaskScratch(workspace, 'task-1');
  const second = createTaskScratch(workspace, 'task-1');
  assert.notEqual(first.realpath, second.realpath);
  assert.ok(first.relative.startsWith('.aos-scratch-task-1-'));
  assert.ok(existsSync(first.realpath));

  const env = buildTaskEnv({
    scratchDir: first.realpath,
    envBase: {
      PATH: '/usr/bin', LANG: 'zh_CN.UTF-8',
      HOME: '/Users/should-not-appear', KB_CONFIG: '/should-not-appear',
      FEISHU_APP_SECRET: 'secret', TMPDIR: '/should-not-appear',
    },
    adapterEnv: { AGENT_OS_ALLOWED_TOOLS: 'request_clarification' },
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, join(first.realpath, 'home'));
  assert.equal(env.TMPDIR, join(first.realpath, 'tmp'));
  assert.ok(env.XDG_CONFIG_HOME!.startsWith(first.realpath));
  assert.ok(!('KB_CONFIG' in env), 'KB 变量不得进入任务环境');
  assert.ok(!('FEISHU_APP_SECRET' in env));
  assert.equal(env.AGENT_OS_ALLOWED_TOOLS, 'request_clarification');
  assert.throws(() => buildTaskEnv({
    scratchDir: first.realpath,
    adapterEnv: { HOME: '/evil' },
  }), /白名单/);
});

// ---- 生产 preparer：一切真实启动失败关闭 ------------------------------------------

test('production preparer fails closed: missing protected roots and empty capability store', async (t) => {
  const dir = temp(t);
  const preparer = createProductionIsolationPreparer({
    protectedRootsFilePath: join(dir, 'missing-roots.json'),
    capabilityFilePath: join(dir, 'missing-capability.json'),
  });
  await assert.rejects(preparer({
    taskId: 'task-1', purpose: 'task', command: 'claude', cwd: dir,
  }), /受保护根清单缺失/);

  // 清单存在但能力库为空 ⇒ 能力核验失败关闭（未做任何 spawn）。
  mkdirSync(join(dir, 'fake-private'), { recursive: true });
  const rootsPath = join(dir, 'roots.json');
  writeFileSync(rootsPath, JSON.stringify({ version: 'v1', roots: [join(dir, 'fake-private')] }));
  const preparer2 = createProductionIsolationPreparer({
    protectedRootsFilePath: rootsPath,
    capabilityFilePath: join(dir, 'missing-capability.json'),
  });
  await assert.rejects(preparer2({
    taskId: 'task-2', purpose: 'task', command: 'claude', cwd: dir,
  }), /读写隔离未验证/);
  // runCli 缺 isolation 直接拒绝（强制入口契约）。
  const { runCli } = await import('../src/cli/runner.js');
  await assert.rejects(
    runCli({ adapter: null as never, prompt: '', cwd: dir, isolation: undefined as never }),
    /isolation supplier/,
  );
});

test('protected roots loader fails closed on missing/empty/malformed', (t) => {
  const dir = temp(t);
  assert.throws(() => loadProtectedRoots(join(dir, 'none.json')), /清单缺失/);
  const empty = join(dir, 'empty.json');
  writeFileSync(empty, JSON.stringify({ version: 'v1', roots: [] }));
  assert.throws(() => loadProtectedRoots(empty), Error);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, 'not json');
  assert.throws(() => loadProtectedRoots(bad), Error);
  const missingRoot = join(dir, 'roots-missing-target.json');
  writeFileSync(missingRoot, JSON.stringify({ version: 'v1', roots: [join(dir, 'no-such-dir')] }));
  assert.throws(() => loadProtectedRoots(missingRoot), Error, '不存在的根必须失败关闭');
});

// ---- launchIsolated：能力缺失时不 spawn -------------------------------------------

test('launchIsolated/prepare spawn nothing without capability evidence', async (t) => {
  const fixture = buildFixtureRoot(t);
  const roots: IsolationProtectedRoots = { version: 'fixture', roots: [fixture.protectedRoot] };
  let spawnCalls = 0;
  // 能力核验在 prepare 阶段就失败关闭（先于任何 spawn/预检）。
  await assert.rejects(prepareIsolation({
    input: { taskId: 'probe-1', purpose: 'probe', command: 'node', cwd: fixture.root },
    harness: {
      capabilityStore: { lookup: () => undefined },
      probeFixture: async () => { spawnCalls += 1; return { ok: true }; },
      spawn: () => { spawnCalls += 1; throw new Error('不应 spawn'); },
      envBase: { PATH: process.env.PATH },
    },
    protectedRoots: roots,
  }), /读写隔离未验证/);
  assert.equal(spawnCalls, 0);
});

// ---- sandbox-exec 可用性：可用则真冒烟，不可用（宿主沙箱内嵌套被拒）诚实 blocked ------
// 可用性判定不使用独立的 exec 探测：空 profile `(version 1)` 在 seatbelt 语义里是
// 「默认全拒」（连 execvp 都被拒，rc=71），曾把可用环境误判为不可用；嵌套 allow
// 写入在部分宿主沙箱下可用。因此以 preflightFixtureProbe 自身结果分支——两种
// 结局（真语义 / 诚实 blocked）都与测试名声明一致。

test('preflight fixture probe: real sandbox-exec semantics or honest blocked', { timeout: 60_000 }, async (t) => {
  const result = await preflightFixtureProbe();
  if (!result.ok) {
    // 本会话在宿主沙箱内：sandbox_apply 嵌套被拒（EPERM）。诚实路径：预检
    // 返回 {ok:false} ⇒ 启动 blocked；不得伪装通过。此分支即「不可用时如何
    // 诚实 blocked」的可执行证明。
    assert.ok(result.reason, '失败必须带原因');
    t.diagnostic(`sandbox-exec 在当前环境不可用（预期 blocked）：${result.reason}`);
    return;
  }
  assert.deepEqual(result, { ok: true, fixtureRoot: result.fixtureRoot });
});

test('real sandbox-exec boundary smoke with diagnostic child (self/backend/descendantSpawn)', { timeout: 120_000 }, async (t) => {
  const availability = await preflightFixtureProbe();
  if (!availability.ok) {
    t.diagnostic(`宿主沙箱内无法嵌套 sandbox-exec，冒烟按诚实 blocked 跳过：${availability.reason}`);
    t.skip('sandbox-exec 不可用（宿主沙箱嵌套限制）');
    return;
  }
  const fixture = buildFixtureRoot(t);
  const roots: IsolationProtectedRoots = { version: 'fixture', roots: [fixture.protectedRoot] };
  const prepared = await prepareIsolation({
    input: { taskId: 'diag-1', purpose: 'probe', command: process.execPath, cwd: fixture.root },
    harness: {
      capabilityStore: alwaysPassStore(),
      envBase: { PATH: process.env.PATH },
    },
    protectedRoots: roots,
  });
  // 子进程的可写目录必须是 profile 实际放行的 scratch（prepare 自建的
  // ephemeral scratch）；fixture.scratch 从未进入允许区——旧写法下真实路径
  // 必然 EPERM，长期被 skip 分支掩盖。
  const scratchArg = prepared.context.scratchDir;
  const reportPath = join(scratchArg, 'diagnostic-report.json');
  const child = launchIsolated(prepared, [
    DIAGNOSTIC_CHILD,
    fixture.protectedRoot,
    scratchArg,
    reportPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout!.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
  const code = await new Promise<number | null>((resolve) => child.once('close', (exitCode) => resolve(exitCode)));
  assert.equal(code, 0, `诊断子进程异常退出：${stdout.slice(0, 500)}`);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));

  // 双证据判读：尝试证据（OS 错误码）+ 落盘证据（实际文件状态）。
  for (const surface of ['self', 'backend', 'descendantSpawn'] as const) {
    const entry = report[surface] as Record<string, { ok: boolean; code?: string | null }>;
    assert.equal(entry.read.ok, false, `${surface} 不应读到假 KB 哨兵`);
    assert.ok(['EPERM', 'EACCES', 'EIO'].includes(String(entry.read.code)), `${surface} 读拒绝应有 OS 错误码，实际 ${entry.read.code}`);
  }
  assert.equal(report.self.writeProtected.ok, false);
  assert.ok(['EPERM', 'EACCES'].includes(String(report.self.writeProtected.code)));
  assert.equal(report.self.writeScratch.ok, true, 'scratch 内应可写');
  assert.equal(report.backend.writeProtected.ok, false, 'backend（fork/exec 后代）继承写拒绝');
  assert.equal(report.backend.writeScratch.ok, true);
  // 落盘证据：受保护根内没有任何 attempt 文件；scratch 内有。
  const protectedFiles = readdirSync(fixture.protectedRoot);
  assert.ok(protectedFiles.every((name) => !name.startsWith('attempt-')), `protected 出现尝试落盘: ${protectedFiles.join(',')}`);
  assert.ok(readdirSync(scratchArg).some((name) => name.startsWith('attempt-')), 'attempt 落盘应在 profile 放行的 scratch 内');
});

test('unsandboxed control run proves the sentinels are readable without policy', (t) => {
  // 对照组（不在沙箱内直接运行）：证明哨兵文件本身可读——若隔离冒烟中读被拒，
  // 拒绝来自 profile 而非文件权限。
  const fixture = buildFixtureRoot(t);
  const reportPath = join(fixture.scratch, 'control-report.json');
  const child = spawnCli(process.execPath, [
    DIAGNOSTIC_CHILD,
    fixture.protectedRoot,
    fixture.scratch,
    reportPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const code = new Promise<number | null>((resolve) => child.once('close', (c) => resolve(c)));
  return code.then((exitCode) => {
    assert.equal(exitCode, 0);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.self.read.ok, true);
    assert.equal(report.self.read.echoed, true, '对照组必须能读到哨兵内容');
    assert.equal(report.self.writeScratch.ok, true);
  });
});

// ---- prepare 顺序与基线判读 --------------------------------------------------------

test('prepare takes baseline and finalize detects out-of-scratch modifications', async (t) => {
  const fixture = buildFixtureRoot(t);
  const roots: IsolationProtectedRoots = { version: 'fixture', roots: [fixture.protectedRoot] };
  const prepared = await prepareIsolation({
    input: { taskId: 'task-clean', purpose: 'task', command: 'node', cwd: fixture.workspace },
    harness: {
      capabilityStore: alwaysPassStore(),
      probeFixture: async () => ({ ok: true }),
      envBase: { PATH: process.env.PATH },
    },
    protectedRoots: roots,
    gitStatus: async () => undefined,
  });
  assert.ok(prepared.context.baselineId);
  assert.ok(prepared.scratchRelative!.startsWith('.aos-scratch-'));
  // 干净结束：diff 全空。
  const clean = await prepared.finalize();
  assertTaskDiffClean(clean);
  // 新任务先取基线，然后任务外改动 ⇒ 违例。
  const prepared2 = await prepareIsolation({
    input: { taskId: 'task-dirty', purpose: 'task', command: 'node', cwd: fixture.workspace },
    harness: {
      capabilityStore: alwaysPassStore(),
      probeFixture: async () => ({ ok: true }),
      envBase: { PATH: process.env.PATH },
    },
    protectedRoots: roots,
    gitStatus: async () => undefined,
  });
  writeFileSync(join(fixture.workspace, 'outside-change.txt'), 'violation');
  const dirty = await prepared2.finalize();
  assert.deepEqual(dirty!.added, ['outside-change.txt']);
  assert.throws(() => assertTaskDiffClean(dirty), /任务外变更检出/);
});

test('capability identity binds engine/roots/purpose/write-policy and is scratch-independent (119 号 P1-1)', (t) => {
  const base = {
    command: 'claude',
    protectedRootsVersion: 'v1',
    purpose: 'task',
    writePolicy: 'none',
    platform: 'darwin' as NodeJS.Platform,
  };
  const key1 = computeIsolationCapabilityIdentity(base);
  // scratch / profile 字面路径不进入身份：等价策略的不同任务可复用证据。
  assert.equal(key1, computeIsolationCapabilityIdentity(base));
  // 维度变化 ⇒ 身份变化（旧证据自然失效）。
  assert.notEqual(key1, computeIsolationCapabilityIdentity({ ...base, protectedRootsVersion: 'v2' }));
  assert.notEqual(key1, computeIsolationCapabilityIdentity({ ...base, purpose: 'probe' }));
  assert.notEqual(key1, computeIsolationCapabilityIdentity({ ...base, command: 'codex' }));
  assert.notEqual(key1, computeIsolationCapabilityIdentity({ ...base, writePolicy: 'auth:ca_x:abc' }));
  assert.notEqual(key1, computeIsolationCapabilityIdentity({ ...base, writePolicy: 'auth:ca_y:abc' }));
  // A03：二进制指纹进入身份——升级/替换二进制后旧证据查不到。
  assert.notEqual(key1, computeIsolationCapabilityIdentity({ ...base, binaryFingerprint: '0123456789abcdef' }));
  assert.notEqual(
    computeIsolationCapabilityIdentity({ ...base, binaryFingerprint: '0123456789abcdef' }),
    computeIsolationCapabilityIdentity({ ...base, binaryFingerprint: 'fedcba9876543210' }),
  );
});

test('binary fingerprint binds realpath + file content (A03 166 号返工)', async (t) => {
  const root = temp(t);
  const binaryPath = join(root, 'fake-cli');
  writeFileSync(binaryPath, '#!/bin/sh\nVERSION-OUTPUT-SAME-EVERY-TIME\n', { mode: 0o755 });
  const contentSha = await computeBinaryContentSha256(binaryPath);
  const fingerprint = computeBinaryFingerprint({ binaryRealPath: binaryPath, contentSha256: contentSha });
  assert.match(fingerprint, /^[0-9a-f]{16}$/);
  // 同路径替换内容（`--version` 输出可以完全不变）⇒ 指纹必须变化。
  writeFileSync(binaryPath, '#!/bin/sh\nEVIL-REPLACED-SAME-VERSION\n', { mode: 0o755 });
  const replacedSha = await computeBinaryContentSha256(binaryPath);
  assert.notEqual(contentSha, replacedSha, '内容摘要必须感知原地替换');
  assert.notEqual(fingerprint, computeBinaryFingerprint({ binaryRealPath: binaryPath, contentSha256: replacedSha }));
  // 路径变化（PATH 换绑）⇒ 指纹变化。
  assert.notEqual(fingerprint, computeBinaryFingerprint({ binaryRealPath: join(root, 'other-cli'), contentSha256: replacedSha }));
  // 稳定可复现（canary 写入侧与 prepare 侧各自计算必须一致）。
  assert.equal(
    computeBinaryFingerprint({ binaryRealPath: binaryPath, contentSha256: replacedSha }),
    computeBinaryFingerprint({ binaryRealPath: binaryPath, contentSha256: await computeBinaryContentSha256(binaryPath) }),
  );
});

test('prepareIsolation fails closed when binaryRealPath is unreadable (A03)', async (t) => {
  const root = temp(t);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  await assert.rejects(
    prepareIsolation({
      input: { taskId: 't-a03', purpose: 'probe', command: 'codex', cwd: workspace },
      harness: {
        capabilityStore: alwaysPassStore(),
        probeFixture: async () => ({ ok: true }),
        envBase: { PATH: process.env.PATH },
        binaryRealPath: join(root, 'does-not-exist'),
      },
      protectedRoots: { version: 'v-a03', roots: [join(root, 'protected')] },
    }),
    /ENOENT|binaryRealPath|隔离失败关闭/,
  );
  // 工作区不留 scratch 痕迹（失败发生在 scratch 创建之前）。
  assert.deepEqual(readdirSync(workspace), []);
});

test('same-path binary replacement invalidates old capability identity (A03 166 号返工)', async (t) => {
  const root = temp(t);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const binaryPath = join(root, 'fake-cli');
  writeFileSync(binaryPath, '#!/bin/sh\nv1-content\n', { mode: 0o755 });
  const roots = { version: 'v-a03-replace', roots: [join(root, 'protected')] };

  const keyStore = {
    knownKey: computeIsolationCapabilityIdentity({
      command: 'codex', purpose: 'probe', protectedRootsVersion: roots.version, protectedRootsDigest: protectedRootsDigest(roots.roots),
      writePolicy: 'none', platform: process.platform,
      binaryFingerprint: computeBinaryFingerprint({
        binaryRealPath: binaryPath,
        contentSha256: await computeBinaryContentSha256(binaryPath),
      }),
    }),
  };
  // 能力库只认「带指纹身份」：第一次（内容 v1）核验通过（走到注入的探针）。
  const lookupKey = (): IsolationCapabilityReader => ({
    lookup: (key: string) => (key === keyStore.knownKey ? {
      read: 'passed' as const,
      write: 'passed' as const,
      evidenceRef: 'fixture://binary-replace',
      expiresAt: '9999-12-31T23:59:59.000Z',
    } : undefined),
  });
  const harnessBase = {
    probeFixture: async () => ({ ok: true }),
    envBase: { PATH: process.env.PATH },
  };
  const first = await prepareIsolation({
    input: { taskId: 't-a03-r1', purpose: 'probe', command: 'codex', cwd: workspace },
    harness: { ...harnessBase, capabilityStore: lookupKey(), binaryRealPath: binaryPath },
    protectedRoots: roots,
  });
  first.dispose();

  // 原地替换二进制内容（同路径）：旧身份查不到 ⇒ 必须在能力核验处失败关闭。
  writeFileSync(binaryPath, '#!/bin/sh\nv2-replaced-content\n', { mode: 0o755 });
  await assert.rejects(
    prepareIsolation({
      input: { taskId: 't-a03-r2', purpose: 'probe', command: 'codex', cwd: workspace },
      harness: { ...harnessBase, capabilityStore: lookupKey(), binaryRealPath: binaryPath },
      protectedRoots: roots,
    }),
    /引擎读写隔离未验证/,
  );
});


test('launch uses pinned absolute binary and rejects replacement after preparation', async (t) => {
  const root = realpathSync(temp(t));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const binary = join(root, 'fake-cli');
  writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  let launched: string[] | undefined;
  const prepared = await prepareIsolation({
    input: { taskId: 'pinned', purpose: 'probe', command: 'fake-cli', cwd: workspace },
    harness: { capabilityStore: alwaysPassStore(), binaryRealPath: binary,
      probeFixture: async () => ({ ok: true }),
      spawn: (_command, args) => { launched = args; return spawn('/usr/bin/true'); } },
    protectedRoots: { version: 'pin', roots: [] },
  });
  t.after(() => prepared.dispose());
  const child = launchIsolated(prepared, ['--probe']);
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  assert.equal(launched?.[3], binary);
  writeFileSync(binary, '#!/bin/sh\necho replaced\n', { mode: 0o755 });
  launched = undefined;
  assert.throws(() => launchIsolated(prepared, []), /可执行文件身份变化/);
  assert.equal(launched, undefined);
});

test('relative PATH is resolved against the actual execution cwd, skips directories', (t) => {
  const root = realpathSync(temp(t));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'fake'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(resolveExecutableLiteralPath('fake', { PATH: 'bin' }, root), join(root, 'bin', 'fake'));
  mkdirSync(join(root, 'bin', 'directory'));
  assert.throws(() => resolveExecutableLiteralPath('directory', { PATH: 'bin' }, root), /无法在 PATH/);
});
