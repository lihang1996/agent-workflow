import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appToolsForBot, parseAppTools, type AppToolName } from '../src/core/app-tool-policy.js';
import { parseAgentOsConfig, buildBotPrompt } from '../src/core/bot-registry.js';
import { TeamRegistry } from '../src/core/team-registry.js';
import { getCliAdapter } from '../src/cli/registry.js';
import { runCli } from '../src/cli/runner.js';
import { createFixtureIsolationSupplier } from './fixtures/isolation-fixture.js';
import { findClarificationRequest, ClarificationFlowStore } from '../src/core/clarification.js';
import { buildClarificationCard } from '../src/im/card.js';
import type { CliAdapter, CliId } from '../src/cli/types.js';

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

async function replayClaude(allowed: AppToolName[], toolName: string, input: unknown, failed = false) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-os-role-replay-'));
  const fixture = createFixtureIsolationSupplier();
  try {
    const script = join(directory, 'replay.mjs');
    const events = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call', name: `mcp__agent_os__${toolName}`, input }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call', is_error: failed }] } },
      { type: 'result', result: '已发送卡片', session_id: 'session' },
    ];
    writeFileSync(script, `process.stdout.write(${JSON.stringify(events.map((event) => JSON.stringify(event)).join('\n') + '\n')});`);
    const parser = getCliAdapter('claude', allowed);
    const adapter: CliAdapter = {
      id: 'claude', command: process.execPath, displayName: 'replay', appTools: allowed,
      buildArgs: () => [script], buildResumeArgs: () => [script],
      buildCompactPlan: (id) => {
        if (!parser.buildCompactPlan) {
          throw new Error('测试所用 Adapter 必须支持 compact');
        }
        return parser.buildCompactPlan(id);
      },
      parseEvents: (line) => parser.parseEvents(line),
    };
    return await runCli({ adapter, cwd: directory, prompt: 'test', isolation: fixture.supplier });
  } finally {
    fixture.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
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
