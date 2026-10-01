import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { APP_TOOL_NAMES, appToolsForBot, parseAppTools, type AppToolName } from '../src/core/app-tool-policy.js';
import { parseAgentOsConfig, buildBotPrompt } from '../src/core/bot-registry.js';
import { TeamRegistry } from '../src/core/team-registry.js';
import { getCliAdapter } from '../src/cli/registry.js';
import { runCli, TOOL_INPUT_KEY_MAX_DEPTH, TOOL_INPUT_KEY_MAX_NODES } from '../src/cli/runner.js';
import { createFixtureIsolationSupplier } from './fixtures/isolation-fixture.js';
import { findClarificationRequest, ClarificationFlowStore } from '../src/core/clarification.js';
import { buildClarificationCard } from '../src/im/card.js';
import type { CliAdapter, CliId, CliRunResult } from '../src/cli/types.js';

const config = parseAgentOsConfig({
  teamLeader: 'coordinator',
  bots: [
    { id: 'coordinator', role: 'CEO 助理', skills: [] },
    { id: 'requirements', role: '产品经理', skills: ['grill-me', 'to-spec'], specStages: ['product'] },
    { id: 'engineer', role: '开发工程师', skills: [], specStages: ['architecture'] },
  ].map((bot) => ({ ...bot, appIdEnv: 'TEST_APP_ID', appSecretEnv: 'TEST_APP_SECRET', defaultCli: 'claude' })),
}, { TEST_APP_ID: 'placeholder', TEST_APP_SECRET: 'placeholder' });
const team = new TeamRegistry(config.teamLeaderId, config.bots);
const clarification = {
  title: '修复策略',
  questions: [{
    id: 'scope', prompt: '修复范围？',
    options: [{ id: 'all', label: '全部修复' }, { id: 'first', label: '先处理第一项' }],
  }],
};

test('role policy uses the configured leader; every executing member may ask the user with a card', () => {
  assert.deepEqual(team.appToolsFor('coordinator'), ['dispatch_task']);
  assert.deepEqual(team.appToolsFor('requirements'), ['request_clarification', 'request_spec_approval']);
  assert.deepEqual(team.appToolsFor('engineer'), ['request_clarification', 'request_architecture_review']);
  assert.deepEqual(appToolsForBot({ id: 'coordinator', skills: ['grill-me', 'lark-doc'] }, 'coordinator'), ['dispatch_task']);
  assert.throws(() => team.appToolsFor('missing'), /不存在/);
  assert.deepEqual(parseAppTools(''), []);
  assert.throws(() => parseAppTools('unknown'), /未知/);
});

test('artifact submission tools are granted by server-side stage, never by skills (T-020)', () => {
  // 开发 bot 即使有 lark-doc/to-spec Skill（文档编辑能力），没有 product 阶段
  // 就不能提交产品方案；架构阶段同理按 specStages 授予。
  assert.deepEqual(
    appToolsForBot({ id: 'dev', skills: ['lark-doc', 'to-spec'], specStages: ['architecture'] }, 'leader'),
    ['request_clarification', 'request_architecture_review'],
  );
  assert.deepEqual(
    appToolsForBot({ id: 'dev', skills: ['lark-doc'] }, 'leader'),
    ['request_clarification'],
  );
  assert.deepEqual(
    appToolsForBot({ id: 'prod', skills: [], specStages: ['product'] }, 'leader'),
    ['request_clarification', 'request_spec_approval'],
  );
  assert.deepEqual(
    appToolsForBot({ id: 'both', skills: ['lark-doc'], specStages: ['product', 'architecture'] }, 'leader'),
    ['request_clarification', 'request_spec_approval', 'request_architecture_review'],
  );
  assert.deepEqual(appToolsForBot({ id: 'plain', skills: ['lark-doc'] }, 'leader'), ['request_clarification']);
});

test('leader prompt delegates ambiguity and does not repeat confirmed repair scope', () => {
  const prompt = buildBotPrompt(team.leader, '全部修复', team.contextFor(team.leaderBotId));
  assert.match(prompt, /已有明确问题清单或用户已要求全部修复时，直接派给开发/);
  assert.match(prompt, /由产品向用户提问/);
  assert.match(prompt, /不要自行调用 request_clarification/);
  assert.doesNotMatch(prompt, /需要用户决策时，必须调用 request_clarification/);
});

function serverParameters(args: string[], cli: CliId) {
  if (cli === 'claude') {
    return JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.agent_os;
  }
  const command = args.find((arg) => arg.startsWith('mcp_servers.agent_os.command='))!;
  const serverArgs = args.find((arg) => arg.startsWith('mcp_servers.agent_os.args='))!;
  return {
    command: JSON.parse(command.slice(command.indexOf('=') + 1)),
    args: JSON.parse(serverArgs.slice(serverArgs.indexOf('=') + 1)),
  };
}

for (const cli of ['claude', 'codex'] as const) {
  for (const bot of config.bots) {
    test(`${cli} new and resumed ${bot.id} sessions expose only their role's MCP tools`, async () => {
      const allowed = team.appToolsFor(bot.id);
      const adapter = getCliAdapter(cli, allowed);
      const fresh = serverParameters(adapter.buildArgs('test', 'argument'), cli);
      const resumed = serverParameters(adapter.buildResumeArgs('test', 'old-session', 'argument'), cli);
      assert.deepEqual(resumed, fresh);
      // Start the actual configured server, without invoking an AI CLI or Feishu.
      // 传入完整环境（含 TMPDIR）：MCP SDK 默认最小 env 不含 TMPDIR，tsx 子进程
      // 会把 IPC 管道建到 /tmp（本会话宿主沙箱拒绝 /tmp named pipe）。
      const transport = new StdioClientTransport({ ...fresh, env: { ...process.env } });
      const client = new Client({ name: 'role-policy-test', version: '1.0.0' });
      try {
        await client.connect(transport);
        const names = client.getServerCapabilities()?.tools
          ? (await client.listTools()).tools.map((tool) => tool.name)
          : [];
        assert.deepEqual(names.sort(), [...allowed].sort());
        if (bot.id === team.leaderBotId) {
          const rejected = await client.callTool({ name: 'request_clarification', arguments: clarification });
          assert.equal(rejected.isError, true);
          const accepted = await client.callTool({ name: 'dispatch_task', arguments: {
            targetBotId: 'engineer', objective: '修复已确认的问题', instruction: '修复所有问题并验证',
          } });
          assert.notEqual(accepted.isError, true);
        }
        if (allowed.includes('request_clarification')) {
          const accepted = await client.callTool({ name: 'request_clarification', arguments: clarification });
          assert.notEqual(accepted.isError, true);
          const request = findClarificationRequest([{ toolName: 'request_clarification', input: clarification }])!;
          const flow = new ClarificationFlowStore().create({
            taskId: 'task', botId: bot.id, sessionId: 'session', ownerOpenId: 'owner',
            originalMessageId: 'message', replyInThread: true, request,
          });
          const card = JSON.stringify(buildClarificationCard({ flow }));
          assert.match(card, /answer_clarification/);
          assert.match(card, /全部修复/);
          assert.match(card, /先处理第一项/);
        }
      } finally {
        await client.close();
        await transport.close();
      }
    });
  }
}

/**
 * 212 回放底座：受控 Node 脚本逐行输出事件，runner 消费真实 adapter 的
 * parseEvents——不启动真实 AI CLI，也没有任何消息副作用。
 */
async function replayRunnerEvents(
  parser: CliAdapter,
  allowed: readonly AppToolName[],
  events: readonly unknown[],
): Promise<CliRunResult> {
  const directory = mkdtempSync(join(tmpdir(), 'agent-os-role-replay-'));
  const fixture = createFixtureIsolationSupplier();
  try {
    const script = join(directory, 'replay.mjs');
    writeFileSync(script, 'process.stdout.write(' + JSON.stringify(events.map((event) => JSON.stringify(event)).join('\n') + '\n') + ');');
    const adapter: CliAdapter = {
      id: parser.id, command: process.execPath, displayName: 'replay', appTools: allowed,
      buildArgs: () => [script], buildResumeArgs: () => [script],
      parseEvents: (line) => parser.parseEvents(line),
    };
    return await runCli({ adapter, cwd: directory, prompt: 'test', isolation: fixture.supplier });
  } finally {
    fixture.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function replayClaude(allowed: AppToolName[], toolName: string, input: unknown, failed = false) {
  return replayRunnerEvents(getCliAdapter('claude', allowed), allowed, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call', name: 'mcp__agent_os__' + toolName, input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call', is_error: failed }] } },
    { type: 'result', result: '已发送卡片', session_id: 'session' },
  ]);
}

test('old leader clarification calls fail instead of producing a false success', async () => {
  await assert.rejects(replayClaude(['dispatch_task'], 'request_clarification', clarification), /当前角色不能调用/);
  await assert.rejects(replayClaude(['dispatch_task'], 'request_clarification', clarification, true), /当前角色不能调用/);
});

test('valid product clarification survives parsing; malformed accepted input fails explicitly', async () => {
  const result = await replayClaude(['request_clarification'], 'request_clarification', clarification);
  assert.equal(findClarificationRequest(result.toolCalls)?.questions.length, 1);
  await assert.rejects(replayClaude(['request_clarification'], 'request_clarification', { questions: [] }), /参数无效/);
});

// ── 212：业务工具必须明确完成成功，不能收下 started 候选 ──

const REPLAY_INPUTS: Record<AppToolName, Record<string, unknown>> = {
  request_clarification: clarification,
  request_spec_approval: {
    deliveryMode: 'local',
    title: '订单模块产品方案',
    summary: '订单创建、支付回调与对账口径',
    specPath: 'docs/spec.md',
    ticketsPath: 'docs/tickets.md',
  },
  request_architecture_review: {
    deliveryMode: 'local',
    title: '订单域架构设计',
    summary: '订单域与支付域分离，网关只保留编排',
    designPath: 'docs/architecture.md',
    handoffToken: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  },
  dispatch_task: {
    targetBotId: 'engineer',
    objective: '实现订单模块',
    instruction: '按产品方案实现订单域并自测',
  },
};

function codexMcpStarted(toolUseId: string, toolName: AppToolName, input: unknown) {
  return {
    type: 'item.started',
    item: {
      id: toolUseId,
      type: 'mcp_tool_call',
      server: 'agent_os',
      tool: toolName,
      arguments: input,
      status: 'in_progress',
    },
  };
}

function codexMcpCompleted(toolUseId: string, toolName: AppToolName) {
  return {
    type: 'item.completed',
    item: {
      id: toolUseId,
      type: 'mcp_tool_call',
      server: 'agent_os',
      tool: toolName,
      status: 'completed',
      // 官方 0.150.1 成功形态：result 携带 content/meta/structured_content。
      result: {
        content: [{ type: 'text', text: 'ok' }],
        meta: { duration_ms: 3 },
        structured_content: { ok: true },
      },
    },
  };
}

const codexFinalAnswer = [
  { type: 'item.completed', item: { id: 'm-final', type: 'agent_message', text: '已提交全部请求' } },
  { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
];

function claudeToolUseLine(toolUseId: string, toolName: AppToolName, input: unknown) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: toolUseId, name: 'mcp__agent_os__' + toolName, input }] },
  };
}

function claudeToolResultLine(toolUseId: string, isError?: boolean) {
  // is_error 可缺省：官方成功语义不要求该字段必须存在。
  const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: toolUseId };
  if (isError !== undefined) block.is_error = isError;
  return { type: 'user', message: { content: [block] } };
}

const claudeFinalAnswer = { type: 'result', result: '已提交全部请求', session_id: 'session' };

test('212: started candidates without an explicit successful end are rejected as unfinished business tools', async () => {
  const allowed = [...APP_TOOL_NAMES];
  // Codex：只发 item.started（业务工具候选）+ 最终回答 + 正常退出。
  await assert.rejects(
    replayRunnerEvents(getCliAdapter('codex', allowed), allowed, [
      { type: 'thread.started', thread_id: 't-212' },
      codexMcpStarted('x-missing', 'request_clarification', clarification),
      ...codexFinalAnswer,
    ]),
    /业务工具未完成：.*缺成功结果/,
  );
  // Claude：tool_use 之后没有对应 tool_result，同样拒绝。
  await assert.rejects(
    replayRunnerEvents(getCliAdapter('claude', allowed), allowed, [
      claudeToolUseLine('a-missing', 'request_clarification', clarification),
      claudeFinalAnswer,
    ]),
    /业务工具未完成：.*缺成功结果/,
  );
});

test('212: explicit success ends keep all four business tools for codex and claude replays', async () => {
  const allowed = [...APP_TOOL_NAMES];
  const codex = await replayRunnerEvents(getCliAdapter('codex', allowed), allowed, [
    { type: 'thread.started', thread_id: 't-212' },
    ...APP_TOOL_NAMES.flatMap((toolName, index) => [
      codexMcpStarted('x-' + index, toolName, REPLAY_INPUTS[toolName]),
      codexMcpCompleted('x-' + index, toolName),
    ]),
    ...codexFinalAnswer,
  ]);
  assert.deepEqual(codex.toolCalls, APP_TOOL_NAMES.map((toolName, index) => ({
    toolUseId: 'x-' + index,
    toolName,
    input: REPLAY_INPUTS[toolName],
  })));
  const claude = await replayRunnerEvents(getCliAdapter('claude', allowed), allowed, [
    ...APP_TOOL_NAMES.flatMap((toolName, index) => [
      claudeToolUseLine('a-' + index, toolName, REPLAY_INPUTS[toolName]),
      claudeToolResultLine('a-' + index),
    ]),
    claudeFinalAnswer,
  ]);
  assert.deepEqual(claude.toolCalls, APP_TOOL_NAMES.map((toolName, index) => ({
    toolUseId: 'a-' + index,
    toolName,
    input: REPLAY_INPUTS[toolName],
  })));
});

test('212: zcode and cursor success orderings survive the explicit-end gate', async () => {
  const allowed = [...APP_TOOL_NAMES];
  const zcode = await replayRunnerEvents(getCliAdapter('zcode', allowed), allowed, [
    { type: 'session.created', sessionId: 'z-session' },
    ...APP_TOOL_NAMES.flatMap((toolName, index) => [
      { type: 'tool.updated', payload: { kind: 'scheduled', toolCallId: 'z-' + index, toolName: 'mcp__agent_os__' + toolName, input: REPLAY_INPUTS[toolName] } },
      { type: 'tool.updated', payload: { kind: 'started', toolCallId: 'z-' + index } },
      { type: 'tool.updated', payload: { kind: 'result', toolCallId: 'z-' + index, result: { success: true } } },
    ]),
    { type: 'result', response: '已提交全部请求', sessionId: 'z-session' },
  ]);
  assert.deepEqual(zcode.toolCalls, APP_TOOL_NAMES.map((toolName, index) => ({
    toolUseId: 'z-' + index,
    toolName,
    input: REPLAY_INPUTS[toolName],
  })));
  const cursor = await replayRunnerEvents(getCliAdapter('cursor', allowed), allowed, [
    ...APP_TOOL_NAMES.flatMap((toolName, index) => [
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'c-' + index,
        tool_call: { mcpToolCall: { args: { providerIdentifier: 'agent_os', toolName, args: REPLAY_INPUTS[toolName] } } },
      },
      {
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'c-' + index,
        tool_call: {
          mcpToolCall: {
            args: { providerIdentifier: 'agent_os', toolName, args: REPLAY_INPUTS[toolName] },
            result: { success: {} },
          },
        },
      },
    ]),
    { type: 'result', subtype: 'success', is_error: false, result: '已提交全部请求' },
  ]);
  assert.deepEqual(cursor.toolCalls, APP_TOOL_NAMES.map((toolName, index) => ({
    toolUseId: 'c-' + index,
    toolName,
    input: REPLAY_INPUTS[toolName],
  })));
});

test('212: failed tool ends delete candidates instead of confirming them', async () => {
  const allowed = [...APP_TOOL_NAMES];
  const claude = await replayRunnerEvents(getCliAdapter('claude', allowed), allowed, [
    claudeToolUseLine('a-fail', 'request_clarification', clarification),
    claudeToolResultLine('a-fail', true),
    claudeFinalAnswer,
  ]);
  assert.equal(claude.toolCalls, undefined);
  const codex = await replayRunnerEvents(getCliAdapter('codex', allowed), allowed, [
    codexMcpStarted('x-fail', 'request_clarification', clarification),
    {
      type: 'item.completed',
      item: { id: 'x-fail', type: 'mcp_tool_call', server: 'agent_os', tool: 'request_clarification', status: 'failed' },
    },
    ...codexFinalAnswer,
  ]);
  assert.equal(codex.toolCalls, undefined);
});

test('212: codex item.completed must carry the official success shape (status/result/error)', async () => {
  const allowed = [...APP_TOOL_NAMES];
  const notSuccessEnds = [
    // status 缺失：「不是 failed」不能当成功。
    { item: { id: 'x-shape', type: 'mcp_tool_call', server: 'agent_os', tool: 'request_clarification' } },
    // status 为中间态/未知值。
    { item: { id: 'x-shape', type: 'mcp_tool_call', server: 'agent_os', tool: 'request_clarification', status: 'in_progress' } },
    // result 缺失或为 null。
    { item: { id: 'x-shape', type: 'mcp_tool_call', server: 'agent_os', tool: 'request_clarification', status: 'completed' } },
    { item: { id: 'x-shape', type: 'mcp_tool_call', server: 'agent_os', tool: 'request_clarification', status: 'completed', result: null } },
    // error 存在一律失败。
    { item: { id: 'x-shape', type: 'mcp_tool_call', server: 'agent_os', tool: 'request_clarification', status: 'completed', error: 'agent_os 调用失败' } },
  ];
  for (const end of notSuccessEnds) {
    const result = await replayRunnerEvents(getCliAdapter('codex', allowed), allowed, [
      codexMcpStarted('x-shape', 'request_clarification', clarification),
      { type: 'item.completed', ...end },
      ...codexFinalAnswer,
    ]);
    assert.equal(result.toolCalls, undefined, JSON.stringify(end));
  }
});

test('212: unmatched tool ends never create or pre-sign business calls', async () => {
  const allowed = [...APP_TOOL_NAMES];
  // 无候选的 native tool_end（Bash 命令成功）不生成业务调用。
  const native = await replayRunnerEvents(getCliAdapter('codex', allowed), allowed, [
    { type: 'item.started', item: { id: 'n-1', type: 'command_execution', command: 'pnpm test', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'n-1', type: 'command_execution', command: 'pnpm test', status: 'completed', exit_code: 0 } },
    ...codexFinalAnswer,
  ]);
  assert.equal(native.toolCalls, undefined);
  // 早到的成功结束不能替后续 started 预先签成功：候选仍未完成。
  await assert.rejects(
    replayRunnerEvents(getCliAdapter('codex', allowed), allowed, [
      codexMcpCompleted('x-early', 'request_clarification'),
      codexMcpStarted('x-early', 'request_clarification', clarification),
      ...codexFinalAnswer,
    ]),
    /业务工具未完成：.*缺成功结果/,
  );
});

test('212: duplicate started/completion collapse to one call; a late failure cannot resurrect it', async () => {
  const allowed = [...APP_TOOL_NAMES];
  const parser = getCliAdapter('codex', allowed);
  const once = await replayRunnerEvents(parser, allowed, [
    codexMcpStarted('x-once', 'request_clarification', clarification),
    codexMcpStarted('x-once', 'request_clarification', clarification),
    codexMcpCompleted('x-once', 'request_clarification'),
    codexMcpCompleted('x-once', 'request_clarification'),
    ...codexFinalAnswer,
  ]);
  assert.deepEqual(once.toolCalls, [
    { toolUseId: 'x-once', toolName: 'request_clarification', input: clarification },
  ]);
  // 216：成功确认后迟到的失败结束优先——已确认调用同样被删除。
  const late = await replayRunnerEvents(parser, allowed, [
    codexMcpStarted('x-late', 'request_clarification', clarification),
    codexMcpCompleted('x-late', 'request_clarification'),
    {
      type: 'item.completed',
      item: { id: 'x-late', type: 'mcp_tool_call', server: 'agent_os', tool: 'request_clarification', status: 'failed' },
    },
    ...codexFinalAnswer,
  ]);
  assert.equal(late.toolCalls, undefined);
  // 失败结束先到：候选已删，随后的成功结束没有候选可确认。
  const flipped = await replayRunnerEvents(parser, allowed, [
    codexMcpStarted('x-flip', 'request_clarification', clarification),
    {
      type: 'item.completed',
      item: { id: 'x-flip', type: 'mcp_tool_call', server: 'agent_os', tool: 'request_clarification', status: 'failed' },
    },
    codexMcpCompleted('x-flip', 'request_clarification'),
    ...codexFinalAnswer,
  ]);
  assert.equal(flipped.toolCalls, undefined);
});

test('212: same toolUseId restarted with a different tool or input is a fixed protocol error', async () => {
  const allowed = [...APP_TOOL_NAMES];
  const parser = getCliAdapter('codex', allowed);
  await assert.rejects(
    replayRunnerEvents(parser, allowed, [
      codexMcpStarted('x-dup', 'request_clarification', clarification),
      codexMcpStarted('x-dup', 'request_clarification', { ...clarification, title: '另一个标题' }),
      codexMcpCompleted('x-dup', 'request_clarification'),
      ...codexFinalAnswer,
    ]),
    /协议错误：同一 toolUseId 重复 started 且工具名或参数不一致/,
  );
  await assert.rejects(
    replayRunnerEvents(parser, allowed, [
      codexMcpStarted('x-swap', 'request_clarification', clarification),
      codexMcpStarted('x-swap', 'request_spec_approval', clarification),
      ...codexFinalAnswer,
    ]),
    /协议错误：同一 toolUseId 重复 started 且工具名或参数不一致/,
  );
});

test('216: a failed toolUseId tombstone can never be re-confirmed by a later started/success', async () => {
  const allowed = [...APP_TOOL_NAMES];
  const parser = getCliAdapter('codex', allowed);
  const failedEnd = {
    type: 'item.completed',
    item: { id: 'x-tomb', type: 'mcp_tool_call', server: 'agent_os', tool: 'request_clarification', status: 'failed' },
  };
  // 失败后同 id 重启 started→success：失败墓碑永久生效，不得返回业务调用。
  await assert.rejects(
    replayRunnerEvents(parser, allowed, [
      codexMcpStarted('x-tomb', 'request_clarification', clarification),
      failedEnd,
      codexMcpStarted('x-tomb', 'request_clarification', clarification),
      codexMcpCompleted('x-tomb', 'request_clarification'),
      ...codexFinalAnswer,
    ]),
    /协议错误：toolUseId 已失败终止/,
  );
  // 失败后的成功结束（无重启）同样没有可确认候选，且不能产生业务调用。
  const afterFail = await replayRunnerEvents(parser, allowed, [
    codexMcpStarted('x-tomb', 'request_clarification', clarification),
    failedEnd,
    codexMcpCompleted('x-tomb', 'request_clarification'),
    ...codexFinalAnswer,
  ]);
  assert.equal(afterFail.toolCalls, undefined);
  // 失败不能抹掉此前权限违规：角色越权 + 失败结束仍失败关闭。
  await assert.rejects(
    replayRunnerEvents(parser, ['request_clarification'], [
      codexMcpStarted('x-role2', 'dispatch_task', REPLAY_INPUTS.dispatch_task),
      {
        type: 'item.completed',
        item: { id: 'x-role2', type: 'mcp_tool_call', server: 'agent_os', tool: 'dispatch_task', status: 'failed' },
      },
      ...codexFinalAnswer,
    ]),
    /当前角色不能调用/,
  );
});

test('216: colliding-but-distinct legal inputs are not treated as the same duplicate started', async () => {
  const allowed = [...APP_TOOL_NAMES];
  const parser = getCliAdapter('codex', allowed);
  // 两份完整合法输入：title/questions 相同，但 options 第二项被整体编码进
  // 第一项 label 的普通字符串里（colliding 只有 2 项，没有另一个 b 项）。
  // 旧 tag+String 裸拼接会把它当成 base 的 3 项渲染而碰撞；无歧义序列化
  // 下两者不同，应判「参数不一致」。
  const base = {
    title: 'fixture',
    questions: [{
      id: 'scope',
      prompt: 'choose?',
      options: [
        { id: 'a', label: 'foo' },
        { id: 'b', label: 'bar' },
        { id: 'c', label: 'third' },
      ],
    }],
  };
  const colliding = {
    title: 'fixture',
    questions: [{
      id: 'scope',
      prompt: 'choose?',
      options: [
        { id: 'a', label: 'foo},object {"id":string b,"label":string bar' },
        { id: 'c', label: 'third' },
      ],
    }],
  };
  await assert.rejects(
    replayRunnerEvents(parser, allowed, [
      codexMcpStarted('x-collide', 'request_clarification', base),
      codexMcpStarted('x-collide', 'request_clarification', colliding),
      codexMcpCompleted('x-collide', 'request_clarification'),
      ...codexFinalAnswer,
    ]),
    /协议错误：同一 toolUseId 重复 started 且工具名或参数不一致/,
  );
});

test('218: encoder budget limits fail closed with fixed errors, not downstream schema failures', async () => {
  const allowed = [...APP_TOOL_NAMES];
  const parser = getCliAdapter('codex', allowed);
  // 深度 >32：叶子为空 object 也不允许绕过（object/array 同样按节点计深度）。
  let deep: unknown = {};
  for (let index = 0; index < TOOL_INPUT_KEY_MAX_DEPTH + 1; index += 1) deep = { nested: deep };
  await assert.rejects(
    replayRunnerEvents(parser, allowed, [
      codexMcpStarted('x-depth', 'request_clarification', deep),
      ...codexFinalAnswer,
    ]),
    /业务工具参数比较键超限（深度），失败关闭/,
  );
  // 节点数 >10000：全为空 object 的节点也计数（数组元素各算一个节点）。
  const wide = Array.from({ length: TOOL_INPUT_KEY_MAX_NODES + 1 }, () => ({}));
  await assert.rejects(
    replayRunnerEvents(parser, allowed, [
      codexMcpStarted('x-nodes', 'request_clarification', wide),
      ...codexFinalAnswer,
    ]),
    /业务工具参数比较键超限（节点数），失败关闭/,
  );
  // UTF-8 字节预算：90000 个中文字符 UTF-16 长度不超限，但 UTF-8 编码
  // 270000 字节超过 262144——必须按字节而非 .length 拒绝。
  const cjk = '长'.repeat(90000);
  await assert.rejects(
    replayRunnerEvents(parser, allowed, [
      codexMcpStarted('x-bytes', 'request_clarification', { ...clarification, title: cjk }),
      ...codexFinalAnswer,
    ]),
    /业务工具参数比较键超限（字节），失败关闭/,
  );
});

test('218: duplicate started with reordered object keys is the same input and confirmed once', async () => {
  const allowed = [...APP_TOOL_NAMES];
  const parser = getCliAdapter('codex', allowed);
  const ordered = { ...REPLAY_INPUTS.dispatch_task };
  const reordered = { objective: ordered.objective, instruction: ordered.instruction, targetBotId: ordered.targetBotId };
  const once = await replayRunnerEvents(parser, allowed, [
    codexMcpStarted('x-order', 'dispatch_task', ordered),
    codexMcpStarted('x-order', 'dispatch_task', reordered),
    codexMcpCompleted('x-order', 'dispatch_task'),
    ...codexFinalAnswer,
  ]);
  assert.deepEqual(once.toolCalls, [
    { toolUseId: 'x-order', toolName: 'dispatch_task', input: ordered },
  ]);
});

test('212: role violations stay fatal even when the started call never completes', async () => {
  const allowed: AppToolName[] = ['request_clarification'];
  await assert.rejects(
    replayRunnerEvents(getCliAdapter('codex', allowed), allowed, [
      codexMcpStarted('x-role', 'dispatch_task', REPLAY_INPUTS.dispatch_task),
      ...codexFinalAnswer,
    ]),
    /当前角色不能调用/,
  );
});
