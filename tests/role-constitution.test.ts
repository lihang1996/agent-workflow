import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPipelineStepPrompt, DEFAULT_PIPELINE_STEPS } from '../src/core/pipeline.js';
import {
  qualityRoleRejectsImplementationHandoff,
  roleBriefForStep,
  roleConstitution,
} from '../src/core/role-constitution.js';
import { skillNameForStep } from '../src/core/quality-gates.js';

test('全局宪法注入每步 prompt，且质检角色拒绝修 bug 交接', () => {
  const constitution = roleConstitution();
  assert.match(constitution, /角色宪法/);
  assert.match(constitution, /禁止自我批准/);
  for (const step of DEFAULT_PIPELINE_STEPS) {
    const prompt = buildPipelineStepPrompt(step, '目标', {});
    assert.match(prompt, /角色宪法/);
    assert.equal(prompt.includes(roleBriefForStep(step.id).slice(0, 8)), true);
  }
  assert.equal(skillNameForStep('summary'), 'coordinate-delivery-summary');
  assert.equal(qualityRoleRejectsImplementationHandoff('qa', '把这个 bug 修了'), true);
  assert.equal(qualityRoleRejectsImplementationHandoff('reviewer', 'fix the bug in login'), true);
  assert.equal(qualityRoleRejectsImplementationHandoff('architect', '改代码补一下校验'), true);
  assert.equal(qualityRoleRejectsImplementationHandoff('dev', '把这个 bug 修了'), false);
  assert.equal(qualityRoleRejectsImplementationHandoff('qa', '分析一下失败日志'), false);
});
