import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCapabilityAllowsLaunch, JsonIsolationCapabilityStore } from '../src/core/isolation-capability.js';
import { adjudicateAttempt } from '../src/core/isolation.js';

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
