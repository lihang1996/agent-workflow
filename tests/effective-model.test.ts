import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeEffectiveModelSelection,
  describeEffectiveModel,
  planExecutionModel,
} from '../src/app/execution-model.js';
import type { BotConfig } from '../src/core/bot-registry.js';
import type { ModelOverrides } from '../src/core/model-selection.js';

/**
 * A05（166 号返工）：视图与执行计划**共用同一计算**（computeEffectiveModel
 * Selection）；证据标签纪律——引擎实际值拿不到就标「未核验」，会话绑定只是
 * 上次执行的计划选择。
 */

function botWith(overrides: ModelOverrides, defaultCliId: BotConfig['defaultCliId'] = 'codex'): BotConfig {
  return {
    id: 'dev-bot',
    appId: 'app',
    appSecret: 'secret',
    defaultCliId,
    modelOverrides: overrides,
    role: 'dev',
    skills: [],
    systemPrompt: '',
    workspaceDir: '/tmp/ws',
    collaborationMaxRounds: 16,
  };
}

const cursorProbe = async () => ({
  ok: true,
  stdout: 'agent 2026.08.11\n--model <model>',
  stderr: '',
});

test('describeEffectiveModel shows a declared role override (A05)', () => {
  const output = describeEffectiveModel(botWith({
    codex: { model: 'gpt-6-sol', reasoningEffort: 'xhigh' },
  }));
  assert.match(output, /生效模型（codex）：/);
  assert.match(output, /角色声明：model=gpt-6-sol，effort=xhigh/);
  assert.match(output, /个人默认：未读取，实际值未知（当前显式选择来自角色声明）/);
  assert.match(output, /最终参数：codex gpt-6-sol \/ effort xhigh（来源：角色声明）/);
  assert.ok(!output.includes('话题级声明'), '未提供话题层时不显示该层');
});

test('describeEffectiveModel falls through to native default without a role override (A05)', () => {
  const output = describeEffectiveModel(botWith({}));
  assert.match(output, /角色声明：无/);
  assert.match(output, /个人默认：引擎 CLI 原生默认/);
  assert.match(output, /实际值未核验/);
  assert.match(output, /最终参数：codex 引擎原生默认 \/ effort 未声明（来源：引擎原生默认；实际值未核验）/);
});

test('describeEffectiveModel marks unsupported declarations honestly for zcode (A05)', () => {
  const output = describeEffectiveModel(botWith({
    zcode: { model: 'gpt-6', reasoningEffort: null },
  }), { cliId: 'zcode' });
  assert.match(output, /生效模型（zcode）：/);
  assert.match(output, /角色声明：model=gpt-6，effort=未声明/);
  assert.match(output, /个人默认：引擎 provider 配置的默认模型/);
  assert.match(output, /最终参数：引擎原生默认（zcode 不支持按执行声明模型，角色声明 model=gpt-6 无法生效/);
  assert.match(output, /将被显式拒绝/);
});

test('describeEffectiveModel shows the topic layer and bound selection when provided (A05)', () => {
  const output = describeEffectiveModel(botWith({
    codex: { model: 'gpt-6-sol', reasoningEffort: 'xhigh' },
  }), {
    topicOverride: { model: 'gpt-5-mini', reasoningEffort: null },
    boundSelection: { model: 'gpt-6-sol', reasoningEffort: 'xhigh' },
  });
  assert.match(output, /话题级声明：model=gpt-5-mini，effort=未声明/);
  assert.match(output, /最终参数：codex gpt-5-mini \/ effort 未声明（来源：话题声明）/);
  assert.match(output, /当前会话绑定：model=gpt-6-sol，effort=xhigh/);
});

// ---- A05（166 号返工）：视图 = 执行计划共用计算 + 证据标签 --------------------------

test('cursor env fallback (CURSOR_CLI_MODEL) appears in both the plan and the view (A05 166 号返工)', async () => {
  const env = { CURSOR_CLI_MODEL: 'gpt-5-codex' };
  const bot = botWith({}, 'cursor');
  const plan = await planExecutionModel(bot.modelOverrides, { cliId: 'cursor' }, {
    env, command: 'agent', probe: cursorProbe,
  });
  assert.equal(plan.modelSelection?.model, 'gpt-5-codex', '执行计划应用环境回退');

  const view = describeEffectiveModel(bot, { cliId: 'cursor', env });
  assert.match(view, /环境回退：CURSOR_CLI_MODEL=gpt-5-codex/);
  assert.match(view, /最终参数：cursor gpt-5-codex \/ effort 未声明（来源：环境变量 CURSOR_CLI_MODEL）/,
    '视图最终参数必须与执行计划一致');
  assert.ok(!/最终参数：cursor 引擎原生默认/.test(view), '不得仍显示引擎原生默认');
});

test('cursor role declaration wins over env fallback in both plan and view (A05 166 号返工)', async () => {
  const env = { CURSOR_CLI_MODEL: 'gpt-5-codex' };
  const bot = botWith({ cursor: { model: 'claude-4.5', reasoningEffort: null } }, 'cursor');
  const plan = await planExecutionModel(bot.modelOverrides, { cliId: 'cursor' }, {
    env, command: 'agent', probe: cursorProbe,
  });
  assert.equal(plan.modelSelection?.model, 'claude-4.5', '角色声明优先于环境回退');
  const view = describeEffectiveModel(bot, { cliId: 'cursor', env });
  assert.match(view, /最终参数：cursor claude-4.5 \/ effort 未声明（来源：角色声明）/);
  assert.ok(!view.includes('环境回退：CURSOR_CLI_MODEL'), '角色声明生效时环境回退不出现');
});

test('partial role declaration (model only) is displayed and planned as-is (A05 166 号返工)', async () => {
  const bot = botWith({ codex: { model: 'gpt-6-sol', reasoningEffort: null } });
  const plan = await planExecutionModel(bot.modelOverrides, { cliId: 'codex' }, {
    command: 'codex',
    probe: async () => ({ ok: true, stdout: 'codex-cli 0.150.1\n-m, --model <MODEL>\n-c model_reasoning_effort', stderr: '' }),
  });
  assert.deepEqual(plan.modelSelection, { model: 'gpt-6-sol', reasoningEffort: null });
  const view = describeEffectiveModel(bot, { env: {} });
  assert.match(view, /角色声明：model=gpt-6-sol，effort=未声明/);
  assert.match(view, /最终参数：codex gpt-6-sol \/ effort 未声明（来源：角色声明）/);
});

test('bound selection is labeled as plan choice with engine value unverified (A05 166 号返工)', () => {
  const view = describeEffectiveModel(botWith({}), {
    boundSelection: { model: 'gpt-6-sol', reasoningEffort: 'xhigh' },
  });
  assert.match(view, /当前会话绑定：model=gpt-6-sol，effort=xhigh（上次执行计划选择；引擎实际使用值未核验）/,
    '计划选择不得标为「实际使用」');
  assert.ok(!/实际使用/.test(view.replace(/实际使用值未核验/g, '')), '不得出现「实际使用」的越权标签');

  // null 绑定 = 原生默认，具体值同样未核验。
  const viewNative = describeEffectiveModel(botWith({}), {
    boundSelection: { model: null, reasoningEffort: null },
  });
  assert.match(viewNative, /当前会话绑定：无（原生默认，具体值未核验）/);
});

test('native default is always labeled 未核验 across engines (A05 166 号返工)', () => {
  const codex = describeEffectiveModel(botWith({}), { env: {} });
  assert.match(codex, /实际值未核验/);
  const zcode = describeEffectiveModel(botWith({}), { cliId: 'zcode', env: {} });
  assert.match(zcode, /个人默认：引擎 provider 配置的默认模型（官方 headless 无按执行声明模型的参数；实际值未核验）/);
  assert.match(zcode, /最终参数：zcode 引擎原生默认 \/ effort 未声明（来源：引擎原生默认；实际值未核验）/,);
});

test('computeEffectiveModelSelection is the single shared computation (A05 166 号返工)', async () => {
  // 同一输入下：计划使用的 effective 与视图使用的 effective 完全一致。
  const env = { CURSOR_CLI_MODEL: 'gpt-5-codex' };
  const computation = computeEffectiveModelSelection({ modelOverrides: {}, cliId: 'cursor', env });
  assert.equal(computation.effectiveSource, 'cursor-env');
  assert.equal(computation.effective.model, 'gpt-5-codex');
  const plan = await planExecutionModel(undefined, { cliId: 'cursor' }, {
    env, command: 'agent', probe: cursorProbe,
  });
  assert.deepEqual(plan.modelSelection, computation.effective, '计划与共用计算一致');
});
