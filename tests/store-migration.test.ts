import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductSpecFlowStore, type ProductSpecFlow } from '../src/core/product-spec.js';
import { JsonProductSpecFlowStore } from '../src/core/product-spec-store.js';
import { assertArtifactAuthorizable } from '../src/core/artifact-digest.js';

function temp(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-store-mig-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 任务前基线的旧格式记录（W5 之前：无 digest/来源/知识引用字段）。 */
function legacyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionVersion: 0,
    token: 'legacytoken0000000000000000000',
    taskId: 'task-1',
    botId: 'product',
    sessionId: 'session-1',
    ownerOpenId: 'owner-open',
    request: {
      title: '方案',
      summary: '说明',
      deliveryMode: 'local',
      specPath: 'spec.md',
      ticketsPath: 'tickets',
    },
    status: 'approved',
    approvedAt: '2026-09-01T00:00:00.000Z',
    approvalMessageId: 'msg-1',
    ...overrides,
  };
}

const localRequest = {
  title: '方案',
  summary: '说明',
  deliveryMode: 'local' as const,
  specPath: 'spec.md',
  ticketsPath: 'tickets',
};

test('legacy rows load with defaults: prd kind, null digest, empty sources/refs', (t) => {
  const dir = temp(t);
  const path = join(dir, 'flows.json');
  writeFileSync(path, `${JSON.stringify([legacyRow()])}\n`);
  const store = new JsonProductSpecFlowStore(path);
  const flow = store.get('legacytoken0000000000000000000')!;
  assert.ok(flow);
  assert.equal(flow.artifact_kind, 'prd');
  assert.equal(flow.content_digest, null);
  assert.equal(flow.digest_algorithm, 'canonical-sha256-v1');
  assert.deepEqual(flow.content_sources, []);
  assert.deepEqual(flow.knowledge_refs, []);
  assert.equal(flow.knowledge_state, null);
  assert.equal(flow.status, 'approved');
});

test('legacy approved rows without digest stay non-authorizable (no default digest backfill)', (t) => {
  const dir = temp(t);
  const path = join(dir, 'flows.json');
  writeFileSync(path, `${JSON.stringify([legacyRow()])}\n`);
  const store = new JsonProductSpecFlowStore(path);
  const flow = store.get('legacytoken0000000000000000000')!;
  assert.throws(() => assertArtifactAuthorizable(flow), /没有内容摘要/);
  // 重载后仍然不可授权（持久层不得默认补出有效摘要）。
  const reloaded = new JsonProductSpecFlowStore(path).get('legacytoken0000000000000000000')!;
  assert.equal(reloaded.content_digest, null);
  assert.throws(() => assertArtifactAuthorizable(reloaded), /没有内容摘要/);
});

test('unknown status values are rejected on load instead of silently dropped', (t) => {
  const dir = temp(t);
  const path = join(dir, 'flows.json');
  writeFileSync(path, `${JSON.stringify([legacyRow({ status: 'unversioned' })])}\n`);
  assert.throws(() => new JsonProductSpecFlowStore(path), /产品方案状态记录无效/);
});

test('malformed digest values are rejected on load', (t) => {
  const dir = temp(t);
  const path = join(dir, 'flows.json');
  writeFileSync(path, `${JSON.stringify([legacyRow({ content_digest: 'not-a-sha256' })])}\n`);
  assert.throws(() => new JsonProductSpecFlowStore(path), /产品方案状态记录无效/);
});

test('new fields round-trip through the JSON store, including invalidated status', (t) => {
  const dir = temp(t);
  const path = join(dir, 'flows.json');
  const store = new JsonProductSpecFlowStore(path);
  const digest = 'b'.repeat(64);
  const knowledgeRefs = [
    {
      system_id: 'shop',
      scope: 'product',
      snapshot_ref: 'snap-shop-1',
      context_ref: 'ctx-shop-1',
      object_ids: ['shop.rule.checkout'],
      requested_seed_ids: ['shop.rule.checkout'],
    },
    {
      system_id: 'crm',
      scope: 'product',
      snapshot_ref: 'snap-crm-1',
      context_ref: 'ctx-crm-1',
      object_ids: ['crm.rule.lead'],
    },
  ];
  const flow = store.create({
    taskId: 'task-2',
    botId: 'product',
    sessionId: 'session-2',
    ownerOpenId: 'owner-open',
    request: localRequest,
    artifact_kind: 'architecture',
    content_digest: digest,
    digest_algorithm: 'canonical-sha256-v1',
    content_sources: [{ kind: 'local', path: 'spec.md' }, { kind: 'local', path: 'tickets' }],
    knowledge_refs: knowledgeRefs,
    knowledge_state: 'ok',
  });
  assert.equal(flow.status, 'pending');

  store.approve(flow.token, 'approval-msg');
  store.invalidate(flow.token, 'external_edit');

  const reloaded = new JsonProductSpecFlowStore(path).get(flow.token)!;
  assert.equal(reloaded.artifact_kind, 'architecture');
  assert.equal(reloaded.content_digest, digest);
  assert.equal(reloaded.status, 'invalidated');
  assert.equal(reloaded.invalidation_reason, 'external_edit');
  assert.deepEqual(reloaded.knowledge_refs, knowledgeRefs);
  assert.deepEqual(reloaded.content_sources, [
    { kind: 'local', path: 'spec.md' },
    { kind: 'local', path: 'tickets' },
  ]);
  assert.equal(reloaded.knowledge_state, 'ok');
  assert.equal(reloaded.approvalMessageId, 'approval-msg');
});

test('lark rows keep a lark content source and null digest after reload', (t) => {
  const dir = temp(t);
  const path = join(dir, 'flows.json');
  const store = new JsonProductSpecFlowStore(path);
  const flow = store.create({
    taskId: 'task-3',
    botId: 'product',
    sessionId: 'session-3',
    ownerOpenId: 'owner-open',
    request: {
      title: '方案',
      summary: '说明',
      deliveryMode: 'lark-doc',
      documentUrl: 'https://team.feishu.cn/docx/abcDEF123',
    },
    content_digest: null,
    content_sources: [{ kind: 'lark', file_token: 'abcDEF123' }],
  });
  const reloaded = new JsonProductSpecFlowStore(path).get(flow.token)!;
  assert.equal(reloaded.content_digest, null);
  assert.deepEqual(reloaded.content_sources, [{ kind: 'lark', file_token: 'abcDEF123' }]);
});

test('invalidation keeps other flows untouched and is idempotent', () => {
  const store = new ProductSpecFlowStore();
  const a = store.create({ taskId: 't-a', botId: 'product', sessionId: 's', ownerOpenId: 'o', request: localRequest });
  const b = store.create({ taskId: 't-b', botId: 'product', sessionId: 's', ownerOpenId: 'o', request: localRequest });
  const invalidated = store.invalidate(a.token, 'upstream_invalidated');
  assert.equal(invalidated?.status, 'invalidated');
  assert.equal(store.invalidate(a.token, 'again'), undefined);
  assert.equal(store.get(b.token)?.status, 'pending');
  // 已失效 flow 不再可审批。
  assert.equal(store.approve(a.token), undefined);
});

test('persisted snapshot writes unknown-new-field-free rows only (schema-clean output)', (t) => {
  const dir = temp(t);
  const path = join(dir, 'flows.json');
  const store = new JsonProductSpecFlowStore(path);
  store.create({ taskId: 't', botId: 'product', sessionId: 's', ownerOpenId: 'o', request: localRequest });
  const rows: ProductSpecFlow[] = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].artifact_kind, 'prd');
  assert.equal(rows[0].content_digest, null);
  assert.deepEqual(rows[0].knowledge_refs, []);
});
