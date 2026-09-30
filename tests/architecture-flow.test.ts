import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArchitectureReviewToolRequestSchema,
  findArchitectureRequest,
  productDocumentToken,
  type KnowledgeRef,
} from '../src/core/product-spec.js';
import { ProductSpecFlowStore, type ProductSpecFlow } from '../src/core/product-spec.js';
import { JsonProductSpecFlowStore } from '../src/core/product-spec-store.js';
import { computeArchitectureArtifactDigest, computeLocalArtifactDigest } from '../src/core/artifact-digest.js';
import {
  ArchitectureHandoffStore,
  openArchitectureHandoff,
} from '../src/core/architecture-handoff.js';
import { createBoundArchitectureFlow } from '../src/app/architecture-flow.js';
import { createBoundProductSpecFlow } from '../src/app/product-spec-creation.js';
import { KnowledgePrefetchLedger, formatKnowledgeCitationToken, type PrefetchRecord } from '../src/core/kb-prefetch.js';
import { ArtifactMonitor } from '../src/app/artifact-monitor.js';
import { SessionManager } from '../src/core/session-manager.js';
import { TeamRegistry } from '../src/core/team-registry.js';
import { createCardActionHandler } from '../src/app/card-action-handler.js';
import type { CardAction } from '../src/im/lark.js';
import type { AppRuntime } from '../src/app/runtime.js';
import type { BotConfig } from '../src/core/bot-registry.js';
import { buildBotPrompt } from '../src/core/bot-registry.js';

const localProductRequest = {
  title: '会员价方案',
  summary: '下单展示会员价。',
  deliveryMode: 'local' as const,
  specPath: '.fx/spec.md',
  ticketsPath: '.fx/tickets',
};

function temp(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-archflow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeProductWorkspace(dir: string): void {
  // W6b 后本地制品必须位于任务 scratch 子树内（fixture 以 .fx 为 scratch 根）。
  mkdirSync(join(dir, '.fx'), { recursive: true });
  writeFileSync(join(dir, '.fx', 'spec.md'), '# 会员价方案\n\n下单展示会员价。\n');
  mkdirSync(join(dir, '.fx', 'tickets'), { recursive: true });
  writeFileSync(join(dir, '.fx', 'tickets', 't1.md'), '## 需求 1\n\n下单展示会员价。');
}

// 最小可信预取台账记录（绑定 PRD 任务/会话；对象 shop.rule.checkout@3 现行）。
function ledgerRecord(binding: { taskId: string; sessionId: string }): PrefetchRecord {
  return {
    prefetch_id: 'kbp_fixture',
    system_id: 'shop',
    scope: 'role:product',
    caller: 'agent-os:product',
    tenant: null,
    blocked_identity_dimensions: ['tenant'],
    task_id: binding.taskId,
    session_id: binding.sessionId,
    outcome: 'ok',
    snapshot_ref: 'snap-shop-1',
    context_ref: 'ctx-shop-1',
    requirement: '会员价',
    requested_seed_ids: ['shop.rule.checkout'],
    current_objects: [{
      object_id: 'shop.rule.checkout',
      revision: 3,
      kind: 'rule',
      name: '会员价规则',
      summary: '下单展示会员价',
      availability_status: 'published',
      origin: 'seed',
    }],
    excluded_objects: [],
    truncated: false,
    truncation_reasons: [],
    warnings: [],
    missing_evidence: [],
    evidence_gaps: [],
    audit: [],
  };
}

function knowledgeRef(): KnowledgeRef {
  return {
    system_id: 'shop',
    scope: 'role:product',
    snapshot_ref: 'snap-shop-1',
    context_ref: 'ctx-shop-1',
    object_ids: ['shop.rule.checkout'],
    object_revisions: { 'shop.rule.checkout': 3 },
    requested_seed_ids: ['shop.rule.checkout'],
  };
}

async function fixture(t: { after: (fn: () => void) => void }): Promise<{
  prdWorkspace: string;
  devWorkspace: string;
  store: ProductSpecFlowStore;
  handoffs: ArchitectureHandoffStore;
  ledger: KnowledgePrefetchLedger;
  prd: ProductSpecFlow;
  handoffToken: string;
}> {
  const prdWorkspace = temp(t);
  writeProductWorkspace(prdWorkspace);
  const devWorkspace = temp(t);
  mkdirSync(join(devWorkspace, '.fx', 'arch'), { recursive: true });
  writeFileSync(
    join(devWorkspace, '.fx', 'arch', 'design.md'),
    [
      '# 会员价架构设计\n',
      '模块：价格引擎、展示层。',
      `引用现行规则：${formatKnowledgeCitationToken({ system_id: 'shop', object_id: 'shop.rule.checkout', revision: 3, snapshot_ref: 'snap-shop-1' })}`,
    ].join('\n'),
  );
  const store = new ProductSpecFlowStore();
  const ledger = new KnowledgePrefetchLedger();
  const record = ledgerRecord({ taskId: 'task-prd', sessionId: 'session-prd' });
  ledger.record(record);
  const prd = await createBoundProductSpecFlow({
    store,
    workspaceDir: prdWorkspace,
    scratchRoot: '.fx',
    identity: {
      taskId: 'task-prd', botId: 'product', sessionId: 'session-prd',
      ownerOpenId: 'owner-open', ownerUnionId: 'union-owner',
    },
    request: localProductRequest,
    knowledge: { refs: [knowledgeRef()], state: 'ok' },
    verifyCitations: () => ({ ok: true }),
  });
  store.approve(prd.token, 'approval-card');
  const handoffs = new ArchitectureHandoffStore();
  const handoff = openArchitectureHandoff({
    flows: store,
    handoffs,
    prdToken: prd.token,
    operator: { operatorOpenId: 'owner-open', operatorUnionId: 'union-owner' },
  });
  return { prdWorkspace, devWorkspace, store, handoffs, ledger, prd, handoffToken: handoff.token };
}

const devIdentity = {
  taskId: 'task-dev', botId: 'developer', sessionId: 'session-dev',
  ownerOpenId: 'owner-open', ownerUnionId: 'union-owner',
};
const archRequest = {
  title: '会员价架构设计',
  summary: '价格引擎与展示层拆分。',
  deliveryMode: 'local' as const,
  designPath: '.fx/arch/design.md',
};

async function createArchitecture(options: {
  prdWorkspace: string;
  devWorkspace: string;
  store: ProductSpecFlowStore;
  handoffs: ArchitectureHandoffStore;
  handoffToken: string;
}): Promise<ProductSpecFlow> {
  return createBoundArchitectureFlow({
    flows: options.store,
    handoffs: options.handoffs,
    workspaceDir: options.devWorkspace,
    scratchRoot: '.fx',
    resolvePrdWorkspaceDir: () => options.prdWorkspace,
    identity: devIdentity,
    request: archRequest,
    handoffToken: options.handoffToken,
  });
}

// ---- 交接（handoff）：显式、不可伪造、服务端可验证 ----------------------------

test('handoff opens only for the owner of an approved, digest-bound PRD; re-click is idempotent', async (t) => {
  const { store, handoffs, prd } = await fixture(t);
  // 重复发起：同一 PRD 只保留一个 open 交接（幂等）。
  const again = openArchitectureHandoff({
    flows: store, handoffs, prdToken: prd.token,
    operator: { operatorOpenId: 'owner-open' },
  });
  assert.equal(again.status, 'open');
  assert.match(again.token, /^[a-f0-9]{32}$/);

  // 非 owner 拒绝。
  assert.throws(() => openArchitectureHandoff({
    flows: store, handoffs: new ArchitectureHandoffStore(), prdToken: prd.token,
    operator: { operatorOpenId: 'attacker' },
  }), /发起人/);

  // pending PRD / 旧记录无摘要 PRD 拒绝。
  const pending = store.create({
    taskId: 't2', botId: 'product', sessionId: 's2', ownerOpenId: 'owner-open', request: localProductRequest,
  });
  assert.throws(() => openArchitectureHandoff({
    flows: store, handoffs: new ArchitectureHandoffStore(), prdToken: pending.token,
    operator: { operatorOpenId: 'owner-open' },
  }), /尚未确认/);
  const legacy = store.create({
    taskId: 't3', botId: 'product', sessionId: 's3', ownerOpenId: 'owner-open',
    request: localProductRequest, content_digest: null,
  });
  store.approve(legacy.token, 'msg');
  assert.throws(() => openArchitectureHandoff({
    flows: store, handoffs: new ArchitectureHandoffStore(), prdToken: legacy.token,
    operator: { operatorOpenId: 'owner-open' },
  }), /没有绑定内容摘要/);
});

test('architecture flow binds upstream from the server-issued handoff and inherits knowledge refs', async (t) => {
  const f = await fixture(t);
  const arch = await createArchitecture(f);

  assert.equal(arch.artifact_kind, 'architecture');
  assert.equal(arch.status, 'pending');
  assert.equal(arch.upstream?.prdToken, f.prd.token);
  assert.equal(arch.upstream?.prdDigest, f.prd.content_digest);
  assert.equal(arch.upstream?.prdTaskId, 'task-prd');
  assert.equal(arch.upstream?.prdSessionId, 'session-prd');
  assert.deepEqual(arch.knowledge_refs, [knowledgeRef()]);
  assert.equal(arch.knowledge_state, 'ok');
  const expected = await computeArchitectureArtifactDigest(f.devWorkspace, archRequest);
  assert.equal(arch.content_digest, expected.digest);
  assert.deepEqual(arch.content_sources, [{ kind: 'local', path: '.fx/arch/design.md' }]);
  // 交接单次使用：重复消费失败关闭。
  await assert.rejects(() => createArchitecture(f), /无效|已使用/);
});

test('unknown or wrong-owner handoff tokens fail closed (zero candidates, no guessing)', async (t) => {
  const f = await fixture(t);
  const unknown = { ...f, handoffToken: 'f'.repeat(32) };
  await assert.rejects(() => createArchitecture(unknown), /交接码无效/);

  // owner 不匹配：交接存在但不能被他人任务消费。
  await assert.rejects(createBoundArchitectureFlow({
    flows: f.store, handoffs: f.handoffs, workspaceDir: f.devWorkspace,
    scratchRoot: '.fx',
    resolvePrdWorkspaceDir: () => f.prdWorkspace,
    identity: { ...devIdentity, ownerOpenId: 'someone-else' },
    request: archRequest,
    handoffToken: f.handoffToken,
  }), /不属于当前任务发起人/);
  // 失败路径不消耗交接：owner 自己仍可使用。
  const arch = await createArchitecture(f);
  assert.equal(arch.status, 'pending');
});

test('upstream drift or invalidation before consumption blocks architecture creation', async (t) => {
  const f = await fixture(t);
  // PRD 批准后被外部编辑：消费时上游漂移检查失败关闭。
  writeFileSync(join(f.prdWorkspace, '.fx', 'tickets', 't1.md'), '## 需求 1（改写）\n\n内容漂移。');
  await assert.rejects(() => createArchitecture(f), /批准后发生了变化|无法完整回读/);
  // 交接未被消费；PRD 重新生成并确认后（新 token）旧交接仍指向旧 PRD。
  writeFileSync(join(f.prdWorkspace, '.fx', 'tickets', 't1.md'), '## 需求 1\n\n恢复但内容不同。');
  await assert.rejects(() => createArchitecture(f), /批准后发生了变化/);
});

test('CLI self-reported upstream fields are rejected by the tool schema', () => {
  const base = { ...archRequest, handoffToken: 'a'.repeat(32) };
  assert.ok(ArchitectureReviewToolRequestSchema.safeParse(base).success);
  // 自报 PRD token / 文档 URL / artifact kind 一律不是合法输入。
  assert.ok(!ArchitectureReviewToolRequestSchema.safeParse({ ...base, prdToken: 'whatever' }).success);
  assert.ok(!ArchitectureReviewToolRequestSchema.safeParse({ ...base, upstream: 'whatever' }).success);
  assert.ok(!ArchitectureReviewToolRequestSchema.safeParse({ ...base, artifactKind: 'architecture' }).success);
  assert.ok(!ArchitectureReviewToolRequestSchema.safeParse({ ...base, handoffToken: 'not-hex!' }).success);
  assert.ok(!ArchitectureReviewToolRequestSchema.safeParse({ ...base, documentUrl: 'https://evil.example/docx/x' }).success);

  const found = findArchitectureRequest([{
    toolName: 'request_architecture_review',
    input: base,
  }]);
  assert.equal(found?.handoffToken, 'a'.repeat(32));
  assert.equal(found?.request.deliveryMode, 'local');
  assert.equal(found?.request.deliveryMode === 'local' ? found.request.designPath : '', '.fx/arch/design.md');
  // 其他工具名不误判。
  assert.equal(findArchitectureRequest([{ toolName: 'request_spec_approval', input: base }]), undefined);
});

test('concurrent consumption of one handoff: single winner, loser flow is voided (not rolled back)', async (t) => {
  const f = await fixture(t);
  // 两个并发任务（不同 taskId，模拟两个会话）同时用同一交接码提交：都通过
  // 交接解析（await 交错），但交接只允许消费一次——赢家得到 pending flow，
  // 输家的 flow 被作废（invalidated，非事务回滚）。
  const createAs = (taskId: string) => createBoundArchitectureFlow({
    flows: f.store, handoffs: f.handoffs, workspaceDir: f.devWorkspace,
    scratchRoot: '.fx',
    resolvePrdWorkspaceDir: () => f.prdWorkspace,
    identity: { ...devIdentity, taskId },
    request: archRequest,
    handoffToken: f.handoffToken,
  });
  const results = await Promise.allSettled([
    createAs('task-dev-1'),
    createAs('task-dev-2'),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match((rejected[0] as PromiseRejectedResult).reason.message, /失效/);
  const winner = (fulfilled[0] as PromiseFulfilledResult<ProductSpecFlow>).value;
  const flows = f.store.listByUpstreamPrd(f.prd.token);
  assert.equal(flows.length, 2);
  assert.equal(f.store.get(winner.token)?.status, 'pending');
  const voided = flows.find((flow) => flow.token !== winner.token)!;
  assert.equal(voided.status, 'invalidated');
  assert.match(voided.invalidation_reason ?? '', /作废/);
  // 交接已消费：后续不能再使用。
  assert.equal(f.handoffs.get(f.handoffToken)?.status, 'consumed');
});

// ---- 架构审批：上游门禁 + G1 + 与 PRD 确认分离 --------------------------------

async function handlerFixture(t: { after: (fn: () => void) => void }): Promise<{
  runtime: AppRuntime;
  handler: ReturnType<typeof createCardActionHandler>;
  prd: ProductSpecFlow;
  arch: ProductSpecFlow;
  prdWorkspace: string;
  devWorkspace: string;
}> {
  const f = await fixture(t);
  const sessions = new SessionManager();
  const { session: prdSession } = await sessions.resolve(
    { chatId: 'c1', threadId: 't1', rootId: 'r1', messageId: 'm1' }, 'claude', 'product', f.prdWorkspace,
  );
  await sessions.transition(prdSession.id, 'idle');
  const { session: devSession } = await sessions.resolve(
    { chatId: 'c2', threadId: 't2', rootId: 'r2', messageId: 'm2' }, 'zcode', 'developer', f.devWorkspace,
  );
  await sessions.transition(devSession.id, 'idle');
  // 重建绑定到真实 session id 的 PRD（上游门禁要按 PRD session 查工作区）。
  const prd = await createBoundProductSpecFlow({
    store: f.store,
    workspaceDir: f.prdWorkspace,
    scratchRoot: '.fx',
    identity: {
      taskId: 'task-prd2', botId: 'product', sessionId: prdSession.id,
      ownerOpenId: 'owner-open', ownerUnionId: 'union-owner',
    },
    request: localProductRequest,
    knowledge: { refs: [knowledgeRef()], state: 'ok' },
    verifyCitations: () => ({ ok: true }),
  });
  f.store.approve(prd.token, 'approval-card');
  // 台账按重建 PRD 的任务/会话再记一条（架构 G1 沿用上游绑定核验继承引用）。
  f.ledger.record(ledgerRecord({ taskId: 'task-prd2', sessionId: prdSession.id }));
  const handoff = openArchitectureHandoff({
    flows: f.store, handoffs: f.handoffs, prdToken: prd.token,
    operator: { operatorOpenId: 'owner-open', operatorUnionId: 'union-owner' },
  });
  const arch = await createBoundArchitectureFlow({
    flows: f.store,
    handoffs: f.handoffs,
    workspaceDir: f.devWorkspace,
    scratchRoot: '.fx',
    resolvePrdWorkspaceDir: () => f.prdWorkspace,
    identity: { ...devIdentity, sessionId: devSession.id },
    request: archRequest,
    handoffToken: handoff.token,
  });
  const productConfig: BotConfig = {
    id: 'product', appId: 'app', appSecret: 's', defaultCliId: 'claude', modelOverrides: {},
    workspaceDir: f.prdWorkspace, role: '产品经理', skills: ['lark-doc'], systemPrompt: '',
    collaborationMaxRounds: 16, specStages: ['product'],
  };
  const developerConfig: BotConfig = {
    id: 'developer', appId: 'app', appSecret: 's', defaultCliId: 'zcode', modelOverrides: {},
    workspaceDir: f.devWorkspace, role: '开发工程师', skills: [], systemPrompt: '',
    collaborationMaxRounds: 16, specStages: ['architecture'],
  };
  const leaderConfig: BotConfig = {
    id: 'leader', appId: 'app', appSecret: 's', defaultCliId: 'codex', modelOverrides: {},
    workspaceDir: f.devWorkspace, role: 'CEO 助理', skills: [], systemPrompt: '',
    collaborationMaxRounds: 16,
  };
  const runtime: AppRuntime = {
    sessions,
    teamRegistry: new TeamRegistry('leader', [leaderConfig, productConfig, developerConfig]),
    activeRuns: new Map(),
    contextWindows: new Map(),
    botRuntimes: new Map(),
    processedCollaborationTurns: new Set(),
  sessionScratches: new Map(),
    collaborationInbox: {} as never,
    clarificationFlows: {} as never,
    productSpecFlows: f.store,
    architectureHandoffs: f.handoffs,
    knowledgePrefetch: f.ledger,
  };
  const handler = createCardActionHandler({ runtime, config: developerConfig, defaultProductDeliveryMode: 'local' });
  return { runtime, handler, prd, arch, prdWorkspace: f.prdWorkspace, devWorkspace: f.devWorkspace };
}

function archAction(token: string): CardAction {
  return {
    messageId: 'arch-card',
    operatorOpenId: 'owner-open',
    operatorUnionId: 'union-owner',
    formValue: {},
    value: { action: 'approve_architecture', flowToken: token },
  };
}

test('architecture approval passes G1 with inherited knowledge citations verified against the PRD binding', async (t) => {
  const { handler, arch, runtime } = await handlerFixture(t);
  const result = await handler(archAction(arch.token));
  assert.equal(result?.toast?.type, 'success');
  assert.equal(runtime.productSpecFlows.get(arch.token)?.status, 'approved');
  assert.match(JSON.stringify(result?.card), /不等于允许开发/);
});

test('architecture approval fails closed without a ledger for inherited knowledge refs', async (t) => {
  const { handler, arch, runtime } = await handlerFixture(t);
  (runtime as { knowledgePrefetch?: unknown }).knowledgePrefetch = undefined;
  const result = await handler(archAction(arch.token));
  assert.equal(result?.toast?.type, 'error');
  assert.match(result?.toast?.content ?? '', /引用核验通道不可用|核验不可用/);
  assert.equal(runtime.productSpecFlows.get(arch.token)?.status, 'pending');
});

test('upstream PRD drift or invalidation blocks architecture approval', async (t) => {
  const { handler, arch, runtime, prdWorkspace } = await handlerFixture(t);
  // PRD 批准后漂移：上游门禁拒绝。
  writeFileSync(join(prdWorkspace, '.fx', 'tickets', 't1.md'), '## 需求 1（改写）\n\n内容漂移。');
  const drifted = await handler(archAction(arch.token));
  assert.equal(drifted?.toast?.type, 'warning');
  assert.match(drifted?.toast?.content ?? '', /上游产品方案/);
  assert.equal(runtime.productSpecFlows.get(arch.token)?.status, 'pending');

  // 恢复后 PRD 直接被置为失效（如监测级联）：确认同样拒绝。
  writeFileSync(join(prdWorkspace, '.fx', 'tickets', 't1.md'), '## 需求 1\n\n下单展示会员价。');
  runtime.productSpecFlows.invalidate(arch.upstream!.prdToken, '外部编辑检测（fixture）');
  const invalidated = await handler(archAction(arch.token));
  assert.equal(invalidated?.toast?.type, 'warning');
  assert.match(invalidated?.toast?.content ?? '', /上游产品方案/);
  assert.equal(runtime.productSpecFlows.get(arch.token)?.status, 'pending');
});

test('architecture designs drift after submission are rejected by G1; approval is not auto-granted by PRD approval', async (t) => {
  const { handler, arch, runtime, devWorkspace } = await handlerFixture(t);
  writeFileSync(join(devWorkspace, '.fx', 'arch', 'design.md'), '# 会员价架构设计（改写）\n\n内容漂移。');
  const drifted = await handler(archAction(arch.token));
  assert.equal(drifted?.toast?.type, 'warning');
  assert.match(drifted?.toast?.content ?? '', /发生了变化/);
  assert.equal(runtime.productSpecFlows.get(arch.token)?.status, 'pending');
});

// ---- 级联失效：PRD 失效 ⇒ 架构失效 + open 交接关闭 -----------------------------

test('PRD invalidation cascades to bound architecture flows and closes open handoffs', async (t) => {
  const f = await fixture(t);
  const arch = await createArchitecture(f);
  f.store.approve(arch.token, 'arch-card');
  // 再开一个交接（用于验证级联关闭）。
  const openAgain = openArchitectureHandoff({
    flows: f.store, handoffs: f.handoffs, prdToken: f.prd.token,
    operator: { operatorOpenId: 'owner-open' },
  });
  assert.equal(openAgain.status, 'open');

  const notified: string[] = [];
  const monitor = new ArtifactMonitor({
    store: f.store, handoffs: f.handoffs,
    notify: ({ flow }) => { notified.push(flow.token); },
  });
  writeFileSync(join(f.prdWorkspace, '.fx', 'spec.md'), '# 会员价方案（外部改写）\n\n内容漂移。');
  const outcome = await monitor.checkExternalEdit({ token: f.prd.token, workspaceDir: f.prdWorkspace });
  assert.equal(outcome.outcome, 'invalidated');

  const cascaded = f.store.get(arch.token)!;
  assert.equal(cascaded.status, 'invalidated');
  assert.match(cascaded.invalidation_reason ?? '', /级联失效/);
  assert.equal(f.handoffs.get(openAgain.token)?.status, 'closed');
  // 通知幂等覆盖两级：PRD 与架构各一次。
  assert.deepEqual(notified.sort(), [arch.token, f.prd.token].sort());
  // 级联后确认架构被拒。
  assert.equal(f.store.approve(arch.token, 'retry'), undefined);
});

// ---- 持久化与既有门禁保持 -----------------------------------------------------

test('architecture flows with upstream round-trip through the JSON store', async (t) => {
  const f = await fixture(t);
  const arch = await createArchitecture(f);
  const dir = temp(t);
  const path = join(dir, 'flows.json');
  const jsonStore = new JsonProductSpecFlowStore(path);
  const reSaved = jsonStore.create({
    taskId: arch.taskId, botId: arch.botId, sessionId: arch.sessionId, ownerOpenId: arch.ownerOpenId,
    request: arch.request, artifact_kind: 'architecture',
    content_digest: arch.content_digest, content_sources: arch.content_sources,
    knowledge_refs: arch.knowledge_refs, knowledge_state: arch.knowledge_state,
    upstream: arch.upstream,
  });
  const reloaded = new JsonProductSpecFlowStore(path).get(reSaved.token)!;
  assert.equal(reloaded.artifact_kind, 'architecture');
  assert.deepEqual(reloaded.upstream, arch.upstream);
  assert.equal(productDocumentToken('https://team.feishu.cn/docx/abcDEF123'), 'abcDEF123');
});

test('prune keeps approved and invalidated rows (digest/upstream/audit basis) and only trims expired', () => {
  const expiredRows: ProductSpecFlow[] = Array.from({ length: 1002 }, (_, index) => ({
    token: `expiredrow${index}${'0'.repeat(18)}`.slice(0, 32),
    taskId: `t-e-${index}`, botId: 'product', sessionId: 's', ownerOpenId: 'o',
    request: localProductRequest, status: 'expired' as const,
  }));
  const store = new ProductSpecFlowStore(expiredRows);
  const approved = store.create({
    taskId: 't-a', botId: 'product', sessionId: 's', ownerOpenId: 'o',
    request: localProductRequest, content_digest: 'a'.repeat(64),
  });
  store.approve(approved.token, 'msg');
  const invalidated = store.create({
    taskId: 't-i', botId: 'product', sessionId: 's', ownerOpenId: 'o',
    request: localProductRequest, content_digest: 'b'.repeat(64),
  });
  store.invalidate(invalidated.token, '外部编辑检测（fixture）');
  // 再触发一次 create ⇒ pruneHistory 只裁剪 expired（保留最近 1000 条）。
  store.create({ taskId: 't-final', botId: 'product', sessionId: 's', ownerOpenId: 'o', request: localProductRequest });
  assert.equal(store.get(approved.token)?.status, 'approved');
  assert.equal(store.get(invalidated.token)?.status, 'invalidated');
  assert.ok(store.get(approved.token)?.content_digest);
  const expiredLeft = [...(store as unknown as { flows?: Map<string, ProductSpecFlow> }).flows?.values() ?? []]
    .filter((flow) => flow.status === 'expired');
  assert.ok(expiredLeft.length <= 1000);
});

test('comment routing fails closed when one document maps to multiple pending flows', async () => {
  const store = new ProductSpecFlowStore();
  const request = { ...localProductRequest, deliveryMode: 'lark-doc' as const, documentUrl: 'https://team.feishu.cn/docx/docABC123' };
  store.create({ taskId: 't1', botId: 'product', sessionId: 's1', ownerOpenId: 'o', request });
  store.create({ taskId: 't2', botId: 'product', sessionId: 's2', ownerOpenId: 'o', request });
  const candidates = store.listPendingByDocument('product', 'docABC123');
  assert.equal(candidates.length, 2);
  // 调度层在多条匹配时拒绝处理（不取第一条）。用注入 runner 验证零执行。
  const { ProductCommentScheduler } = await import('../src/app/product-comment-scheduler.js');
  let executed = 0;
  const scheduler = new ProductCommentScheduler(
    { productSpecFlows: store } as unknown as AppRuntime,
    async () => { executed += 1; },
  );
  scheduler.schedule(
    { id: 'product', appId: 'a', appSecret: 's', defaultCliId: 'claude', modelOverrides: {}, role: '产品', skills: ['lark-drive'], systemPrompt: '', workspaceDir: '.', collaborationMaxRounds: 16 },
    {} as never,
    { eventId: 'e1', fileToken: 'docABC123', fileType: 'docx', commentId: 'c1', replyId: '', senderOpenId: 'o', senderUnionId: 'u', mentionedBot: true },
  );
  await scheduler.drain();
  assert.equal(executed, 0);
});

test('approval and comment remain mutually exclusive on architecture flows too', async (t) => {
  const store = new ProductSpecFlowStore();
  const flow = store.create({
    taskId: 't', botId: 'developer', sessionId: 's', ownerOpenId: 'o',
    request: archRequest, artifact_kind: 'architecture', content_digest: 'c'.repeat(64),
  });
  const release = store.reserveComment(flow.token);
  assert.ok(release);
  assert.equal(store.beginApproval(flow.token), false);
  release();
  assert.ok(store.beginApproval(flow.token));
  assert.equal(store.reserveComment(flow.token), undefined);
  store.endApproval(flow.token);
  assert.ok(store.reserveComment(flow.token));
});

// ---- 角色提示：架构阶段由服务端阶段授予，小改动不强制 --------------------------

test('developer prompt includes architecture-stage rules only for stage-granted bots', () => {
  const developerPrompt = buildBotPrompt(
    { role: '开发工程师', skills: ['implement-ticket'], systemPrompt: '', specStages: ['architecture'] },
    '实现一个横向切片',
  );
  assert.match(developerPrompt, /架构设计交付规则/);
  assert.match(developerPrompt, /小改动[^\n]*不要强制产出架构文档|小改动、明确的一次性修复不要强制产出架构文档/);
  assert.match(developerPrompt, /不得自报产品方案编号/);
  assert.ok(!developerPrompt.includes('产品方案交付规则'));

  const productPrompt = buildBotPrompt(
    { role: '产品经理', skills: ['lark-doc'], systemPrompt: '', specStages: ['product'] },
    '整理需求',
  );
  assert.match(productPrompt, /产品方案交付规则/);
  assert.ok(!productPrompt.includes('架构设计交付规则'));

  const plainPrompt = buildBotPrompt(
    { role: '开发工程师', skills: ['implement-ticket'], systemPrompt: '' },
    '修复一个 typo',
  );
  assert.ok(!plainPrompt.includes('架构设计交付规则'));
  assert.ok(!plainPrompt.includes('产品方案交付规则'));
});
