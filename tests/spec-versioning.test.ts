import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { extractRequirementIds } from '../src/core/requirement-ids.js';
import { JsonSpecStore } from '../src/core/spec-store.js';

function input(projectId: string, workflowId: string, content: string) {
  return {
    title: 'Delivery contract',
    content,
    projectId,
    chatId: 'oc',
    topicId: 'om',
    messageId: workflowId,
    ownerOpenId: 'ou',
    botId: 'pm',
    workflowId,
  };
}

test('规范需求 ID 按首次出现顺序归一化并去重', () => {
  assert.deepEqual(
    extractRequirementIds('RQ-001 登录\n引用 rq-001\nREQ-2 兼容项\nRQ-ABC 不属于编号'),
    ['RQ-001', 'REQ-2', 'RQ-ABC'],
  );
});

test('同一项目的 Spec 具有版本链且同时只能有一个规范版本', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-spec-version-'));
  try {
    const store = await JsonSpecStore.open(join(root, 'specs.json'));
    const first = await store.create(input(
      '/workspace/app',
      '11111111-1111-4111-8111-111111111111',
      'RQ-001 first',
    ));
    const approvedFirst = await store.update(first.id, { status: 'approved' });
    assert.match(approvedFirst.approvedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
    await store.markCanonical(first.id);

    const second = await store.create(input(
      '/workspace/app',
      '22222222-2222-4222-8222-222222222222',
      'RQ-001 second',
    ));
    assert.equal(second.version, 2);
    assert.equal(second.supersedesSpecId, first.id);
    assert.match(second.contentHash ?? '', /^[a-f0-9]{64}$/);
    await store.update(second.id, { status: 'approved' });
    await store.markCanonical(second.id);
    assert.equal(store.get(first.id)?.canonical, false);
    assert.equal(store.findCanonical('/workspace/app')?.id, second.id);

    const revised = await store.update(second.id, { content: 'RQ-001 revised' });
    assert.equal(revised.version, 3);
    assert.equal(revised.canonical, false);
    assert.equal(revised.status, 'changes_requested');
    assert.equal(revised.approvedAt, undefined);
    await assert.rejects(
      store.update(revised.id, { content: 'RQ-001 silently approved', status: 'approved' }),
      /正文变更与人工批准不能在同一次/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('旧版已批准 Spec 会确定性补齐控制器批准时间', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-spec-approved-at-'));
  const path = join(root, 'specs.json');
  try {
    const store = await JsonSpecStore.open(path);
    const spec = await store.create(input(
      '/workspace/app',
      '44444444-4444-4444-8444-444444444444',
      'RQ-001 legacy',
    ));
    await store.update(spec.id, { status: 'approved' });
    const rows = JSON.parse(await readFile(path, 'utf8')) as Array<Record<string, unknown>>;
    const legacyUpdatedAt = rows[0]?.updatedAt;
    delete rows[0]?.approvedAt;
    await writeFile(path, JSON.stringify(rows));

    const reopened = await JsonSpecStore.open(path);
    assert.equal(reopened.get(spec.id)?.approvedAt, legacyUpdatedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Spec 持久化内容与 hash 不一致时拒绝恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-spec-hash-'));
  const path = join(root, 'specs.json');
  try {
    const store = await JsonSpecStore.open(path);
    const spec = await store.create(input(
      '/workspace/app',
      '33333333-3333-4333-8333-333333333333',
      'RQ-001 trusted',
    ));
    const rows = JSON.parse(await readFile(path, 'utf8')) as Array<Record<string, unknown>>;
    rows[0] = { ...rows[0], content: 'RQ-001 tampered', contentHash: spec.contentHash };
    await writeFile(path, JSON.stringify(rows));
    await assert.rejects(JsonSpecStore.open(path), /contentHash 不一致/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
