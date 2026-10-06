import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBotPrompt, type BotConfig } from '../src/core/bot-registry.js';
import { TeamRegistry } from '../src/core/team-registry.js';

function makeBot(id: string, overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id,
    appId: `fixture-private-app-id-${id}`,
    appSecret: `fixture-private-app-secret-${id}`,
    defaultCliId: 'codex',
    modelOverrides: {},
    role: id,
    skills: [],
    systemPrompt: `fixture-private-system-prompt-${id}`,
    workspaceDir: `/fixture/private/workspace/${id}`,
    collaborationMaxRounds: 16,
    ...overrides,
  };
}

function makeTeam(...members: BotConfig[]): TeamRegistry {
  return new TeamRegistry('leader', [makeBot('leader', { systemPrompt: '' }), ...members]);
}

function promptFor(team: TeamRegistry): string {
  return buildBotPrompt(team.leader, '现在产品、开发都用什么模型？', team.contextFor('leader'));
}

function memberDefaultEntry(context: string, botId: string): string {
  const lines = context.split('\n');
  const index = lines.findIndex((line) => line.startsWith(`- ${botId}：默认引擎=`));
  assert.notEqual(index, -1, `默认执行配置缺少 ${botId}`);
  assert.match(lines[index + 1], /^  状态：/);
  return lines.slice(index, index + 2).join('\n');
}

test('team defaults reach the final prompt with each member engine, model and effort', () => {
  const team = makeTeam(
    makeBot('product', {
      role: '产品',
      modelOverrides: { codex: { model: 'gpt-6-astra', reasoningEffort: 'medium' } },
    }),
    makeBot('developer', {
      role: '开发',
      defaultCliId: 'zcode',
      modelOverrides: { zcode: { model: 'glm-5.3', reasoningEffort: 'high' } },
    }),
  );

  const prompt = promptFor(team);

  assert.match(prompt, /团队角色默认执行配置.*来自 Agent OS 服务端配置/);
  assert.match(memberDefaultEntry(prompt, 'product'), /默认引擎=codex；model=gpt-6-astra；effort=medium/);
  assert.match(memberDefaultEntry(prompt, 'developer'), /默认引擎=zcode；model=glm-5\.3；effort=high/);
  assert.match(prompt, /现在产品、开发都用什么模型/);
});

test('declared defaults are distinct from topic and actual model values, including blocked ZCode declarations', () => {
  const team = makeTeam(
    makeBot('product', {
      modelOverrides: { codex: { model: 'fixture-codex-model', reasoningEffort: 'medium' } },
    }),
    makeBot('developer', {
      defaultCliId: 'zcode',
      modelOverrides: { zcode: { model: 'fixture-zcode-model', reasoningEffort: 'high' } },
    }),
  );

  const prompt = promptFor(team);
  const product = memberDefaultEntry(prompt, 'product');
  const developer = memberDefaultEntry(prompt, 'developer');

  assert.match(prompt, /角色默认配置.*不代表.*话题/);
  assert.match(prompt, /不证明.*实际使用/);
  assert.match(prompt, /直接依据以上配置回答/);
  assert.match(product, /声明可作为执行参数/);
  assert.match(product, /实际使用值未核验/);
  assert.match(developer, /声明受阻断/);
  assert.match(developer, /无法保证使用指定模型/);
  assert.match(developer, /实际使用值未核验/);
});

test('missing role overrides expose unverified native defaults without inventing model or effort values', () => {
  const team = makeTeam(makeBot('product'));

  const entry = memberDefaultEntry(promptFor(team), 'product');

  assert.match(entry, /默认引擎=codex；model=未声明.*原生默认.*未核验/);
  assert.match(entry, /；effort=未声明/);
  assert.match(entry, /状态：未声明模型与推理强度/);
  assert.doesNotMatch(entry, /model=(?:gpt-|glm-)/);
});

test('an effort-only role override does not imply a configured model', () => {
  const team = makeTeam(makeBot('product', {
    modelOverrides: { codex: { model: null, reasoningEffort: 'high' } },
  }));

  const entry = memberDefaultEntry(promptFor(team), 'product');

  assert.match(entry, /model=未声明.*原生默认.*未核验/);
  assert.match(entry, /；effort=high/);
  assert.match(entry, /声明可作为执行参数/);
  assert.doesNotMatch(entry, /model=(?:gpt-|glm-)/);
});

test('overrides for another engine cannot become the member default model', () => {
  const team = makeTeam(makeBot('product', {
    defaultCliId: 'codex',
    modelOverrides: { claude: { model: 'fixture-other-engine-model', reasoningEffort: 'max' } },
  }));

  const entry = memberDefaultEntry(promptFor(team), 'product');

  assert.match(entry, /默认引擎=codex；model=未声明/);
  assert.match(entry, /；effort=未声明/);
  assert.doesNotMatch(entry, /fixture-other-engine-model|effort=max/);
});

test('unsupported independent effort is reported as blocked using the engine capability policy', () => {
  const team = makeTeam(makeBot('developer', {
    defaultCliId: 'cursor',
    modelOverrides: { cursor: { model: 'fixture-cursor-model', reasoningEffort: 'high' } },
  }));

  const entry = memberDefaultEntry(promptFor(team), 'developer');

  assert.match(entry, /model=fixture-cursor-model；effort=high/);
  assert.match(entry, /声明受阻断/);
  assert.match(entry, /不支持独立设置推理强度/);
  assert.match(entry, /实际使用值未核验/);
});

test('an invalid enumerated effort is blocked instead of described as a usable declaration', () => {
  const team = makeTeam(makeBot('product', {
    defaultCliId: 'claude',
    modelOverrides: { claude: { model: 'fixture-claude-model', reasoningEffort: 'fixture-invalid-effort' } },
  }));

  const entry = memberDefaultEntry(promptFor(team), 'product');

  assert.match(entry, /effort=fixture-invalid-effort/);
  assert.match(entry, /声明受阻断/);
  assert.match(entry, /支持的推理强度.*收到的是 fixture-invalid-effort/);
  assert.doesNotMatch(entry, /声明可作为执行参数/);
});

test('model context excludes bot credentials, private prompts and workspace paths for every member', () => {
  const team = makeTeam(makeBot('product'), makeBot('developer'));
  const privateValues = team.members.flatMap((member) => [
    member.appId,
    member.appSecret,
    member.systemPrompt,
    member.workspaceDir,
  ]).filter((value) => value.length > 0);

  const contexts = team.members.map((member) => team.contextFor(member.id));
  const leaderPrompt = promptFor(team);

  for (const context of [...contexts, leaderPrompt]) {
    for (const value of privateValues) {
      assert.equal(context.includes(value), false, `团队模型上下文泄露夹具私有字段：${value}`);
    }
  }
});
