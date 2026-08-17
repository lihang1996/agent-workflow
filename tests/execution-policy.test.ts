import assert from 'node:assert/strict';
import test from 'node:test';
import { cliPolicyForPipelineStep } from '../src/cli/execution-policy.js';

test('流水线步骤在未整单审批时：PM/开发可写产品，质检只写证据', () => {
  assert.equal(cliPolicyForPipelineStep('pm'), 'standard');
  assert.equal(cliPolicyForPipelineStep('dev', 'standard'), 'standard');
  for (const stepId of ['architect', 'review', 'qa', 'runtime_audit', 'final_review', 'summary']) {
    assert.equal(cliPolicyForPipelineStep(stepId, 'standard'), 'evidence-write', stepId);
  }
});

test('整单已审批时流水线各步都走 approved，不把质检改成 read-only', () => {
  for (const stepId of ['pm', 'dev', 'review', 'qa', 'final_review']) {
    assert.equal(cliPolicyForPipelineStep(stepId, 'approved'), 'approved', stepId);
  }
});
