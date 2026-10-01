import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCapabilityAllowsLaunch, JsonIsolationCapabilityStore } from '../src/core/isolation-capability.js';
import {
  adjudicateAttempt,
  createProductionIsolationPreparer,
  type IsolationPrepareInput,
  type IsolationSupplier,
  type PreparedIsolation,
} from '../src/core/isolation.js';

const SOURCE_ROOT = new URL('../src/', import.meta.url);

function sourceText(relative: string): string {
  return readFileSync(new URL(relative, SOURCE_ROOT), 'utf8');
}

/** A03：构造一份合法的能力库文件（_v: 2），测试结束自动清理。 */
function capabilityFile(t: { after: (fn: () => void) => void }, entries: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-capability-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'capability.json');
  writeFileSync(filePath, JSON.stringify({ _v: 2, entries }));
  return filePath;
}

const PASSED_ENTRY = {
  read: 'passed',
  write: 'passed',
  evidenceRef: '.agent-os/probe/canary-codex-2026-09-30.out.txt',
  expiresAt: '9999-12-31T23:59:59.000Z',
};

/**
 * 209 号（纠正环境假设）：正例统一经本 helper 驱动生产 preparer——能力必须
 * 命中；真实环境（AO_DIRECT_OS=1，无外层沙箱可嵌套）继续准备并成功；受限
 * 环境（测试进程本身在宿主沙箱内）在 fixture 写预检阶段明确失败。
 *
 * 只捕获 preparer 本身抛出的异常（捕获范围不包住后续断言）：
 * - AO_DIRECT_OS=1（真实 OS）：任何异常都原样重抛——预检必须成功，异常即真实回归；
 * - 受限环境：只接受 `/^隔离预检失败（fixture 写探针）：/` 这一已确认预检
 *   阶段的错误（它只会出现在能力核验通过之后，证明能力已命中）；能力拒绝/
 *   ENOENT/其他任何异常不能当作成功，一律重抛。
 *
 * prepare 成功时不宽泛接受任何结果：核验 capabilityKey 与 fixture 写入的
 * 准确键一致、binaryRealPath 为当前期望二进制 realpath、context.cwd 为输入
 * cwd 的 realpath、purpose 为 probe；finally 中 finalize + dispose（未启动
 * 任何 child ⇒ dispose 只清理本 prepare 自建的 ephemeral scratch，安全），
 * 并断言 dispose 结果与 scratch 已清理。
 */
async function prepareProbeExpectingCapabilityHit(
  supplier: IsolationSupplier,
  input: IsolationPrepareInput,
  expected: { capabilityKey: string; binaryRealPath: string },
): Promise<void> {
  assert.ok(expected.capabilityKey, '期望能力键必须来自 fixture 唯一条目（非空）');
  let prepared: PreparedIsolation;
  try {
    prepared = await supplier(input);
  } catch (error) {
    if (process.env.AO_DIRECT_OS === '1') throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (!/^隔离预检失败（fixture 写探针）：/.test(message)) throw error;
    return; // 受限环境：能力核验已通过，fixture 预检明确失败（已确认阶段）。
  }
  const scratch = prepared.pendingEphemeralScratch;
  try {
    assert.equal(prepared.capabilityKey, expected.capabilityKey, '能力键必须命中 fixture 写入的准确键');
    assert.equal(prepared.harness.binaryRealPath, expected.binaryRealPath, '二进制必须解析到当前期望的 realpath');
    assert.equal(prepared.context.cwd, realpathSync(input.cwd), 'context.cwd 必须为输入 cwd 的 realpath');
    assert.equal(prepared.context.purpose, 'probe', '探测 purpose 必须为 probe');
  } finally {
    await prepared.finalize(); // probe purpose 为 no-op，仍按生命周期调用。
    const disposed = prepared.dispose();
    assert.equal(disposed.disposed, true, 'dispose 必须清理本 prepare 的 ephemeral scratch');
    if (scratch !== undefined) {
      assert.ok(!existsSync(scratch), 'dispose 后 scratch 目录必须已删除');
    }
  }
}

/**
 * 静态接线断言（100 号修订版 §2.2「逐入口接线并作静态断言」）：
 * 任务承载启动点必须经统一隔离边界；业务层不得裸用 spawnCli。
 */
test('all task-bearing launch sites route through launchIsolated; spawnCli is not called directly', () => {
  // executeRun：spawn 只经 launchIsolated，且 RunCliOptions.isolation 为必填。
  const runner = sourceText('cli/runner.ts');
  assert.ok(runner.includes('launchIsolated(prepared'), 'runner 必须经 launchIsolated 启动');
  assert.ok(!/spawnCli\(/.test(runner), 'runner 不得直接调用 spawnCli');
  assert.ok(runner.includes('isolation: IsolationSupplier'), 'RunCliOptions 必须强制 isolation');

  // compact：两处 spawn 均经 launchIsolated。
  const compact = sourceText('cli/native-compact.ts');
  assert.ok(compact.includes('launchIsolated(prepared, plan.args'), 'compact 必须经 launchIsolated');
  assert.ok(!/spawnCli\(/.test(compact), 'compact 不得直接调用 spawnCli');

  // engine-runtime：--version/--help 探测不豁免，经隔离边界，且不再有裸 spawn。
  const engineRuntime = sourceText('core/engine-runtime.ts');
  assert.ok(engineRuntime.includes('launchIsolated(prepared'), '探测必须经 launchIsolated');
  assert.ok(!/from 'node:child_process'/.test(engineRuntime), '探测不得保留裸 child_process spawn');

  // native-sessions：codex 列表经 launchIsolated；claude 全局历史读取被移除。
  const sessions = sourceText('cli/native-sessions.ts');
  assert.ok(sessions.includes('launchIsolated(prepared'), '会话列表必须经 launchIsolated');
  assert.ok(!sessions.includes("homedir(), '.claude'"), '不得读取全局 ~/.claude');

  // 唯一 spawn choke point 保持为 spawn-cli.ts。
  const spawnCli = sourceText('cli/spawn-cli.ts');
  assert.ok(spawnCli.includes('export function spawnCli'), 'spawnCli 保持导出 choke point');
});

test('runCli rejects without an isolation supplier (no bypass)', async () => {
  const { runCli } = await import('../src/cli/runner.js');
  await assert.rejects(
    runCli({ adapter: undefined as never, prompt: '', cwd: '.', isolation: undefined as never }),
    /isolation supplier/,
  );
});

// ---- 能力库与证据判读 ------------------------------------------------------------

test('capability store is read-only and fails closed on missing file', () => {
  const store = new JsonIsolationCapabilityStore(join(tmpdir(), 'agent-os-nonexistent-capability.json'));
  assert.equal(store.lookup('any-key'), undefined);
});

// ---- A03（166 号返工）：内容身份刷新 + 生产 preparer 二进制/根接线 --------------------

test('capability store refreshes on content change even when mtime is preserved (A03 166 号返工)', (t) => {
  const filePath = capabilityFile(t, {});
  const frozen = new Date(1700000000000);
  utimesSync(filePath, frozen, frozen);
  const withEntry = JSON.stringify({ _v: 2, entries: { key_a: PASSED_ENTRY } });
  writeFileSync(filePath, withEntry);
  utimesSync(filePath, frozen, frozen);
  const store = new JsonIsolationCapabilityStore(filePath);
  assert.ok(store.lookup('key_a'));
  // 原子替换（内容撤销）并**保留 mtime**：不能以 mtime 充当撤销协议。
  writeFileSync(filePath, JSON.stringify({ _v: 2, entries: {} }));
  utimesSync(filePath, frozen, frozen);
  assert.equal(store.lookup('key_a'), undefined, '内容已撤销（mtime 不变）⇒ 必须按无证据处理');
  // 恢复内容（mtime 仍不变）：条目重新生效——刷新以内容为准。
  writeFileSync(filePath, withEntry);
  utimesSync(filePath, frozen, frozen);
  assert.ok(store.lookup('key_a'), '内容恢复 ⇒ 条目重新生效');
});

test('production preparer binds binary content identity; replaced binary rejects at capability check (A03 166 号返工)', async (t) => {
  const { computeBinaryContentSha256, computeBinaryFingerprint, computeIsolationCapabilityIdentity, protectedRootsDigest } = await import('../src/core/isolation-capability.js');
  // macOS：tmpdir() 可能返回 /var/folders/...（/private/var 的路径别名），此处规范化以与生产 preparer 的 realpath 同源。
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-os-prod-preparer-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  const fakeBinary = join(binDir, 'codex');
  writeFileSync(fakeBinary, '#!/bin/sh\nORIGINAL-v1\n', { mode: 0o755 });
  const protectedRoot = join(dir, 'kb-private');
  mkdirSync(protectedRoot);
  const rootsFile = join(dir, 'roots.json');
  writeFileSync(rootsFile, JSON.stringify({ version: 'prod-test-v1', roots: [protectedRoot] }));

  const entry = { ...PASSED_ENTRY, evidenceRef: 'fixture://prod-preparer' };
  const keyFor = async (): Promise<string> => computeIsolationCapabilityIdentity({
    command: 'codex', purpose: 'probe', protectedRootsVersion: 'prod-test-v1',
    writePolicy: 'none', platform: process.platform,
    protectedRootsDigest: protectedRootsDigest([protectedRoot]),
    binaryFingerprint: computeBinaryFingerprint({
      binaryRealPath: fakeBinary,
      contentSha256: await computeBinaryContentSha256(fakeBinary),
    }),
  });
  const capabilityFileOf = async (): Promise<{ filePath: string; capabilityKey: string }> => {
    const capabilityKey = await keyFor();
    const filePath = join(dir, `capability-${Date.now()}.json`);
    writeFileSync(filePath, JSON.stringify({ _v: 2, entries: { [capabilityKey]: entry } }));
    return { filePath, capabilityKey };
  };
  const preparerOf = (capabilityFilePath: string) => createProductionIsolationPreparer({
    capabilityFilePath,
    protectedRootsFilePath: rootsFile,
    envBase: { PATH: binDir },
  });

  // 指纹身份命中：能力必须命中——真实环境继续准备成功，受限环境在 fixture
  // 预检阶段明确失败（helper 只接受该已确认预检错误，其余异常一律判失败）。
  const firstEvidence = await capabilityFileOf();
  const first = preparerOf(firstEvidence.filePath);
  await prepareProbeExpectingCapabilityHit(
    first,
    { taskId: 't1', purpose: 'probe', command: 'codex', cwd: dir },
    { capabilityKey: firstEvidence.capabilityKey, binaryRealPath: realpathSync(fakeBinary) },
  );

  // 原地替换二进制内容（同路径、--version 可不变）：旧证据失效 ⇒ 能力核验拒绝。
  writeFileSync(fakeBinary, '#!/bin/sh\nREPLACED-v2\n', { mode: 0o755 });
  await assert.rejects(
    first({ taskId: 't2', purpose: 'probe', command: 'codex', cwd: dir }),
    /引擎读写隔离未验证/,
    '替换后的二进制不能沿用旧能力证据',
  );

  // 新内容重新登记证据后又能通过（canary 重跑后的正常路径）。
  const secondEvidence = await capabilityFileOf();
  const second = preparerOf(secondEvidence.filePath);
  await prepareProbeExpectingCapabilityHit(
    second,
    { taskId: 't3', purpose: 'probe', command: 'codex', cwd: dir },
    { capabilityKey: secondEvidence.capabilityKey, binaryRealPath: realpathSync(fakeBinary) },
  );
});

test('production preparer reloads protected roots on every call (A03 166 号返工)', async (t) => {
  const { computeBinaryContentSha256, computeBinaryFingerprint, computeIsolationCapabilityIdentity, protectedRootsDigest } = await import('../src/core/isolation-capability.js');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-os-prod-roots-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  const fakeBinary = join(binDir, 'codex');
  writeFileSync(fakeBinary, '#!/bin/sh\nv1\n', { mode: 0o755 });
  const protectedRoot = join(dir, 'kb-private');
  mkdirSync(protectedRoot);
  const rootsFile = join(dir, 'roots.json');
  writeFileSync(rootsFile, JSON.stringify({ version: 'roots-test-v1', roots: [protectedRoot] }));
  const capabilityKey = computeIsolationCapabilityIdentity({
    command: 'codex', purpose: 'probe', protectedRootsVersion: 'roots-test-v1',
    writePolicy: 'none', platform: process.platform,
    protectedRootsDigest: protectedRootsDigest([protectedRoot]),
    binaryFingerprint: computeBinaryFingerprint({
      binaryRealPath: fakeBinary,
      contentSha256: await computeBinaryContentSha256(fakeBinary),
    }),
  });
  const capabilityFilePath = join(dir, 'capability.json');
  writeFileSync(capabilityFilePath, JSON.stringify({ _v: 2, entries: {
    [capabilityKey]: { ...PASSED_ENTRY, evidenceRef: 'fixture://prod-roots' },
  } }));
  const preparer = createProductionIsolationPreparer({
    capabilityFilePath,
    protectedRootsFilePath: rootsFile,
    envBase: { PATH: binDir },
  });

  // 初次：能力必须命中——真实环境继续准备成功，受限环境在 fixture 预检
  // 阶段明确失败（两种结局都证明能力核验已通过，由 helper 精确区分）。
  await prepareProbeExpectingCapabilityHit(
    preparer,
    { taskId: 'r1', purpose: 'probe', command: 'codex', cwd: dir },
    { capabilityKey, binaryRealPath: realpathSync(fakeBinary) },
  );

  // 运行期变更根清单（同一 supplier，版本不变，指向不存在的根）：下一次启动
  // 必须重读清单并在 realpath 校验处失败关闭（不能沿用缓存旧根）。
  writeFileSync(rootsFile, JSON.stringify({ version: 'roots-test-v1', roots: [join(dir, 'missing-root')] }));
  await assert.rejects(
    preparer({ taskId: 'r2', purpose: 'probe', command: 'codex', cwd: dir }),
    /ENOENT|受保护根/,
    '根清单变化必须被重读',
  );

  const alternateRoot = join(dir, 'alternate-private');
  mkdirSync(alternateRoot);
  writeFileSync(rootsFile, JSON.stringify({ version: 'roots-test-v1', roots: [alternateRoot] }));
  await assert.rejects(preparer({ taskId: 'r2b', purpose: 'probe', command: 'codex', cwd: dir }), /引擎读写隔离未验证/);

  // 版本变更（根集合变化的标准形态）：能力身份随之变化 ⇒ 旧证据失效。
  writeFileSync(rootsFile, JSON.stringify({ version: 'roots-test-v2', roots: [protectedRoot] }));
  await assert.rejects(
    preparer({ taskId: 'r3', purpose: 'probe', command: 'codex', cwd: dir }),
    /引擎读写隔离未验证/,
    '根版本变化 ⇒ 旧能力证据失效',
  );
});

test('production preparer resolves binary via PATH; rebinding PATH invalidates old evidence (A03 166 号返工)', async (t) => {
  const { computeBinaryContentSha256, computeBinaryFingerprint, computeIsolationCapabilityIdentity, protectedRootsDigest } = await import('../src/core/isolation-capability.js');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-os-prod-path-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binA = join(dir, 'bin-a');
  const binB = join(dir, 'bin-b');
  mkdirSync(binA);
  mkdirSync(binB);
  writeFileSync(join(binA, 'codex'), '#!/bin/sh\nBINARY-A\n', { mode: 0o755 });
  writeFileSync(join(binB, 'codex'), '#!/bin/sh\nBINARY-B\n', { mode: 0o755 });
  const protectedRoot = join(dir, 'kb-private');
  mkdirSync(protectedRoot);
  const rootsFile = join(dir, 'roots.json');
  writeFileSync(rootsFile, JSON.stringify({ version: 'path-test-v1', roots: [protectedRoot] }));
  const keyViaA = computeIsolationCapabilityIdentity({
    command: 'codex', purpose: 'probe', protectedRootsVersion: 'path-test-v1',
    writePolicy: 'none', platform: process.platform,
    protectedRootsDigest: protectedRootsDigest([protectedRoot]),
    binaryFingerprint: computeBinaryFingerprint({
      binaryRealPath: join(binA, 'codex'),
      contentSha256: await computeBinaryContentSha256(join(binA, 'codex')),
    }),
  });
  const capabilityFilePath = join(dir, 'capability.json');
  writeFileSync(capabilityFilePath, JSON.stringify({ _v: 2, entries: {
    [keyViaA]: { ...PASSED_ENTRY, evidenceRef: 'fixture://prod-path' },
  } }));

  // PATH 指向 binA：指纹身份命中——能力必须命中；真实环境继续准备成功，
  // 受限环境在 fixture 预检阶段明确失败（helper 精确区分两种结局）。
  const viaA = createProductionIsolationPreparer({
    capabilityFilePath, protectedRootsFilePath: rootsFile, envBase: { PATH: binA },
  });
  await prepareProbeExpectingCapabilityHit(
    viaA,
    { taskId: 'p1', purpose: 'probe', command: 'codex', cwd: dir },
    { capabilityKey: keyViaA, binaryRealPath: realpathSync(join(binA, 'codex')) },
  );
  // PATH 换绑到 binB（不同二进制）：旧证据失效 ⇒ 能力核验拒绝。
  const viaB = createProductionIsolationPreparer({
    capabilityFilePath, protectedRootsFilePath: rootsFile, envBase: { PATH: binB },
  });
  await assert.rejects(
    viaB({ taskId: 'p2', purpose: 'probe', command: 'codex', cwd: dir }),
    /引擎读写隔离未验证/,
    'PATH 换绑后不能沿用旧能力证据',
  );
  // PATH 上没有引擎命令：失败关闭（身份必填维度不可降级）。
  const viaNone = createProductionIsolationPreparer({
    capabilityFilePath, protectedRootsFilePath: rootsFile, envBase: { PATH: join(dir, 'empty') },
  });
  mkdirSync(join(dir, 'empty'));
  await assert.rejects(
    viaNone({ taskId: 'p3', purpose: 'probe', command: 'codex', cwd: dir }),
    /无法在 PATH 上解析引擎命令/,
  );
});

// ---- 209：prepare helper 自身的负例单测 ---------------------------------------------

test('prepare helper rethrows non-precheck errors instead of accepting them (209)', async () => {
  // 能力拒绝不是预检错误：不能借「受限环境」宽泛当作成功，必须原样拒绝。
  const noEvidence: IsolationSupplier = async () => {
    throw new Error('引擎读写隔离未验证（blocked）：无该环境键下的 canary 证据（G-W6b-CANARY 未执行）');
  };
  await assert.rejects(
    prepareProbeExpectingCapabilityHit(
      noEvidence,
      { taskId: 'h1', purpose: 'probe', command: 'codex', cwd: '.' },
      { capabilityKey: 'expected-key', binaryRealPath: '/nonexistent/codex' },
    ),
    /引擎读写隔离未验证/,
  );
  // ENOENT 等其他错误同样不能当作成功：helper 只接受行首锚定的预检前缀。
  const missingRoot: IsolationSupplier = async () => {
    throw new Error("ENOENT: no such file or directory, realpath '/missing/root'");
  };
  await assert.rejects(
    prepareProbeExpectingCapabilityHit(
      missingRoot,
      { taskId: 'h1b', purpose: 'probe', command: 'codex', cwd: '.' },
      { capabilityKey: 'expected-key', binaryRealPath: '/nonexistent/codex' },
    ),
    /ENOENT/,
  );
});

test('prepare helper rejects a wrong capabilityKey and still disposes the prepare scratch (209)', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-os-helper-stub-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let disposeCalls = 0;
  const stub: PreparedIsolation = {
    harness: {
      capabilityStore: { lookup: () => undefined },
      binaryRealPath: join(dir, 'codex'),
    },
    context: {
      taskId: 'h2', purpose: 'probe', command: 'codex', cwd: dir,
      scratchDir: join(dir, 'scratch'), allowedPaths: [],
      protectedRoots: { version: 'helper-stub-v1', roots: [dir] },
    },
    profile: '(version 1)',
    env: { PATH: dir },
    capabilityKey: 'wrong-key-from-stub',
    finalize: async () => undefined,
    dispose: () => {
      disposeCalls += 1;
      return { disposed: true };
    },
    pendingEphemeralScratch: join(dir, 'scratch'),
  };
  await assert.rejects(
    prepareProbeExpectingCapabilityHit(
      async () => stub,
      { taskId: 'h2', purpose: 'probe', command: 'codex', cwd: dir },
      { capabilityKey: 'expected-key', binaryRealPath: join(dir, 'codex') },
    ),
    /能力键/,
  );
  assert.equal(disposeCalls, 1, '断言失败路径也必须 finalize + dispose 本 prepare 的 scratch');
});

// ---- A03：过期拒绝 + 文件刷新 ------------------------------------------------------

test('capability store rejects expired entries as no-evidence (A03)', (t) => {
  const filePath = capabilityFile(t, {
    key_expired: { ...PASSED_ENTRY, expiresAt: '2000-01-01T00:00:00.000Z' },
    key_valid: PASSED_ENTRY,
  });
  const store = new JsonIsolationCapabilityStore(filePath);
  assert.equal(store.lookup('key_expired'), undefined, '过期条目必须按无证据处理');
  assert.ok(store.lookup('key_valid'), '未过期条目正常返回');
  // store 已把过期条目过滤为 undefined ⇒ 启动断言按「无证据」失败关闭。
  assert.throws(() => assertCapabilityAllowsLaunch(store, 'key_expired'), /无该环境键下的 canary 证据/);
  assert.throws(() => assertCapabilityAllowsLaunch(store, 'key_missing'), /无该环境键下的 canary 证据/);
});

test('assertCapabilityAllowsLaunch rejects expired entries from custom readers (A03)', () => {
  // 自定义 reader 不经 JsonIsolationCapabilityStore 的过滤，断言层兜底同样拒绝。
  const customReader = {
    lookup: () => ({
      read: 'passed' as const,
      write: 'passed' as const,
      evidenceRef: 'custom://evidence',
      expiresAt: '2000-01-01T00:00:00.000Z',
    }),
  };
  assert.throws(() => assertCapabilityAllowsLaunch(customReader, 'any-key'), /已过期/);
});

test('capability store reloads when the file mtime changes (A03)', (t) => {
  const filePath = capabilityFile(t, { key_a: PASSED_ENTRY });
  const store = new JsonIsolationCapabilityStore(filePath);
  assert.ok(store.lookup('key_a'));

  // 写入后显式设定递增 mtime：不依赖文件系统时间戳精度，保证「文件变了」
  // 这一前提本身是确定的。
  const rewrite = (content: string, mtimeMs: number): void => {
    writeFileSync(filePath, content);
    utimesSync(filePath, new Date(mtimeMs - 60_000), new Date(mtimeMs));
  };

  // 撤销（重写为空库）：mtime 变化后旧键立即查不到。
  rewrite(JSON.stringify({ _v: 2, entries: {} }), Date.now() + 1_000);
  assert.equal(store.lookup('key_a'), undefined, '证据被撤销后必须即时生效');

  // 重新写入不同指纹的键：新内容生效。
  rewrite(JSON.stringify({ _v: 2, entries: { key_b: PASSED_ENTRY } }), Date.now() + 2_000);
  assert.ok(store.lookup('key_b'), '文件更新后新条目生效');
  assert.equal(store.lookup('key_a'), undefined);

  // 文件被删除：失败关闭（一切键按无证据处理）。
  rmSync(filePath);
  assert.equal(store.lookup('key_b'), undefined);

  // 文件被改成坏内容：lookup 抛错失败关闭，不静默沿用旧条目。
  const corruptPath = capabilityFile(t, { key_c: PASSED_ENTRY });
  const corruptStore = new JsonIsolationCapabilityStore(corruptPath);
  writeFileSync(corruptPath, '{ not json');
  utimesSync(corruptPath, new Date(Date.now() - 60_000), new Date(Date.now() + 3_000));
  assert.throws(() => corruptStore.lookup('key_c'), /JSON|json|Unexpected/);
});

// 旧格式（_v: 1，无 expiresAt/evidenceRef）不被接受：失败关闭而非静默降级。
test('capability store rejects legacy v1 files (A03)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-capability-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'legacy.json');
  writeFileSync(filePath, JSON.stringify({ _v: 1, entries: { key_old: { read: 'passed', write: 'passed' } } }));
  assert.throws(() => new JsonIsolationCapabilityStore(filePath), /_v|literal|Invalid|invalid/i);
});

test('evidence adjudication: OS error ⇒ blocked; landing/echo ⇒ allowed; neither ⇒ inconclusive', () => {
  assert.equal(adjudicateAttempt({ direction: 'read', toolError: 'EPERM: Operation not permitted', landedOrEchoed: false }), 'blocked');
  assert.equal(adjudicateAttempt({ direction: 'write', toolError: 'EACCES: Permission denied', landedOrEchoed: false }), 'blocked');
  assert.equal(adjudicateAttempt({ direction: 'write', toolError: undefined, landedOrEchoed: true }), 'allowed');
  assert.equal(adjudicateAttempt({ direction: 'read', toolError: 'tool reported failure without errno', landedOrEchoed: false }), 'inconclusive');
  assert.equal(adjudicateAttempt({ direction: 'read', toolError: 'EPERM …', landedOrEchoed: true }), 'allowed', '落盘/复述优先判失败');
});
