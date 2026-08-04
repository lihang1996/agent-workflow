import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeAdapter } from '../src/cli/claude-adapter.js';
import { CodexAdapter } from '../src/cli/codex-adapter.js';
import { runCli } from '../src/cli/runner.js';
import type { CliAdapter, CliEvent } from '../src/cli/types.js';

class NodeScriptAdapter implements CliAdapter {
  readonly id = 'claude' as const;
  readonly command = process.execPath;
  readonly displayName = '测试 CLI';

  constructor(private readonly script: string) {}

  buildArgs(): string[] { return ['-e', this.script]; }
  buildResumeArgs(): string[] { return this.buildArgs(); }
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
    () => runCli({ adapter, prompt: 'test', cwd: process.cwd(), timeoutMs: 30 }),
    /执行超时/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => runCli({ adapter, prompt: 'test', cwd: process.cwd(), signal: controller.signal }),
    /执行已取消/,
  );
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
