import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CollaborationOriginSchema,
  type CollaborationOrigin,
} from '../src/core/collaboration.js';
import { ClarificationFlowStore } from '../src/core/clarification.js';
import { JsonProductSpecFlowStore } from '../src/core/product-spec-store.js';

const collaboration: CollaborationOrigin = {
  taskId: 'task-doctor',
  fromBotId: 'ceo-assistant',
  reportToBotId: 'ceo-assistant',
  round: 1,
  maxRounds: 16,
};

const productRequest = {
  title: 'Doctor 诊断命令',
  summary: '为 Agent OS 增加只读诊断入口。',
  deliveryMode: 'local' as const,
  specPath: '.scratch/doctor/spec.md',
  ticketsPath: '.scratch/doctor/issues',
};

test('clarification flow preserves collaboration origin after answering', () => {
  const store = new ClarificationFlowStore();
  const flow = store.create({
    taskId: 'task-doctor',
    botId: 'product',
    sessionId: 'agent-session',
    ownerOpenId: 'owner-placeholder',
    collaboration,
    originalMessageId: 'message-placeholder',
    replyInThread: true,
    request: {
      title: '需求澄清',
      intro: '',
      questions: [{
        id: 'scope',
        prompt: '诊断范围是什么？',
        options: [
          { id: 'local', label: '本地状态' },
          { id: 'full', label: '完整链路' },
        ],
      }],
    },
  });

  const answered = store.answer(flow.token, 'scope', '本地状态');
  assert.equal(answered?.complete, true);
  assert.deepEqual(answered?.flow.collaboration, collaboration);
});

test('product spec store persists collaboration through reload and approval', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-os-product-spec-'));
  const filePath = join(directory, 'flows.json');
  try {
    const store = new JsonProductSpecFlowStore(filePath);
    const created = store.create({
      taskId: 'task-doctor',
      botId: 'product',
      sessionId: 'agent-session',
      ownerOpenId: 'owner-placeholder',
      collaboration,
      request: productRequest,
    });

    const reloaded = new JsonProductSpecFlowStore(filePath);
    assert.deepEqual(reloaded.get(created.token)?.collaboration, collaboration);
    const approved = reloaded.approve(created.token);
    assert.equal(approved?.collaboration?.reportToBotId, 'ceo-assistant');

    const approvedReloaded = new JsonProductSpecFlowStore(filePath)
      .get(created.token);
    assert.equal(approvedReloaded?.status, 'approved');
    assert.deepEqual(approvedReloaded?.collaboration, collaboration);
    assert.match(readFileSync(filePath, 'utf8'), /"collaboration"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('product spec store remains compatible with legacy rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-os-product-spec-legacy-'));
  const filePath = join(directory, 'flows.json');
  try {
    writeFileSync(filePath, JSON.stringify([{
      token: 'legacy-token',
      taskId: 'legacy-task',
      botId: 'product',
      sessionId: 'legacy-session',
      ownerOpenId: 'legacy-owner',
      request: productRequest,
      status: 'pending',
    }]), 'utf8');

    const legacy = new JsonProductSpecFlowStore(filePath).get('legacy-token');
    assert.equal(legacy?.status, 'pending');
    assert.equal(legacy?.collaboration, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('collaboration origin schema rejects unknown fields and invalid rounds', () => {
  assert.equal(CollaborationOriginSchema.safeParse({
    ...collaboration,
    unexpected: true,
  }).success, false);
  assert.equal(CollaborationOriginSchema.safeParse({
    ...collaboration,
    round: collaboration.maxRounds + 1,
  }).success, false);
});
