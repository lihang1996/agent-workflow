import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ensureZcodeAppToolsConfig, mergeZcodeMcpConfig } from '../src/cli/app-tools.js';
import { getCliAdapter, listCliAdapters, parseCliId } from '../src/cli/registry.js';
import { parseCliRequest } from '../src/core/command-parser.js';
import { ZcodeAdapter } from '../src/cli/zcode-adapter.js';
import type { CliEvent } from '../src/cli/types.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'zcode');

const zcode = getCliAdapter('zcode', ['request_clarification']);

test('zcode args use prompt/mode/output-format; resume uses the exact session id', () => {
  assert.deepEqual(
    zcode.buildArgs('任务内容', 'argument'),
    ['--prompt', '任务内容', '--mode', 'yolo', '--output-format', 'stream-json'],
  );
  const resumed = zcode.buildResumeArgs('继续任务', 'sess-1', 'argument');
  assert.deepEqual(
    resumed.slice(0, 6),
    ['--prompt', '继续任务', '--resume', 'sess-1', '--mode', 'yolo'],
  );
  assert.equal(resumed[resumed.length - 1], 'stream-json');
  assert.ok(!resumed.includes('--continue'));
});

test('zcode repeats --attach for every attachment on fresh and resumed runs', () => {
  const attachments = [
    { path: '/abs/a.png', type: 'image' as const },
    { path: '/abs/b.txt', type: 'file' as const },
  ];
  assert.deepEqual(
    zcode.buildArgs('task', 'argument', attachments).slice(-4),
    ['--attach', '/abs/a.png', '--attach', '/abs/b.txt'],
  );
  assert.deepEqual(
    zcode.buildResumeArgs('task', 'sess-1', 'argument', attachments).slice(-4),
    ['--attach', '/abs/a.png', '--attach', '/abs/b.txt'],
  );
  assert.deepEqual(zcode.buildArgs('task', 'argument', []), zcode.buildArgs('task', 'argument'));
});

test('zcode rejects stdin prompts explicitly (argument-only, macOS first)', () => {
  assert.throws(() => zcode.buildArgs('task', 'stdin'), /参数方式/);
  assert.throws(() => zcode.buildResumeArgs('task', 'sess-1', 'stdin'), /参数方式/);
});

test('zcode overlays allowed tools, including an explicit empty list', () => {
  assert.equal(zcode.buildEnv?.().AGENT_OS_ALLOWED_TOOLS, 'request_clarification');
  assert.equal(getCliAdapter('zcode', []).buildEnv?.().AGENT_OS_ALLOWED_TOOLS, '');
});

test('zcode does not expose a compact protocol', () => {
  assert.equal(zcode.buildCompactPlan, undefined);
});

test('zcode adapters are per-execution instances, including comment runs', () => {
  const first = getCliAdapter('zcode', ['request_clarification']);
  const second = getCliAdapter('zcode', ['request_clarification']);
  const comment = getCliAdapter('zcode');
  assert.notEqual(first, second);
  assert.notEqual(first, comment);
  assert.equal(comment.appTools.length, 0);
  assert.ok(first instanceof ZcodeAdapter);
  // 旧引擎单例行为保持不变。
  assert.equal(getCliAdapter('claude'), getCliAdapter('claude'));
  assert.equal(getCliAdapter('cursor'), getCliAdapter('cursor'));
  const listed = listCliAdapters().find((adapter) => adapter.id === 'zcode');
  assert.ok(listed);
  assert.notEqual(listed, first);
});

test('zcode maps session, final result and noise events', () => {
  const events = (value: object) => zcode.parseEvents(JSON.stringify(value));
  assert.deepEqual(
    events({ type: 'session.created', sessionId: 'sess-1' }),
    [{ type: 'session', sessionId: 'sess-1' }],
  );
  assert.deepEqual(events({ type: 'session.resumed' }), []);
  assert.deepEqual(
    events({ type: 'result', response: '完成了', sessionId: 'sess-1' }),
    [{ type: 'result', answer: '完成了', sessionId: 'sess-1' }],
  );
  // 无 response 的 result 不是最终回答，但顶层 sessionId 仍可补获会话。
  assert.deepEqual(
    events({ type: 'result', sessionId: 'sess-1' }),
    [{ type: 'session', sessionId: 'sess-1' }],
  );
  // 非最终事件无 sessionId 时忽略；有 sessionId 时只补获会话。
  assert.deepEqual(events({ type: 'turn.completed' }), []);
  assert.deepEqual(
    events({ type: 'turn.completed', sessionId: 'sess-2' }),
    [{ type: 'session', sessionId: 'sess-2' }],
  );
  assert.deepEqual(events({ type: 'message.upserted' }), []);
  assert.deepEqual(events({ type: 'model.streaming' }), []);
  assert.deepEqual(events({ type: 'whatever.else' }), []);
  assert.deepEqual(zcode.parseEvents('not-json'), []);
  assert.deepEqual(zcode.parseEvents('42'), []);
});

test('/zcode is parsed as a CLI request and accepted as defaultCli', () => {
  assert.deepEqual(parseCliRequest('/zcode 写个页面'), {
    cliId: 'zcode',
    prompt: '写个页面',
  });
  assert.equal(parseCliId('zcode'), 'zcode');
});

test('zcode maps a real turn.failed sample from stream-json probes', () => {
  const line = readFileSync(join(fixtureDir, 'turn-failed.ndjson'), 'utf8').trim();
  const [failure] = zcode.parseEvents(line);
  assert.ok(failure);
  assert.equal(failure.type, 'error');
  assert.equal(failure.type === 'error' && failure.message, 'Select a model before continuing');
  assert.equal(failure.type === 'error' && failure.sessionId, 'sess_9bf0005c-2ae6-402b-a57d-cda4a2402adb');
});

test('zcode maps this-turn usage and context, never session-cumulative tokens', () => {
  const events = (value: object) => zcode.parseEvents(JSON.stringify(value));
  const [result] = events({
    type: 'result',
    response: 'pong',
    sessionId: 'sess-stats',
    usage: {
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      cacheReadTokens: 4,
    },
    projection: {
      status: 'idle',
      turnCount: 2,
      totalTokenCount: 999,
      contextUsed: 80,
      contextWindow: 128000,
    },
  });
  assert.equal(result?.type, 'result');
  assert.deepEqual(result?.type === 'result' ? result.stats : undefined, {
    totalTokens: 15,
    inputTokens: 12,
    outputTokens: 3,
    cacheReadTokens: 4,
    turns: 2,
    contextUsedTokens: 80,
    contextWindowTokens: 128000,
  });
  const [nested] = events({
    type: 'result',
    response: 'ok',
    usage: {
      inputTokenDetails: { cacheReadTokens: 7 },
    },
  });
  assert.equal(nested?.type === 'result' && nested.stats?.cacheReadTokens, 7);
  assert.equal(nested?.type === 'result' && nested.stats?.totalTokens, undefined);
});

test('zcode prefers official cache tokens including zero and retains fallback fields', () => {
  const adapter = new ZcodeAdapter();
  for (const [usage, expected] of [
    [{ cacheReadTokens: 0, cachedInputTokens: 8, inputTokenDetails: { cacheReadTokens: 9 } }, 0],
    [{ cachedInputTokens: 8, inputTokenDetails: { cacheReadTokens: 9 } }, 8],
  ] as const) {
    const [result] = adapter.parseEvents(JSON.stringify({ type: 'result', response: 'ok', usage }));
    assert.equal(result?.type === 'result' && result.stats?.cacheReadTokens, expected);
  }
});

test('zcode rejects wrapped MCP business errors and still submits genuine success', () => {
  const adapter = new ZcodeAdapter(['dispatch_task']);
  const input = { targetBotId: 'engineer', objective: '修复问题', instruction: '修复并验证' };
  const replay = (toolCallId: string, content: string) => {
    adapter.parseEvents(JSON.stringify({
      type: 'tool.updated',
      payload: { kind: 'scheduled', toolCallId, toolName: 'mcp__agent_os__dispatch_task', input },
    }));
    return adapter.parseEvents(JSON.stringify({
      type: 'tool.updated',
      payload: { kind: 'result', toolCallId, result: { success: true, content } },
    }));
  };
  // 按 CLI 0.16.9 序列化格式构造的回归样本，不冒充真实成功任务的 stdout。
  assert.deepEqual(replay('wrapped-error', 'MCP tool returned an error:\nTool execution rejected'), [
    { type: 'tool_end', toolUseId: 'wrapped-error', failed: true },
  ]);
  assert.deepEqual(replay('accepted', '派发请求已交给 Agent OS，等待协作任务送达目标成员。'), [
    { type: 'tool_call', toolUseId: 'accepted', toolName: 'dispatch_task', input },
    { type: 'tool_end', toolUseId: 'accepted', failed: false },
  ]);
});

test('zcode does not treat ordinary output as an agent_os MCP error', () => {
  for (const toolName of ['Read', 'Bash', 'mcp__other__dispatch_task']) {
    const adapter = new ZcodeAdapter();
    adapter.parseEvents(JSON.stringify({
      type: 'tool.updated',
      payload: { kind: 'scheduled', toolCallId: 'ordinary', toolName, input: {} },
    }));
    assert.deepEqual(adapter.parseEvents(JSON.stringify({
      type: 'tool.updated',
      payload: {
        kind: 'result', toolCallId: 'ordinary',
        result: { success: true, content: 'MCP tool returned an error:\nquoted text' },
      },
    })), [{ type: 'tool_end', toolUseId: 'ordinary', failed: false }]);
  }
});

test('zcode correlates scheduled/started/result and dispatches business calls once', () => {
  const events = (value: object) => zcode.parseEvents(JSON.stringify(value));

  // scheduled：暂存名称与输入，不产生业务事件；顶层 sessionId 仍可补获会话。
  assert.deepEqual(events({
    type: 'tool.updated',
    sessionId: 'sess-tool',
    payload: {
      kind: 'scheduled',
      toolCallId: 'tc-1',
      toolName: 'mcp__agent_os__request_clarification',
      input: { questions: [{ question: '范围？', options: ['A', 'B'] }] },
    },
  }), [{ type: 'session', sessionId: 'sess-tool' }]);

  // started：名称从暂存补齐，业务工具显示去前缀名。
  assert.deepEqual(
    events({ type: 'tool.updated', payload: { kind: 'started', toolCallId: 'tc-1' } }),
    [{
      type: 'tool_start',
      toolUseId: 'tc-1',
      toolName: 'request_clarification',
      label: '调用 request_clarification',
    }],
  );

  // result：确认成功才派发业务动作，同 ID 不重复派发。
  const firstResult = events({
    type: 'tool.updated',
    payload: { kind: 'result', toolCallId: 'tc-1', result: { success: true } },
  });
  assert.deepEqual(firstResult, [
    {
      type: 'tool_call',
      toolUseId: 'tc-1',
      toolName: 'request_clarification',
      input: { questions: [{ question: '范围？', options: ['A', 'B'] }] },
    },
    { type: 'tool_end', toolUseId: 'tc-1', failed: false },
  ]);
  assert.deepEqual(
    events({
      type: 'tool.updated',
      payload: { kind: 'result', toolCallId: 'tc-1', result: { success: true } },
    }),
    [{ type: 'tool_end', toolUseId: 'tc-1', failed: false }],
  );
});

test('zcode native tool start maps labels and details from the scheduled input', () => {
  const events = (value: object) => zcode.parseEvents(JSON.stringify(value));
  assert.deepEqual(events({
    type: 'tool.updated',
    payload: { kind: 'scheduled', toolCallId: 'tc-r', toolName: 'Read', input: { file_path: '/a/b/c.txt' } },
  }), []);
  assert.deepEqual(
    events({ type: 'tool.updated', payload: { kind: 'started', toolCallId: 'tc-r' } }),
    [{ type: 'tool_start', toolUseId: 'tc-r', toolName: 'Read', label: '读取文件', detail: 'b/c.txt' }],
  );
  assert.deepEqual(
    events({ type: 'tool.updated', payload: { kind: 'result', toolCallId: 'tc-r', result: { success: true } } }),
    [{ type: 'tool_end', toolUseId: 'tc-r', failed: false }],
  );
});

test('zcode never dispatches business actions for failed or foreign or omitted calls', () => {
  const events = (value: object) => zcode.parseEvents(JSON.stringify(value));

  // 工具错误：结束调用并丢弃业务候选；之后再补 result 也不派发。
  events({
    type: 'tool.updated',
    payload: { kind: 'scheduled', toolCallId: 'tc-e', toolName: 'mcp__agent_os__request_clarification', input: {} },
  });
  assert.deepEqual(
    events({ type: 'tool.updated', payload: { kind: 'error', toolCallId: 'tc-e' } }),
    [{ type: 'tool_end', toolUseId: 'tc-e', failed: true }],
  );
  assert.deepEqual(
    events({ type: 'tool.updated', payload: { kind: 'result', toolCallId: 'tc-e', result: { success: true } } }),
    [{ type: 'tool_end', toolUseId: 'tc-e', failed: false }],
  );

  // 失败结果：不派发业务动作。
  events({
    type: 'tool.updated',
    payload: { kind: 'scheduled', toolCallId: 'tc-f', toolName: 'mcp__agent_os__request_clarification', input: {} },
  });
  assert.deepEqual(
    events({ type: 'tool.updated', payload: { kind: 'result', toolCallId: 'tc-f', result: { success: false } } }),
    [{ type: 'tool_end', toolUseId: 'tc-f', failed: true }],
  );

  // 其他 MCP server 的同名工具不识别为业务调用。
  events({
    type: 'tool.updated',
    payload: { kind: 'scheduled', toolCallId: 'tc-x', toolName: 'mcp__other__request_clarification', input: {} },
  });
  assert.deepEqual(
    events({ type: 'tool.updated', payload: { kind: 'result', toolCallId: 'tc-x', result: { success: true } } }),
    [{ type: 'tool_end', toolUseId: 'tc-x', failed: false }],
  );

  // inputOmitted：缺少输入不猜测参数、不派发。
  events({
    type: 'tool.updated',
    payload: { kind: 'scheduled', toolCallId: 'tc-o', toolName: 'mcp__agent_os__dispatch_task', input: {}, inputOmitted: true },
  });
  assert.deepEqual(
    events({ type: 'tool.updated', payload: { kind: 'result', toolCallId: 'tc-o', result: { success: true } } }),
    [{ type: 'tool_end', toolUseId: 'tc-o', failed: false }],
  );

  // 没见过 scheduled 的 result：缺失输入不造业务调用。
  assert.deepEqual(
    events({ type: 'tool.updated', payload: { kind: 'result', toolCallId: 'tc-missing', result: { success: true } } }),
    [{ type: 'tool_end', toolUseId: 'tc-missing', failed: false }],
  );
});

test('zcode parses JSON-string tool inputs like cursor does', () => {
  const zcodeJson = getCliAdapter('zcode', ['request_clarification']);
  zcodeJson.parseEvents(JSON.stringify({
    type: 'tool.updated',
    payload: {
      kind: 'scheduled',
      toolCallId: 'tc-j',
      toolName: 'mcp__agent_os__request_clarification',
      input: '{"questions":[{"question":"Q","options":["A"]}]}',
    },
  }));
  const [dispatched] = zcodeJson.parseEvents(JSON.stringify({
    type: 'tool.updated',
    payload: { kind: 'result', toolCallId: 'tc-j', result: { success: true } },
  }));
  assert.ok(dispatched);
  assert.equal(dispatched.type, 'tool_call');
  assert.equal(dispatched.type === 'tool_call' && (dispatched.input as { questions: unknown[] }).questions.length, 1);
});

test('zcode mcp config merge keeps other servers and never bakes --tools', () => {
  const merged = mergeZcodeMcpConfig({
    mcp: { servers: { other: { command: 'keep-me' } } },
    unrelated: true,
  });
  const mcp = merged.mcp as { servers: Record<string, { type?: string; command?: string; args?: string[] }> };
  assert.equal(mcp.servers.other.command, 'keep-me');
  assert.equal(mcp.servers.agent_os.type, 'stdio');
  assert.ok(mcp.servers.agent_os.command);
  assert.ok(!mcp.servers.agent_os.args?.some((arg) => arg.startsWith('--tools=')));
  assert.equal((merged as { unrelated?: boolean }).unrelated, true);
});

test('zcode mcp config ensure creates nested file, keeps others, preserves corrupted file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-os-zcode-mcp-'));
  const filePath = join(directory, 'nested', 'cli', 'config.json');
  try {
    // 父目录不存在：从零创建。
    await ensureZcodeAppToolsConfig(filePath);
    const first = JSON.parse(readFileSync(filePath, 'utf8')) as {
      mcp: { servers: Record<string, { type?: string; command?: string }> };
    };
    assert.equal(first.mcp.servers.agent_os.type, 'stdio');

    // 已有条目保持不变，不整份覆盖。
    first.mcp.servers.other = { command: 'keep-me' };
    writeFileSync(filePath, JSON.stringify(first));
    await ensureZcodeAppToolsConfig(filePath);
    const second = JSON.parse(readFileSync(filePath, 'utf8')) as {
      mcp: { servers: Record<string, { command?: string }> };
    };
    assert.equal(second.mcp.servers.other.command, 'keep-me');
    assert.equal(second.mcp.servers.agent_os.command, first.mcp.servers.agent_os.command);

    // 损坏配置：报错且保留原文件，不当空配置覆盖。
    const corruptPath = join(directory, 'corrupt.json');
    writeFileSync(corruptPath, '{broken');
    await assert.rejects(() => ensureZcodeAppToolsConfig(corruptPath), /无法读取 ZCode MCP 配置/);
    assert.equal(readFileSync(corruptPath, 'utf8'), '{broken');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('zcode tool events never leak across adapter instances', () => {
  const first = new ZcodeAdapter(['request_clarification']);
  const second = new ZcodeAdapter(['request_clarification']);
  first.parseEvents(JSON.stringify({
    type: 'tool.updated',
    payload: { kind: 'scheduled', toolCallId: 'tc-shared', toolName: 'mcp__agent_os__request_clarification', input: {} },
  }));
  // 第二个实例看不到第一个实例的暂存记录：不派发业务动作。
  const events: CliEvent[] = second.parseEvents(JSON.stringify({
    type: 'tool.updated',
    payload: { kind: 'result', toolCallId: 'tc-shared', result: { success: true } },
  }));
  assert.deepEqual(events, [{ type: 'tool_end', toolUseId: 'tc-shared', failed: false }]);
  // 第一个实例自身仍然可以完成关联派发。
  const own = first.parseEvents(JSON.stringify({
    type: 'tool.updated',
    payload: { kind: 'result', toolCallId: 'tc-shared', result: { success: true } },
  }));
  assert.equal(own[0].type, 'tool_call');
});
