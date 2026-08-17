import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonCollabStore } from '../src/core/collab-store.js';
import { buildFollowUpReviewPrompt, buildInitialReviewPrompt, isReviewApproved, isReviewExplicitlyApproved } from '../src/core/collab.js';

test('评审只接受明确的通过结论行', () => {
  for (const answer of [
    '[APPROVED]',
    '结论：[APPROVED]',
    '## 最终结论：LGTM',
    '- 评审通过。',
    '核验完成。第 3 轮复审结论:**[APPROVED]**',
    '## 复审结论:通过 ✅',
    '复审结论：**通过**',
  ]) {
    assert.equal(isReviewApproved(answer), true, answer);
  }
  for (const answer of [
    '未审核通过，仍需修改',
    '不可以合并',
    '修复后可以写 [APPROVED]',
    '结论：[APPROVED]，但还有阻塞问题',
    '请在通过时输出 LGTM',
    '第 2 轮复审结论:**未通过(No [APPROVED])**',
  ]) {
    assert.equal(isReviewApproved(answer), false, answer);
  }
  assert.equal(isReviewApproved('[APPROVED]\n最终结论：不通过，仍需修改'), false);
  assert.equal(isReviewApproved('复审结论：不通过\n[APPROVED]'), true);
});

test('结构化门禁必须有显式 APPROVED 标记', () => {
  assert.equal(isReviewExplicitlyApproved('最终结论：评审通过'), false);
  assert.equal(isReviewExplicitlyApproved('结论：[APPROVED]\n[GATE_RESULT] {}'), true);
  assert.equal(isReviewExplicitlyApproved('[DECISION:approved]\n[RESULT:done]'), true);
  assert.equal(isReviewExplicitlyApproved('[DECISION:approved-with-waiver]'), true);
});

test('协作评审 prompt 禁止把未通过标成 RESULT:failed', () => {
  const first = buildInitialReviewPrompt('审查实现', 1);
  assert.match(first, /通过或未通过都用 \[RESULT:done\]/);
  assert.match(first, /禁止把「发现需改代码」写成 \[RESULT:failed\]/);
  const followUp = buildFollowUpReviewPrompt('审查实现', 2, '已按意见修改');
  assert.match(followUp, /仍输出 \[RESULT:done\]/);
  assert.match(followUp, /禁止用 \[RESULT:failed\] 表示有 bug/);
});

test('协作轮次落盘失败时回滚内存状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-collab-rollback-'));
  try {
    const store = new JsonCollabStore(root);
    await assert.rejects(() => store.setRound('oc:omt', 1));
    assert.equal(store.size, 0);
    assert.equal(store.getRound('oc:omt'), undefined);
  } finally {
    await rm(`${root}.tmp`, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('损坏协作轮次文件会明确报错', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-collab-invalid-'));
  const path = join(root, 'collab.json');
  try {
    await writeFile(path, JSON.stringify([{ topicKey: 'oc:omt', round: 99, updatedAt: 'bad' }]));
    await assert.rejects(() => JsonCollabStore.open(path), /第 1 条记录格式错误/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
