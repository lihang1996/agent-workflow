import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureCursorAppToolsConfig, mergeCursorMcpConfig } from '../src/cli/app-tools.js';
import { getCliAdapter } from '../src/cli/registry.js';
import { CursorAdapter } from '../src/cli/cursor-adapter.js';

const cursor = getCliAdapter('cursor', ['request_clarification']);

test('cursor args use print/force/stream-json; resume uses the exact session id', () => {
  assert.deepEqual(
    cursor.buildArgs('任务内容', 'argument').slice(0, 4),
    ['-p', '--force', '--output-format', 'stream-json'],
  );
  assert.equal(cursor.buildArgs('任务内容', 'argument').at(-1), '任务内容');
  assert.ok(!cursor.buildArgs('任务内容', 'stdin').includes('任务内容'));
  const resumed = cursor.buildResumeArgs('继续任务', 'sess-1', 'argument');
  assert.equal(resumed[resumed.indexOf('--resume') + 1], 'sess-1');
  assert.ok(!resumed.includes('--continue'));
  assert.deepEqual(
    cursor.buildArgs('task', 'argument', [{ path: '/abs/a.png', type: 'image' }]),
    cursor.buildArgs('task', 'argument'),
  );
});

test('cursor overlays allowed tools, including an explicit empty list', () => {
  assert.equal(cursor.buildEnv?.().AGENT_OS_ALLOWED_TOOLS, 'request_clarification');
  assert.equal(getCliAdapter('cursor', []).buildEnv?.().AGENT_OS_ALLOWED_TOOLS, '');
  assert.equal(getCliAdapter('claude').buildEnv, undefined);
  assert.equal(getCliAdapter('codex').buildEnv, undefined);
});

test('cursor mcp.json merge keeps other servers and interpolates tools', () => {
  const merged = mergeCursorMcpConfig({
    mcpServers: { other: { command: 'keep-me' } },
  });
  const servers = merged.mcpServers as Record<string, { command?: string; args?: string[] }>;
  assert.equal(servers.other.command, 'keep-me');
  assert.ok(servers.agent_os.args?.includes('--tools=${env:AGENT_OS_ALLOWED_TOOLS}'));
});

test('cursor mcp.json ensure writes agent_os without replacing the file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-os-cursor-mcp-'));
  const filePath = join(directory, 'mcp.json');
  try {
    await ensureCursorAppToolsConfig(filePath);
    const first = JSON.parse(readFileSync(filePath, 'utf8'));
    first.mcpServers.other = { command: 'keep-me' };
    writeFileSync(filePath, JSON.stringify(first));
    await ensureCursorAppToolsConfig(filePath);
    const second = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.equal(second.mcpServers.other.command, 'keep-me');
    assert.equal(second.mcpServers.agent_os.type, 'stdio');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cursor mcp.json keeps invalid existing files instead of overwriting them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-os-cursor-mcp-bad-'));
  const filePath = join(directory, 'mcp.json');
  try {
    writeFileSync(filePath, '{');
    await assert.rejects(
      () => ensureCursorAppToolsConfig(filePath),
      /无法读取 Cursor MCP 配置/,
    );
    assert.equal(readFileSync(filePath, 'utf8'), '{');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cursor events map session, tools, and only confirmed business calls', () => {
  const adapter = new CursorAdapter(['request_clarification']);
  assert.deepEqual(
    adapter.parseEvents('{"type":"system","subtype":"init","session_id":"s1"}'),
    [{ type: 'session', sessionId: 's1' }],
  );
  assert.deepEqual(adapter.parseEvents('{"type":"assistant","message":{"content":[]}}'), []);
  assert.deepEqual(
    adapter.parseEvents('{"type":"result","result":"nope","session_id":"s1"}'),
    [],
  );

  const started = adapter.parseEvents(JSON.stringify({
    type: 'tool_call',
    subtype: 'started',
    call_id: 'read-1',
    tool_call: { readToolCall: { args: { path: 'README.md' } } },
  }));
  assert.equal(started[0]?.type, 'tool_start');
  assert.ok(!started.some((event) => event.type === 'tool_call'));

  const incomplete = adapter.parseEvents(JSON.stringify({
    type: 'tool_call',
    subtype: 'started',
    call_id: 'biz-1',
    tool_call: {
      function: {
        name: 'request_clarification',
        arguments: JSON.stringify({
          title: '范围',
          questions: [{ id: 'q1', prompt: '？', options: [{ id: 'a', label: 'A' }] }],
        }),
      },
    },
  }));
  assert.ok(!incomplete.some((event) => event.type === 'tool_call'));

  const failed = adapter.parseEvents(JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'biz-fail',
    tool_call: {
      function: {
        name: 'request_clarification',
        arguments: '{}',
        result: { error: 'nope' },
      },
    },
  }));
  assert.deepEqual(failed, [{ type: 'tool_end', toolUseId: 'biz-fail', failed: true }]);

  const input = {
    title: '范围',
    questions: [{ id: 'q1', prompt: '？', options: [{ id: 'a', label: 'A' }] }],
  };
  const completed = JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'biz-ok',
    tool_call: {
      function: {
        name: 'request_clarification',
        arguments: JSON.stringify(input),
        result: { success: {} },
      },
    },
  });
  const success = adapter.parseEvents(completed);
  assert.deepEqual(success[0], {
    type: 'tool_call',
    toolUseId: 'biz-ok',
    toolName: 'request_clarification',
    input,
  });
  assert.deepEqual(success[1], { type: 'tool_end', toolUseId: 'biz-ok', failed: false });
  assert.deepEqual(adapter.parseEvents(completed), [
    { type: 'tool_end', toolUseId: 'biz-ok', failed: false },
  ]);

  assert.deepEqual(
    adapter.parseEvents(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '完成',
      session_id: 's1',
      duration_ms: 12,
    })),
    [{ type: 'result', answer: '完成', sessionId: 's1', stats: { durationMs: 12 } }],
  );
});

const clarificationInput = {
  title: '范围',
  questions: [{ id: 'q1', prompt: '？', options: [{ id: 'a', label: 'A' }] }],
};

function mcpToolCallEvent(options: {
  callId: string;
  subtype: 'started' | 'completed';
  providerIdentifier?: string;
  toolName?: string;
  args?: unknown;
  success?: { isError?: boolean };
}) {
  return JSON.stringify({
    type: 'tool_call',
    subtype: options.subtype,
    call_id: options.callId,
    tool_call: {
      mcpToolCall: {
        args: {
          providerIdentifier: options.providerIdentifier ?? 'agent_os',
          toolName: options.toolName ?? 'request_clarification',
          args: options.args ?? clarificationInput,
        },
        ...(options.success
          ? { result: { success: options.success } }
          : {}),
      },
    },
  });
}

test('cursor maps successful agent_os mcpToolCall events to business tool_call', () => {
  const adapter = new CursorAdapter(['request_clarification']);
  const started = adapter.parseEvents(mcpToolCallEvent({ callId: 'mcp-1', subtype: 'started' }));
  assert.equal(started[0]?.type, 'tool_start');
  assert.ok(!started.some((event) => event.type === 'tool_call'));

  const success = adapter.parseEvents(mcpToolCallEvent({
    callId: 'mcp-1',
    subtype: 'completed',
    success: { isError: false },
  }));
  assert.deepEqual(success[0], {
    type: 'tool_call',
    toolUseId: 'mcp-1',
    toolName: 'request_clarification',
    input: clarificationInput,
  });
  assert.deepEqual(success[1], { type: 'tool_end', toolUseId: 'mcp-1', failed: false });
});

test('cursor ignores failed or foreign mcpToolCall events', () => {
  const adapter = new CursorAdapter(['request_clarification']);
  assert.deepEqual(
    adapter.parseEvents(mcpToolCallEvent({
      callId: 'mcp-fail',
      subtype: 'completed',
      success: { isError: true },
    })),
    [{ type: 'tool_end', toolUseId: 'mcp-fail', failed: true }],
  );
  assert.deepEqual(
    adapter.parseEvents(mcpToolCallEvent({
      callId: 'mcp-other',
      subtype: 'completed',
      providerIdentifier: 'other_server',
      success: { isError: false },
    })),
    [{ type: 'tool_end', toolUseId: 'mcp-other', failed: false }],
  );
});

test('cursor mcp.json setup is shared and survives concurrent first-use calls', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-os-cursor-mcp-race-'));
  const filePath = join(directory, 'mcp.json');
  try {
    await Promise.all(Array.from({ length: 24 }, () => ensureCursorAppToolsConfig(filePath)));
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.equal(parsed.mcpServers.agent_os.type, 'stdio');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
