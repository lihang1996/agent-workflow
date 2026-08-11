import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeliveryMutationTask } from '../src/core/delivery-policy.js';

test('交付变更识别阻止直接代码生成但不阻断只读咨询', () => {
  assert.equal(isDeliveryMutationTask('帮我修复登录页面代码'), true);
  assert.equal(isDeliveryMutationTask('implement a new API endpoint'), true);
  assert.equal(isDeliveryMutationTask('帮我详细优化一下 Agent OS 的代码和工作流'), true);
  assert.equal(isDeliveryMutationTask('update the backend deployment config'), true);
  assert.equal(isDeliveryMutationTask('请分析这个项目的架构风险'), false);
  assert.equal(isDeliveryMutationTask('解释 TypeScript 泛型'), false);
});
