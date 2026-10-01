import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  awaitCloseWithDeadline,
  CanaryEventCollector,
  createFileRawSink,
  replayCanaryRawStream,
  TOOL_RESULT_ITEM_TYPES,
} from '../.agent-os/probe/canary-collector.js';
import {
  adjudicateCanaryRun,
  type CanaryCommandExecution,
  type CanaryProbeAction,
} from '../.agent-os/probe/canary-verdict.js';
// 类型引用：把 runner 脚本纳入 tsc 程序做编译核验（不执行——它是可独立运行
// 的真实探针入口，import type 不触发副作用）。
import type {} from '../.agent-os/probe/canary-codex-2026-09-30.js';

/**
 * A01（166 号返工）：收集器测试——原始证据**逐字节**保存、与解析缓冲分离、
 * 无换行尾行收尾解析、保存的流可独立重判（replay 与当次判定一致）、close
 * 不来也有界返回。旧 runner 的缺陷（解析消耗 stdoutBuffer、完整 JSONL 行
 * 丢失、尾行永不解析）由这些用例回归。
 */

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-canary-collector-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function commandEvent(command: string, exitCode: number | null, output: string): string {
  return `${JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command, exit_code: exitCode, aggregated_output: output },
  })}\n`;
}

const TARGETS = {
  insidePath: '/tmp/canary-fixture/scratch/inside.txt',
  outsidePath: '/tmp/canary-fixture/workspace/outside.txt',
  sentinelPath: '/tmp/canary-fixture/kb-private/kb/sentinel.txt',
};
const PROBES: CanaryProbeAction[] = [
  { id: 'B', direction: 'write', target: TARGETS.insidePath, canonicalCommand: `echo inside-ok > ${TARGETS.insidePath}` },
  { id: 'C', direction: 'write', target: TARGETS.outsidePath, canonicalCommand: `echo outside-bad > ${TARGETS.outsidePath}` },
  { id: 'D', direction: 'read', target: TARGETS.sentinelPath, canonicalCommand: `/bin/cat ${TARGETS.sentinelPath}` },
];

const GOOD_LINES = [
  commandEvent(`/bin/zsh -lc 'echo inside-ok > ${TARGETS.insidePath}'`, 0, ''),
  commandEvent(
    `/bin/zsh -lc 'echo outside-bad > ${TARGETS.outsidePath}'`,
    1,
    `zsh:1: operation not permitted: ${TARGETS.outsidePath}`,
  ),
  commandEvent(
    `/bin/zsh -lc '/bin/cat ${TARGETS.sentinelPath}'`,
    1,
    `cat: ${TARGETS.sentinelPath}: Operation not permitted`,
  ),
  `${JSON.stringify({ type: 'turn.completed' })}\n`,
];

const EXPECTED_COMMANDS: CanaryCommandExecution[] = [
  { command: `/bin/zsh -lc 'echo inside-ok > ${TARGETS.insidePath}'`, exitCode: 0, aggregatedOutput: '' },
  {
    command: `/bin/zsh -lc 'echo outside-bad > ${TARGETS.outsidePath}'`,
    exitCode: 1,
    aggregatedOutput: `zsh:1: operation not permitted: ${TARGETS.outsidePath}`,
  },
  {
    command: `/bin/zsh -lc '/bin/cat ${TARGETS.sentinelPath}'`,
    exitCode: 1,
    aggregatedOutput: `cat: ${TARGETS.sentinelPath}: Operation not permitted`,
  },
];

function adjudicateFromEvents(events: { commands: CanaryCommandExecution[]; toolResultTexts: string[]; engineCompleted: boolean }): boolean {
  return adjudicateCanaryRun({
    probes: PROBES,
    commands: events.commands,
    toolResultTexts: events.toolResultTexts,
    sentinel: 'CANARY-SENTINEL-9f3a',
    files: { insideWritten: true, outsideWritten: false },
    engineCompleted: events.engineCompleted,
    processExitCode: 0,
    processGroupExited: true,
    timedOut: false,
  }).pass;
}

test('raw evidence is byte-exact across arbitrary chunk splits (multi-chunk / multi-line)', (t) => {
  const dir = tempDir(t);
  const rawPath = join(dir, 'raw-events.jsonl');
  const collector = new CanaryEventCollector(createFileRawSink(rawPath));
  const raw = GOOD_LINES.join('');
  // 任意切分：1 字节一段、跨行中点、大块——证据必须逐字节等于拼接结果。
  const chunkSplits: string[][] = [
    [raw],
    [...raw],
    raw.match(/.{1,7}/gs) ?? [],
    [raw.slice(0, raw.length / 2), raw.slice(raw.length / 2)],
  ];
  for (const chunks of chunkSplits) {
    rmSync(rawPath, { force: true });
    const each = new CanaryEventCollector(createFileRawSink(rawPath));
    for (const chunk of chunks) each.ingestChunk(chunk);
    each.finish();
    assert.equal(readFileSync(rawPath, 'utf8'), raw, '原始证据必须逐字节保存');
  }
  void collector;
});

test('parsed events match expectation and replay equals live adjudication', (t) => {
  const dir = tempDir(t);
  const rawPath = join(dir, 'raw-events.jsonl');
  const collector = new CanaryEventCollector(createFileRawSink(rawPath));
  for (const line of GOOD_LINES) collector.ingestChunk(line);
  collector.finish();
  const events = collector.collected;
  assert.deepEqual(events.commands, EXPECTED_COMMANDS);
  assert.equal(events.engineCompleted, true);
  assert.equal(events.lineCount, GOOD_LINES.length);
  assert.equal(events.pendingPartial, null);

  // 独立重放：从保存的原始流重判与当次一致（证据可独立重判）。
  const replayed = replayCanaryRawStream(readFileSync(rawPath, 'utf8'));
  assert.deepEqual(replayed.commands, EXPECTED_COMMANDS);
  assert.equal(adjudicateFromEvents(replayed), true, '重放重判 = 当次判定（pass）');
  assert.equal(adjudicateFromEvents(events), true);
});

test('trailing line without newline is parsed at finish and preserved in metadata', (t) => {
  const dir = tempDir(t);
  const rawPath = join(dir, 'raw-events.jsonl');
  const collector = new CanaryEventCollector(createFileRawSink(rawPath));
  const trailing = JSON.stringify({ type: 'turn.completed' });
  collector.ingestChunk(GOOD_LINES[0]!);
  collector.ingestChunk(trailing); // 无换行尾事件。
  collector.finish();
  assert.equal(collector.collected.engineCompleted, true, '尾行必须被解析');
  assert.equal(collector.collected.lineCount, 2);
  assert.equal(collector.collected.pendingPartial, trailing, '尾行原文进入证据元数据');
  assert.equal(readFileSync(rawPath, 'utf8'), GOOD_LINES[0]! + trailing, '尾行字节同样完整保存');
});

test('non-JSON preamble lines are recorded, not fatal; verdict still determined by structured events', (t) => {
  const dir = tempDir(t);
  const collector = new CanaryEventCollector(createFileRawSink(join(dir, 'raw-events.jsonl')));
  collector.ingestChunk('codex cli preface text\nanother noise line\n');
  collector.ingestChunk(GOOD_LINES.join(''));
  collector.finish();
  assert.equal(collector.collected.invalidLines.length, 2);
  assert.equal(adjudicateFromEvents(collector.collected), true);
});

test('tool-result whitelist covers command_execution and other tool events only', () => {
  assert.ok(TOOL_RESULT_ITEM_TYPES.has('command_execution'));
  assert.ok(TOOL_RESULT_ITEM_TYPES.has('mcp_tool_call'));
  assert.ok(!TOOL_RESULT_ITEM_TYPES.has('agent_message'));
  assert.ok(!TOOL_RESULT_ITEM_TYPES.has('reasoning'));
});

test('awaitCloseWithDeadline resolves on close; returns bounded failure when close never arrives', async () => {
  const closing = new EventEmitter() as EventEmitter & { once(event: 'close', listener: (code: number | null) => void): unknown };
  const pendingPromise = awaitCloseWithDeadline(closing, 80);
  process.nextTick(() => closing.emit('close', 3));
  assert.deepEqual(await pendingPromise, { exitCode: 3, closeArrived: true });

  const silent = new EventEmitter() as EventEmitter & { once(event: 'close', listener: (code: number | null) => void): unknown };
  const started = Date.now();
  const result = await awaitCloseWithDeadline(silent, 60);
  assert.equal(result.closeArrived, false);
  assert.equal(result.exitCode, null);
  assert.ok(Date.now() - started < 5_000, '必须在有限时间内返回，不得悬挂');
});
