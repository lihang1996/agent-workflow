import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductSpecFlowStore, type ProductSpecFlow } from '../src/core/product-spec.js';
import { JsonProductSpecFlowStore } from '../src/core/product-spec-store.js';
import {
  assertArtifactStillMatchesApproval,
  computeLocalArtifactDigest,
  verifyApprovableArtifact,
} from '../src/core/artifact-digest.js';
import { applyArtifactRevision, commentRevisionReply, localArtifactReader } from '../src/app/artifact-revision.js';
import { ArtifactMonitor } from '../src/app/artifact-monitor.js';

const localRequest = {
  title: '方案',
  summary: '说明',
  deliveryMode: 'local' as const,
  specPath: 'spec.md',
  ticketsPath: 'tickets',
};
const larkRequest = {
  title: '方案',
  summary: '说明',
  deliveryMode: 'lark-doc' as const,
  documentUrl: 'https://team.feishu.cn/docx/abcDEF123',
};

function temp(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-artmon-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function workspaceWith(t: { after: (fn: () => void) => void }): Promise<{ dir: string; store: ProductSpecFlowStore }> {
  const dir = temp(t);
  writeFileSync(join(dir, 'spec.md'), '# 方案\n\n本地交付。\n');
  mkdirSync(join(dir, 'tickets'), { recursive: true });
  writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1\n\n下单展示会员价。');
  const store = new ProductSpecFlowStore();
  return { dir, store };
}

async function createLocalFlow(
  dir: string,
  store: ProductSpecFlowStore,
  status: 'pending' | 'approved' = 'pending',
): Promise<ProductSpecFlow> {
  const digest = await computeLocalArtifactDigest(dir, localRequest);
  const flow = store.create({
    taskId: 'task-1',
    botId: 'product',
    sessionId: 'session-1',
    ownerOpenId: 'owner-open',
    request: localRequest,
    content_digest: digest.digest,
    digest_algorithm: 'canonical-sha256-v1',
    content_sources: digest.content_sources,
  });
  if (status === 'approved') store.approve(flow.token, 'approval-msg');
  return store.get(flow.token)!;
}

// ---- T-019：评论修订的摘要重算（回读成功才持久化，失败不报“修改完成”） ------

test('comment revision rebinds digest only after a verified full read-back', async (t) => {
  const { dir, store } = await workspaceWith(t);
  const flow = await createLocalFlow(dir, store);
  // 评论修订：tickets 内容被 CLI 修改。
  writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1（修订）\n\n下单展示会员价与积分。');

  const verification = await applyArtifactRevision({ flow, store, workspaceDir: dir, readFullDocument: localArtifactReader });
  assert.equal(verification.status, 'verified');

  const rebound = store.get(flow.token)!;
  assert.equal(rebound.status, 'pending');
  const expected = await computeLocalArtifactDigest(dir, localRequest);
  assert.equal(rebound.content_digest, expected.digest);
  // 重绑后 G1 通过：修订版本可被确认（确认仍由用户发起）。
  const gate = await verifyApprovableArtifact({ flow: rebound, workspaceDir: dir });
  assert.deepEqual(gate, { ok: true });
  const reply = commentRevisionReply('已按评论调整了会员价规则。', verification);
  assert.ok(!reply.includes('未经服务端核验'));
});

test('comment revision read failure keeps the old digest and never claims completion', async (t) => {
  const { dir, store } = await workspaceWith(t);
  const flow = await createLocalFlow(dir, store);
  // 修订后 tickets 目录被移走：完整回读失败（真实原因是外部状态损坏）。
  rmSync(join(dir, 'tickets'), { recursive: true, force: true });

  const verification = await applyArtifactRevision({ flow, store, workspaceDir: dir, readFullDocument: localArtifactReader });
  assert.equal(verification.status, 'unverified');
  assert.match(verification.reason, /完整回读失败/);

  // 摘要保持旧值：绝不留下一个“看起来已核验”的新摘要。
  assert.equal(store.get(flow.token)?.content_digest, flow.content_digest);
  // G1 失败关闭（无法回读）。
  const gate = await verifyApprovableArtifact({ flow: store.get(flow.token)!, workspaceDir: dir });
  assert.equal(gate.ok, false);
});

test('unverified replies never relay CLI success claims (61 号 P1)', async (t) => {
  const { dir, store } = await workspaceWith(t);
  const flow = await createLocalFlow(dir, store);
  rmSync(join(dir, 'tickets'), { recursive: true, force: true });
  const verification = await applyArtifactRevision({ flow, store, workspaceDir: dir, readFullDocument: localArtifactReader });
  assert.equal(verification.status, 'unverified');

  // CLI 自称修改完成：服务端不得原样转述（即使附加免责声明也不行）。
  const reply = commentRevisionReply('修改完成，文档已更新', verification);
  assert.ok(!reply.includes('修改完成，文档已更新'));
  assert.ok(!reply.includes('修改完成'));
  assert.ok(!reply.includes('已更新'));
  assert.match(reply, /未能完成制品完整性核验/);
  assert.match(reply, /核验缺口/);
  assert.match(reply, /打开文档核对/);

  // 空回答：同一中性文案（同样不含成功承诺）。
  const emptyReply = commentRevisionReply('', verification);
  assert.ok(!emptyReply.includes('修改完成'));
  assert.match(emptyReply, /未能完成制品完整性核验/);

  // 已核验：才转述 CLI 对改动的说明。
  const verified = { status: 'verified' as const, digest: 'd'.repeat(64), contentSources: [] };
  const verifiedReply = commentRevisionReply('会员价规则已按评论补充积分说明。', verified);
  assert.match(verifiedReply, /积分说明/);
  assert.ok(!verifiedReply.includes('未能完成制品完整性核验'));
});

test('lark comment revisions stay unverified (U-3): digest stays null and reply discloses blocked', async (t) => {
  const { store } = await workspaceWith(t);
  const flow = store.create({
    taskId: 'task-1', botId: 'product', sessionId: 'session-1', ownerOpenId: 'owner-open',
    request: larkRequest, content_digest: null, content_sources: [{ kind: 'lark', file_token: 'abcDEF123' }],
  });
  // 生产没有已核验的飞书完整文档 reader：不注入 readFullDocument。
  const verification = await applyArtifactRevision({ flow, store, workspaceDir: undefined });
  assert.equal(verification.status, 'unverified');
  assert.match(verification.reason, /U-3/);
  assert.equal(store.get(flow.token)?.content_digest, null);
  const reply = commentRevisionReply('修改完成，文档已更新', verification);
  // 飞书未核验：中性文案 + U-3 缺口，绝不回显完成自述。
  assert.ok(!reply.includes('修改完成'));
  assert.match(reply, /未能完成制品完整性核验/);
  assert.match(reply, /U-3/);
});

// ---- T-019：批准后的外部编辑监测 ---------------------------------------------

test('monitor detects drift, invalidates once, and notifies idempotently', async (t) => {
  const { dir, store } = await workspaceWith(t);
  const flow = await createLocalFlow(dir, store, 'approved');
  const notified: string[] = [];
  let hookCount = 0;
  const monitor = new ArtifactMonitor({
    store,
    notify: ({ flow: f }) => { notified.push(f.token); },
    hooks: { onInvalidated: () => { hookCount += 1; } },
  });

  // 无变化：consistent，零通知。
  assert.equal((await monitor.checkExternalEdit({ token: flow.token, workspaceDir: dir })).outcome, 'consistent');
  assert.deepEqual(notified, []);

  // 外部编辑：失效 + 审计 + 一次通知。
  writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1（外部改写）\n\n绕过流程的编辑。');
  const drift = await monitor.checkExternalEdit({ token: flow.token, workspaceDir: dir });
  assert.equal(drift.outcome, 'invalidated');
  assert.match(drift.reason, /外部编辑/);
  assert.equal(store.get(flow.token)?.status, 'invalidated');
  assert.equal(notified.length, 1);
  assert.equal(hookCount, 1);
  assert.ok(monitor.audit.some((entry) => entry.token === flow.token && entry.outcome === 'invalidated'));

  // 重复检查：already_invalidated，不重复通知（幂等）。
  const again = await monitor.checkExternalEdit({ token: flow.token, workspaceDir: dir });
  assert.equal(again.outcome, 'already_invalidated');
  assert.equal(notified.length, 1);
  assert.equal(hookCount, 1);
});

test('monitor read failures record unverifiable without invalidating; gates still fail closed', async (t) => {
  const { dir, store } = await workspaceWith(t);
  const flow = await createLocalFlow(dir, store, 'approved');
  rmSync(join(dir, 'tickets'), { recursive: true, force: true });
  const notified: string[] = [];
  const monitor = new ArtifactMonitor({ store, notify: ({ flow: f }) => { notified.push(f.token); } });

  const outcome = await monitor.checkExternalEdit({ token: flow.token, workspaceDir: dir });
  assert.equal(outcome.outcome, 'unverifiable');
  assert.match(outcome.reason, /无法核验/);
  // 读取失败 ≠ 内容已改：flow 保持 approved，只记录审计。
  assert.equal(store.get(flow.token)?.status, 'approved');
  assert.deepEqual(notified, []);
  assert.ok(monitor.audit.some((entry) => entry.token === flow.token && entry.outcome === 'unverifiable'));
  // G2/G3 仍失败关闭：授权前完整回读会抛错，不放行。
  await assert.rejects(
    assertArtifactStillMatchesApproval({
      flow: { status: 'approved', content_digest: flow.content_digest, request: flow.request, artifact_kind: 'prd' },
      workspaceDir: dir,
    }),
    /无法完整回读/,
  );
});

test('monitor skips pending flows, legacy digest-less rows, and lark deliveries (U-3)', async (t) => {
  const { dir, store } = await workspaceWith(t);
  const pending = await createLocalFlow(dir, store, 'pending');
  const monitor = new ArtifactMonitor({ store });
  assert.equal((await monitor.checkExternalEdit({ token: pending.token, workspaceDir: dir })).outcome, 'skipped');

  const legacy = store.create({
    taskId: 'task-2', botId: 'product', sessionId: 'session-2', ownerOpenId: 'owner-open',
    request: localRequest, content_digest: null,
  });
  store.approve(legacy.token, 'msg');
  assert.equal((await monitor.checkExternalEdit({ token: legacy.token, workspaceDir: dir })).outcome, 'skipped');

  const lark = store.create({
    taskId: 'task-3', botId: 'product', sessionId: 'session-3', ownerOpenId: 'owner-open',
    request: larkRequest,
    // 飞书正式路径 digest 恒 null（会先命中“旧记录”skip）；这里显式绑定一个
    // 摘要来覆盖「已绑定摘要的飞书制品因 U-3 不能监测」的独立分支。
    content_digest: 'a'.repeat(64),
    content_sources: [{ kind: 'lark', file_token: 'abcDEF123' }],
  });
  store.approve(lark.token, 'msg');
  const skipped = await monitor.checkExternalEdit({ token: lark.token, workspaceDir: dir });
  assert.equal(skipped.outcome, 'skipped');
  assert.match(skipped.reason, /U-3/);
});

test('monitor invalidation persists through the JSON store (audit basis survives reload)', async (t) => {
  const dir = temp(t);
  const workspace = join(dir, 'ws');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'spec.md'), '# 方案\n\n本地交付。\n');
  mkdirSync(join(workspace, 'tickets'), { recursive: true });
  writeFileSync(join(workspace, 'tickets', 't1.md'), '## 需求 1\n\n下单展示会员价。');
  const path = join(dir, 'flows.json');
  const store = new JsonProductSpecFlowStore(path);
  const digest = await computeLocalArtifactDigest(workspace, localRequest);
  const flow = store.create({
    taskId: 'task-1', botId: 'product', sessionId: 'session-1', ownerOpenId: 'owner-open',
    request: localRequest, content_digest: digest.digest, content_sources: digest.content_sources,
  });
  store.approve(flow.token, 'approval-msg');
  writeFileSync(join(workspace, 'spec.md'), '# 方案（外部改写）\n\n内容漂移。');
  const monitor = new ArtifactMonitor({ store });
  const outcome = await monitor.checkExternalEdit({ token: flow.token, workspaceDir: workspace });
  assert.equal(outcome.outcome, 'invalidated');
  // 重新加载后失效状态与原因仍在（审计依据不因重启丢失）。
  const reloaded = new JsonProductSpecFlowStore(path).get(flow.token)!;
  assert.equal(reloaded.status, 'invalidated');
  assert.match(reloaded.invalidation_reason ?? '', /外部编辑/);
});

// ---- 61 号 P1/P2：通知与钩子异常不得阻断失效；失败可观察、可重试 ----------

test('notify rejection and hook throw never block invalidation (state first, notify later)', async (t) => {
  const { dir, store } = await workspaceWith(t);
  const flow = await createLocalFlow(dir, store, 'approved');
  writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1（外部改写）\n\n绕过流程的编辑。');
  let calls = 0;
  const monitor = new ArtifactMonitor({
    store,
    notify: () => { calls += 1; throw new Error('notify down'); },
    hooks: { onInvalidated: () => { throw new Error('hook boom'); } },
  });
  const drift = await monitor.checkExternalEdit({ token: flow.token, workspaceDir: dir });
  // 失效先完成；通知/钩子异常不影响持久状态，也不向外抛。
  assert.equal(drift.outcome, 'invalidated');
  assert.equal(store.get(flow.token)?.status, 'invalidated');
  assert.equal(calls, 1);
  const record = monitor.notifications.find((entry) => entry.token === flow.token);
  assert.equal(record?.status, 'failed');
  assert.match(record?.error ?? '', /notify down/);
  assert.match(record?.hookError ?? '', /hook boom/);
});

test('hanging notify is bounded by timeout, marked unknown, and never auto-retried (68 号 P1)', async (t) => {
  const { dir, store } = await workspaceWith(t);
  const flow = await createLocalFlow(dir, store, 'approved');
  writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1（外部改写）\n\n绕过流程的编辑。');
  let attempts = 0;
  const monitor = new ArtifactMonitor({
    store,
    // 永不结算：结果不确定。
    notify: () => new Promise<void>(() => { attempts += 1; }),
    notifyTimeoutMs: 20,
  });
  const drift = await monitor.checkExternalEdit({ token: flow.token, workspaceDir: dir });
  assert.equal(drift.outcome, 'invalidated');
  assert.equal(store.get(flow.token)?.status, 'invalidated');
  assert.equal(monitor.notifications.find((entry) => entry.token === flow.token)?.status, 'unknown');
  // 无接收端幂等保证：结果不确定时不自动重发（避免重复外部动作）。
  await monitor.checkExternalEdit({ token: flow.token, workspaceDir: dir });
  await monitor.checkExternalEdit({ token: flow.token, workspaceDir: dir });
  assert.equal(attempts, 1);
  assert.equal(monitor.notifications.filter((entry) => entry.token === flow.token).length, 1);
  assert.ok(monitor.notifications.every((entry) => entry.status !== 'sent'));
});

test('failed notifications (contract: reject = no side effect) are retried on later checks, delivering once', async (t) => {
  const { dir, store } = await workspaceWith(t);
  const flow = await createLocalFlow(dir, store, 'approved');
  writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1（外部改写）\n\n绕过流程的编辑。');
  let attempts = 0;
  const monitor = new ArtifactMonitor({
    store,
    // 按契约：reject 表示未产生任何外部副作用，监控可安全补试。
    notify: () => { attempts += 1; if (attempts === 1) throw new Error('transient'); },
  });
  const drift = await monitor.checkExternalEdit({ token: flow.token, workspaceDir: dir });
  assert.equal(drift.outcome, 'invalidated');
  assert.equal(monitor.notifications.find((entry) => entry.token === flow.token)?.status, 'failed');
  const again = await monitor.checkExternalEdit({ token: flow.token, workspaceDir: dir });
  assert.equal(again.outcome, 'already_invalidated');
  assert.equal(attempts, 2);
  assert.equal(monitor.notifications.filter((entry) => entry.token === flow.token && entry.status === 'sent').length, 1);
  await monitor.checkExternalEdit({ token: flow.token, workspaceDir: dir });
  assert.equal(attempts, 2);
});

test('no notify callback records not_configured and never sent (68 号 P1)', async (t) => {
  const { dir, store } = await workspaceWith(t);
  const flow = await createLocalFlow(dir, store, 'approved');
  writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1（外部改写）\n\n绕过流程的编辑。');
  const monitor = new ArtifactMonitor({ store });
  const drift = await monitor.checkExternalEdit({ token: flow.token, workspaceDir: dir });
  assert.equal(drift.outcome, 'invalidated');
  assert.equal(store.get(flow.token)?.status, 'invalidated');
  const record = monitor.notifications.find((entry) => entry.token === flow.token);
  assert.equal(record?.status, 'not_configured');
  assert.ok(monitor.notifications.every((entry) => entry.status !== 'sent'));
  // not_configured 不自动重试：重复检查不追加记录。
  await monitor.checkExternalEdit({ token: flow.token, workspaceDir: dir });
  assert.equal(monitor.notifications.filter((entry) => entry.token === flow.token).length, 1);
});

test('retryPendingNotifications covers cascade dependents beyond the checked token (68 号 P2)', async (t) => {
  const { dir, store } = await workspaceWith(t);
  const prd = await createLocalFlow(dir, store, 'approved');
  const archRequestLocal = {
    title: '架构', summary: '说明', deliveryMode: 'local' as const, designPath: 'arch/design.md',
  };
  const upstream = {
    prdToken: prd.token, prdDigest: prd.content_digest!, prdTaskId: 'task-prd',
    prdSessionId: 'session-prd', knowledgeRefs: [], knowledgeState: null,
  };
  const arch = store.create({
    taskId: 'ta', botId: 'developer', sessionId: 'sa', ownerOpenId: 'owner-open',
    request: archRequestLocal, artifact_kind: 'architecture' as const, content_digest: '1'.repeat(64), upstream,
  });
  store.approve(arch.token, 'arch-card');
  const deliveredTokens: string[] = [];
  const attemptsByToken = new Map<string, number>();
  const monitor = new ArtifactMonitor({
    store,
    // PRD 送达；架构第一次按契约 reject（未产生副作用），补试成功。
    notify: ({ flow }) => {
      const attempt = (attemptsByToken.get(flow.token) ?? 0) + 1;
      attemptsByToken.set(flow.token, attempt);
      if (flow.token === arch.token && attempt === 1) throw new Error('arch sink down');
      deliveredTokens.push(flow.token);
    },
  });
  writeFileSync(join(dir, 'spec.md'), '# 方案（外部改写）\n\n内容漂移。');
  const outcome = await monitor.checkExternalEdit({ token: prd.token, workspaceDir: dir });
  assert.equal(outcome.outcome, 'invalidated');
  assert.equal(monitor.notifications.find((entry) => entry.token === prd.token)?.status, 'sent');
  assert.equal(monitor.notifications.find((entry) => entry.token === arch.token)?.status, 'failed');
  // 只重查 PRD 不补试架构（随检查补试只覆盖被检查 token）。
  await monitor.checkExternalEdit({ token: prd.token, workspaceDir: dir });
  assert.equal(monitor.notifications.some((entry) => entry.token === arch.token && entry.status === 'sent'), false);
  // 显式补试接口覆盖全部 failed（含级联依赖）；成功后不再重复。
  const retried = await monitor.retryPendingNotifications();
  assert.deepEqual(retried, [arch.token]);
  assert.equal(monitor.notifications.filter((entry) => entry.token === arch.token).at(-1)?.status, 'sent');
  assert.deepEqual(deliveredTokens.sort(), [arch.token, prd.token].sort());
  assert.deepEqual(await monitor.retryPendingNotifications(), []);
  // 待处理视图只列 failed（unknown/not_configured 不在其中，需人工核对）。
  assert.deepEqual(monitor.listPendingNotifications(), []);
});

test('partial cascade: terminal dependents keep their own reason; live ones still cascade and notify', async (t) => {
  const { dir, store } = await workspaceWith(t);
  const prd = await createLocalFlow(dir, store, 'approved');
  const archRequestLocal = {
    title: '架构', summary: '说明', deliveryMode: 'local' as const, designPath: 'arch/design.md',
  };
  const upstream = {
    prdToken: prd.token, prdDigest: prd.content_digest!, prdTaskId: 'task-prd',
    prdSessionId: 'session-prd', knowledgeRefs: [], knowledgeState: null,
  };
  const live = store.create({
    taskId: 'ta', botId: 'developer', sessionId: 'sa', ownerOpenId: 'owner-open',
    request: archRequestLocal, artifact_kind: 'architecture' as const, content_digest: '1'.repeat(64), upstream,
  });
  store.approve(live.token, 'arch-card');
  const terminal = store.create({
    taskId: 'tt', botId: 'developer', sessionId: 'st', ownerOpenId: 'owner-open',
    request: archRequestLocal, artifact_kind: 'architecture' as const, content_digest: '2'.repeat(64), upstream,
  });
  store.approve(terminal.token, 'arch-card');
  store.invalidate(terminal.token, '先前其他原因');

  const notified: string[] = [];
  const monitor = new ArtifactMonitor({ store, notify: ({ flow }) => { notified.push(flow.token); } });
  writeFileSync(join(dir, 'spec.md'), '# 方案（外部改写）\n\n内容漂移。');
  const outcome = await monitor.checkExternalEdit({ token: prd.token, workspaceDir: dir });
  assert.equal(outcome.outcome, 'invalidated');
  assert.equal(store.get(live.token)?.status, 'invalidated');
  assert.match(store.get(live.token)?.invalidation_reason ?? '', /级联失效/);
  // 已终态依赖：保持原有失效原因，不被覆盖，也不重复通知。
  assert.equal(store.get(terminal.token)?.invalidation_reason, '先前其他原因');
  assert.deepEqual(notified.sort(), [live.token, prd.token].sort());
});
