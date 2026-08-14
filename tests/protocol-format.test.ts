import assert from 'node:assert/strict';
import test from 'node:test';
import { FingerprintDriftError } from '../src/core/quality-gates.js';
import {
  buildProtocolFormatRepairPrompt,
  isProtocolFormatError,
  resolveFormatRepairAttempts,
  shouldRepairProtocolFormat,
} from '../src/core/protocol-format.js';
import { RuntimeSourceChangedError } from '../src/core/runtime-source-guard.js';

test('协议格式错误可纠偏，质量结论和漂移不能纠偏', () => {
  assert.equal(
    isProtocolFormatError(new Error('canonical Spec 的 [RISK_WAIVER] 后必须紧跟完整 JSON 对象')),
    true,
  );
  assert.equal(
    isProtocolFormatError(new Error(
      '产品经理未创建结构化问卷，且输出不是可确认的产品 Spec；本次输出不会保存或显示确认卡。具体原因：缺少稳定需求 ID',
    )),
    true,
  );
  assert.equal(
    isProtocolFormatError(new Error('流水线步骤缺少显式 [RESULT:done|blocked|failed] 终态标记，不能按成功处理。')),
    true,
  );
  assert.equal(
    isProtocolFormatError(new Error('质量步骤 review 缺少可解析的 [GATE_RESULT] JSON 证据')),
    true,
  );
  assert.equal(isProtocolFormatError(new Error('门禁 artifact hash 不匹配：change-review.json')), true);
  assert.equal(isProtocolFormatError(new Error('质量门禁 change-review 仍有未闭环 P0/P1：FIND-1')), false);
  assert.equal(isProtocolFormatError(new Error('质量门禁仍有必需检查未通过：unit(fail)')), false);
  assert.equal(
    isProtocolFormatError(new FingerprintDriftError('implementation', 'dev', '当前变更快照与最新 implementation gate 不一致')),
    false,
  );
  assert.equal(isProtocolFormatError(new RuntimeSourceChangedError()), false);
  assert.equal(isProtocolFormatError(new Error('spawn agent ENOENT')), false);
});

test('同一会话格式纠偏需要 resume id，且次数有上限', () => {
  const error = new Error('缺少可解析的 [GATE_RESULT] JSON 证据');
  assert.equal(shouldRepairProtocolFormat({
    error, repairsUsed: 0, maxRepairs: 1, resumeSessionId: 'sess-1',
  }), true);
  assert.equal(shouldRepairProtocolFormat({
    error, repairsUsed: 1, maxRepairs: 1, resumeSessionId: 'sess-1',
  }), false);
  assert.equal(shouldRepairProtocolFormat({
    error, repairsUsed: 0, maxRepairs: 1,
  }), false);
  assert.equal(shouldRepairProtocolFormat({
    error, repairsUsed: 0, maxRepairs: 1, resumeSessionId: 'sess-1', aborted: true,
  }), false);
  assert.equal(resolveFormatRepairAttempts(undefined), 1);
  assert.equal(resolveFormatRepairAttempts('0'), 0);
  assert.equal(resolveFormatRepairAttempts('9'), 2);
  assert.match(buildProtocolFormatRepairPrompt(error), /禁止重新探索/);
  assert.match(buildProtocolFormatRepairPrompt(error), /GATE_RESULT/);
});
