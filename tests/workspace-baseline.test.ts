import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  baselineDiffClean,
  diffWorkspaceBaseline,
  loadWorkspaceBaseline,
  persistWorkspaceBaseline,
  takeWorkspaceBaseline,
} from '../src/core/workspace-baseline.js';

function temp(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-baseline-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('baseline records files, empty dirs, symlinks (target+identity) and detects changes', async (t) => {
  const dir = temp(t);
  writeFileSync(join(dir, 'dirty-existing.txt'), '用户已有脏文件');
  mkdirSync(join(dir, 'empty-dir'));
  mkdirSync(join(dir, 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'pkg', 'a.ts'), 'export {}');
  symlinkSync('dirty-existing.txt', join(dir, 'link.ts'));
  const gitStatus = async () => [' M dirty-existing.txt'];

  const baseline = await takeWorkspaceBaseline({ workspaceDir: dir, gitStatus });
  assert.equal(baseline.incomplete, false);
  assert.equal(baseline.entries['dirty-existing.txt']!.kind, 'file');
  assert.equal(baseline.entries['empty-dir']!.kind, 'dir', '空目录必须入基线');
  assert.equal(baseline.entries['pkg/a.ts']!.kind, 'file');
  assert.equal(baseline.entries['link.ts']!.kind, 'symlink');
  assert.equal(baseline.entries['link.ts']!.target, 'dirty-existing.txt');
  assert.ok(baseline.entries['link.ts']!.identity);
  assert.deepEqual(baseline.gitPorcelain, [' M dirty-existing.txt']);

  // 无变化：diff 全空。
  let diff = await diffWorkspaceBaseline({ baseline, workspaceDir: dir, gitStatus });
  assert.deepEqual([diff.added, diff.modified, diff.removed], [[], [], []]);
  assert.equal(baselineDiffClean(diff), true);

  // 已有脏文件内容变化 ⇒ modified（无 mtime 豁免）。
  writeFileSync(join(dir, 'dirty-existing.txt'), 'changed');
  // 符号链接改指向 ⇒ modified（target 变化）。
  rmSync(join(dir, 'link.ts'));
  symlinkSync('pkg/a.ts', join(dir, 'link.ts'));
  // 新增 / 删除。
  writeFileSync(join(dir, 'new.txt'), 'new');
  rmSync(join(dir, 'pkg', 'a.ts'));
  diff = await diffWorkspaceBaseline({ baseline, workspaceDir: dir, gitStatus });
  assert.deepEqual(diff.added, ['new.txt']);
  assert.ok(diff.modified.includes('dirty-existing.txt'));
  assert.ok(diff.modified.includes('link.ts'));
  assert.deepEqual(diff.removed, ['pkg/a.ts']);
  assert.equal(baselineDiffClean(diff), false);
});

test('scratch exceptions classify task-writable subtree separately', async (t) => {
  const dir = temp(t);
  mkdirSync(join(dir, '.aos-scratch-task-1-abc'), { recursive: true });
  writeFileSync(join(dir, 'user.txt'), 'u');
  const baseline = await takeWorkspaceBaseline({
    workspaceDir: dir,
    scratchExceptions: ['.aos-scratch-task-1-abc'],
    gitStatus: async () => undefined,
  });
  writeFileSync(join(dir, '.aos-scratch-task-1-abc', 'out.md'), 'task output');
  const diff = await diffWorkspaceBaseline({ baseline, workspaceDir: dir, gitStatus: async () => undefined });
  assert.deepEqual(diff.added, [], 'scratch 内新增不算违规');
  assert.deepEqual(diff.scratchChanges, ['.aos-scratch-task-1-abc/out.md']);
  assert.equal(baselineDiffClean(diff), true);
});

test('limits and scan errors mark incomplete and fail the diff closed', async (t) => {
  const dir = temp(t);
  writeFileSync(join(dir, 'a.txt'), 'a');
  writeFileSync(join(dir, 'b.txt'), 'b');
  const limited = await takeWorkspaceBaseline({
    workspaceDir: dir,
    limits: { maxEntries: 1 },
    gitStatus: async () => undefined,
  });
  assert.equal(limited.incomplete, true);
  await assert.rejects(
    diffWorkspaceBaseline({ baseline: limited, workspaceDir: dir }),
    /基线不完整.*失败关闭/,
  );
});

test('persistence round-trips; missing baseline file fails closed (never git status)', async (t) => {
  const dir = temp(t);
  writeFileSync(join(dir, 'x.txt'), 'x');
  const baseline = await takeWorkspaceBaseline({ workspaceDir: dir, gitStatus: async () => undefined });
  const path = join(dir, 'bl.json');
  persistWorkspaceBaseline(path, baseline);
  const reloaded = loadWorkspaceBaseline(path);
  assert.equal(reloaded.entries['x.txt']!.kind, 'file');
  rmSync(path);
  assert.throws(() => loadWorkspaceBaseline(path), /基线缺失，失败关闭/);
});

test('same-type replacement via rename (untracked swap) is caught by content hash', async (t) => {
  const dir = temp(t);
  writeFileSync(join(dir, 'f.txt'), 'original');
  const baseline = await takeWorkspaceBaseline({ workspaceDir: dir, gitStatus: async () => undefined });
  writeFileSync(join(dir, 'tmp.txt'), 'different content');
  renameSync(join(dir, 'tmp.txt'), join(dir, 'f.txt'));
  const diff = await diffWorkspaceBaseline({ baseline, workspaceDir: dir, gitStatus: async () => undefined });
  assert.deepEqual(diff.modified, ['f.txt']);
  assert.deepEqual(diff.added, []);
});
