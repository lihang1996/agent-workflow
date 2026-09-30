import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KbCallError,
  KNOWLEDGE_RUNTIME_GATE,
  KnowledgePrefetchLedger,
  assertKnowledgeRuntimeConsumptionAllowed,
  buildPrunedContext,
  decodeKbEnvelope,
  knowledgeRefsFromRecord,
  knowledgeUsageNotice,
  prefetchKnowledgeContext,
  resolvePrefetchIdentity,
  type PrefetchIdentity,
  type PrefetchRecord,
} from '../src/core/kb-prefetch.js';
import { FixtureKbMcpServer, sampleShopSystem, type FixtureKbSystem } from './fixtures/kb/fixture-kb-client.js';
import { parseAgentOsConfig } from '../src/core/bot-registry.js';

const identity: PrefetchIdentity = {
  callerBotId: 'product',
  role: '产品',
  kbSystems: ['shop', 'new-proj', 'broken-sys', 'crm'],
  tenant: null,
  blockedDimensions: ['tenant'],
};
/** 同时命中下单/退款/订单三对象的查询（fixture 检索候选语义与真实一致，不再全量返回）。 */
const requirement = '优化下单流程的退款体验，涉及订单模块';
const binding = { taskId: 'task-1', sessionId: 'session-1' };

function serverWith(options: { systems: FixtureKbSystem[]; allowedSystems?: string[]; anchor?: boolean }): FixtureKbMcpServer {
  return new FixtureKbMcpServer({ systems: options.systems, allowedSystems: options.allowedSystems, simulateTrustedCurrentAnchor: options.anchor });
}

async function prefetch(client: FixtureKbMcpServer, systemId = 'shop', anchor = true, query = requirement): Promise<PrefetchRecord> {
  return prefetchKnowledgeContext({
    client,
    identity,
    systemId,
    requirement: query,
    taskId: binding.taskId,
    sessionId: binding.sessionId,
  });
}

const searchCalls = (client: FixtureKbMcpServer) => client.calls.filter((call) => call.tool === 'search_knowledge' && (call.args as { mode?: string }).mode === 'search');
const toolCalls = (client: FixtureKbMcpServer, tool: string) => client.calls.filter((call) => call.tool === tool);

test('happy path (simulated trusted anchor): catalog→search→impact→build→read-back audited on one fixed snapshot', async () => {
  const client = serverWith({ systems: [sampleShopSystem()], anchor: true });
  const record = await prefetch(client);
  assert.equal(record.outcome, 'ok');
  assert.equal(record.snapshot_ref, 'snap-shop-2026-09-28');
  assert.ok(record.context_ref);
  assert.deepEqual(
    record.audit.map((entry) => entry.tool),
    ['search_knowledge', 'search_knowledge', 'analyze_change_impact', 'build_prd_context', 'get_knowledge'],
  );
  for (const entry of record.audit) {
    assert.equal(entry.snapshot_ref, record.snapshot_ref);
    assert.equal(entry.outcome, 'ok');
  }
  // 检索候选语义与真实一致：只返回与 query 相关的对象（draft/offline 未命中）。
  // 现行事实 = published 且 usable_as_current=true（读回仍为 true）。
  assert.deepEqual(
    record.current_objects.map((object) => object.object_id).sort(),
    ['shop.module.order', 'shop.rule.checkout', 'shop.rule.refund'],
  );
  assert.deepEqual(record.excluded_objects, [], '未命中的 draft/offline 不出现在结果里');
  assert.equal(record.truncated, false);
  assert.equal(record.tenant, null, 'tenant 无受信任来源，恒为 null（显式 blocked 维度）');
  assert.deepEqual(record.blocked_identity_dimensions, ['tenant']);
  // 审计 input 覆盖真实契约关键参数。
  const searchAudit = record.audit.find((entry) => (entry.input as { mode?: string }).mode === 'search')!;
  assert.equal((searchAudit.input as { query: string }).query, requirement);
  assert.equal((searchAudit.input as { purpose: string }).purpose, 'prd');
  const impactAudit = record.audit.find((entry) => entry.tool === 'analyze_change_impact')!;
  assert.equal((impactAudit.input as { change_intent: string }).change_intent, 'modify', '真实 impact 必须携带 change_intent');
  const buildAudit = record.audit.find((entry) => entry.tool === 'build_prd_context')!;
  assert.equal((buildAudit.input as { mode: string }).mode, 'build');
});

test('pruned copy contains only current objects; no credentials, kb plumbing or excluded content', async () => {
  const client = serverWith({ systems: [sampleShopSystem()], anchor: true });
  const record = await prefetch(client);
  const pruned = buildPrunedContext(record);
  assert.deepEqual(
    pruned.objects.map((object) => object.object_id).sort(),
    ['shop.module.order', 'shop.rule.checkout', 'shop.rule.refund'],
  );
  assert.equal(pruned.excluded_object_count, 0);
  assert.ok(pruned.usage_rules.length >= 2);
  const serialized = JSON.stringify(pruned);
  assert.ok(!serialized.includes('coupon-draft'), 'draft 对象不得进入裁剪副本');
  assert.ok(!serialized.includes('legacy-offline'), 'offline 对象不得进入裁剪副本');
  assert.ok(!serialized.includes('已下线'), '未命中对象的摘要不得泄漏进副本');
  assert.ok(!serialized.includes('KB_'), '副本不得携带 KB 凭据环境变量');
  assert.ok(!serialized.includes('kb-mcp'), '副本不得携带 kb-mcp 连接信息');
});

test('production parity: without a trusted anchor nothing is current — impact/build are skipped and the gap is recorded', async () => {
  const client = serverWith({ systems: [sampleShopSystem()], anchor: false });
  const record = await prefetch(client);
  assert.equal(record.outcome, 'ok', '协议成功但无现行事实，不是错误');
  assert.equal(record.context_ref, null);
  assert.deepEqual(record.current_objects, []);
  assert.deepEqual(record.excluded_objects.map((object) => object.object_id).sort(), [
    'shop.module.order', 'shop.rule.checkout', 'shop.rule.refund',
  ], '命中的 published 对象也全部按历史/待核实排除');
  assert.ok(record.evidence_gaps.includes('no_current_objects'));
  assert.ok(record.evidence_gaps.includes('trusted_anchor_unconfigured'));
  assert.ok(record.warnings.some((warning) => warning.startsWith('trusted_anchor_unconfigured')));
  // 零现行种子：不得调用会拒绝空种子的 impact，也不做无意义的 build。
  assert.equal(toolCalls(client, 'analyze_change_impact').length, 0);
  assert.equal(toolCalls(client, 'build_prd_context').length, 0);
  assert.equal(toolCalls(client, 'get_knowledge').length, 0);
  assert.match(knowledgeUsageNotice(record), /不得引用任何现行事实/);
  assert.deepEqual(knowledgeRefsFromRecord(record), [], '无现行对象时不产出引用');
  assert.throws(() => buildPrunedContext(record), /无现行对象|完整成功/);
});

test('published but not usable_as_current stays out of current facts even with the simulated anchor', async () => {
  const system = sampleShopSystem();
  const checkout = system.objects!.find((object) => object.id === 'shop.rule.checkout')!;
  checkout.usable_as_current = false;
  checkout.availability_reason = 'verification 未满足：业务确认缺失';
  const client = serverWith({ systems: [system], anchor: true });
  const record = await prefetch(client);
  assert.deepEqual(record.current_objects.map((object) => object.object_id).sort(), ['shop.module.order', 'shop.rule.refund']);
  const excluded = record.excluded_objects.find((object) => object.object_id === 'shop.rule.checkout')!;
  assert.match(excluded.exclusion_reason, /usable_as_current=false/);
  assert.match(excluded.exclusion_reason, /业务确认缺失/);
});

test('pagination: every page is read until total_pages and hits are complete', async () => {
  const client = serverWith({ systems: [{ ...sampleShopSystem(), pageSize: 2 }], anchor: true });
  const record = await prefetch(client);
  const pages = searchCalls(client);
  assert.equal(pages.length, 2, '3 个命中对象、页宽 2 → 2 页');
  assert.deepEqual(pages.map((call) => (call.args as { page: number }).page), [1, 2]);
  assert.equal(record.truncated, false, '分页读完不算截断');
  assert.deepEqual(
    record.current_objects.map((object) => object.object_id).sort(),
    ['shop.module.order', 'shop.rule.checkout', 'shop.rule.refund'],
  );
});

test('reading past the page safety cap marks truncation instead of claiming completeness', async () => {
  const objects = Array.from({ length: 55 }, (_, index) => ({
    id: `shop.rule.extra-${index}`,
    revision: 1,
    kind: 'rule',
    name: `扩展规则 ${index}`,
    publication_status: 'published' as const,
    verification_status: 'verified',
    summary: '用于触发分页上限。',
    usable_as_current: true,
  }));
  const client = serverWith({ systems: [{ systemId: 'shop', activeSnapshot: 'snap-shop-1', pageSize: 1, objects }], anchor: true });
  const record = await prefetch(client, 'shop', true, '扩展规则');
  assert.ok(searchCalls(client).length <= 50);
  assert.equal(record.truncated, true);
  assert.ok(record.truncation_reasons.includes('search_pages_capped'));
  assert.ok(record.truncation_reasons.includes('seed_limit_exceeded'), '种子限额截断也要如实标注');
  assert.match(knowledgeUsageNotice(record), /截断/);
});

test('server-side truncation flags, missing evidence and warnings propagate to the record', async () => {
  const client = serverWith({ systems: [{ ...sampleShopSystem(), searchTruncated: true }], anchor: false });
  const record = await prefetch(client);
  assert.equal(record.truncated, true);
  assert.ok(record.truncation_reasons.includes('response_budget_exceeded'));
  assert.ok(record.warnings.some((warning) => warning.startsWith('trusted_anchor_unconfigured')), '警示必须向下传递');
});

test('draft and offline hits are excluded from current facts with explicit reasons', async () => {
  // 定制系统：摘要不含与 query 交叉的词元，避免误命中扩大候选集。
  const system: FixtureKbSystem = {
    systemId: 'shop',
    activeSnapshot: 'snap-shop-1',
    objects: [
      { id: 'shop.rule.checkout', revision: 3, kind: 'rule', name: '下单规则', publication_status: 'published', verification_status: 'verified', usable_as_current: true, summary: '订单创建需校验库存。' },
      { id: 'shop.rule.coupon-draft', revision: 1, kind: 'rule', name: '优惠券规则', publication_status: 'draft', verification_status: 'unverified', summary: '草稿。' },
      { id: 'shop.rule.legacy-offline', revision: 4, kind: 'rule', name: '旧版支付规则', publication_status: 'offline', verification_status: 'verified', summary: '已停用。' },
    ],
  };
  const client = serverWith({ systems: [system], anchor: true });
  // 「规则」词元命中全部三个对象：draft 与 offline 被逐条排除并给出原因。
  const record = await prefetch(client, 'shop', true, '优惠券规则与旧版支付规则');
  assert.deepEqual(record.current_objects.map((object) => object.object_id), ['shop.rule.checkout']);
  assert.deepEqual(record.excluded_objects.map((object) => object.object_id).sort(), [
    'shop.rule.coupon-draft', 'shop.rule.legacy-offline',
  ]);
  const draft = record.excluded_objects.find((object) => object.object_id === 'shop.rule.coupon-draft')!;
  assert.match(draft.exclusion_reason, /draft/);
  const offline = record.excluded_objects.find((object) => object.object_id === 'shop.rule.legacy-offline')!;
  assert.match(offline.exclusion_reason, /offline/);
});

test('zero search hits on a populated system are an evidence gap, never a fabricated current fact', async () => {
  const client = serverWith({ systems: [sampleShopSystem()], anchor: true });
  const record = await prefetch(client, 'shop', true, '区块链元宇宙xyz');
  assert.equal(record.outcome, 'ok');
  assert.deepEqual(record.current_objects, []);
  assert.deepEqual(record.excluded_objects, []);
  assert.ok(record.evidence_gaps.includes('no_current_objects'));
  assert.equal(toolCalls(client, 'analyze_change_impact').length, 0);
  assert.equal(toolCalls(client, 'build_prd_context').length, 0);
});

test('fixture refuses impossible current combos: draft/unverified objects stay non-current even with the simulated anchor', async () => {
  const system: FixtureKbSystem = {
    systemId: 'shop',
    activeSnapshot: 'snap-shop-1',
    objects: [
      { id: 'shop.rule.fake-draft', revision: 1, kind: 'rule', name: '草稿规则（却标记 current）', summary: '不可能组合。', publication_status: 'draft', verification_status: 'verified', usable_as_current: true },
      { id: 'shop.rule.unverified', revision: 1, kind: 'rule', name: '未核实规则', summary: 'verification 未满足。', publication_status: 'published', verification_status: 'unverified', usable_as_current: true },
    ],
  };
  const client = serverWith({ systems: [system], anchor: true });
  const record = await prefetch(client, 'shop', true, '规则');
  assert.deepEqual(record.current_objects, [], 'draft/unverified 不可能作为现行事实');
  assert.deepEqual(record.excluded_objects.map((object) => object.object_id).sort(), ['shop.rule.fake-draft', 'shop.rule.unverified']);
  assert.match(record.excluded_objects[0]!.exclusion_reason, /draft/);
});

test('read-back without a verified recheck is not trusted as a context', async () => {
  const client = serverWith({ systems: [{ ...sampleShopSystem(), recheckUnverified: true }], anchor: true });
  const record = await prefetch(client);
  assert.equal(record.outcome, 'degraded');
  const readBack = record.audit.find((entry) => entry.tool === 'get_knowledge')!;
  assert.ok(readBack.outcome === 'failed' && readBack.failure_kind === 'kb_protocol_error');
});

test('empty search hits are an evidence gap, not an error, and never call impact/build', async () => {
  const client = serverWith({ systems: [{ systemId: 'new-proj', activeSnapshot: 'snap-empty', objects: [] }], anchor: true });
  const record = await prefetch(client, 'new-proj');
  assert.equal(record.outcome, 'ok');
  assert.ok(record.evidence_gaps.includes('no_current_objects'));
  assert.equal(toolCalls(client, 'analyze_change_impact').length, 0);
  assert.equal(toolCalls(client, 'build_prd_context').length, 0);
  assert.match(knowledgeUsageNotice(record), /不得引用任何现行事实/);
});

test('out-of-scope system is denied before any KB call (trusted mapping, not self-report)', async () => {
  const client = serverWith({ systems: [sampleShopSystem()], anchor: true });
  await assert.rejects(
    prefetch(client, 'secret-crm'),
    (error: unknown) => error instanceof KbCallError && error.kind === 'scope_denied',
  );
  assert.equal(client.calls.length, 0, '越权请求不得触发任何 KB 工具调用');
});

test('server-side ACL (allowedSystems) denies even when the bot scope allows: degraded', async () => {
  const client = serverWith({ systems: [sampleShopSystem()], allowedSystems: ['shop'], anchor: true });
  const record = await prefetch(client, 'crm');
  assert.equal(record.outcome, 'degraded');
  assert.ok(record.audit.some((entry) => entry.outcome === 'failed' && entry.failure_kind === 'scope_denied'));
});

test('new project without an active snapshot is a distinct non-error outcome', async () => {
  const client = serverWith({ systems: [sampleShopSystem(), { systemId: 'new-proj', activeSnapshot: null, objects: [] }], anchor: true });
  const record = await prefetch(client, 'new-proj');
  assert.equal(record.outcome, 'new_project_no_baseline');
  assert.equal(record.snapshot_ref, null);
  assert.equal(record.context_ref, null);
  assert.deepEqual(record.audit.map((entry) => entry.tool), ['search_knowledge']);
  assert.ok(record.audit[0].outcome === 'failed' && record.audit[0].failure_kind === 'scope_not_available');
  assert.match(knowledgeUsageNotice(record), /新项目、无既有基准/);
  assert.ok(!knowledgeUsageNotice(record).includes('degraded'));
});

test('existing project with KB failure is degraded at any stage, including read-back', async (t) => {
  for (const failTool of ['search_knowledge', 'analyze_change_impact', 'build_prd_context', 'get_knowledge'] as const) {
    const client = serverWith({ systems: [{ ...sampleShopSystem(), failTool }], anchor: true });
    const record = await prefetch(client);
    assert.equal(record.outcome, 'degraded', failTool);
    assert.equal(record.context_ref, null, '降级记录不得携带可用 context_ref');
    assert.ok(record.audit.some((entry) => entry.outcome === 'failed'));
  }
  t.diagnostic('catalog 阶段故障同样降级');
  const catalogFail = serverWith({ systems: [{ ...sampleShopSystem(), failTool: 'all' }], anchor: true });
  assert.equal((await prefetch(catalogFail)).outcome, 'degraded');
});

test('corrupted protocol frames fail closed instead of being accepted', async () => {
  for (const corrupt of ['bad-json', 'wrong-contract-version', 'ok-status-missing', 'wrong-system', 'wrong-snapshot', 'error-envelope-malformed'] as const) {
    const client = serverWith({ systems: [{ ...sampleShopSystem(), corrupt, corruptTool: 'search_knowledge' }], anchor: true });
    const record = await prefetch(client);
    assert.equal(record.outcome, 'degraded', corrupt);
    assert.ok(
      record.audit.some((entry) => entry.outcome === 'failed' && entry.failure_kind === 'kb_protocol_error'),
      `${corrupt} 必须记为协议失败（畸形错误信封不得被误判成新项目/业务分支）`,
    );
  }
});

test('context read-back inconsistency (tampered artifact) degrades the whole prefetch', async () => {
  const client = serverWith({ systems: [{ ...sampleShopSystem(), tamperContexts: true }], anchor: true });
  const record = await prefetch(client);
  assert.equal(record.outcome, 'degraded');
  assert.equal(record.context_ref, null);
  const readBack = record.audit.find((entry) => entry.tool === 'get_knowledge')!;
  assert.ok(readBack.outcome === 'failed' && readBack.failure_kind === 'scope_denied');
});

test('withdrawal never leaks: pre-run withdrawal is invisible in results; post-build withdrawal rejects the whole context', async () => {
  // A. 预先撤回：对象完全不出现，也不出现在排除清单（无可反推的痕迹）。
  const preWithdrawn = serverWith({ systems: [sampleShopSystem()], anchor: true });
  preWithdrawn.withdraw('shop.rule.checkout');
  const recordA = await prefetch(preWithdrawn);
  assert.deepEqual(recordA.current_objects.map((object) => object.object_id).sort(), ['shop.module.order', 'shop.rule.refund']);
  assert.ok(!JSON.stringify(recordA).includes('checkout'), '撤回对象 id 不得出现在记录中');
  assert.ok(!JSON.stringify(buildPrunedContext(recordA)).includes('下单规则'), '撤回对象名称不得泄漏');

  // B. build 成功后撤回种子：读回整体拒绝（不返回片段），整次预取降级。
  const postWithdrawn = serverWith({ systems: [{ ...sampleShopSystem(), withdrawSeedsAfterBuild: true }], anchor: true });
  const recordB = await prefetch(postWithdrawn);
  assert.equal(recordB.outcome, 'degraded');
  assert.equal(recordB.context_ref, null);
  const ledger = new KnowledgePrefetchLedger();
  ledger.record(recordB);
  assert.equal(ledger.verifyReferences([{
    system_id: 'shop', scope: recordB.scope, snapshot_ref: 'snap-shop-2026-09-28',
    context_ref: 'ctx-fixture-fabricated', object_ids: ['shop.rule.refund'],
  }], binding).ok, false, '降级记录不能支撑任何引用');
});

test('ledger verifies full binding: wrong task/session/scope/revision/fabricated refs are all rejected', async () => {
  const client = serverWith({ systems: [sampleShopSystem()], anchor: true });
  const ledger = new KnowledgePrefetchLedger();
  const record = await prefetch(client);
  ledger.record(record);
  const refs = knowledgeRefsFromRecord(record);
  assert.equal(refs.length, 1);
  const good = refs[0];

  assert.deepEqual(ledger.verifyReferences(good ? [good] : [], binding), { ok: true });

  const fabricated = [{ ...good, context_ref: 'ctx-model-self-report' }];
  assert.equal(ledger.verifyReferences(fabricated, binding).ok, false);

  const wrongTask = [{ ...good }];
  assert.equal(ledger.verifyReferences(wrongTask, { taskId: 'other-task', sessionId: binding.sessionId }).ok, false, '错任务被拒');

  const wrongSession = [{ ...good }];
  assert.equal(ledger.verifyReferences(wrongSession, { taskId: binding.taskId, sessionId: 'other-session' }).ok, false, '错会话被拒');

  const wrongScope = [{ ...good, scope: 'role:开发' }];
  assert.equal(ledger.verifyReferences(wrongScope, binding).ok, false, '错角色/作用域被拒');

  const wrongSnapshot = [{ ...good, snapshot_ref: 'snap-not-the-fixed-one' }];
  assert.equal(ledger.verifyReferences(wrongSnapshot, binding).ok, false);

  const wrongSeeds = [{ ...good, requested_seed_ids: ['shop.rule.ghost'] }];
  assert.equal(ledger.verifyReferences(wrongSeeds, binding).ok, false, '种子声明不一致被拒');

  const wrongRevision = [{ ...good, object_revisions: { ...(good.object_revisions ?? {}), 'shop.rule.checkout': 99 } }];
  assert.equal(ledger.verifyReferences(wrongRevision, binding).ok, false, 'revision 不一致被拒');

  const nonCurrent = [{ ...good, object_ids: ['shop.rule.coupon-draft'], object_revisions: { 'shop.rule.coupon-draft': 1 } }];
  const nonCurrentCheck = ledger.verifyReferences(nonCurrent, binding);
  assert.equal(nonCurrentCheck.ok, false);
  // 未命中/非现行对象（draft 未入快照结果集）同样不得通过引用核验。
  if (!nonCurrentCheck.ok) assert.match(nonCurrentCheck.reason, /现行对象|不得作为现行事实/);
});

test('empty knowledge scope from bot config denies every system (runtime stays blocked by default)', async () => {
  const env = { APP_ID: 'app', APP_SECRET: 'secret' };
  const withoutScope = parseAgentOsConfig({
    teamLeader: 'product',
    bots: [{
      id: 'product', appIdEnv: 'APP_ID', appSecretEnv: 'APP_SECRET', defaultCli: 'claude',
      modelOverrides: {}, role: '产品',
    }],
  }, env);
  assert.deepEqual(withoutScope.bots[0].kbSystems, [], '缺省作用域为空：KB 预取按越权拒绝');
  const emptyIdentity = resolvePrefetchIdentity(withoutScope.bots[0]);
  assert.equal(emptyIdentity.ok, true);
  const client = serverWith({ systems: [sampleShopSystem()], anchor: true });
  await assert.rejects(
    prefetchKnowledgeContext({
      client, identity: emptyIdentity.ok ? emptyIdentity.identity : identity,
      systemId: 'shop', requirement, taskId: binding.taskId, sessionId: binding.sessionId,
    }),
    (error: unknown) => error instanceof KbCallError && error.kind === 'scope_denied',
  );
  assert.equal(client.calls.length, 0);
});

test('bot config carries a trusted kb scope binding (server-side only)', () => {
  const env = { APP_ID: 'app', APP_SECRET: 'secret' };
  const withScope = parseAgentOsConfig({
    teamLeader: 'product',
    bots: [{
      id: 'product', appIdEnv: 'APP_ID', appSecretEnv: 'APP_SECRET', defaultCli: 'claude',
      modelOverrides: {}, role: '产品', kbSystems: ['shop', 'crm'],
    }],
  }, env);
  assert.deepEqual(withScope.bots[0].kbSystems, ['shop', 'crm']);
});

test('identity resolution: role must come from server config; tenant stays blocked', () => {
  const ok = resolvePrefetchIdentity({ id: 'product', role: '产品', kbSystems: ['shop'] });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.identity.role, '产品');
    assert.equal(ok.identity.tenant, null);
    assert.deepEqual(ok.identity.blockedDimensions, ['tenant']);
  }
  const missingRole = resolvePrefetchIdentity({ id: 'product', kbSystems: ['shop'] });
  assert.equal(missingRole.ok, false);
  if (!missingRole.ok) assert.match(missingRole.reason, /无可信身份来源/);
});

test('runtime gate: multi-system consumption stays blocked with documented reasons', () => {
  assert.equal(KNOWLEDGE_RUNTIME_GATE.status, 'blocked');
  assert.ok(KNOWLEDGE_RUNTIME_GATE.reasons.length >= 2);
  assert.throws(() => assertKnowledgeRuntimeConsumptionAllowed(), /blocked/);
});

test('record helper: prefetch_id/scope/caller/task binding shape is auditable', async () => {
  const client = serverWith({ systems: [sampleShopSystem()], anchor: true });
  const record: PrefetchRecord = await prefetch(client);
  assert.match(record.prefetch_id, /^kbp_[0-9a-f]{32}$/);
  assert.equal(record.scope, 'role:产品');
  assert.equal(record.caller, 'agent-os:product');
  assert.equal(record.task_id, binding.taskId);
  assert.equal(record.session_id, binding.sessionId);
  assert.ok(record.audit.every((entry) => !Number.isNaN(Date.parse(entry.at))));
});

test('protocol negatives: caller self-report in args and empty impact seeds are rejected by the service contract', async () => {
  const client = serverWith({ systems: [sampleShopSystem()], anchor: true });
  const callerFrame = await client.call('search_knowledge', { system_id: 'shop', purpose: 'prd', mode: 'catalog', caller: 'agent-os:product' });
  assert.throws(
    () => decodeKbEnvelope('search_knowledge', callerFrame),
    (error: unknown) => error instanceof KbCallError && error.serverCode === 'invalid_argument',
  );
  const emptySeedsFrame = await client.call('analyze_change_impact', { system_id: 'shop', snapshot_ref: 'snap-shop-2026-09-28', seeds: [], change_intent: 'modify' });
  assert.throws(
    () => decodeKbEnvelope('analyze_change_impact', emptySeedsFrame),
    (error: unknown) => error instanceof KbCallError && error.serverCode === 'invalid_argument',
  );
});
