import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compactAgentOutput,
  displayAgentOutput,
  humanReadableAgentOutput,
} from '../src/core/agent-output.js';

test('飞书展示移除 RESULT、GATE_RESULT 与尾部 DSML 协议', () => {
  const raw = [
    'QA 已完成。',
    '',
    '[RESULT:done]',
    `[GATE_RESULT] ${JSON.stringify({ gateId: 'verification', status: 'pass' })}`,
    '</｜｜DSML｜｜parameter>',
    '</｜｜DSML｜｜tool_calls>',
  ].join('\n');
  assert.equal(humanReadableAgentOutput(raw), 'QA 已完成。');
  assert.doesNotMatch(displayAgentOutput(raw), /GATE_RESULT|DSML|RESULT:/);
});

test('协议引用不是机器结果，不会误截普通正文', () => {
  const text = '请检查 `[GATE_RESULT].artifacts`，随后继续说明。';
  assert.equal(humanReadableAgentOutput(text), text);
});

test('跨角色上下文有界并保留首尾信息', () => {
  const compacted = compactAgentOutput(`开头${'x'.repeat(2_000)}结尾`, 300);
  assert.ok(compacted.length <= 300);
  assert.match(compacted, /^开头/);
  assert.match(compacted, /结尾$/);
  assert.match(compacted, /已省略/);
});

test('只有机器协议时使用安全占位而不泄漏 JSON', () => {
  const display = displayAgentOutput('[RESULT:done]\n[GATE_RESULT] {"gateId":"design"}');
  assert.match(display, /结构化结果已保存/);
  assert.doesNotMatch(display, /gateId/);
});

test('飞书展示正文有界，不再把超长流水线回答连续刷屏', () => {
  const visible = displayAgentOutput(`开头\n${'细节'.repeat(10_000)}\n结尾`);
  assert.ok(visible.length <= 6_000);
  assert.match(visible, /中间内容已省略/);
  assert.match(visible, /结尾$/);
});
