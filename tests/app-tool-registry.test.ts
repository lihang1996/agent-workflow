import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeAdapter } from '../src/cli/claude-adapter.js';
import { CodexAdapter } from '../src/cli/codex-adapter.js';
import { CursorAdapter } from '../src/cli/cursor-adapter.js';
import { ZcodeAdapter } from '../src/cli/zcode-adapter.js';
import type { CliEvent } from '../src/cli/types.js';
import {
  APP_TOOL_NAMES,
  appToolsForBot,
  isAppToolName,
  validateAppToolCalls,
  type AppToolName,
} from '../src/core/app-tool-policy.js';

const ARCHITECTURE_REVIEW: AppToolName = 'request_architecture_review';

/** 架构审批正例：local 交付、相对 designPath、32 位小写 hex 交接码。 */
const ARCHITECTURE_INPUT = {
  deliveryMode: 'local',
  title: '订单域架构设计',
  summary: '订单域与支付域分离，网关只保留编排',
  designPath: 'docs/architecture.md',
  handoffToken: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
};

const VALID_INPUTS: Record<AppToolName, unknown> = {
  request_clarification: {
    title: '需求范围澄清',
    questions: [{
      id: 'scope',
      prompt: '先实现哪个范围？',
      options: [{ id: 'all', label: '全部实现' }, { id: 'core', label: '仅核心链路' }],
    }],
  },
  request_spec_approval: {
    deliveryMode: 'local',
    title: '订单模块产品方案',
    summary: '订单创建、支付回调与对账口径',
    specPath: 'docs/spec.md',
    ticketsPath: 'docs/tickets.md',
  },
  request_architecture_review: ARCHITECTURE_INPUT,
  dispatch_task: {
    targetBotId: 'engineer',
    objective: '实现订单模块',
    instruction: '按产品方案实现订单域并自测',
  },
};

function businessCalls(events: readonly CliEvent[]) {
  return events.filter(
    (event): event is Extract<CliEvent, { type: 'tool_call' }> => event.type === 'tool_call',
  );
}

function zcodeBusinessEvents(
  toolCallId: string,
  toolName: string,
  input: unknown,
  result: unknown,
  inputOmitted = false,
): CliEvent[] {
  const adapter = new ZcodeAdapter([...APP_TOOL_NAMES]);
  adapter.parseEvents(JSON.stringify({
    type: 'tool.updated',
    payload: { kind: 'scheduled', toolCallId, toolName, input, inputOmitted },
  }));
  return adapter.parseEvents(JSON.stringify({
    type: 'tool.updated',
    payload: { kind: 'result', toolCallId, result },
  }));
}

function cursorMcpEvents(
  adapter: CursorAdapter,
  callId: string,
  options: {
    subtype: 'started' | 'completed';
    providerIdentifier?: string;
    toolName?: string;
    args?: unknown;
    result?: unknown;
  },
): CliEvent[] {
  return adapter.parseEvents(JSON.stringify({
    type: 'tool_call',
    subtype: options.subtype,
    call_id: callId,
    tool_call: {
      mcpToolCall: {
        args: {
          providerIdentifier: options.providerIdentifier ?? 'agent_os',
          toolName: options.toolName ?? ARCHITECTURE_REVIEW,
          args: options.args ?? ARCHITECTURE_INPUT,
        },
        ...(options.result === undefined ? {} : { result: options.result }),
      },
    },
  }));
}

function claudeToolUse(
  adapter: ClaudeAdapter,
  id: string,
  name: string,
  input: unknown,
): CliEvent[] {
  return adapter.parseEvents(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] },
  }));
}

test('central registry derives the name list and guard for every registered tool', () => {
  assert.deepEqual([...APP_TOOL_NAMES].sort(), [
    'dispatch_task',
    'request_architecture_review',
    'request_clarification',
    'request_spec_approval',
  ]);
  for (const name of APP_TOOL_NAMES) {
    assert.equal(isAppToolName(name), true, name);
  }
  assert.equal(isAppToolName('mcp__agent_os__request_architecture_review'), false);
  assert.equal(isAppToolName('no_such_tool'), false);
});

test('zcode recognizes every registered tool via the central registry', () => {
  for (const toolName of APP_TOOL_NAMES) {
    const input = VALID_INPUTS[toolName];
    assert.deepEqual(
      zcodeBusinessEvents(`z-` + toolName, `mcp__agent_os__` + toolName, input, { success: true }),
      [
        { type: 'tool_call', toolUseId: `z-` + toolName, toolName, input },
        { type: 'tool_end', toolUseId: `z-` + toolName, failed: false },
      ],
      toolName,
    );
  }
});

test('zcode dispatches architecture review only after an explicit success result', () => {
  const adapter = new ZcodeAdapter([ARCHITECTURE_REVIEW]);
  assert.deepEqual(adapter.parseEvents(JSON.stringify({
    type: 'tool.updated',
    payload: {
      kind: 'scheduled',
      toolCallId: 'z-arch',
      toolName: 'mcp__agent_os__request_architecture_review',
      input: ARCHITECTURE_INPUT,
    },
  })), []);
  assert.deepEqual(
    adapter.parseEvents(JSON.stringify({
      type: 'tool.updated',
      payload: { kind: 'started', toolCallId: 'z-arch' },
    })),
    [{
      type: 'tool_start',
      toolUseId: 'z-arch',
      toolName: ARCHITECTURE_REVIEW,
      label: `调用 ` + ARCHITECTURE_REVIEW,
    }],
  );
  const first = adapter.parseEvents(JSON.stringify({
    type: 'tool.updated',
    payload: { kind: 'result', toolCallId: 'z-arch', result: { success: true } },
  }));
  assert.deepEqual(first, [
    {
      type: 'tool_call',
      toolUseId: 'z-arch',
      toolName: ARCHITECTURE_REVIEW,
      input: ARCHITECTURE_INPUT,
    },
    { type: 'tool_end', toolUseId: 'z-arch', failed: false },
  ]);
  // 同一 toolCallId 重放成功结果只补 tool_end，不重复提交。
  assert.deepEqual(adapter.parseEvents(JSON.stringify({
    type: 'tool.updated',
    payload: { kind: 'result', toolCallId: 'z-arch', result: { success: true } },
  })), [{ type: 'tool_end', toolUseId: 'z-arch', failed: false }]);
});

test('zcode never submits architecture for failures, wrapped errors or omitted input', () => {
  // CLI 0.16.9 把 MCP 业务错误包装成 success:true 文本，必须识别为失败。
  assert.deepEqual(
    zcodeBusinessEvents('z-wrap', 'mcp__agent_os__request_architecture_review', ARCHITECTURE_INPUT, {
      success: true,
      content: 'MCP tool returned an error:\n交接码无效',
    }),
    [{ type: 'tool_end', toolUseId: 'z-wrap', failed: true }],
  );
  assert.deepEqual(
    zcodeBusinessEvents('z-fail', 'mcp__agent_os__request_architecture_review', ARCHITECTURE_INPUT, {
      success: false,
    }),
    [{ type: 'tool_end', toolUseId: 'z-fail', failed: true }],
  );
  // inputOmitted：缺少输入就不猜测参数。
  assert.deepEqual(
    zcodeBusinessEvents('z-omit', 'mcp__agent_os__request_architecture_review', ARCHITECTURE_INPUT, {
      success: true,
    }, true),
    [{ type: 'tool_end', toolUseId: 'z-omit', failed: false }],
  );
});

test('zcode ignores unknown tools and other MCP servers', () => {
  const names = ['mcp__agent_os__no_such_tool', 'mcp__other__request_architecture_review'];
  for (const toolName of names) {
    assert.deepEqual(
      zcodeBusinessEvents(`z-x-` + toolName, toolName, ARCHITECTURE_INPUT, { success: true }),
      [{ type: 'tool_end', toolUseId: `z-x-` + toolName, failed: false }],
      toolName,
    );
  }
});

test('cursor recognizes every registered tool via agent_os mcpToolCall', () => {
  const adapter = new CursorAdapter([...APP_TOOL_NAMES]);
  for (const toolName of APP_TOOL_NAMES) {
    const input = VALID_INPUTS[toolName];
    const events = cursorMcpEvents(adapter, `c-` + toolName, {
      subtype: 'completed',
      toolName,
      args: input,
      result: { success: {} },
    });
    assert.deepEqual(events, [
      { type: 'tool_call', toolUseId: `c-` + toolName, toolName, input },
      { type: 'tool_end', toolUseId: `c-` + toolName, failed: false },
    ], toolName);
  }
});

test('cursor keeps the verified function form for architecture review', () => {
  const adapter = new CursorAdapter([ARCHITECTURE_REVIEW]);
  const events = adapter.parseEvents(JSON.stringify({
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'c-fn-arch',
    tool_call: {
      function: {
        name: ARCHITECTURE_REVIEW,
        arguments: JSON.stringify(ARCHITECTURE_INPUT),
        result: { success: {} },
      },
    },
  }));
  assert.deepEqual(events, [
    {
      type: 'tool_call',
      toolUseId: 'c-fn-arch',
      toolName: ARCHITECTURE_REVIEW,
      input: ARCHITECTURE_INPUT,
    },
    { type: 'tool_end', toolUseId: 'c-fn-arch', failed: false },
  ]);
});

test('cursor ignores failed, foreign and unknown calls and dispatches once', () => {
  const adapter = new CursorAdapter([ARCHITECTURE_REVIEW]);
  const started = cursorMcpEvents(adapter, 'c-st', { subtype: 'started' });
  assert.equal(started[0]?.type, 'tool_start');
  assert.deepEqual(businessCalls(started), []);
  assert.deepEqual(
    cursorMcpEvents(adapter, 'c-fail', { subtype: 'completed', result: { error: '交接码无效' } }),
    [{ type: 'tool_end', toolUseId: 'c-fail', failed: true }],
  );
  assert.deepEqual(
    cursorMcpEvents(adapter, 'c-other', {
      subtype: 'completed',
      providerIdentifier: 'other_server',
      result: { success: {} },
    }),
    [{ type: 'tool_end', toolUseId: 'c-other', failed: false }],
  );
  const unknown = cursorMcpEvents(adapter, 'c-unknown', {
    subtype: 'completed',
    toolName: 'no_such_tool',
    result: { success: {} },
  });
  // completed 事件只给 tool_end；未注册工具不产生业务提交。
  assert.deepEqual(unknown, [{ type: 'tool_end', toolUseId: 'c-unknown', failed: false }]);
  assert.deepEqual(businessCalls(unknown), []);
  // 去重：同一 call_id 的成功事件重放只补 tool_end。
  assert.equal(
    businessCalls(cursorMcpEvents(adapter, 'c-once', {
      subtype: 'completed',
      result: { success: {} },
    })).length,
    1,
  );
  assert.deepEqual(
    cursorMcpEvents(adapter, 'c-once', { subtype: 'completed', result: { success: {} } }),
    [{ type: 'tool_end', toolUseId: 'c-once', failed: false }],
  );
});

test('codex collects every registered tool as a started candidate from agent_os', () => {
  const codex = new CodexAdapter([...APP_TOOL_NAMES]);
  for (const toolName of APP_TOOL_NAMES) {
    const input = VALID_INPUTS[toolName];
    const events = codex.parseEvents(JSON.stringify({
      type: 'item.started',
      item: {
        id: `x-` + toolName,
        type: 'mcp_tool_call',
        server: 'agent_os',
        tool: toolName,
        arguments: input,
      },
    }));
    assert.deepEqual(businessCalls(events), [
      { type: 'tool_call', toolUseId: `x-` + toolName, toolName, input },
    ], toolName);
  }
});

test('codex keeps started candidate timing and failed tool_end deletion contract', () => {
  const codex = new CodexAdapter([ARCHITECTURE_REVIEW]);
  const started = codex.parseEvents(JSON.stringify({
    type: 'item.started',
    item: {
      id: 'x-arch',
      type: 'mcp_tool_call',
      server: 'agent_os',
      tool: ARCHITECTURE_REVIEW,
      arguments: ARCHITECTURE_INPUT,
    },
  }));
  assert.deepEqual(started[0], {
    type: 'tool_start',
    toolUseId: 'x-arch',
    toolName: 'MCP',
    label: '调用外部工具',
    detail: 'agent_os.request_architecture_review',
  });
  assert.deepEqual(businessCalls(started), [
    {
      type: 'tool_call',
      toolUseId: 'x-arch',
      toolName: ARCHITECTURE_REVIEW,
      input: ARCHITECTURE_INPUT,
    },
  ]);
  // 失败的 item.completed 必须给 failed tool_end，由 runner 删除 started 候选。
  assert.deepEqual(codex.parseEvents(JSON.stringify({
    type: 'item.completed',
    item: { id: 'x-arch', type: 'mcp_tool_call', status: 'failed' },
  })), [{ type: 'tool_end', toolUseId: 'x-arch', failed: true }]);
});

test('codex does not treat other servers or unregistered tools as business calls', () => {
  const codex = new CodexAdapter([...APP_TOOL_NAMES]);
  const other = codex.parseEvents(JSON.stringify({
    type: 'item.started',
    item: {
      id: 'x-other',
      type: 'mcp_tool_call',
      server: 'other',
      tool: ARCHITECTURE_REVIEW,
      arguments: ARCHITECTURE_INPUT,
    },
  }));
  assert.equal(other[0]?.type, 'tool_start');
  assert.deepEqual(businessCalls(other), []);
  const unknown = codex.parseEvents(JSON.stringify({
    type: 'item.started',
    item: { id: 'x-unknown', type: 'mcp_tool_call', server: 'agent_os', tool: 'no_such_tool', arguments: {} },
  }));
  assert.equal(unknown[0]?.type, 'tool_start');
  assert.deepEqual(businessCalls(unknown), []);
});

test('claude collects every registered tool from agent_os tool_use blocks', () => {
  const claude = new ClaudeAdapter([...APP_TOOL_NAMES]);
  for (const toolName of APP_TOOL_NAMES) {
    const input = VALID_INPUTS[toolName];
    const events = claudeToolUse(claude, `a-` + toolName, `mcp__agent_os__` + toolName, input);
    assert.deepEqual(businessCalls(events), [
      { type: 'tool_call', toolUseId: `a-` + toolName, toolName, input },
    ], toolName);
  }
});

test('claude keeps started candidate timing and failed tool_end deletion contract', () => {
  const claude = new ClaudeAdapter([ARCHITECTURE_REVIEW]);
  const started = claudeToolUse(
    claude,
    'a-arch',
    `mcp__agent_os__` + ARCHITECTURE_REVIEW,
    ARCHITECTURE_INPUT,
  );
  assert.equal(started[0]?.type, 'tool_start');
  assert.deepEqual(businessCalls(started), [
    {
      type: 'tool_call',
      toolUseId: 'a-arch',
      toolName: ARCHITECTURE_REVIEW,
      input: ARCHITECTURE_INPUT,
    },
  ]);
  assert.deepEqual(claude.parseEvents(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'a-arch', is_error: true }] },
  })), [{ type: 'tool_end', toolUseId: 'a-arch', failed: true }]);
});

test('claude does not treat other servers or unregistered tools as business calls', () => {
  const claude = new ClaudeAdapter([...APP_TOOL_NAMES]);
  const names = ['mcp__other__request_architecture_review', 'mcp__agent_os__no_such_tool'];
  for (const name of names) {
    const events = claudeToolUse(claude, `a-x-` + name, name, ARCHITECTURE_INPUT);
    assert.equal(events[0]?.type, 'tool_start', name);
    assert.deepEqual(businessCalls(events), [], name);
  }
});

test('architecture review stays stage-gated and schema-checked', () => {
  assert.deepEqual(
    appToolsForBot({ id: 'dev', skills: ['lark-doc'], specStages: ['architecture'] }, 'leader'),
    ['request_clarification', ARCHITECTURE_REVIEW],
  );
  assert.deepEqual(
    appToolsForBot({ id: 'dev', skills: ['lark-doc'] }, 'leader'),
    ['request_clarification'],
  );
  // 角色拒绝：没有 architecture 阶段的成员提交合法输入也不得通过。
  assert.throws(
    () => validateAppToolCalls(['request_clarification', 'dispatch_task'], [
      { toolName: ARCHITECTURE_REVIEW, input: ARCHITECTURE_INPUT },
    ]),
    /当前角色不能调用/,
  );
  // schema 拒绝：自报上游、绝对路径与非 32 位小写 hex 交接码都不通过。
  const badInputs = [
    { ...ARCHITECTURE_INPUT, handoffToken: 'A'.repeat(32) },
    { ...ARCHITECTURE_INPUT, handoffToken: '0f1e2d3c4b5a69788796a5b4c3d2e1f' },
    { ...ARCHITECTURE_INPUT, designPath: '/abs/architecture.md' },
    { ...ARCHITECTURE_INPUT, prdToken: 'self-reported-upstream' },
  ];
  for (const input of badInputs) {
    assert.throws(
      () => validateAppToolCalls([ARCHITECTURE_REVIEW], [{ toolName: ARCHITECTURE_REVIEW, input }]),
      /参数无效/,
    );
  }
  validateAppToolCalls(
    [ARCHITECTURE_REVIEW],
    [{ toolName: ARCHITECTURE_REVIEW, input: ARCHITECTURE_INPUT }],
  );
});
