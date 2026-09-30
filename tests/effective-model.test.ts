import assert from 'node:assert/strict';
import test from 'node:test';
import { describeEffectiveModel } from '../src/app/execution-model.js';
import type { BotConfig } from '../src/core/bot-registry.js';
import type { ModelOverrides } from '../src/core/model-selection.js';

/**
 * A05：生效模型三层视图（角色声明 → 个人默认 → 最终参数）单元测试。
 * 覆盖三种情况：角色有声明 / 无声明 / 引擎不支持声明（zcode）。
 */

function botWith(overrides: ModelOverrides): BotConfig {
  return {
    id: 'dev-bot',
    appId: 'app',
    appSecret: 'secret',
    defaultCliId: 'codex',
    modelOverrides: overrides,
    role: 'dev',
    skills: [],
    systemPrompt: '',
    workspaceDir: '/tmp/ws',
    collaborationMaxRounds: 16,
  };
}

test('describeEffectiveModel shows a declared role override (A05)', () => {
  const output = describeEffectiveModel(botWith({
    codex: { model: 'gpt-6-sol', reasoningEffort: 'xhigh' },
  }));
  assert.match(output, /生效模型（codex）：/);
  assert.match(output, /角色声明：model=gpt-6-sol，effort=xhigh/);
  assert.match(output, /个人默认：引擎 CLI 原生默认/);
  assert.match(output, /最终参数：codex gpt-6-sol \/ effort xhigh（来源：角色声明）/);
  assert.ok(!output.includes('话题级声明'), '未提供话题层时不显示该层');
});

test('describeEffectiveModel falls through to native default without a role override (A05)', () => {
  const output = describeEffectiveModel(botWith({}));
  assert.match(output, /角色声明：无/);
  assert.match(output, /个人默认：引擎 CLI 原生默认/);
  assert.match(output, /最终参数：codex 引擎原生默认 \/ effort 未声明（来源：引擎原生默认）/);
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
