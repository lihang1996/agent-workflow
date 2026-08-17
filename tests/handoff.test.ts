import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHandoffPrompt, resolveHandoffTarget } from '../src/core/handoff.js';
import type { Bot } from '../src/im/lark.js';

test('交接 prompt 带上目标角色禁令，并可解析运行时/终审别名', () => {
  const from = { id: 'ceo', name: 'CEO助手' } as Bot;
  const qa = { id: 'qa', name: '测试工程师' } as Bot;
  const prompt = buildHandoffPrompt(from, '分析失败日志', qa);
  assert.match(prompt, /禁止改产品代码/);
  const bots = [
    { id: 'qa', name: '测试工程师' },
    { id: 'runtime_auditor', name: '运行时审计' },
    { id: 'final_reviewer', name: '最终审查' },
  ] as Bot[];
  assert.equal(resolveHandoffTarget('运行时审计', bots)?.id, 'runtime_auditor');
  assert.equal(resolveHandoffTarget('终审', bots)?.id, 'final_reviewer');
});
