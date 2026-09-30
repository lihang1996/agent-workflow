import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodingAuthorizationStore,
  DEFAULT_AUTHORIZATION_TTL_MS,
  JsonCodingAuthorizationStore,
  assertAuthorizationUsable,
  confirmCodingAuthorization,
  createCodingAuthorizationDraft,
  effectiveStatus,
  invalidateAuthorizationsForPrd,
  isWithinAllowedPaths,
  resolveAuthorizedPaths,
  revokeCodingAuthorization,
  sweepExpirations,
  type CodingAuthorizationRecord,
} from '../src/core/coding-authorization.js';
import { ProductSpecFlowStore, type ProductSpecFlow } from '../src/core/product-spec.js';
import { computeArchitectureArtifactDigest, computeLocalArtifactDigest } from '../src/core/artifact-digest.js';
import { ArtifactMonitor } from '../src/app/artifact-monitor.js';
import { createAuthorizationInvalidationHook } from '../src/app/authorization-cascade.js';
import { SessionManager } from '../src/core/session-manager.js';
import { TeamRegistry } from '../src/core/team-registry.js';
import { createCardActionHandler } from '../src/app/card-action-handler.js';
import type { CardAction } from '../src/im/lark.js';
import type { AppRuntime } from '../src/app/runtime.js';
import type { BotConfig } from '../src/core/bot-registry.js';

const localProductRequest = {
  title: '会员价方案',
  summary: '下单展示会员价。',
  deliveryMode: 'local' as const,
  specPath: 'spec.md',
  ticketsPath: 'tickets',
};
const archRequest = {
  title: '会员价架构设计',
  summary: '价格引擎与展示层拆分。',
  deliveryMode: 'local' as const,
  designPath: 'arch/design.md',
};

function temp(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-codingauth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeProductWorkspace(dir: string): void {
  writeFileSync(join(dir, 'spec.md'), '# 会员价方案\n\n下单展示会员价。\n');
  mkdirSync(join(dir, 'tickets'), { recursive: true });
  writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1\n\n下单展示会员价。');
}

function writeDevWorkspace(dir: string): void {
  mkdirSync(join(dir, 'arch'), { recursive: true });
  writeFileSync(join(dir, 'arch', 'design.md'), '# 架构设计\n\n价格引擎模块。');
}

/** 服务级 fixture：PRD（approved）+ 可选架构（approved）+ 手动工作区解析器。 */
async function serviceFixture(t: { after: (fn: () => void) => void }, options: { withArchitecture?: boolean } = {}): Promise<{
  prdWorkspace: string;
  devWorkspace: string;
  flows: ProductSpecFlowStore;
  authorizations: CodingAuthorizationStore;
  prd: ProductSpecFlow;
  architecture?: ProductSpecFlow;
  resolveWorkspaceDir: (sessionId: string) => string | undefined;
  operator: { operatorOpenId: string; operatorUnionId: string };
}> {
  const prdWorkspace = temp(t);
  writeProductWorkspace(prdWorkspace);
  const devWorkspace = temp(t);
  writeDevWorkspace(devWorkspace);
  const flows = new ProductSpecFlowStore();
  const digest = await computeLocalArtifactDigest(prdWorkspace, localProductRequest);
  const prd = flows.create({
    taskId: 'task-prd', botId: 'product', sessionId: 'session-prd',
    ownerOpenId: 'owner-open', ownerUnionId: 'union-owner',
    request: localProductRequest,
    content_digest: digest.digest, digest_algorithm: 'canonical-sha256-v1',
    content_sources: digest.content_sources,
  });
  flows.approve(prd.token, 'approval-card');
  let architecture: ProductSpecFlow | undefined;
  if (options.withArchitecture) {
    // 直接构造已批准架构：摘要来自真实设计文档（drift 复核用）。
    const designDigest = await computeArchitectureArtifactDigest(devWorkspace, archRequest);
    architecture = flows.create({
      taskId: 'task-dev', botId: 'developer', sessionId: 'session-dev',
      ownerOpenId: 'owner-open', ownerUnionId: 'union-owner',
      request: archRequest, artifact_kind: 'architecture',
      content_digest: designDigest.digest,
      content_sources: designDigest.content_sources,
      upstream: {
        prdToken: prd.token, prdDigest: prd.content_digest!,
        prdTaskId: 'task-prd', prdSessionId: 'session-prd',
        knowledgeRefs: [], knowledgeState: null,
      },
    });
    flows.approve(architecture.token, 'arch-card');
  }
  const resolveWorkspaceDir = (sessionId: string) =>
    sessionId === 'session-dev' ? devWorkspace
      : sessionId === 'session-prd' ? prdWorkspace
        : undefined;
  return {
    prdWorkspace, devWorkspace, flows, authorizations: new CodingAuthorizationStore(),
    prd, architecture, resolveWorkspaceDir,
    operator: { operatorOpenId: 'owner-open', operatorUnionId: 'union-owner' },
  };
}

const stranger = { operatorOpenId: 'attacker', operatorUnionId: 'other-union' };

// ---- 状态迁移全链路 -----------------------------------------------------------

test('lifecycle: draft → second confirmation → active → usable → revoked', async (t) => {
  const f = await serviceFixture(t);
  const draft = await createCodingAuthorizationDraft({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    input: { flowToken: f.prd.token, allowedPaths: ['tickets'] },
    resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.requesterOpenId, 'owner-open');
  assert.equal(draft.prdFlowToken, f.prd.token);
  assert.equal(draft.prdDigest, f.prd.content_digest);
  assert.equal(draft.workspaceRealpath, realpathSync(f.prdWorkspace));
  assert.deepEqual(draft.allowedPaths, ['tickets']);
  assert.ok(!draft.grantedBy); // 确认前没有授权人
  assert.ok(Date.parse(draft.expiresAt) - Date.parse(draft.createdAt) <= DEFAULT_AUTHORIZATION_TTL_MS + 1000);

  // 二次确认前不可用（draft 不是 active）。
  await assert.rejects(assertAuthorizationUsable({
    store: f.authorizations, flows: f.flows, authorizationId: draft.id,
    resolveWorkspaceDir: f.resolveWorkspaceDir,
  }), /不可用（状态 draft）/);

  const active = await confirmCodingAuthorization({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    authorizationId: draft.id, resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  assert.equal(active.status, 'active');
  assert.equal(active.grantedBy, 'owner-open');
  assert.ok(active.grantedAt);

  const usable = await assertAuthorizationUsable({
    store: f.authorizations, flows: f.flows, authorizationId: draft.id,
    resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  assert.equal(usable.status, 'active');

  const revoked = revokeCodingAuthorization({
    store: f.authorizations, operator: f.operator, authorizationId: draft.id,
  });
  assert.equal(revoked.status, 'revoked');
  await assert.rejects(assertAuthorizationUsable({
    store: f.authorizations, flows: f.flows, authorizationId: draft.id,
    resolveWorkspaceDir: f.resolveWorkspaceDir,
  }), /不可用（状态 revoked/);
});

// ---- 错误主体 / 未批准 / 摘要漂移 ---------------------------------------------

test('wrong operators are rejected at draft, confirm, and revoke', async (t) => {
  const f = await serviceFixture(t);
  await assert.rejects(createCodingAuthorizationDraft({
    store: f.authorizations, flows: f.flows, operator: stranger,
    input: { flowToken: f.prd.token, allowedPaths: ['tickets'] }, resolveWorkspaceDir: f.resolveWorkspaceDir,
  }), /发起人/);
  const draft = await createCodingAuthorizationDraft({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    input: { flowToken: f.prd.token, allowedPaths: ['tickets'] }, resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  await assert.rejects(confirmCodingAuthorization({
    store: f.authorizations, flows: f.flows, operator: stranger,
    authorizationId: draft.id, resolveWorkspaceDir: f.resolveWorkspaceDir,
  }), /发起人/);
  assert.equal(f.authorizations.get(draft.id)?.status, 'draft');
  await confirmCodingAuthorization({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    authorizationId: draft.id, resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  assert.throws(() => revokeCodingAuthorization({
    store: f.authorizations, operator: stranger, authorizationId: draft.id,
  }), /发起人/);
  assert.equal(f.authorizations.get(draft.id)?.status, 'active');
});

test('unapproved or digest-less PRDs and post-approval drift reject drafts and confirms', async (t) => {
  const f = await serviceFixture(t);
  // pending PRD。
  const pending = f.flows.create({
    taskId: 't2', botId: 'product', sessionId: 'session-prd',
    ownerOpenId: 'owner-open', ownerUnionId: 'union-owner', request: localProductRequest,
  });
  await assert.rejects(createCodingAuthorizationDraft({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    input: { flowToken: pending.token }, resolveWorkspaceDir: f.resolveWorkspaceDir,
  }), /尚未确认或没有绑定内容摘要/);
  // 旧记录无摘要。
  const legacy = f.flows.create({
    taskId: 't3', botId: 'product', sessionId: 'session-prd',
    ownerOpenId: 'owner-open', ownerUnionId: 'union-owner',
    request: localProductRequest, content_digest: null,
  });
  f.flows.approve(legacy.token, 'msg');
  await assert.rejects(createCodingAuthorizationDraft({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    input: { flowToken: legacy.token }, resolveWorkspaceDir: f.resolveWorkspaceDir,
  }), /尚未确认或没有绑定内容摘要/);

  // 授权前 PRD 漂移：直接拒绝；确认前漂移：确认拒绝且不 active。
  writeFileSync(join(f.prdWorkspace, 'tickets', 't2.md'), '## 外部改写\n\n绕过流程。');
  await assert.rejects(createCodingAuthorizationDraft({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    input: { flowToken: f.prd.token, allowedPaths: ['tickets'] }, resolveWorkspaceDir: f.resolveWorkspaceDir,
  }), /发生了变化|无法完整回读/);

  const f2 = await serviceFixture(t);
  const draft = await createCodingAuthorizationDraft({
    store: f2.authorizations, flows: f2.flows, operator: f2.operator,
    input: { flowToken: f2.prd.token, allowedPaths: ['tickets'] }, resolveWorkspaceDir: f2.resolveWorkspaceDir,
  });
  writeFileSync(join(f2.prdWorkspace, 'spec.md'), '# 改写\n\n内容漂移。');
  await assert.rejects(confirmCodingAuthorization({
    store: f2.authorizations, flows: f2.flows, operator: f2.operator,
    authorizationId: draft.id, resolveWorkspaceDir: f2.resolveWorkspaceDir,
  }), /发生了变化|无法完整回读/);
  assert.equal(f2.authorizations.get(draft.id)?.status, 'draft');
});

// ---- 架构绑定与二次确认语义 ----------------------------------------------------

test('architecture authorization binds arch and upstream PRD tokens and digests', async (t) => {
  const f = await serviceFixture(t, { withArchitecture: true });
  const draft = await createCodingAuthorizationDraft({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    input: { flowToken: f.architecture!.token, allowedPaths: ['arch'] },
    resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  assert.equal(draft.architectureFlowToken, f.architecture!.token);
  assert.equal(draft.architectureDigest, f.architecture!.content_digest);
  assert.equal(draft.architectureUpstreamPrdToken, f.prd.token);
  assert.equal(draft.prdFlowToken, f.prd.token);
  // 工作区绑定开发会话工作区。
  assert.equal(draft.workspaceRealpath, realpathSync(f.devWorkspace));

  const active = await confirmCodingAuthorization({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    authorizationId: draft.id, resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  assert.equal(active.status, 'active');

  // 架构失效后授权不可用（级联在 monitor 测试中验证，这里验证使用门禁）。
  f.flows.invalidate(f.architecture!.token, '外部编辑（fixture）');
  await assert.rejects(assertAuthorizationUsable({
    store: f.authorizations, flows: f.flows, authorizationId: draft.id,
    resolveWorkspaceDir: f.resolveWorkspaceDir,
  }), /架构设计已失效/);
});

test('PRD approval never creates an authorization; non-draft/duplicate confirmations fail closed', async (t) => {
  const f = await serviceFixture(t);
  assert.equal(f.authorizations.list().length, 0);
  f.flows.approve(f.prd.token, 'again');
  assert.equal(f.authorizations.list().length, 0);

  const draft = await createCodingAuthorizationDraft({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    input: { flowToken: f.prd.token, allowedPaths: ['tickets'] }, resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  await confirmCodingAuthorization({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    authorizationId: draft.id, resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  // 重复确认失败关闭。
  await assert.rejects(confirmCodingAuthorization({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    authorizationId: draft.id, resolveWorkspaceDir: f.resolveWorkspaceDir,
  }), /active 状态，不能再次确认/);
  // 撤销后确认同样失败。
  revokeCodingAuthorization({ store: f.authorizations, operator: f.operator, authorizationId: draft.id });
  await assert.rejects(confirmCodingAuthorization({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    authorizationId: draft.id, resolveWorkspaceDir: f.resolveWorkspaceDir,
  }), /revoked 状态/);
  // 终态撤销再撤销失败。
  assert.throws(() => revokeCodingAuthorization({
    store: f.authorizations, operator: f.operator, authorizationId: draft.id,
  }), /无需撤销/);
});

test('expired drafts cannot be confirmed; expiry flips active authorizations', async (t) => {
  const f = await serviceFixture(t);
  const start = new Date('2026-09-30T00:00:00Z');
  const draft = await createCodingAuthorizationDraft({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    input: { flowToken: f.prd.token, ttlMs: 60 * 60 * 1000, allowedPaths: ['tickets'] },
    resolveWorkspaceDir: f.resolveWorkspaceDir,
    now: () => start,
  });
  const afterExpiry = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  await assert.rejects(confirmCodingAuthorization({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    authorizationId: draft.id, resolveWorkspaceDir: f.resolveWorkspaceDir,
    now: () => afterExpiry,
  }), /超过有效期/);
  assert.equal(f.authorizations.get(draft.id)?.status, 'draft');

  const draft2 = await createCodingAuthorizationDraft({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    input: { flowToken: f.prd.token, ttlMs: 60 * 60 * 1000, allowedPaths: ['tickets'] },
    resolveWorkspaceDir: f.resolveWorkspaceDir,
    now: () => start,
  });
  await confirmCodingAuthorization({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    authorizationId: draft2.id, resolveWorkspaceDir: f.resolveWorkspaceDir,
    now: () => start,
  });
  const record = f.authorizations.get(draft2.id)!;
  assert.equal(effectiveStatus(record, new Date(start.getTime() + 30 * 60 * 1000)), 'active');
  assert.equal(effectiveStatus(record, afterExpiry), 'expired');
  // 惰性过期在使用门禁立即拦截。
  await assert.rejects(assertAuthorizationUsable({
    store: f.authorizations, flows: f.flows, authorizationId: draft2.id,
    resolveWorkspaceDir: f.resolveWorkspaceDir,
    now: () => afterExpiry,
  }), /不可用（状态 expired/);
  // sweep 把到期 active 落盘。
  assert.equal(sweepExpirations({ store: f.authorizations, now: () => afterExpiry }), 1);
  assert.equal(f.authorizations.get(draft2.id)?.status, 'expired');
});

// ---- 路径授权：抗别名 / .. / 符号链接 / 缺失叶子 --------------------------------

test('allowed path validation rejects escapes and collapses in-workspace aliases', async (t) => {
  const dir = temp(t);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'x');
  mkdirSync(join(dir, 'real'), { recursive: true });
  mkdirSync(join(dir, 'outside'), { recursive: true });
  symlinkSync(join(dir, 'real'), join(dir, 'alias')); // 内部别名
  symlinkSync(join(dir, 'outside'), join(dir, 'badlink')); // 指向内部其他目录（仍合法）
  const outside = temp(t);
  symlinkSync(outside, join(dir, 'escape')); // 指向工作区外

  const workspaceRealpath = realpathSync(dir);
  // 已存在路径：realpath 折叠（alias → real）。
  const alias = await resolveAuthorizedPaths({ workspaceDir: dir, allowedPaths: ['alias'] });
  assert.deepEqual(alias.paths, ['real']);
  assert.equal(alias.pendingRecheck, false);
  // 常规路径。
  assert.deepEqual(
    (await resolveAuthorizedPaths({ workspaceDir: dir, allowedPaths: ['src'] })).paths,
    ['src'],
  );
  // 指向外部：拒绝。
  await assert.rejects(
    resolveAuthorizedPaths({ workspaceDir: dir, allowedPaths: ['escape'] }),
    /越出了工作区/,
  );
  await assert.rejects(
    resolveAuthorizedPaths({ workspaceDir: dir, allowedPaths: ['escape/file.ts'] }),
    /越出了工作区/,
  );
  // 畸形输入：绝对路径 / .. / 反斜杠 / 空段 / 盘符。
  for (const bad of ['/etc', '../sibling', 'a\\b', 'a//b', 'C:/x', '..']) {
    await assert.rejects(
      resolveAuthorizedPaths({ workspaceDir: dir, allowedPaths: [bad] }),
      Error,
      `应拒绝: ${bad}`,
    );
  }
  // 缺失叶子：现存父链在内 ⇒ 允许 + pendingRecheck；父链经外部符号链接 ⇒ 拒绝。
  const missing = await resolveAuthorizedPaths({ workspaceDir: dir, allowedPaths: ['src/new/module'] });
  assert.deepEqual(missing.paths, ['src/new/module']);
  assert.equal(missing.pendingRecheck, true);
  await assert.rejects(
    resolveAuthorizedPaths({ workspaceDir: dir, allowedPaths: ['escape/new/module'] }),
    /越出了工作区/,
  );
  // 别名下的缺失叶子：折叠到真实父路径之下。
  const aliasMissing = await resolveAuthorizedPaths({ workspaceDir: dir, allowedPaths: ['alias/nested/file.md'] });
  assert.deepEqual(aliasMissing.paths, ['real/nested/file.md']);
  assert.equal(aliasMissing.pendingRecheck, true);
  // 全工作区。
  assert.deepEqual(
    (await resolveAuthorizedPaths({ workspaceDir: dir, allowedPaths: ['.'] })).paths,
    ['.'],
  );
  assert.equal(workspaceRealpath.length > 0, true);
});

test('path containment is segment-aware, never string-prefix (a/b does not allow a/bb)', () => {
  const allowed = ['a/b'];
  assert.equal(isWithinAllowedPaths(allowed, 'a/b'), true);
  assert.equal(isWithinAllowedPaths(allowed, 'a/b/c.ts'), true);
  assert.equal(isWithinAllowedPaths(allowed, 'a/bb'), false);
  assert.equal(isWithinAllowedPaths(allowed, 'a'), false);
  assert.equal(isWithinAllowedPaths(allowed, 'b'), false);
  assert.equal(isWithinAllowedPaths(['.'], 'any/where.ts'), true);
  assert.equal(isWithinAllowedPaths(['a/b'], 'a/b/../c'), false, '候选不得含 ..');
});

// ---- 持久化：roundtrip / 坏记录失败关闭 / 重载后语义不变 ------------------------

test('JSON store round-trips records; bad rows fail closed on load', async (t) => {
  const dir = temp(t);
  const path = join(dir, 'authorizations.json');
  const store = new JsonCodingAuthorizationStore(path);
  const f = await serviceFixture(t);
  const draft = await createCodingAuthorizationDraft({
    store, flows: f.flows, operator: f.operator,
    input: { flowToken: f.prd.token, allowedPaths: ['src', 'tickets'], ttlMs: 3600_000 },
    resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  // 重载后仍是 draft，且可确认（持久化后二次确认语义不变）。
  let reloaded = new JsonCodingAuthorizationStore(path).get(draft.id)!;
  assert.equal(reloaded.status, 'draft');
  assert.deepEqual(reloaded.allowedPaths, ['src', 'tickets']);
  const store2 = new JsonCodingAuthorizationStore(path);
  await confirmCodingAuthorization({
    store: store2, flows: f.flows, operator: f.operator,
    authorizationId: draft.id, resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  reloaded = new JsonCodingAuthorizationStore(path).get(draft.id)!;
  assert.equal(reloaded.status, 'active');
  assert.equal(reloaded.grantedBy, 'owner-open');
  // 重载后重复确认仍失败。
  await assert.rejects(confirmCodingAuthorization({
    store: new JsonCodingAuthorizationStore(path), flows: f.flows, operator: f.operator,
    authorizationId: draft.id, resolveWorkspaceDir: f.resolveWorkspaceDir,
  }), /active 状态/);

  // 坏记录（未知 status / 缺字段 / 错版本）加载失败关闭。
  const corrupt = join(dir, 'corrupt.json');
  writeFileSync(corrupt, JSON.stringify({
    _v: 1,
    records: [{ ...draft, id: 'ca_' + '0'.repeat(32), status: 'paused' }],
  }));
  assert.throws(() => new JsonCodingAuthorizationStore(corrupt), /无效（失败关闭）/);
  const corrupt2 = join(dir, 'corrupt2.json');
  writeFileSync(corrupt2, JSON.stringify({ _v: 2, records: [] }));
  assert.throws(() => new JsonCodingAuthorizationStore(corrupt2), Error);
});

// ---- 级联失效（monitor 钩子接线，fixture 验证） ---------------------------------

test('monitor invalidation cascades to bound authorizations via the hook', async (t) => {
  const f = await serviceFixture(t, { withArchitecture: true });
  const prdDraft = await createCodingAuthorizationDraft({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    input: { flowToken: f.prd.token, allowedPaths: ['tickets'] }, resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  const archActive = await createCodingAuthorizationDraft({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    input: { flowToken: f.architecture!.token, allowedPaths: ['arch'] }, resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  await confirmCodingAuthorization({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    authorizationId: archActive.id, resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  // 无关授权不受影响。
  const other = await serviceFixture(t);
  const unrelated = await createCodingAuthorizationDraft({
    store: f.authorizations, flows: other.flows, operator: other.operator,
    input: { flowToken: other.prd.token, allowedPaths: ['tickets'] },
    resolveWorkspaceDir: (sessionId) => sessionId === 'session-prd' ? other.prdWorkspace : undefined,
  });

  const monitor = new ArtifactMonitor({
    store: f.flows,
    hooks: createAuthorizationInvalidationHook({ authorizations: f.authorizations }),
  });
  writeFileSync(join(f.prdWorkspace, 'spec.md'), '# 外部改写\n\n内容漂移。');
  const outcome = await monitor.checkExternalEdit({
    token: f.prd.token, workspaceDir: f.prdWorkspace,
  });
  assert.equal(outcome.outcome, 'invalidated');
  assert.equal(f.authorizations.get(prdDraft.id)?.status, 'invalidated');
  assert.equal(f.authorizations.get(archActive.id)?.status, 'invalidated');
  assert.match(f.authorizations.get(archActive.id)?.statusReason ?? '', /级联失效/);
  assert.equal(f.authorizations.get(unrelated.id)?.status, 'draft');
  // 直接调用级联原语同样幂等（终态跳过）。
  assert.equal(invalidateAuthorizationsForPrd({
    store: f.authorizations, prdToken: f.prd.token, reason: '再次触发',
  }), 0);
});

// ---- 卡片入口（显式 flowToken 动作 + 二次确认 + 撤销 + 普通文本不越权） --------

async function cardFixture(t: { after: (fn: () => void) => void }): Promise<{
  runtime: AppRuntime;
  handler: ReturnType<typeof createCardActionHandler>;
  prd: ProductSpecFlow;
  workspaceDir: string;
}> {
  const workspaceDir = temp(t);
  writeProductWorkspace(workspaceDir);
  const digest = await computeLocalArtifactDigest(workspaceDir, localProductRequest);
  const sessions = new SessionManager();
  const { session } = await sessions.resolve(
    { chatId: 'c1', threadId: 't1', rootId: 'r1', messageId: 'm1' }, 'claude', 'product', workspaceDir,
  );
  await sessions.transition(session.id, 'idle');
  const flows = new ProductSpecFlowStore();
  const prd = flows.create({
    taskId: 'task-prd', botId: 'product', sessionId: session.id,
    ownerOpenId: 'owner-open', ownerUnionId: 'union-owner',
    request: localProductRequest,
    content_digest: digest.digest, digest_algorithm: 'canonical-sha256-v1',
    content_sources: digest.content_sources,
  });
  flows.approve(prd.token, 'approval-card');
  const config: BotConfig = {
    id: 'product', appId: 'app', appSecret: 's', defaultCliId: 'claude', modelOverrides: {},
    workspaceDir, role: '产品经理', skills: ['lark-doc'], systemPrompt: '',
    collaborationMaxRounds: 16, specStages: ['product'],
  };
  const leader: BotConfig = { ...config, id: 'leader', specStages: [] };
  const runtime: AppRuntime = {
    sessions,
    teamRegistry: new TeamRegistry('leader', [leader, config]),
    activeRuns: new Map(),
    contextWindows: new Map(),
    botRuntimes: new Map(),
    processedCollaborationTurns: new Set(),
  sessionScratches: new Map(),
    collaborationInbox: {} as never,
    clarificationFlows: {} as never,
    productSpecFlows: flows,
    codingAuthorizations: new CodingAuthorizationStore(),
  };
  const handler = createCardActionHandler({ runtime, config, defaultProductDeliveryMode: 'local' });
  return { runtime, handler, prd, workspaceDir };
}

function cardAction(action: string, value: Record<string, unknown>): CardAction {
  return {
    messageId: 'card',
    operatorOpenId: 'owner-open',
    operatorUnionId: 'union-owner',
    formValue: {},
    value: { action, ...value },
  };
}

test('card entry: authorize → draft card with full contents → confirm → active → revoke', async (t) => {
  const { runtime, handler, prd, workspaceDir } = await cardFixture(t);
  // PRD 确认动作本身不产生授权。
  await handler(cardAction('approve_product_spec', { flowToken: prd.token }));
  assert.equal(runtime.codingAuthorizations!.list().length, 0);

  const draftResult = await handler(cardAction('authorize_coding', { flowToken: prd.token, allowedPaths: ['tickets'] }));
  assert.equal(draftResult?.toast?.type, 'success');
  const draftCard = JSON.stringify(draftResult?.card);
  assert.match(draftCard, /待二次确认/);
  assert.match(draftCard, new RegExp(prd.token));
  assert.match(draftCard, new RegExp(prd.content_digest!.slice(0, 16)));
  assert.match(draftCard, /允许路径/);
  assert.match(draftCard, /有效期至/);
  const draft = runtime.codingAuthorizations!.list()[0]!;
  assert.equal(draft.status, 'draft');

  const confirmResult = await handler(cardAction('confirm_coding_authorization', { authorizationId: draft.id }));
  assert.equal(confirmResult?.toast?.type, 'success');
  assert.match(JSON.stringify(confirmResult?.card), /撤销授权/);
  assert.equal(runtime.codingAuthorizations!.get(draft.id)?.status, 'active');

  // 非授权人确认/撤销被拒。
  const strangerResult = await handler({
    ...cardAction('revoke_coding_authorization', { authorizationId: draft.id }),
    operatorOpenId: 'attacker', operatorUnionId: 'other',
  });
  assert.equal(strangerResult?.toast?.type, 'error');
  assert.equal(runtime.codingAuthorizations!.get(draft.id)?.status, 'active');

  const revokeResult = await handler(cardAction('revoke_coding_authorization', { authorizationId: draft.id }));
  assert.equal(revokeResult?.toast?.type, 'success');
  assert.equal(runtime.codingAuthorizations!.get(draft.id)?.status, 'revoked');
  // 授权后制品漂移会让 confirm 拒绝（草稿仍保留为 draft）。
  const draft2Result = await handler(cardAction('authorize_coding', { flowToken: prd.token, allowedPaths: ['tickets'] }));
  assert.equal(draft2Result?.toast?.type, 'success');
  const draft2 = runtime.codingAuthorizations!.list().find((record) => record.status === 'draft')!;
  writeFileSync(join(workspaceDir, 'tickets', 't2.md'), '## 漂移\n\n外部改写。');
  const confirm2 = await handler(cardAction('confirm_coding_authorization', { authorizationId: draft2.id }));
  assert.equal(confirm2?.toast?.type, 'error');
  assert.match(confirm2?.toast?.content ?? '', /发生了变化/);
  assert.equal(runtime.codingAuthorizations!.get(draft2.id)?.status, 'draft');
});

test('card entry rejects pending artifacts and unresolvable workspaces', async (t) => {
  const { runtime, handler, workspaceDir } = await cardFixture(t);
  const digest = await computeLocalArtifactDigest(workspaceDir, localProductRequest);
  const pending = runtime.productSpecFlows.create({
    taskId: 'task-2', botId: 'product', sessionId: 'missing-session',
    ownerOpenId: 'owner-open', ownerUnionId: 'union-owner',
    request: localProductRequest, content_digest: digest.digest,
  });
  const rejected = await handler(cardAction('authorize_coding', { flowToken: pending.token }));
  assert.equal(rejected?.toast?.type, 'error');
  assert.match(rejected?.toast?.content ?? '', /尚未确认/);
  assert.equal(runtime.codingAuthorizations!.list().length, 0);

  const approved = runtime.productSpecFlows.create({
    taskId: 'task-3', botId: 'product', sessionId: 'missing-session',
    ownerOpenId: 'owner-open', ownerUnionId: 'union-owner',
    request: localProductRequest, content_digest: digest.digest,
  });
  runtime.productSpecFlows.approve(approved.token, 'card');
  const noWorkspace = await handler(cardAction('authorize_coding', { flowToken: approved.token }));
  assert.equal(noWorkspace?.toast?.type, 'error');
  assert.match(noWorkspace?.toast?.content ?? '', /会话工作区/);
  assert.equal(runtime.codingAuthorizations!.list().length, 0);
});

test('transition table: terminal states never revive; illegal edges rejected (84 号 P1-2)', () => {
  const store = new CodingAuthorizationStore();
  const base = (id: string, status: CodingAuthorizationRecord['status']): CodingAuthorizationRecord => ({
    id, status, requesterOpenId: 'owner', prdFlowToken: 'p', prdDigest: 'b'.repeat(64),
    workspaceRealpath: '/ws', allowedPaths: ['src'],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    createdAt: new Date().toISOString(),
    ...(status === 'active' ? { grantedBy: 'owner', grantedAt: new Date().toISOString() } : {}),
  });
  const revoked = base('ca_' + 'a'.repeat(32), 'revoked');
  store.insert(revoked);
  assert.equal(store.transition(revoked.id, 'revoked', 'active'), undefined);
  assert.equal(store.transition(revoked.id, 'revoked', 'draft'), undefined);
  assert.equal(store.get(revoked.id)?.status, 'revoked');
  // active 不可回退成 draft（防绕过二次确认）；draft→expired 不在边表。
  const active = base('ca_' + 'b'.repeat(32), 'active');
  store.insert(active);
  assert.equal(store.transition(active.id, 'active', 'draft'), undefined, 'active→draft 必须被拒绝');
  assert.equal(store.get(active.id)?.status, 'active');
  const draft = base('ca_' + 'c'.repeat(32), 'draft');
  store.insert(draft);
  assert.equal(store.transition(draft.id, 'draft', 'expired'), undefined, 'draft→expired 不在边表');
  assert.equal(store.transition('missing', 'draft', 'active'), undefined);
  // 合法边：draft→active 的 patch 与状态在同一次迁移中生效。
  const patched = store.transition(draft.id, 'draft', 'active', undefined, (record) => {
    record.grantedBy = 'owner';
    record.grantedAt = new Date().toISOString();
  });
  assert.equal(patched?.status, 'active');
  assert.equal(patched?.grantedBy, 'owner');
});

// ---- 84 号 P1 新增负例 ---------------------------------------------------------

test('draft bound to an older PRD approval cannot confirm after re-approval to a new version (84 号 P1-1)', async (t) => {
  const f = await serviceFixture(t);
  const draft = await createCodingAuthorizationDraft({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    input: { flowToken: f.prd.token, allowedPaths: ['tickets'] },
    resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  // 模拟「PRD 重新审批为新版本且磁盘文件同步为新版本」：直接把 flow 的绑定
  // 摘要替换为重算的新摘要（store 内对象可变；新 flow token 场景由同一比对覆盖）。
  writeFileSync(join(f.prdWorkspace, 'tickets', 't1.md'), '## 需求 1（新版本）\n\n内容全新。');
  const newDigest = await computeLocalArtifactDigest(f.prdWorkspace, localProductRequest);
  const flow = f.flows.get(f.prd.token)!;
  flow.content_digest = newDigest.digest;
  await assert.rejects(confirmCodingAuthorization({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    authorizationId: draft.id, resolveWorkspaceDir: f.resolveWorkspaceDir,
  }), /与授权草稿绑定不一致/);
  assert.equal(f.authorizations.get(draft.id)?.status, 'draft');
});

test('confirm persists status and grant fields atomically; failures roll back (84 号 P1-2)', async (t) => {
  const f = await serviceFixture(t);
  const dir = temp(t);
  const stateDir = join(dir, 'nested');
  const path = join(stateDir, 'authorizations.json');
  const store = new JsonCodingAuthorizationStore(path);
  const draft = await createCodingAuthorizationDraft({
    store, flows: f.flows, operator: f.operator,
    input: { flowToken: f.prd.token, allowedPaths: ['tickets'] },
    resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  assert.equal(existsSync(path), true);
  // 注入持久化失败：把状态目录替换成普通文件（mkdir/write 必然 ENOTDIR）。
  rmSync(stateDir, { recursive: true, force: true });
  writeFileSync(stateDir, 'not a directory');
  // 迁移抛错且内存回滚：不产生 active、不写授权人（无半成品落盘窗口）。
  assert.throws(() => store.transition(draft.id, 'draft', 'active', undefined, (record) => {
    record.grantedBy = 'owner-open';
    record.grantedAt = new Date().toISOString();
  }), Error);
  assert.equal(store.get(draft.id)?.status, 'draft');
  assert.equal(store.get(draft.id)?.grantedBy, undefined);
  assert.equal(existsSync(path), false);

  // 加载侧失败关闭：active 无授权人/时间、draft 带授权痕迹都拒绝。
  const good = join(dir, 'good.json');
  const goodStore = new JsonCodingAuthorizationStore(good);
  const draft2 = await createCodingAuthorizationDraft({
    store: goodStore, flows: f.flows, operator: f.operator,
    input: { flowToken: f.prd.token, allowedPaths: ['tickets'] },
    resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  await confirmCodingAuthorization({
    store: goodStore, flows: f.flows, operator: f.operator,
    authorizationId: draft2.id, resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  const rows: unknown[] = JSON.parse(readFileSync(good, 'utf8')).records;
  const activeRow = rows[0] as Record<string, unknown>;
  const corruptActive = join(dir, 'corrupt-active.json');
  const stripped = { ...activeRow };
  delete stripped.grantedBy;
  delete stripped.grantedAt;
  writeFileSync(corruptActive, JSON.stringify({ _v: 1, records: [stripped] }));
  assert.throws(() => new JsonCodingAuthorizationStore(corruptActive), /active 授权缺少授权人/);
  const corruptDraft = join(dir, 'corrupt-draft.json');
  const forged = { ...activeRow, status: 'draft' };
  writeFileSync(corruptDraft, JSON.stringify({ _v: 1, records: [forged] }));
  assert.throws(() => new JsonCodingAuthorizationStore(corruptDraft), /draft 授权带有授权人/);
});

test('non-ENOENT path errors fail closed instead of treated as missing leaves (84 号 P1-3)', async (t) => {
  const dir = temp(t);
  // 符号链接自环：路径解析触发 ELOOP（非 ENOENT）——必须失败关闭。
  symlinkSync(dir, join(dir, 'loop'));
  const deep = Array(40).fill('loop').join('/') + '/file.md';
  await assert.rejects(
    resolveAuthorizedPaths({ workspaceDir: dir, allowedPaths: [deep] }),
    /允许路径核验失败|ELOOP/,
  );
});

test('allowed path replaced by an outside symlink after draft/active is rejected on re-verification (84 号 P1-3)', async (t) => {
  const f = await serviceFixture(t);
  // 用制品（spec/tickets）之外的目录做允许路径，路径复核分支不会被制品漂移
  // 检查抢先拦截。
  mkdirSync(join(f.prdWorkspace, 'modules'), { recursive: true });
  const draft = await createCodingAuthorizationDraft({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    input: { flowToken: f.prd.token, allowedPaths: ['modules'] },
    resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  const outside = temp(t);
  rmSync(join(f.prdWorkspace, 'modules'), { recursive: true, force: true });
  symlinkSync(outside, join(f.prdWorkspace, 'modules'));
  await assert.rejects(confirmCodingAuthorization({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    authorizationId: draft.id, resolveWorkspaceDir: f.resolveWorkspaceDir,
  }), /越出了工作区/);
  assert.equal(f.authorizations.get(draft.id)?.status, 'draft');

  // active 授权的使用门禁同样复核：替换后不可用。
  const f2 = await serviceFixture(t);
  mkdirSync(join(f2.prdWorkspace, 'modules'), { recursive: true });
  const draft2 = await createCodingAuthorizationDraft({
    store: f2.authorizations, flows: f2.flows, operator: f2.operator,
    input: { flowToken: f2.prd.token, allowedPaths: ['modules'] },
    resolveWorkspaceDir: f2.resolveWorkspaceDir,
  });
  await confirmCodingAuthorization({
    store: f2.authorizations, flows: f2.flows, operator: f2.operator,
    authorizationId: draft2.id, resolveWorkspaceDir: f2.resolveWorkspaceDir,
  });
  const outside2 = temp(t);
  rmSync(join(f2.prdWorkspace, 'modules'), { recursive: true, force: true });
  symlinkSync(outside2, join(f2.prdWorkspace, 'modules'));
  await assert.rejects(assertAuthorizationUsable({
    store: f2.authorizations, flows: f2.flows, authorizationId: draft2.id,
    resolveWorkspaceDir: f2.resolveWorkspaceDir,
  }), /允许路径复核失败|越出了工作区/);
});

test('authorization entry fails closed without explicit allowed paths (84 号 P1-4)', async (t) => {
  const f = await serviceFixture(t);
  // 服务层：未提供允许路径 ⇒ 失败关闭，不得默认整个工作区。
  await assert.rejects(createCodingAuthorizationDraft({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    input: { flowToken: f.prd.token }, resolveWorkspaceDir: f.resolveWorkspaceDir,
  }), /未选择允许路径/);
  assert.equal(f.authorizations.list().length, 0);

  // 卡片入口：当前按钮不携带路径选择 ⇒ 阻断并提示（不虚构路径选择 UI）。
  const { runtime, handler, prd } = await cardFixture(t);
  const blocked = await handler(cardAction('authorize_coding', { flowToken: prd.token }));
  assert.equal(blocked?.toast?.type, 'error');
  assert.match(blocked?.toast?.content ?? '', /未选择允许路径/);
  assert.equal(runtime.codingAuthorizations!.list().length, 0);
  // 显式携带路径（合法、在工作区内）时才创建草稿。
  const ok = await handler(cardAction('authorize_coding', { flowToken: prd.token, allowedPaths: ['tickets'] }));
  assert.equal(ok?.toast?.type, 'success');
  const created = runtime.codingAuthorizations!.list();
  assert.equal(created.length, 1);
  assert.deepEqual(created[0]!.allowedPaths, ['tickets']);
});

// ---- 94 号 P1 新增负例 ---------------------------------------------------------

test('missing-leaf tails under deeper alias targets compute exact real paths (94 号 P1-1)', async (t) => {
  const dir = temp(t);
  mkdirSync(join(dir, 'real', 'sub', 'deep'), { recursive: true });
  // 别名目标比别名字面更深：字面 1 段 → 目标 2 段 / 3 段。
  symlinkSync(join(dir, 'real', 'sub'), join(dir, 'alias'));
  symlinkSync(join(dir, 'real', 'sub', 'deep'), join(dir, 'alias2'));

  const r1 = await resolveAuthorizedPaths({ workspaceDir: dir, allowedPaths: ['alias/new/file.md'] });
  assert.deepEqual(r1.paths, ['real/sub/new/file.md']);
  assert.equal(r1.pendingRecheck, true);
  const r2 = await resolveAuthorizedPaths({ workspaceDir: dir, allowedPaths: ['alias2/a/b/c.md'] });
  assert.deepEqual(r2.paths, ['real/sub/deep/a/b/c.md']);
  // 不扩大到目标父目录 / 目标下的其他文件（段感知包含）。
  assert.equal(isWithinAllowedPaths(r1.paths, 'real/sub'), false);
  assert.equal(isWithinAllowedPaths(r1.paths, 'real/sub/other.md'), false);
  assert.equal(isWithinAllowedPaths(r1.paths, 'real/sub/new/file.md'), true);
  assert.equal(isWithinAllowedPaths(r2.paths, 'real/sub/deep'), false);
  assert.equal(isWithinAllowedPaths(r2.paths, 'real/sub/deep/a/b/c.md'), true);
});

test('drafts with alias-input missing leaves confirm and re-verify consistently (94 号 P1-1)', async (t) => {
  const f = await serviceFixture(t);
  mkdirSync(join(f.prdWorkspace, 'real', 'sub'), { recursive: true });
  symlinkSync(join(f.prdWorkspace, 'real', 'sub'), join(f.prdWorkspace, 'alias'));
  const draft = await createCodingAuthorizationDraft({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    input: { flowToken: f.prd.token, allowedPaths: ['alias/new/file.md'] },
    resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  assert.deepEqual(draft.allowedPaths, ['real/sub/new/file.md']);
  assert.equal(draft.pendingPathRecheck, true);

  const active = await confirmCodingAuthorization({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    authorizationId: draft.id, resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  assert.equal(active.status, 'active');
  // 138 号 P0-1 修订：active + pendingPathRecheck 在使用门被阻断——缺失叶子
  // 的授权范围未经服务端重新核验前不得用于编码（旧断言「可用」已过时）。
  await assert.rejects(assertAuthorizationUsable({
    store: f.authorizations, flows: f.flows, authorizationId: draft.id,
    resolveWorkspaceDir: f.resolveWorkspaceDir,
  }), /pendingPathRecheck/);
  // 记录本身仍保留规范路径集合与待复核标志（供服务端重新授权时核对）。
  const record = f.authorizations.get(draft.id)!;
  assert.deepEqual(record.allowedPaths, ['real/sub/new/file.md']);
  assert.equal(record.pendingPathRecheck, true);
});

test('all store write paths enforce grant invariants; views are defensive clones (94 号 P1-2)', async (t) => {
  const f = await serviceFixture(t);
  const draft = await createCodingAuthorizationDraft({
    store: f.authorizations, flows: f.flows, operator: f.operator,
    input: { flowToken: f.prd.token, allowedPaths: ['tickets'] },
    resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  // 无 patch 的 draft→active：违反「active 必有授权人/时间」⇒ 抛错，内存保持 draft。
  assert.throws(() => f.authorizations.transition(draft.id, 'draft', 'active'), /授权人|不变量/);
  assert.equal(f.authorizations.get(draft.id)?.status, 'draft');

  // Json store 同样失败关闭，且磁盘状态保持 draft（重载验证）。
  const dir = temp(t);
  const path = join(dir, 'authorizations.json');
  const json = new JsonCodingAuthorizationStore(path);
  const jsonDraft = await createCodingAuthorizationDraft({
    store: json, flows: f.flows, operator: f.operator,
    input: { flowToken: f.prd.token, allowedPaths: ['tickets'] },
    resolveWorkspaceDir: f.resolveWorkspaceDir,
  });
  assert.throws(() => json.transition(jsonDraft.id, 'draft', 'active'), /授权人|不变量/);
  assert.equal(new JsonCodingAuthorizationStore(path).get(jsonDraft.id)?.status, 'draft');

  // 非法 insert（未知 status / 畸形记录）拒绝，内存与磁盘都不新增。
  assert.throws(
    () => json.insert({ ...json.get(jsonDraft.id)!, id: 'ca_' + 'd'.repeat(32), status: 'paused' } as unknown as CodingAuthorizationRecord),
    /不变量/,
  );
  assert.throws(
    () => f.authorizations.insert({ bad: true } as unknown as CodingAuthorizationRecord),
    /不变量/,
  );
  assert.equal(json.list().length, 1);
  assert.equal(f.authorizations.list().length, 1);

  // get/list 返回防御性克隆：外部改 status 不影响 store 内部状态。
  const handle = f.authorizations.get(draft.id)!;
  handle.status = 'active';
  handle.grantedBy = 'forged';
  assert.equal(f.authorizations.get(draft.id)?.status, 'draft');
  assert.equal(f.authorizations.get(draft.id)?.grantedBy, undefined);

  // 使用门禁兜底：即使内存中出现无 grant 的 active（绕过 store 的极端路径），
  // 也按无效处理。
  class LooseAuthorizationStore extends CodingAuthorizationStore {
    insertLoose(record: CodingAuthorizationRecord): void {
      (this as unknown as { records: Map<string, CodingAuthorizationRecord> }).records.set(record.id, record);
    }
  }
  const loose = new LooseAuthorizationStore();
  loose.insertLoose({
    ...draft, status: 'active',
  });
  await assert.rejects(assertAuthorizationUsable({
    store: loose, flows: f.flows, authorizationId: draft.id,
    resolveWorkspaceDir: f.resolveWorkspaceDir,
  }), /缺少二次确认元数据/);
});
