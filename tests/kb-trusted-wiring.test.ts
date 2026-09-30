import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  KnowledgePrefetchLedger,
  formatKnowledgeCitationToken,
  knowledgeUsageNotice,
  knowledgeRefsFromRecord,
  prefetchKnowledgeContext,
  resolvePrefetchIdentity,
  runTrustedKnowledgePrefetch,
  verifyArtifactCitations,
  verifyDeliverableCitations,
} from '../src/core/kb-prefetch.js';
import { FixtureKbMcpServer, sampleShopSystem, type FixtureKbSystem } from './fixtures/kb/fixture-kb-client.js';
import { SessionManager } from '../src/core/session-manager.js';
import { TeamRegistry } from '../src/core/team-registry.js';
import { ClarificationFlowStore } from '../src/core/clarification.js';
import { ProductSpecFlowStore, type ProductSpecFlow } from '../src/core/product-spec.js';
import { JsonProductSpecFlowStore } from '../src/core/product-spec-store.js';
import { CollaborationInbox } from '../src/core/collaboration.js';
import { createCardActionHandler } from '../src/app/card-action-handler.js';
import { resolveResultCard } from '../src/app/result-delivery.js';
import { createBoundProductSpecFlow } from '../src/app/product-spec-creation.js';
import { computeLocalArtifactDigest, verifyApprovableArtifact } from '../src/core/artifact-digest.js';
import { buildProductSpecApprovalCard } from '../src/im/card.js';
import { type BotConfig } from '../src/core/bot-registry.js';
import type { AppRuntime } from '../src/app/runtime.js';
import type { CardAction } from '../src/im/lark.js';

/**
 * T-016/017 本地可信接线：服务端身份 → 预取 → 裁剪副本 → 服务端持有 refs 绑定
 * 任务/会话/审批 flow → G1 引用核验。全部使用本地 fixture（真实 kb-mcp 契约
 * 形状）与 mkdtemp 临时目录；运行态与飞书保持 blocked，不构成生产验收。
 */

const binding = { taskId: 'task-kb', sessionId: 'session-kb' };
const requirement = '优化下单流程的退款体验，涉及订单模块';

function mkdirFx(dir: string): string {
  // W6b 后本地制品必须位于任务 scratch 子树内（fixture 以 .fx 为 scratch 根）。
  mkdirSync(join(dir, '.fx'), { recursive: true });
  return join(dir, '.fx');
}

const localRequest = {
  title: '方案',
  summary: '说明',
  deliveryMode: 'local' as const,
  specPath: '.fx/spec.md',
  ticketsPath: '.fx/tickets',
};

async function trustedBundle(taskId = binding.taskId, sessionId = binding.sessionId, query = requirement) {
  const client = new FixtureKbMcpServer({ systems: [sampleShopSystem()], simulateTrustedCurrentAnchor: true });
  const bundle = await runTrustedKnowledgePrefetch({
    client,
    bot: { id: 'product', role: '产品', kbSystems: ['shop'] },
    systemId: 'shop',
    requirement: query,
    taskId,
    sessionId,
  });
  return bundle;
}

test('trusted wiring: server identity → prefetch → pruned copy → refs bound to task/session', async () => {
  const bundle = await trustedBundle();
  assert.equal(bundle.record.outcome, 'ok');
  assert.equal(bundle.knowledgeState, 'ok');
  assert.ok(bundle.pruned, '有现行对象时必须产出裁剪副本');
  assert.equal(bundle.refs.length, 1);
  const ref = bundle.refs[0];
  assert.equal(ref.system_id, 'shop');
  assert.equal(ref.scope, 'role:产品');
  assert.ok(ref.context_ref);
  assert.deepEqual(Object.keys(ref.object_revisions ?? {}).sort(),
    ['shop.module.order', 'shop.rule.checkout', 'shop.rule.refund']);
  assert.deepEqual(ref.requested_seed_ids, ['shop.rule.checkout', 'shop.rule.refund', 'shop.module.order']);
  const serialized = JSON.stringify(bundle.pruned);
  assert.ok(!serialized.includes('KB_') && !serialized.includes('kb-mcp'));
});

test('trusted wiring without a trusted anchor yields no refs and an explicit notice', async () => {
  const client = new FixtureKbMcpServer({ systems: [sampleShopSystem()] });
  const bundle = await runTrustedKnowledgePrefetch({
    client,
    bot: { id: 'product', role: '产品', kbSystems: ['shop'] },
    systemId: 'shop',
    requirement,
    ...binding,
  });
  // W5 四轮：已有项目零现行对象是独立可持久化状态，不再误标 ok。
  assert.equal(bundle.knowledgeState, 'no_current_objects');
  assert.equal(bundle.pruned, null);
  assert.deepEqual(bundle.refs, []);
});

test('artifact citations: tokens in local artifact files verify against the ledger, fabrication fails closed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-kb-wire-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundle = await trustedBundle();
  const ledger = new KnowledgePrefetchLedger();
  ledger.record(bundle.record);
  // 补充一份命中 draft 对象的预取记录（同一 ledger），供非现行引用负例使用。
  const draftBundle = await trustedBundle('task-kb', 'session-kb', '优惠券规则');
  ledger.record(draftBundle.record);
  const ref = bundle.refs[0];

  const tokenFor = (objectId: string) => formatKnowledgeCitationToken({
    system_id: 'shop', object_id: objectId, revision: ref.object_revisions![objectId], snapshot_ref: ref.snapshot_ref,
  });
  writeFileSync(join(mkdirFx(dir), 'spec.md'), `# 方案\n\n基于 ${tokenFor('shop.rule.checkout')} 与 ${tokenFor('shop.rule.refund')}。\n`);
  mkdirSync(join(dir, '.fx', 'tickets'), { recursive: true });
  writeFileSync(join(dir, '.fx', 'tickets', 't1.md'), `## 需求 1\n\n涉及 ${tokenFor('shop.module.order')}。\n`);

  const texts = [
    await readFile(join(dir, '.fx', 'spec.md'), 'utf8'),
    await readFile(join(dir, '.fx', 'tickets', 't1.md'), 'utf8'),
  ];
  const verified = verifyArtifactCitations({ artifactTexts: texts, declaredRefs: bundle.refs, ledger, binding });
  assert.equal(verified.ok, true);
  assert.equal(verified.citations.length, 3);

  // 伪造引用（台账外 snapshot/对象）失败关闭。
  const forged = verifyArtifactCitations({
    artifactTexts: [`见 ${formatKnowledgeCitationToken({ system_id: 'shop', object_id: 'shop.rule.ghost', revision: 1, snapshot_ref: ref.snapshot_ref })}`],
    declaredRefs: [],
    ledger,
    binding,
  });
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.match(forged.reason, /未在声明|不在|不可解析/);

  // 错 revision：revision_mismatch。
  const wrongRevision = verifyArtifactCitations({
    artifactTexts: [`见 ${formatKnowledgeCitationToken({ system_id: 'shop', object_id: 'shop.rule.checkout', revision: 99, snapshot_ref: ref.snapshot_ref })}`],
    declaredRefs: [{ ...ref, object_ids: ['shop.rule.checkout'], object_revisions: { 'shop.rule.checkout': ref.object_revisions!['shop.rule.checkout'] } }],
    ledger,
    binding,
  });
  assert.equal(wrongRevision.ok, false);
  if (!wrongRevision.ok) assert.match(wrongRevision.reason, /revision/);

  // 声明了但正文没引用（绑定与实际内容不一致）。
  const declaredNotCited = verifyArtifactCitations({ artifactTexts: ['正文没有引用。'], declaredRefs: bundle.refs, ledger, binding });
  assert.equal(declaredNotCited.ok, false);
  if (!declaredNotCited.ok) assert.match(declaredNotCited.reason, /未出现在制品正文中/);

  // 正文引用了但 refs 未声明（绑定不完整）；object_revisions 须与缩减后的
  // object_ids 同步裁剪，否则先触发「声明了未引用对象的 revision」。
  const citedNotDeclared = verifyArtifactCitations({
    artifactTexts: texts,
    declaredRefs: [{
      ...ref,
      object_ids: ['shop.rule.checkout'],
      object_revisions: { 'shop.rule.checkout': ref.object_revisions!['shop.rule.checkout'] },
    }],
    ledger,
    binding,
  });
  assert.equal(citedNotDeclared.ok, false);
  if (!citedNotDeclared.ok) assert.match(citedNotDeclared.reason, /未在声明/);

  // 无运行时台账：一切引用失败关闭。
  const noLedger = verifyDeliverableCitations([{ system_id: 'shop', object_id: 'shop.rule.checkout', revision: 3, snapshot_ref: ref.snapshot_ref }], new KnowledgePrefetchLedger(), binding);
  assert.equal(noLedger[0].status, 'snapshot_mismatch');

  // 非现行对象（draft）引用被拒并标注。
  const draftCitation = verifyDeliverableCitations([{ system_id: 'shop', object_id: 'shop.rule.coupon-draft', revision: 1, snapshot_ref: ref.snapshot_ref }], ledger, binding);
  assert.equal(draftCitation[0].status, 'not_current_rejected');
  assert.match(draftCitation[0].note, /不得作为现行事实/);
});

test('G1 integration: knowledge refs bound to the approving task/session verify; wrong binding or missing ledger rejects', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-kb-g1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config: BotConfig = {
    id: 'product', appId: 'app', appSecret: 'test', defaultCliId: 'claude', modelOverrides: {},
    workspaceDir: dir, role: '产品', skills: ['lark-doc'], systemPrompt: '', collaborationMaxRounds: 16,
  };
  const leader: BotConfig = { ...config, id: 'leader', skills: [] };
  const bot = { reply: async () => 'text', replyCard: async () => 'card', replyMention: async () => 'notice', updateCard: async () => {}, replyToDocumentComment: async () => {}, setDocumentCommentWorking: async () => {} } as never;
  const sessions = new SessionManager();
  const { session } = await sessions.resolve({ chatId: 'chat', threadId: 'thread', rootId: 'root', messageId: 'msg' }, 'claude', config.id, dir);
  await sessions.transition(session.id, 'idle');
  const runtime: AppRuntime = {
    sessions,
    teamRegistry: new TeamRegistry('leader', [leader, config]),
    activeRuns: new Map(),
    contextWindows: new Map(),
    botRuntimes: new Map(),
    processedCollaborationTurns: new Set(),
  sessionScratches: new Map(),
    collaborationInbox: new CollaborationInbox(),
    clarificationFlows: new ClarificationFlowStore(),
    productSpecFlows: new ProductSpecFlowStore(),
  };
  for (const cfg of [config, leader]) runtime.botRuntimes.set(cfg.id, { config: cfg, bot, identity: { openId: `bot-${cfg.id}`, name: cfg.id } });

  // 制品文件包含与台账一致的结构化引用令牌。
  const bundle = await trustedBundle('task-g1', session.id);
  const ledger = new KnowledgePrefetchLedger();
  ledger.record(bundle.record);
  const ref = bundle.refs[0];
  const tokenFor = (objectId: string) => formatKnowledgeCitationToken({
    system_id: 'shop', object_id: objectId, revision: ref.object_revisions![objectId], snapshot_ref: ref.snapshot_ref,
  });
  writeFileSync(join(mkdirFx(dir), 'spec.md'), `# 方案\n\n基于 ${tokenFor('shop.rule.checkout')}。\n`);
  mkdirSync(join(dir, '.fx', 'tickets'), { recursive: true });
  writeFileSync(join(dir, '.fx', 'tickets', 't1.md'), `## 需求 1\n\n涉及 ${tokenFor('shop.module.order')} 与 ${tokenFor('shop.rule.refund')}。\n`);
  const digest = await computeLocalArtifactDigest(dir, localRequest);

  const createFlow = (knowledgeRefs: ProductSpecFlow['knowledge_refs'], flowDigest = digest): ProductSpecFlow => runtime.productSpecFlows.create({
    taskId: 'task-g1', botId: 'product', sessionId: session.id, sessionVersion: session.version ?? 0,
    ownerOpenId: 'owner', ownerUnionId: 'union-owner', ownerBotId: 'product',
    request: localRequest,
    content_digest: flowDigest.digest,
    digest_algorithm: 'canonical-sha256-v1',
    content_sources: flowDigest.content_sources,
    knowledge_refs: knowledgeRefs ?? [],
    knowledge_state: 'ok',
  });
  const handler = createCardActionHandler({ runtime, config, defaultProductDeliveryMode: 'lark-doc' });
  const action = (token: string): CardAction => ({
    messageId: 'approval-card', operatorOpenId: 'owner', operatorUnionId: 'union-owner', formValue: {},
    value: { action: 'approve_product_spec', flowToken: token },
  });

  // ① 绑定一致：审批通过。
  runtime.knowledgePrefetch = ledger;
  const good = createFlow(bundle.refs);
  const approved = await handler(action(good.token));
  assert.equal(approved?.toast?.type, 'success');
  assert.equal(runtime.productSpecFlows.get(good.token)?.status, 'approved');

  // ② 引用绑定的会话与审批流不一致（漏绑定/错会话）：拒绝，保持 pending。
  const otherSession = await trustedBundle('task-g1', 'session-other');
  ledger.record(otherSession.record);
  const mismatched = createFlow(otherSession.refs);
  const rejected = await handler(action(mismatched.token));
  assert.equal(rejected?.toast?.type, 'warning');
  assert.match(rejected?.toast?.content ?? '', /任务\/会话|不一致|跨任务/);
  assert.equal(runtime.productSpecFlows.get(mismatched.token)?.status, 'pending');

  // ③ 声明了引用但没有运行时台账（knowledgePrefetch 缺失）：失败关闭。
  runtime.knowledgePrefetch = undefined;
  const noLedgerFlow = createFlow(bundle.refs);
  const noLedger = await handler(action(noLedgerFlow.token));
  assert.equal(noLedger?.toast?.type, 'error');
  assert.match(noLedger?.toast?.content ?? '', /台账不可用|核验/);
  assert.equal(runtime.productSpecFlows.get(noLedgerFlow.token)?.status, 'pending');

  // ④ 空 refs + 正文令牌（work/44-4）：正文实际引用未声明 → 拒绝，保持 pending。
  runtime.knowledgePrefetch = ledger;
  writeFileSync(join(dir, '.fx', 'tickets', 't2.md'), `## 需求 2\n\n伪造 ${tokenFor('shop.rule.checkout')}。\n`);
  const tokenWithoutRefs = createFlow([], await computeLocalArtifactDigest(dir, localRequest));
  const undeclared = await handler(action(tokenWithoutRefs.token));
  assert.equal(undeclared?.toast?.type, 'warning', '空 refs 不能靠正文令牌获签');
  assert.match(undeclared?.toast?.content ?? '', /未在声明|核验未通过/);
  assert.equal(runtime.productSpecFlows.get(tokenWithoutRefs.token)?.status, 'pending');
});

test('creation point (work/44-4): citations in the artifact must verify before a flow is created; no verifier fails closed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-kb-create-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bundle = await trustedBundle('task-create', 'session-create');
  const ledger = new KnowledgePrefetchLedger();
  ledger.record(bundle.record);
  const ref = bundle.refs[0];
  const token = formatKnowledgeCitationToken({
    system_id: 'shop', object_id: 'shop.rule.checkout', revision: ref.object_revisions!['shop.rule.checkout'], snapshot_ref: ref.snapshot_ref,
  });
  writeFileSync(join(mkdirFx(dir), 'spec.md'), `# 方案\n\n基于 ${token}。\n`);
  mkdirSync(join(dir, '.fx', 'tickets'), { recursive: true });
  writeFileSync(join(dir, '.fx', 'tickets', 't1.md'), `## 需求 1\n\n涉及 ${formatKnowledgeCitationToken({ system_id: 'shop', object_id: 'shop.rule.refund', revision: ref.object_revisions!['shop.rule.refund'], snapshot_ref: ref.snapshot_ref })} 与 ${formatKnowledgeCitationToken({ system_id: 'shop', object_id: 'shop.module.order', revision: ref.object_revisions!['shop.module.order'], snapshot_ref: ref.snapshot_ref })}。\n`);
  const store = new ProductSpecFlowStore();
  const identity = {
    taskId: 'task-create', botId: 'product', sessionId: 'session-create',
    ownerOpenId: 'owner', ownerUnionId: 'union-owner', ownerBotId: 'product',
  };
  const verifyWithLedger = ({ artifactTexts, declaredRefs }: { artifactTexts: readonly string[]; declaredRefs: typeof bundle.refs }) =>
    verifyArtifactCitations({ artifactTexts, declaredRefs, ledger, binding: { taskId: 'task-create', sessionId: 'session-create' } });

  // 无核验通道：正文令牌存在 → 提交失败关闭，不生成 flow。
  await assert.rejects(
    createBoundProductSpecFlow({ store, workspaceDir: dir, scratchRoot: '.fx', identity, request: localRequest }),
    /引用核验通道不可用/,
  );
  assert.equal(store.forSession('session-create').length, 0);

  // 核验失败（声明与正文不一致：声明子集且裁剪 revisions）：提交失败关闭。
  await assert.rejects(
    createBoundProductSpecFlow({
      store, workspaceDir: dir, scratchRoot: '.fx', identity, request: localRequest,
      knowledge: {
        refs: [{
          ...ref,
          object_ids: ['shop.rule.checkout'],
          object_revisions: { 'shop.rule.checkout': ref.object_revisions!['shop.rule.checkout'] },
        }],
        state: 'ok',
      },
      verifyCitations: verifyWithLedger,
    }),
    /未在声明|未出现在制品正文中|核验未通过/,
  );

  // 声明与正文一致且核验通过：创建成功并绑定 digest 与 refs。
  const flow = await createBoundProductSpecFlow({
    scratchRoot: '.fx',
    store, workspaceDir: dir, identity, request: localRequest,
    knowledge: { refs: bundle.refs, state: 'ok' },
    verifyCitations: verifyWithLedger,
  });
  assert.ok(flow.content_digest);
  assert.deepEqual(flow.knowledge_refs, bundle.refs);

  // 无令牌且无声明：不要求核验通道（生产行为）。
  const plainDir = mkdtempSync(join(tmpdir(), 'agent-os-kb-plain-'));
  t.after(() => rmSync(plainDir, { recursive: true, force: true }));
  writeFileSync(join(mkdirFx(plainDir), 'spec.md'), '# 方案\n');
  mkdirSync(join(plainDir, '.fx', 'tickets'), { recursive: true });
  writeFileSync(join(plainDir, '.fx', 'tickets', 't1.md'), '## 需求 1\n');
  const plain = await createBoundProductSpecFlow({ store, workspaceDir: plainDir, scratchRoot: '.fx', identity, request: localRequest });
  assert.ok(plain.content_digest);
  assert.deepEqual(plain.knowledge_refs, []);
});

test('display: legacy approved without digest and invalidated flows are shown as unusable, never as valid approvals', async () => {
  const config: BotConfig = {
    id: 'product', appId: 'app', appSecret: 'test', defaultCliId: 'claude', modelOverrides: {},
    workspaceDir: '.', role: '产品', skills: [], systemPrompt: '', collaborationMaxRounds: 16,
  };
  const leader: BotConfig = { ...config, id: 'leader' };
  const sessions = new SessionManager();
  const { session } = await sessions.resolve({ chatId: 'c', threadId: 'thread', rootId: 'root', messageId: 'm' }, 'claude', config.id, '.');
  await sessions.transition(session.id, 'idle');
  const runtime: AppRuntime = {
    sessions,
    teamRegistry: new TeamRegistry('leader', [leader, config]),
    activeRuns: new Map(), contextWindows: new Map(), botRuntimes: new Map(),
    processedCollaborationTurns: new Set(),
  sessionScratches: new Map(), collaborationInbox: new CollaborationInbox(),
    clarificationFlows: new ClarificationFlowStore(), productSpecFlows: new ProductSpecFlowStore(),
  };
  const bot = { reply: async () => 't', replyCard: async () => 'c', replyMention: async () => 'n', updateCard: async () => {} } as never;
  for (const cfg of [config, leader]) runtime.botRuntimes.set(cfg.id, { config: cfg, bot, identity: { openId: `bot-${cfg.id}`, name: cfg.id } });
  const store = runtime.productSpecFlows;
  const createFlow = (digest: string | null) => store.create({
    taskId: 'task-d', botId: 'product', sessionId: session.id, sessionVersion: session.version ?? 0,
    ownerOpenId: 'owner', ownerUnionId: 'union-owner', ownerBotId: 'product', request: localRequest, content_digest: digest,
  });
  const legacy = createFlow(null);
  store.approve(legacy.token, 'card-old');
  const invalidated = createFlow('a'.repeat(64));
  store.approve(invalidated.token, 'card-inv');
  store.invalidate(invalidated.token, '外部编辑导致摘要漂移');

  const handler = createCardActionHandler({ runtime, config, defaultProductDeliveryMode: 'lark-doc' });
  const action = (token: string): CardAction => ({
    messageId: 'approval-card', operatorOpenId: 'owner', operatorUnionId: 'union-owner', formValue: {},
    value: { action: 'approve_product_spec', flowToken: token },
  });

  const legacyAgain = await handler(action(legacy.token));
  assert.equal(legacyAgain?.toast?.type, 'warning');
  assert.match(JSON.stringify(legacyAgain?.card), /确认记录不可用|不能作为有效版本/);

  const invalidatedAgain = await handler(action(invalidated.token));
  assert.equal(invalidatedAgain?.toast?.type, 'warning');
  assert.match(JSON.stringify(invalidatedAgain?.card), /失效/);
  assert.equal(store.get(invalidated.token)?.status, 'invalidated');

  // 补发渲染（resolveResultCard）同样不得把失效/未绑定确认展示为可用版本。
  const legacyCard = JSON.stringify(resolveResultCard(runtime, { type: 'card', messageId: 'card-old', card: {}, flow: { kind: 'product', token: legacy.token } }));
  assert.match(legacyCard, /确认记录不可用/);
  assert.ok(!legacyCard.includes('产品阶段已就绪'));
  const invalidatedCard = JSON.stringify(resolveResultCard(runtime, { type: 'card', messageId: 'card-inv', card: {}, flow: { kind: 'product', token: invalidated.token } }));
  assert.match(invalidatedCard, /确认记录不可用|已失效/);
  assert.ok(!invalidatedCard.includes('产品阶段已就绪'));
});

test('work/45-3: two ledger records with the same object cannot be mixed across snapshots', async () => {
  // 记录 A：默认样例系统（snap-shop-2026-09-28）。
  const bundleA = await trustedBundle();
  // 记录 B：同 task/session/system 的另一快照，含同名对象（不同 revision）。
  const systemB: FixtureKbSystem = {
    systemId: 'shop',
    activeSnapshot: 'snap-shop-other-day',
    objects: [
      { id: 'shop.rule.checkout', revision: 7, kind: 'rule', name: '下单规则', publication_status: 'published', verification_status: 'verified', usable_as_current: true, summary: '另一快照版本。' },
    ],
  };
  const identityB = resolvePrefetchIdentity({ id: 'product', role: '产品', kbSystems: ['shop'] });
  assert.equal(identityB.ok, true);
  const recordB = await prefetchKnowledgeContext({
    client: new FixtureKbMcpServer({ systems: [systemB], simulateTrustedCurrentAnchor: true }),
    identity: identityB.ok ? identityB.identity : undefined!,
    systemId: 'shop',
    requirement: '下单规则',
    taskId: binding.taskId,
    sessionId: binding.sessionId,
  });
  assert.equal(recordB.outcome, 'ok');
  const ledger = new KnowledgePrefetchLedger();
  ledger.record(bundleA.record);
  ledger.record(recordB);

  const cite = (snapshotRef: string, revision: number) => formatKnowledgeCitationToken({
    system_id: 'shop', object_id: 'shop.rule.checkout', revision, snapshot_ref: snapshotRef,
  });
  // 声明 A、正文引用 B 的快照/revision → 拒绝（不允许不同快照混搭）。
  const mixed = verifyArtifactCitations({
    artifactTexts: [`见 ${cite('snap-shop-other-day', 7)}`],
    declaredRefs: bundleA.refs,
    ledger,
    binding,
  });
  assert.equal(mixed.ok, false);
  if (!mixed.ok) assert.match(mixed.reason, /未在声明的引用绑定内|快照或对象不匹配/);
  // 反向同理：声明 B、正文引用 A → 拒绝。
  const refsB = knowledgeRefsFromRecord(recordB);
  const reversed = verifyArtifactCitations({
    artifactTexts: [`见 ${cite('snap-shop-2026-09-28', 3)}`],
    declaredRefs: refsB,
    ledger,
    binding,
  });
  assert.equal(reversed.ok, false);
  if (!reversed.ok) assert.match(reversed.reason, /未在声明的引用绑定内|快照或对象不匹配/);
  // 对照：声明与正文同一快照、全部对象与 revision 一致 → 通过。
  const refA = bundleA.refs[0];
  const allTokensA = refA.object_ids.map((id) => formatKnowledgeCitationToken({
    system_id: 'shop', object_id: id, revision: refA.object_revisions![id], snapshot_ref: refA.snapshot_ref,
  })).join(' 与 ');
  const consistent = verifyArtifactCitations({
    artifactTexts: [`见 ${allTokensA}`],
    declaredRefs: bundleA.refs,
    ledger,
    binding,
  });
  assert.deepEqual(consistent.ok, true);
});

test('work/45-4: refs missing object_revisions or requested_seed_ids are rejected (no partial binding)', async () => {
  const bundle = await trustedBundle();
  const ledger = new KnowledgePrefetchLedger();
  ledger.record(bundle.record);
  const good = bundle.refs[0];
  assert.equal(ledger.verifyReferences([good], binding).ok, true);

  const noRevisions = [{ ...good }];
  delete noRevisions[0].object_revisions;
  const checkA = ledger.verifyReferences(noRevisions, binding);
  assert.equal(checkA.ok, false);
  if (!checkA.ok) assert.match(checkA.reason, /缺少对象 revision 绑定/);

  const noSeeds = [{ ...good }];
  delete noSeeds[0].requested_seed_ids;
  const checkB = ledger.verifyReferences(noSeeds, binding);
  assert.equal(checkB.ok, false);
  if (!checkB.ok) assert.match(checkB.reason, /缺少种子清单绑定/);
});

test('work/45-2: malformed [[kb: tokens fail closed at submission even with a verifier available', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-kb-malformed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(mkdirFx(dir), 'spec.md'), '# 方案\n\n见 [[kb:shop|shop.rule.checkout@x|snap-shop-1]] 与未闭合 [[kb:shop|obj。\n');
  mkdirSync(join(dir, '.fx', 'tickets'), { recursive: true });
  writeFileSync(join(dir, '.fx', 'tickets', 't1.md'), '## 需求 1\n');
  const store = new ProductSpecFlowStore();
  const identity = { taskId: 't-m', botId: 'product', sessionId: 's-m', ownerOpenId: 'owner' };
  await assert.rejects(
    createBoundProductSpecFlow({
      store, workspaceDir: dir, scratchRoot: '.fx', identity, request: localRequest,
      verifyCitations: () => ({ ok: true }),
    }),
    /畸形/,
  );
  assert.equal(store.forSession('s-m').length, 0, '畸形令牌不得生成确认 flow');
});

test('work/47-3: 读回时现行对象清空 → 无现行引用、明确证据缺口，FlowStore 持久化+重载稳定', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-kb-drop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // fixture 在 build 与 get_knowledge 之间翻转 availability：搜索时种子 current，
  // 读回时全部降为 non-current（真实 get_knowledge 重评语义）。
  const system: FixtureKbSystem = { ...sampleShopSystem(), readBackDropsCurrent: true };
  const bundle = await runTrustedKnowledgePrefetch({
    client: new FixtureKbMcpServer({ systems: [system], simulateTrustedCurrentAnchor: true }),
    bot: { id: 'product', role: '产品', kbSystems: ['shop'] },
    systemId: 'shop',
    requirement,
    ...binding,
  });
  assert.equal(bundle.record.outcome, 'ok');
  assert.ok(bundle.record.context_ref, '协议成功、context_ref 存在（不误导为 degraded/新项目）');
  assert.deepEqual(bundle.record.current_objects, [], '读回后不得把旧对象当现行');
  assert.ok(bundle.record.evidence_gaps.includes('no_current_objects'));
  assert.ok(bundle.record.excluded_objects.length >= 3, '旧种子逐条进入排除清单（读回降级原因）');
  assert.ok(bundle.record.excluded_objects.every((object) => !object.availability.usable_as_current));
  assert.deepEqual(bundle.refs, [], '零现行对象不产出 object_ids 为空的 ref（schema min(1) 不可持久化）');
  assert.equal(bundle.pruned, null);
  assert.match(knowledgeUsageNotice(bundle.record), /不得引用任何现行事实/);

  // 持久化稳定性：refs=[] 的 flow 落盘后重载不抛错（旧实现会持久化空 ref 使下次加载崩溃）。
  const store = new JsonProductSpecFlowStore(join(dir, 'flows.json'));
  const flow = store.create({
    taskId: binding.taskId, botId: 'product', sessionId: binding.sessionId,
    ownerOpenId: 'owner', request: localRequest,
    content_digest: 'a'.repeat(64), knowledge_refs: bundle.refs, knowledge_state: bundle.knowledgeState,
  });
  const reloaded = new JsonProductSpecFlowStore(join(dir, 'flows.json')).get(flow.token)!;
  assert.deepEqual(reloaded.knowledge_refs, []);
  // W5 四轮：该场景落盘为独立状态 no_current_objects（不再是 ok）。
  assert.equal(reloaded.knowledge_state, 'no_current_objects');
});

test('work/49-3: 真实内容寻址复用——相同内容同 ref，两任务各有所得，第三任务被拒', async () => {
  // 真实语义：两个任务以完全相同的系统内容预取 ⇒ 相同 canonical JSON ⇒
  // 相同 context_ref（fixedContextRef 模拟 store.save 内容寻址）。
  const run = (taskId: string, sessionId: string) => runTrustedKnowledgePrefetch({
    client: new FixtureKbMcpServer({
      systems: [{ ...sampleShopSystem(), fixedContextRef: 'ctx-shared-ref' }],
      simulateTrustedCurrentAnchor: true,
    }),
    bot: { id: 'product', role: '产品', kbSystems: ['shop'] },
    systemId: 'shop',
    requirement,
    taskId,
    sessionId,
  });
  const bundle1 = await run('task-1', 'session-1');
  const bundle2 = await run('task-2', 'session-2');
  assert.equal(bundle1.record.context_ref, 'ctx-shared-ref');
  assert.equal(bundle2.record.context_ref, 'ctx-shared-ref');

  const ledger = new KnowledgePrefetchLedger();
  ledger.record(bundle1.record);
  ledger.record(bundle2.record);
  assert.equal(ledger.byContextRef('ctx-shared-ref').length, 2, '同 ref 双任务记录互不覆盖');
  assert.deepEqual(ledger.verifyReferences(bundle1.refs, { taskId: 'task-1', sessionId: 'session-1' }), { ok: true });
  assert.deepEqual(ledger.verifyReferences(bundle2.refs, { taskId: 'task-2', sessionId: 'session-2' }), { ok: true });
  // 没有自己记录的第三任务必须拒绝（跨任务串用）。
  const third = ledger.verifyReferences(bundle1.refs, { taskId: 'task-3', sessionId: 'session-3' });
  assert.equal(third.ok, false);
  if (!third.ok) assert.match(third.reason, /跨任务|不在当前任务/);
});

test('work/49-3: 复合键无歧义——分隔符碰撞（"a b"+"c" vs "a"+"b c"）不覆盖不串用', async () => {
  // 人工碰撞压力场景：同 ref、不同内容（真实内容寻址下不同内容必得不同 ref，
  // 此处强制同 ref 以验证键编码本身无歧义）。
  const run = (system: FixtureKbSystem, taskId: string, sessionId: string) => runTrustedKnowledgePrefetch({
    client: new FixtureKbMcpServer({ systems: [system], simulateTrustedCurrentAnchor: true }),
    bot: { id: 'product', role: '产品', kbSystems: ['shop'] },
    systemId: 'shop',
    requirement,
    taskId,
    sessionId,
  });
  const bundleA = await run({ ...sampleShopSystem(), fixedContextRef: 'ctx-collide' }, 'a b', 'c');
  const bundleB = await run({
    ...sampleShopSystem(),
    fixedContextRef: 'ctx-collide',
    objects: sampleShopSystem().objects!.filter((object) => object.id !== 'shop.module.order'),
  }, 'a', 'b c');
  assert.equal(bundleA.record.context_ref, 'ctx-collide');
  assert.equal(bundleB.record.context_ref, 'ctx-collide');

  const ledger = new KnowledgePrefetchLedger();
  ledger.record(bundleA.record);
  ledger.record(bundleB.record);
  // 旧空格拼接键下这两条记录会碰撞覆盖；JSON tuple 键下互不覆盖。
  assert.equal(ledger.byContextRef('ctx-collide').length, 2);
  assert.deepEqual(ledger.verifyReferences(bundleA.refs, { taskId: 'a b', sessionId: 'c' }), { ok: true });
  assert.deepEqual(ledger.verifyReferences(bundleB.refs, { taskId: 'a', sessionId: 'b c' }), { ok: true });
  const crossed = ledger.verifyReferences(bundleA.refs, { taskId: 'a', sessionId: 'b c' });
  assert.equal(crossed.ok, false, '同 ref 下绑定到他人记录的引用不得串用（A 的 3 对象不在 B 记录内）');
  if (!crossed.ok) assert.match(crossed.reason, /现行对象集|种子|不得/);
  assert.ok(ledger.get('ctx-collide', { taskId: 'a b', sessionId: 'c' }));
  assert.ok(ledger.get('ctx-collide', { taskId: 'a', sessionId: 'b c' }));
});

test('work/49-2: no_current_objects 全链路——预取→flow 落盘/重载→卡片/G1 都不静默放行', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-kb-nc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(mkdirFx(dir), 'spec.md'), '# 方案\n\n读回后无现行对象。\n');
  mkdirSync(join(dir, '.fx', 'tickets'), { recursive: true });
  writeFileSync(join(dir, '.fx', 'tickets', 't1.md'), '## 需求 1\n\n按历史资料标注。');

  const bundle = await runTrustedKnowledgePrefetch({
    client: new FixtureKbMcpServer({
      systems: [{ ...sampleShopSystem(), readBackDropsCurrent: true }],
      simulateTrustedCurrentAnchor: true,
    }),
    bot: { id: 'product', role: '产品', kbSystems: ['shop'] },
    systemId: 'shop',
    requirement,
    taskId: 'task-nc',
    sessionId: 'session-nc',
  });
  assert.equal(bundle.knowledgeState, 'no_current_objects', '不得与 ok/新项目混同');
  assert.deepEqual(bundle.refs, []);

  // flow 创建（真实摘要绑定 + 知识状态）→ 落盘 → 重载后状态不丢失。
  const digest = await computeLocalArtifactDigest(dir, localRequest);
  const store = new JsonProductSpecFlowStore(join(dir, 'flows.json'));
  const flow = store.create({
    taskId: 'task-nc', botId: 'product', sessionId: 'session-nc', ownerOpenId: 'owner',
    request: localRequest, content_digest: digest.digest, digest_algorithm: 'canonical-sha256-v1',
    content_sources: digest.content_sources, knowledge_refs: bundle.refs, knowledge_state: bundle.knowledgeState,
  });
  const reloaded = new JsonProductSpecFlowStore(join(dir, 'flows.json')).get(flow.token)!;
  assert.equal(reloaded.knowledge_state, 'no_current_objects', '状态经持久化/重载不丢失');
  assert.deepEqual(reloaded.knowledge_refs, []);

  // 确认卡：blocked 原因 + 无确认按钮。
  const card = JSON.stringify(buildProductSpecApprovalCard(reloaded));
  assert.match(card, /no_current_objects/);
  assert.match(card, /不得引用现行事实/);
  assert.ok(!card.includes('确认产品方案'), 'no_current_objects 的 flow 不得出现确认按钮');

  // G1：即使 refs 为空（无引用需核验）也因状态被拒，绝不静默放行。
  const gate = await verifyApprovableArtifact({ flow: reloaded, workspaceDir: dir });
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.match(gate.message, /no_current_objects|不得引用现行事实/);
});
