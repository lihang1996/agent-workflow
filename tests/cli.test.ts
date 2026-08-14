import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeAdapter } from '../src/cli/claude-adapter.js';
import { CodexAdapter } from '../src/cli/codex-adapter.js';
import { CursorAdapter } from '../src/cli/cursor-adapter.js';
import { resolveCliIdleTimeoutMs, resolveCliTimeoutMs, runCli } from '../src/cli/runner.js';
import {
  resolveCliMaxToolCount,
  resolveCliToolLoopStreak,
  ToolLoopWatch,
} from '../src/cli/tool-budget.js';
import { formatEngineChoices, formatEngineIds, isCliId, type CliAdapter, type CliEvent } from '../src/cli/types.js';
import { isReviewExplicitlyApproved } from '../src/core/collab.js';
import { hasExplicitStepResult } from '../src/core/step-result.js';

class NodeScriptAdapter implements CliAdapter {
  readonly id = 'claude' as const;
  readonly command = process.execPath;
  readonly displayName = '测试 CLI';

  constructor(
    private readonly script: string,
    private readonly resumeScript = script,
  ) {}

  buildArgs(): string[] { return ['-e', this.script]; }
  buildResumeArgs(): string[] { return ['-e', this.resumeScript]; }
  parseEvents(line: string): CliEvent[] { return [JSON.parse(line) as CliEvent]; }
}

test('CLI 流中的错误事件优先于随后出现的结果', async () => {
  const script = [
    `console.log(JSON.stringify({type:'error',message:'真实失败'}))`,
    `console.log(JSON.stringify({type:'result',answer:'不应成功'}))`,
  ].join(';');
  await assert.rejects(
    () => runCli({ adapter: new NodeScriptAdapter(script), prompt: 'test', cwd: process.cwd() }),
    /真实失败/,
  );
});

test('CLI 失败输出只保留有界尾部', async () => {
  const script = `process.stderr.write('x'.repeat(100000));process.exitCode=1`;
  await assert.rejects(
    () => runCli({ adapter: new NodeScriptAdapter(script), prompt: 'test', cwd: process.cwd() }),
    (error: Error) => error.message.length <= 64 * 1024 && error.message === 'x'.repeat(error.message.length),
  );
});

test('CLI 事件处理器异常会安全终止子进程', async () => {
  const script = `console.log(JSON.stringify({type:'assistant',text:'hello'}));setInterval(()=>{},1000)`;
  await assert.rejects(
    () => runCli({
      adapter: new NodeScriptAdapter(script), prompt: 'test', cwd: process.cwd(), timeoutMs: 2_000,
      onEvent: () => { throw new Error('卡片处理异常'); },
    }),
    /事件处理失败.*卡片处理异常/,
  );
});

test('CLI 超时和预先取消均不会留下运行任务', async () => {
  const adapter = new NodeScriptAdapter('setInterval(()=>{},1000)');
  await assert.rejects(
    () => runCli({
      adapter, prompt: 'test', cwd: process.cwd(), timeoutMs: 30, idleTimeoutMs: 0,
    }),
    /执行超时/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => runCli({ adapter, prompt: 'test', cwd: process.cwd(), signal: controller.signal }),
    /执行已取消/,
  );
});

test('CLI 空闲超时：有输出会续命，长时间无输出才终止', async () => {
  const script = [
    `console.log(JSON.stringify({type:'assistant',text:'tick'}));`,
    `setInterval(()=>{},1000);`,
  ].join('');
  await assert.rejects(
    () => runCli({
      adapter: new NodeScriptAdapter(script),
      prompt: 'test',
      cwd: process.cwd(),
      timeoutMs: 10_000,
      idleTimeoutMs: 80,
    }),
    /无输出，疑似卡住/,
  );
});

test('CLI_TIMEOUT_MS 环境变量可覆盖默认超时', () => {
  assert.equal(resolveCliTimeoutMs(undefined, '120000'), 120_000);
  assert.equal(resolveCliTimeoutMs(5_000, '120000'), 5_000);
  assert.equal(resolveCliTimeoutMs(undefined, '1'), 60_000);
  assert.equal(resolveCliTimeoutMs(undefined, 'not-a-number'), 6 * 60 * 60 * 1000);
});

test('CLI_IDLE_TIMEOUT_MS 支持关闭与环境覆盖', () => {
  assert.equal(resolveCliIdleTimeoutMs(0), 0);
  assert.equal(resolveCliIdleTimeoutMs(undefined, '0'), 0);
  assert.equal(resolveCliIdleTimeoutMs(undefined, '900000'), 900_000);
  assert.equal(resolveCliIdleTimeoutMs(3_000, '900000'), 3_000);
});

test('仅输入分析不会恢复或返回持久会话', async () => {
  const fresh = `console.log(JSON.stringify({type:'result',answer:'fresh',sessionId:'new-session'}))`;
  const resumed = `console.log(JSON.stringify({type:'result',answer:'resumed',sessionId:'old-session'}))`;
  const result = await runCli({
    adapter: new NodeScriptAdapter(fresh, resumed),
    prompt: '分析已提供日志',
    cwd: process.cwd(),
    sessionId: 'old-session',
    executionPolicy: 'input-only',
  });
  assert.equal(result.answer, 'fresh');
  assert.equal(result.sessionId, undefined);
});

test('Claude 流同时解析文本、上下文和工具事件', () => {
  const events = new ClaudeAdapter().parseEvents(JSON.stringify({
    type: 'assistant',
    session_id: 'claude-session',
    message: {
      usage: { input_tokens: 10, output_tokens: 99, cache_read_input_tokens: 5 },
      content: [
        { type: 'text', text: '正在检查' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a.ts' } },
      ],
    },
  }));
  assert.deepEqual(events.map((event) => event.type), ['context', 'assistant', 'tool_start']);
  assert.equal(events[0].type === 'context' && events[0].usedTokens, 15);
  assert.equal(events.every((event) => !('sessionId' in event) || event.sessionId === 'claude-session'), true);
});

test('Codex 流标记失败工具并读取 turn token 用量', () => {
  const adapter = new CodexAdapter();
  adapter.parseEvents(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));
  adapter.parseEvents(JSON.stringify({
    type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'pnpm test' },
  }));
  const ended = adapter.parseEvents(JSON.stringify({
    type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', exit_code: 1 },
  }));
  assert.equal(ended[0].type === 'tool_end' && ended[0].failed, true);
  adapter.parseEvents(JSON.stringify({
    type: 'item.completed', item: { type: 'agent_message', text: '已完成' },
  }));
  const result = adapter.parseEvents(JSON.stringify({
    type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 8 },
  }));
  assert.equal(result[0].type, 'result');
  assert.deepEqual(result[0].type === 'result' ? result[0].stats : undefined, {
    inputTokens: 20,
    outputTokens: 8,
    cacheReadTokens: 5,
    totalTokens: 28,
  });
});

test('引擎 id 与 /engine 文案包含 cursor', () => {
  assert.equal(isCliId('cursor'), true);
  assert.equal(isCliId('gemini'), false);
  assert.equal(formatEngineIds(), 'claude|codex|cursor');
  assert.equal(formatEngineChoices(), '/engine claude 或 /engine codex 或 /engine cursor');
});

test('Cursor 默认固定 grok 4.6，忽略 auto 和其它模型，且不启用 Smart Auto', () => {
  const previousModel = process.env.CURSOR_MODEL;
  const previousMcp = process.env.MCP_ENABLED;
  process.env.MCP_ENABLED = 'false';
  try {
    delete process.env.CURSOR_MODEL;
    const adapter = new CursorAdapter();
    const unset = adapter.buildArgs('写代码', { executionPolicy: 'standard' });
    assert.equal(unset[unset.indexOf('--model') + 1], 'cursor-grok-4.6-high');
    assert.equal(unset.includes('--auto-review'), false);
    assert.equal(unset.includes('--force'), true);
    assert.equal(unset[unset.indexOf('--sandbox') + 1], 'disabled');
    assert.match(unset.at(-1) ?? '', /不是 Claude dontAsk/);

    process.env.CURSOR_MODEL = 'auto';
    const ignored = adapter.buildArgs('写代码', { executionPolicy: 'standard' });
    assert.equal(ignored[ignored.indexOf('--model') + 1], 'cursor-grok-4.6-high');

    process.env.CURSOR_MODEL = 'sonnet-4';
    const blocked = adapter.buildArgs('写代码', { executionPolicy: 'standard' });
    assert.equal(blocked[blocked.indexOf('--model') + 1], 'cursor-grok-4.6-high');

    // 新的严格验证：只允许精确的 cursor-grok-4.6-high
    process.env.CURSOR_MODEL = 'cursor-grok-4.6-xhigh';
    const alsoBlocked = adapter.buildArgs('写代码', { executionPolicy: 'standard' });
    assert.equal(alsoBlocked[alsoBlocked.indexOf('--model') + 1], 'cursor-grok-4.6-high');
  } finally {
    if (previousModel === undefined) delete process.env.CURSOR_MODEL;
    else process.env.CURSOR_MODEL = previousModel;
    if (previousMcp === undefined) delete process.env.MCP_ENABLED;
    else process.env.MCP_ENABLED = previousMcp;
  }
});

test('Cursor 流解析会话、工具和最终结果', () => {
  const adapter = new CursorAdapter();
  const session = adapter.parseEvents(JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'cursor-session',
    model: 'Composer',
  }));
  assert.equal(session[0]?.type, 'session');
  assert.equal(session[0]?.type === 'session' && session[0].sessionId, 'cursor-session');

  const assistant = adapter.parseEvents(JSON.stringify({
    type: 'assistant',
    session_id: 'cursor-session',
    message: { role: 'assistant', content: [{ type: 'text', text: '正在读取' }] },
  }));
  assert.equal(assistant[0]?.type === 'assistant' && assistant[0].text, '正在读取');

  const started = adapter.parseEvents(JSON.stringify({
    type: 'tool_call',
    subtype: 'started',
    call_id: 'tool-1',
    session_id: 'cursor-session',
    tool_call: { readToolCall: { args: { path: '/tmp/a.ts' } } },
  }));
  assert.equal(started[0]?.type, 'tool_start');
  assert.equal(started[0]?.type === 'tool_start' && started[0].toolName, 'Read');
  assert.equal(started[0]?.type === 'tool_start' && started[0].detail, 'tmp/a.ts');

  const ended = adapter.parseEvents(JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'tool-1',
    session_id: 'cursor-session',
    tool_call: { readToolCall: { args: { path: '/tmp/a.ts' }, result: { error: { message: 'missing' } } } },
  }));
  assert.equal(ended[0]?.type === 'tool_end' && ended[0].failed, true);

  const missingIdA = adapter.parseEvents(JSON.stringify({
    type: 'tool_call',
    subtype: 'started',
    tool_call: { grepToolCall: { args: { pattern: 'foo' } } },
  }));
  const missingIdB = adapter.parseEvents(JSON.stringify({
    type: 'tool_call',
    subtype: 'started',
    tool_call: { grepToolCall: { args: { pattern: 'bar' } } },
  }));
  assert.equal(missingIdA[0]?.type === 'tool_start' && missingIdA[0].toolUseId, 'cursor-tool-1');
  assert.equal(missingIdB[0]?.type === 'tool_start' && missingIdB[0].toolUseId, 'cursor-tool-2');

  const resultOnly = new CursorAdapter().parseEvents(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '已完成',
    session_id: 'cursor-session',
    duration_ms: 1200,
  }));
  assert.equal(resultOnly[0]?.type, 'result');
  assert.equal(resultOnly[0]?.type === 'result' && resultOnly[0].answer, '已完成');
  assert.deepEqual(resultOnly[0]?.type === 'result' ? resultOnly[0].stats : undefined, { durationMs: 1200 });
});

test('Cursor 终态用分段 assistant 文本，避免官方 result 无换行粘连破坏协议标记', () => {
  const adapter = new CursorAdapter();
  adapter.parseEvents(JSON.stringify({
    type: 'assistant',
    session_id: 'cursor-session',
    message: { role: 'assistant', content: [{ type: 'text', text: 'I will read the file' }] },
  }));
  adapter.parseEvents(JSON.stringify({
    type: 'assistant',
    session_id: 'cursor-session',
    message: { role: 'assistant', content: [{ type: 'text', text: '[APPROVED]\n[RESULT:done] 完成' }] },
  }));
  const result = adapter.parseEvents(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'I will read the file[APPROVED]\n[RESULT:done] 完成',
    session_id: 'cursor-session',
  }));
  assert.equal(result[0]?.type, 'result');
  const answer = result[0]?.type === 'result' ? result[0].answer : '';
  assert.equal(answer, 'I will read the file\n\n[APPROVED]\n[RESULT:done] 完成');
  assert.equal(hasExplicitStepResult(answer), true);
  assert.equal(isReviewExplicitlyApproved(answer), true);
  assert.equal(hasExplicitStepResult('I will read the file[RESULT:done] 完成'), false);
  assert.equal(isReviewExplicitlyApproved('I will read the file[APPROVED]'), false);
});

test('CLI_MAX_TOOL_COUNT 默认 500，非法值回退', () => {
  assert.equal(resolveCliMaxToolCount(12, '500'), 12);
  assert.equal(resolveCliMaxToolCount(undefined, '500'), 500);
  assert.equal(resolveCliMaxToolCount(undefined, 'not-a-number'), 500);
  assert.equal(resolveCliToolLoopStreak(0), 0);
  assert.equal(resolveCliToolLoopStreak(undefined, '20'), 20);
});

test('同一目标连续调用才视为死循环，换文件或缺少 detail 不算', () => {
  const same = (id: string) => ({
    type: 'tool_start' as const,
    toolUseId: id,
    toolName: 'Read',
    label: '读取文件',
    detail: 'src/a.ts',
  });
  const other = (id: string) => ({
    type: 'tool_start' as const,
    toolUseId: id,
    toolName: 'Read',
    label: '读取文件',
    detail: 'src/b.ts',
  });
  const edit = (id: string) => ({
    type: 'tool_start' as const,
    toolUseId: id,
    toolName: 'Edit',
    label: '修改文件',
    detail: 'src/a.ts',
  });
  const watch = new ToolLoopWatch(3);
  assert.equal(watch.observe(same('1')).looped, false);
  assert.equal(watch.observe(same('2')).looped, false);
  assert.equal(watch.observe(same('3')).looped, true);

  const mixed = new ToolLoopWatch(3);
  assert.equal(mixed.observe(same('1')).looped, false);
  assert.equal(mixed.observe(other('2')).looped, false);
  assert.equal(mixed.observe(same('3')).looped, false);

  const noDetail = new ToolLoopWatch(3);
  for (let i = 0; i < 5; i++) {
    assert.equal(
      noDetail.observe({ type: 'tool_start', toolUseId: `${i}`, toolName: 'Read', label: '读取文件' }).looped,
      false,
    );
  }

  const warnWatch = new ToolLoopWatch(15);
  for (let i = 1; i <= 9; i++) {
    const observed = warnWatch.observe(same(`${i}`));
    assert.equal(observed.warn, i === 8);
    assert.equal(observed.looped, false);
  }

  const pingPong = new ToolLoopWatch({
    consecutiveWarn: 99,
    consecutiveCritical: 99,
    repeatWarn: 99,
    repeatCritical: 99,
    pingPongWarn: 3,
    pingPongCritical: 4,
    historySize: 30,
  });
  assert.equal(pingPong.observe(same('p1')).looped, false);
  assert.equal(pingPong.observe(other('p2')).looped, false);
  const pingWarn = pingPong.observe(same('p3'));
  assert.equal(pingWarn.warn, true);
  assert.equal(pingWarn.detector, 'ping_pong');
  const pingKill = pingPong.observe(other('p4'));
  assert.equal(pingKill.looped, true);
  assert.equal(pingKill.detector, 'ping_pong');

  const readEdit = new ToolLoopWatch({
    consecutiveWarn: 99,
    consecutiveCritical: 99,
    repeatWarn: 99,
    repeatCritical: 99,
    pingPongWarn: 3,
    pingPongCritical: 4,
    historySize: 30,
  });
  for (let i = 0; i < 8; i++) {
    const observed = readEdit.observe(i % 2 === 0 ? same(`r${i}`) : edit(`e${i}`));
    assert.equal(observed.looped, false, `Read/Edit 第 ${i + 1} 次不应算乒乓`);
  }

  const windowRepeat = new ToolLoopWatch({
    consecutiveWarn: 99,
    consecutiveCritical: 99,
    repeatWarn: 3,
    repeatCritical: 4,
    pingPongWarn: 99,
    pingPongCritical: 99,
    historySize: 30,
  });
  assert.equal(windowRepeat.observe(same('w1')).looped, false);
  assert.equal(windowRepeat.observe(other('w2')).looped, false);
  assert.equal(windowRepeat.observe(same('w3')).warn, false);
  assert.equal(windowRepeat.observe(edit('w4')).looped, false);
  const windowWarn = windowRepeat.observe(same('w5'));
  assert.equal(windowWarn.warn, true);
  assert.equal(windowWarn.detector, 'generic_repeat');
  assert.equal(windowRepeat.observe(edit('w6')).looped, false);
  const windowKill = windowRepeat.observe(same('w7'));
  assert.equal(windowKill.looped, true);
  assert.equal(windowKill.detector, 'generic_repeat');
});

test('CLI 同一目标连续调用会按死循环终止', async () => {
  const events = Array.from({ length: 4 }, (_, i) => (
    `console.log(JSON.stringify({type:'tool_start',toolUseId:'t${i}',toolName:'Bash',label:'运行命令',detail:'pnpm test'}))`
  )).join(';');
  await assert.rejects(
    () => runCli({
      adapter: new NodeScriptAdapter(`${events};setInterval(()=>{},1000)`),
      prompt: 'test',
      cwd: process.cwd(),
      timeoutMs: 2_000,
      idleTimeoutMs: 0,
      maxToolCount: 500,
      toolLoopStreak: 3,
    }),
    /疑似工具死循环/,
  );
});

test('CLI 交错不同目标不会被当成死循环', async () => {
  const events = Array.from({ length: 6 }, (_, i) => (
    `console.log(JSON.stringify({type:'tool_start',toolUseId:'t${i}',toolName:'Read',label:'读取文件',detail:'file-${i}.ts'}))`
  )).join(';');
  const result = await runCli({
    adapter: new NodeScriptAdapter(`${events};console.log(JSON.stringify({type:'result',answer:'ok'}))`),
    prompt: 'test',
    cwd: process.cwd(),
    idleTimeoutMs: 0,
    maxToolCount: 500,
    toolLoopStreak: 3,
  });
  assert.equal(result.answer, 'ok');
});
