import assert from 'node:assert/strict';
import test from 'node:test';
import { linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactDigestError,
  DIGEST_ALGORITHM,
  assertArtifactAuthorizable,
  assertArtifactStillMatchesApproval,
  assertLarkDigestCapability,
  computeLocalArtifactDigest,
  readLocalArtifactSnapshot,
  verifyApprovableArtifact,
} from '../src/core/artifact-digest.js';
import { assertProductSpecDocuments } from '../src/app/product-spec-documents.js';
import type { KnowledgeRef, ProductSpecFlow } from '../src/core/product-spec.js';

function temp(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-digest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeLocalArtifact(dir: string): void {
  writeFileSync(join(dir, 'spec.md'), '# 方案\n\n下单流程优化。\n');
  mkdirSync(join(dir, 'tickets'), { recursive: true });
  mkdirSync(join(dir, 'tickets', 'epic-1'), { recursive: true });
  writeFileSync(join(dir, 'tickets', 't2.md'), '## 需求 2\n\n退款入口前置。');
  writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1\n\n下单时展示会员价。');
  writeFileSync(join(dir, 'tickets', 'epic-1', 't3.md'), '## 需求 3\n\n优惠券叠加。');
  writeFileSync(join(dir, 'tickets', 'notes.txt'), '非必需文件，不参与摘要');
}

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

test('local digest deterministically covers spec file and all tickets .md files', async (t) => {
  const dir = temp(t);
  writeLocalArtifact(dir);
  const first = await computeLocalArtifactDigest(dir, localRequest);
  const second = await computeLocalArtifactDigest(dir, localRequest);
  assert.equal(first.algorithm, DIGEST_ALGORITHM);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(
    first.files.map((file) => file.path),
    ['spec.md', 'tickets/epic-1/t3.md', 'tickets/t1.md', 'tickets/t2.md'],
  );
  assert.ok(/^[0-9a-f]{64}$/.test(first.digest));
  // 非 .md 文件不进入摘要清单。
  assert.ok(first.files.every((file) => file.path.endsWith('.md')));
  assert.deepEqual(first.content_sources, [
    { kind: 'local', path: 'spec.md' },
    { kind: 'local', path: 'tickets' },
  ]);
});

test('content change, addition and removal of required .md files all change the digest', async (t) => {
  const dir = temp(t);
  writeLocalArtifact(dir);
  const baseline = await computeLocalArtifactDigest(dir, localRequest);

  writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1（改）\n\n描述更新。');
  const modified = await computeLocalArtifactDigest(dir, localRequest);
  assert.notEqual(modified.digest, baseline.digest);
  writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1\n\n下单时展示会员价。');

  writeFileSync(join(dir, 'tickets', 't4.md'), '## 需求 4\n\n新增。');
  const added = await computeLocalArtifactDigest(dir, localRequest);
  assert.notEqual(added.digest, baseline.digest);
  rmSync(join(dir, 'tickets', 't4.md'));

  rmSync(join(dir, 'tickets', 'epic-1', 't3.md'));
  const removed = await computeLocalArtifactDigest(dir, localRequest);
  assert.notEqual(removed.digest, baseline.digest);
});

test('missing spec file fails closed with spec_missing', async (t) => {
  const dir = temp(t);
  mkdirSync(join(dir, 'tickets'), { recursive: true });
  writeFileSync(join(dir, 'tickets', 't1.md'), '内容');
  await assert.rejects(
    computeLocalArtifactDigest(dir, localRequest),
    (error: unknown) => error instanceof ArtifactDigestError && error.code === 'spec_missing',
  );
});

test('missing tickets directory or empty tickets directory fails closed', async (t) => {
  const dir = temp(t);
  writeFileSync(join(dir, 'spec.md'), '方案');
  await assert.rejects(
    computeLocalArtifactDigest(dir, localRequest),
    (error: unknown) => error instanceof ArtifactDigestError && error.code === 'tickets_missing',
  );
  mkdirSync(join(dir, 'tickets'), { recursive: true });
  await assert.rejects(
    computeLocalArtifactDigest(dir, localRequest),
    (error: unknown) => error instanceof ArtifactDigestError && error.code === 'tickets_empty',
  );
});

test('symlinks are rejected, including links pointing back inside the workspace', async (t) => {
  const dir = temp(t);
  writeLocalArtifact(dir);
  writeFileSync(join(dir, 'outside-secret.md'), '工作区外文件');
  const outside = join(dir, '..', 'digest-outside-secret.md');
  writeFileSync(outside, '越界目标');
  t.after(() => rmSync(outside, { force: true }));

  symlinkSync(outside, join(dir, 'tickets', 'escape.md'));
  await assert.rejects(
    computeLocalArtifactDigest(dir, localRequest),
    (error: unknown) => error instanceof ArtifactDigestError && error.code === 'symlink_not_allowed',
  );
  rmSync(join(dir, 'tickets', 'escape.md'));

  symlinkSync(join(dir, 'spec.md'), join(dir, 'tickets', 'alias.md'));
  await assert.rejects(
    computeLocalArtifactDigest(dir, localRequest),
    (error: unknown) => error instanceof ArtifactDigestError && error.code === 'symlink_not_allowed',
  );
});

test('spec path escaping the workspace via resolution is rejected', async (t) => {
  const dir = temp(t);
  const outsideDir = mkdtempSync(join(tmpdir(), 'agent-os-digest-out-'));
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
  writeFileSync(join(outsideDir, 'stolen.md'), '越界 spec');
  // 直接把 specPath 指到工作区外的相对路径（..）会被请求 schema 拒绝；
  // 这里绕过 schema 直接验证摘要层的 containment。
  await assert.rejects(
    computeLocalArtifactDigest(dir, {
      ...localRequest,
      specPath: join('..', 'agent-os-digest-out-', 'stolen.md').split('/').join('/'),
    } as typeof localRequest),
    (error: unknown) => error instanceof ArtifactDigestError,
  );
});

test('lark delivery mode cannot produce an approval digest (U-3 blocked)', () => {
  assert.throws(() => assertLarkDigestCapability(), (error: unknown) =>
    error instanceof ArtifactDigestError && error.code === 'lark_digest_blocked');
});

type GateFlow = Pick<ProductSpecFlow, 'request' | 'content_digest' | 'knowledge_refs' | 'knowledge_state'>;

test('approval gate passes when the artifact re-reads identical', async (t) => {
  const dir = temp(t);
  writeLocalArtifact(dir);
  const digest = await computeLocalArtifactDigest(dir, localRequest);
  const gate = await verifyApprovableArtifact({
    flow: { request: localRequest, content_digest: digest.digest, knowledge_refs: [], knowledge_state: null } as GateFlow,
    workspaceDir: dir,
  });
  assert.deepEqual(gate, { ok: true });
});

test('approval gate rejects drift, missing digest, unreadable files and lark mode', async (t) => {
  const dir = temp(t);
  writeLocalArtifact(dir);
  const digest = await computeLocalArtifactDigest(dir, localRequest);

  writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1\n\n批准前被外部修改。');
  const drifted = await verifyApprovableArtifact({
    flow: { request: localRequest, content_digest: digest.digest, knowledge_refs: [], knowledge_state: null } as GateFlow,
    workspaceDir: dir,
  });
  assert.equal(drifted.ok, false);
  if (!drifted.ok) {
    assert.equal(drifted.level, 'warning');
    assert.match(drifted.message, /发生了变化/);
  }

  const legacy = await verifyApprovableArtifact({
    flow: { request: localRequest, content_digest: null, knowledge_refs: [], knowledge_state: null } as GateFlow,
    workspaceDir: dir,
  });
  assert.equal(legacy.ok, false);
  if (!legacy.ok) assert.match(legacy.message, /没有绑定内容摘要/);

  rmSync(join(dir, 'tickets'), { recursive: true, force: true });
  const unreadable = await verifyApprovableArtifact({
    flow: { request: localRequest, content_digest: digest.digest, knowledge_refs: [], knowledge_state: null } as GateFlow,
    workspaceDir: dir,
  });
  assert.equal(unreadable.ok, false);
  if (!unreadable.ok) assert.match(unreadable.message, /无法完整回读/);

  const lark = await verifyApprovableArtifact({
    flow: { request: larkRequest, content_digest: digest.digest, knowledge_refs: [], knowledge_state: null } as GateFlow,
    workspaceDir: dir,
  });
  assert.equal(lark.ok, false);
  if (!lark.ok) assert.match(lark.message, /blocked/);
});

test('approval gate rejects degraded knowledge state and unverifiable knowledge refs', async (t) => {
  const dir = temp(t);
  writeLocalArtifact(dir);
  const digest = await computeLocalArtifactDigest(dir, localRequest);
  const base = { request: localRequest, content_digest: digest.digest, knowledge_refs: [] as KnowledgeRef[] } as GateFlow;

  const degraded = await verifyApprovableArtifact({
    flow: { ...base, knowledge_state: 'degraded' } as GateFlow,
    workspaceDir: dir,
  });
  assert.equal(degraded.ok, false);
  if (!degraded.ok) assert.match(degraded.message, /degraded|例外/);

  const refs: KnowledgeRef[] = [{
    system_id: 'shop',
    scope: 'role:产品',
    snapshot_ref: 'snap-1',
    context_ref: 'ctx-1',
    object_ids: ['shop.rule.checkout'],
  }];
  const noVerifier = await verifyApprovableArtifact({
    flow: { ...base, knowledge_refs: refs } as GateFlow,
    workspaceDir: dir,
  });
  assert.equal(noVerifier.ok, false);
  if (!noVerifier.ok) assert.equal(noVerifier.level, 'error');

  const rejected = await verifyApprovableArtifact({
    flow: { ...base, knowledge_refs: refs } as GateFlow,
    workspaceDir: dir,
    verifyKnowledgeCitations: () => ({ ok: false, reason: '对象 x 不可作为现行事实（draft）' }),
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.message, /draft|现行事实/);

  const verified = await verifyApprovableArtifact({
    flow: { ...base, knowledge_refs: refs } as GateFlow,
    workspaceDir: dir,
    verifyKnowledgeCitations: () => ({ ok: true }),
  });
  assert.deepEqual(verified, { ok: true });
});

test('approval gate extracts actual citations from the fixed artifact: a token without a verifier or undeclared refs fails closed', async (t) => {
  const dir = temp(t);
  writeLocalArtifact(dir);
  const digest = await computeLocalArtifactDigest(dir, localRequest);
  // 正文塞入结构化引用令牌，但 flow 声明 refs 为空且无核验通道。
  writeFileSync(join(dir, 'spec.md'), `# 方案\n\n基于 [[kb:shop|shop.rule.checkout@3|snap-shop-1]]。\n`);
  const withToken = await computeLocalArtifactDigest(dir, localRequest);
  const flow = { request: localRequest, content_digest: withToken.digest, knowledge_refs: [] as KnowledgeRef[] } as GateFlow;

  const noVerifier = await verifyApprovableArtifact({ flow, workspaceDir: dir });
  assert.equal(noVerifier.ok, false, '空 refs 不能靠正文令牌获签');
  if (!noVerifier.ok) assert.equal(noVerifier.level, 'error');

  const verifierRejectsUndeclared = await verifyApprovableArtifact({
    flow,
    workspaceDir: dir,
    verifyKnowledgeCitations: ({ artifactTexts, declaredRefs }) => {
      const tokens = artifactTexts.join('').match(/\[\[kb:[^\]]+\]\]/g) ?? [];
      if (tokens.length > 0 && declaredRefs.length === 0) {
        return { ok: false, reason: '制品正文引用了未声明的知识对象（shop:shop.rule.checkout）' };
      }
      return { ok: true };
    },
  });
  assert.equal(verifierRejectsUndeclared.ok, false);
  if (!verifierRejectsUndeclared.ok) assert.match(verifierRejectsUndeclared.message, /未声明/);

  // 摘要与正文一致的前提下，声明与正文一致的 refs 且核验通过才放行。
  const ok = await verifyApprovableArtifact({
    flow,
    workspaceDir: dir,
    verifyKnowledgeCitations: () => ({ ok: true }),
  });
  assert.deepEqual(ok, { ok: true });
  // 恢复无令牌正文后，无令牌且无声明时不要求核验通道（基线 digest 重新对齐）。
  writeFileSync(join(dir, 'spec.md'), '# 方案\n\n下单流程优化。\n');
  const plain = await verifyApprovableArtifact({
    flow: { request: localRequest, content_digest: digest.digest, knowledge_refs: [] } as GateFlow,
    workspaceDir: dir,
  });
  assert.deepEqual(plain, { ok: true });
});

test('G2 guard: approved legacy records without digest are never authorizable', () => {
  assert.throws(
    () => assertArtifactAuthorizable({ status: 'approved', content_digest: null }),
    /没有内容摘要/,
  );
  assert.throws(
    () => assertArtifactAuthorizable({ status: 'pending', content_digest: 'a'.repeat(64) }),
    /尚未获得审批/,
  );
  assert.doesNotThrow(() =>
    assertArtifactAuthorizable({ status: 'approved', content_digest: 'a'.repeat(64) }));
});

test('W5 返修：父目录符号链接（工作区内/外别名）不再绕过一律拒绝符号链接的声明', async (t) => {
  // 场景 A：ticketsPath 的父组件是工作区内目录别名（realpath 仍在工作区内，
  // 旧实现对最终路径 lstat 拦不住）。
  const dirA = temp(t);
  writeLocalArtifact(dirA);
  mkdirSync(join(dirA, 'real-tickets', 'nested'), { recursive: true });
  writeFileSync(join(dirA, 'real-tickets', 'nested', 't9.md'), '## 需求 9');
  symlinkSync(join(dirA, 'real-tickets'), join(dirA, 'alias-tickets'));
  await assert.rejects(
    computeLocalArtifactDigest(dirA, { ...localRequest, ticketsPath: 'alias-tickets/nested' }),
    (error: unknown) => error instanceof ArtifactDigestError && error.code === 'symlink_not_allowed',
  );

  // 场景 B：specPath 的父组件是指向工作区外的符号链接目录。
  const dirB = temp(t);
  writeLocalArtifact(dirB);
  const outsideDir = mkdtempSync(join(tmpdir(), 'agent-os-digest-out2-'));
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
  mkdirSync(join(outsideDir, 'docs'), { recursive: true });
  writeFileSync(join(outsideDir, 'docs', 'spec.md'), '越界 spec');
  symlinkSync(join(outsideDir, 'docs'), join(dirB, 'linked-docs'));
  await assert.rejects(
    computeLocalArtifactDigest(dirB, { ...localRequest, specPath: 'linked-docs/spec.md' }),
    (error: unknown) => error instanceof ArtifactDigestError && error.code === 'symlink_not_allowed',
  );
});

test('W5 返修：只有确切 .git 元数据目录被跳过，.github 下的 .md 参与摘要且漂移可检出', async (t) => {
  const dir = temp(t);
  writeLocalArtifact(dir);
  mkdirSync(join(dir, 'tickets', '.github'), { recursive: true });
  writeFileSync(join(dir, 'tickets', '.github', 'notes.md'), '## 流程备注');
  mkdirSync(join(dir, 'tickets', '.git'), { recursive: true });
  writeFileSync(join(dir, 'tickets', '.git', 'config.md'), '## git 元数据内的 .md');

  const withNotes = await computeLocalArtifactDigest(dir, localRequest);
  assert.ok(withNotes.files.some((file) => file.path === 'tickets/.github/notes.md'), '.github 下的 .md 必须进入摘要');
  assert.ok(!withNotes.files.some((file) => file.path.startsWith('tickets/.git/')), '确切 .git 元数据目录不进入摘要');

  // 增删 .github/notes.md 都要改变摘要（漂移可检出）。
  writeFileSync(join(dir, 'tickets', '.github', 'notes.md'), '## 流程备注（改）');
  const modified = await computeLocalArtifactDigest(dir, localRequest);
  assert.notEqual(modified.digest, withNotes.digest);
  rmSync(join(dir, 'tickets', '.github', 'notes.md'));
  const removed = await computeLocalArtifactDigest(dir, localRequest);
  assert.notEqual(removed.digest, withNotes.digest);
});

test('W5 返修（work/44-3）：含换行的文件名无法构造清单碰撞，不同文件集摘要必不同', async (t) => {
  const dirA = temp(t);
  const dirB = temp(t);
  // 旧「sha256  path\n」串接下，名为 "a\nb.md" 的单个文件可与两个文件
  // "a<sha256前缀伪造>" 的清单产生同串接歧义；JSON 数组编码不存在该歧义。
  mkdirSync(join(dirA, 'tickets'), { recursive: true });
  writeFileSync(join(dirA, 'spec.md'), '# 方案\n');
  writeFileSync(join(dirA, 'tickets', 'a\nb.md'), '换行文件名');
  const digestA = await computeLocalArtifactDigest(dirA, localRequest);
  assert.ok(digestA.files.some((file) => file.path === 'tickets/a\nb.md'), '路径原样进入清单，不转义换行');

  mkdirSync(join(dirB, 'tickets'), { recursive: true });
  writeFileSync(join(dirB, 'spec.md'), '# 方案\n');
  writeFileSync(join(dirB, 'tickets', 'a'), ''); // 非 .md，不参与摘要
  writeFileSync(join(dirB, 'tickets', 'b.md'), '换行文件名');
  const digestB = await computeLocalArtifactDigest(dirB, localRequest);
  assert.equal(digestA.files.length, 2);
  assert.equal(digestB.files.length, 2);
  assert.notEqual(digestA.digest, digestB.digest, '不同文件集合不得共享同一摘要（清单编码无歧义）');
  // 同名文件内容变化仍可检出。
  writeFileSync(join(dirA, 'tickets', 'a\nb.md'), '换行文件名（改）');
  const digestA2 = await computeLocalArtifactDigest(dirA, localRequest);
  assert.notEqual(digestA2.digest, digestA.digest);
});

test('W5 返修（work/44-3）：文件名中的字面反斜杠保留为文件名，不与真实子目录路径混淆', async (t) => {
  const dir = temp(t);
  mkdirSync(join(dir, 'tickets'), { recursive: true });
  writeFileSync(join(dir, 'spec.md'), '# 方案\n');
  // macOS 文件名允许字面反斜杠：旧 toPosix 会把它当分隔符转换。
  writeFileSync(join(dir, 'tickets', 'weird\\name.md'), '字面反斜杠文件');
  const onlyBackslash = await computeLocalArtifactDigest(dir, localRequest);
  assert.deepEqual(onlyBackslash.files.map((file) => file.path), ['spec.md', 'tickets/weird\\name.md']);

  // 再放入真实子目录 a/b.md：两个条目必须保持可区分且摘要不同。
  mkdirSync(join(dir, 'tickets', 'a'), { recursive: true });
  writeFileSync(join(dir, 'tickets', 'a', 'b.md'), '真实子目录文件');
  const both = await computeLocalArtifactDigest(dir, localRequest);
  assert.deepEqual(both.files.map((file) => file.path).sort(), ['spec.md', 'tickets/a/b.md', 'tickets/weird\\name.md']);
  assert.notEqual(both.digest, onlyBackslash.digest);
  rmSync(join(dir, 'tickets', 'a'), { recursive: true, force: true });
  const removedSubdir = await computeLocalArtifactDigest(dir, localRequest);
  assert.notEqual(removedSubdir.digest, both.digest);
});

test('W5 返修：嵌套唯一票据可通过同一递归验证提交（创建点与摘要口径一致）', async (t) => {
  const dir = temp(t);
  writeFileSync(join(dir, 'spec.md'), '# 方案\n\n本地交付。\n');
  mkdirSync(join(dir, 'tickets', 'epic', 'story'), { recursive: true });
  writeFileSync(join(dir, 'tickets', 'epic', 'story', 'only.md'), '## 嵌套唯一票据');
  await assert.doesNotReject(assertProductSpecDocuments(dir, localRequest));
  const digest = await computeLocalArtifactDigest(dir, localRequest);
  assert.deepEqual(digest.files.map((file) => file.path), ['spec.md', 'tickets/epic/story/only.md']);
});

test('W5 返修：G2/G3 异步完整回读守卫——批准后改文件、缺摘要、未批准、飞书模式均失败关闭', async (t) => {
  const dir = temp(t);
  writeLocalArtifact(dir);
  const digest = await computeLocalArtifactDigest(dir, localRequest);

  await assert.doesNotReject(assertArtifactStillMatchesApproval({
    flow: { status: 'approved', content_digest: digest.digest, request: localRequest } as Parameters<typeof assertArtifactStillMatchesApproval>[0]['flow'],
    workspaceDir: dir,
  }));

  writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1\n\n批准后被外部修改。');
  await assert.rejects(
    assertArtifactStillMatchesApproval({
      flow: { status: 'approved', content_digest: digest.digest, request: localRequest } as Parameters<typeof assertArtifactStillMatchesApproval>[0]['flow'],
      workspaceDir: dir,
    }),
    /批准后发生了变化|重新生成/,
  );
  writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1\n\n下单时展示会员价。');

  await assert.rejects(
    assertArtifactStillMatchesApproval({
      flow: { status: 'approved', content_digest: null, request: localRequest } as Parameters<typeof assertArtifactStillMatchesApproval>[0]['flow'],
      workspaceDir: dir,
    }),
    /没有内容摘要/,
  );
  await assert.rejects(
    assertArtifactStillMatchesApproval({
      flow: { status: 'pending', content_digest: digest.digest, request: localRequest } as Parameters<typeof assertArtifactStillMatchesApproval>[0]['flow'],
      workspaceDir: dir,
    }),
    /尚未获得审批/,
  );
  await assert.rejects(
    assertArtifactStillMatchesApproval({
      flow: { status: 'approved', content_digest: digest.digest, request: larkRequest } as Parameters<typeof assertArtifactStillMatchesApproval>[0]['flow'],
      workspaceDir: dir,
    }),
    /blocked/,
  );
  await assert.rejects(
    assertArtifactStillMatchesApproval({
      flow: { status: 'approved', content_digest: digest.digest, request: localRequest } as Parameters<typeof assertArtifactStillMatchesApproval>[0]['flow'],
      workspaceDir: undefined,
    }),
    /工作区/,
  );
});

test('work/45-5: Spec 兼作唯一 Ticket 按真实文件身份拒绝（两个静态负例）', async (t) => {
  // A：specPath 直接指向 tickets 目录内的唯一文件（路径字符串不同但同一文件）。
  const dirA = temp(t);
  mkdirSync(join(dirA, 'tickets'), { recursive: true });
  writeFileSync(join(dirA, 'tickets', 'only.md'), '# 方案\n\n既是 Spec 又是唯一 Ticket。');
  await assert.rejects(
    computeLocalArtifactDigest(dirA, { ...localRequest, specPath: 'tickets/only.md' }),
    (error: unknown) => error instanceof ArtifactDigestError && error.code === 'tickets_empty',
  );

  // B：ticketsPath='.' 且目录内只有 Spec（同一文件经 '.' 前缀重复枚举）。
  const dirB = temp(t);
  writeFileSync(join(dirB, 'spec.md'), '# 方案\n');
  await assert.rejects(
    computeLocalArtifactDigest(dirB, { ...localRequest, specPath: 'spec.md', ticketsPath: '.' }),
    (error: unknown) => error instanceof ArtifactDigestError && error.code === 'tickets_empty',
  );
});

test('work/45-1: 单次受控读取返回同批摘要与正文；读取过程中变化失败关闭', async (t) => {
  const dir = temp(t);
  writeLocalArtifact(dir);
  const snapshot = await readLocalArtifactSnapshot(dir, localRequest);
  const separate = await computeLocalArtifactDigest(dir, localRequest);
  assert.equal(snapshot.digest.digest, separate.digest);
  assert.deepEqual(snapshot.digest.files.map((file) => file.path), separate.files.map((file) => file.path));
  assert.equal(snapshot.texts.length, snapshot.digest.files.length, '正文与清单同批同序');
  assert.ok(snapshot.texts.join('\n').includes('下单时展示会员价'));

  // 注入「读取过程中 A→B」：读后改写既有文件 → 身份/内容漂移被稳定性复核拦下。
  await assert.rejects(
    readLocalArtifactSnapshot(dir, localRequest, {
      afterRead: async () => { writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1（读中被替换）'); },
    }),
    (error: unknown) => error instanceof ArtifactDigestError && error.code === 'changed_during_read',
  );
  // 读中新增文件（文件集变化）同样失败关闭。
  await assert.rejects(
    readLocalArtifactSnapshot(dir, localRequest, {
      afterRead: async () => { writeFileSync(join(dir, 'tickets', 't9.md'), '## 读中新增'); },
    }),
    (error: unknown) => error instanceof ArtifactDigestError && error.code === 'changed_during_read',
  );
});

test('work/45-1: G1 消费单次快照——读中被替换为无引用版本时确认被拒绝（不再可能绑定 A 检查 B）', async (t) => {
  const dir = temp(t);
  writeLocalArtifact(dir);
  writeFileSync(join(dir, 'spec.md'), '# 方案\n\n基于 [[kb:shop|shop.rule.checkout@3|snap-shop-1]]。\n');
  const digest = await computeLocalArtifactDigest(dir, localRequest);
  const flow = { request: localRequest, content_digest: digest.digest, knowledge_refs: [] } as GateFlow;

  // 对照先行：无注入时同一 flow 正常通过（正文令牌经核验通道）。
  const clean = await verifyApprovableArtifact({
    flow,
    workspaceDir: dir,
    verifyKnowledgeCitations: () => ({ ok: true }),
  });
  assert.deepEqual(clean, { ok: true });

  // 注入读中替换：第一次读到的 A（含令牌、摘要匹配），读中被改成 B（无令牌）。
  // 旧实现会拿 A 的摘要 + B 的正文放行；现在稳定性复核直接失败关闭。
  const gate = await verifyApprovableArtifact({
    flow,
    workspaceDir: dir,
    verifyKnowledgeCitations: () => ({ ok: true }),
    artifactReadHook: async () => {
      writeFileSync(join(dir, 'spec.md'), '# 方案\n\n（读取过程中被替换为无引用版本）。\n');
    },
  });
  assert.equal(gate.ok, false);
  if (!gate.ok) {
    assert.equal(gate.level, 'error');
    assert.match(gate.message, /读取过程中发生变化/);
  }
});

test('work/45-2: G1 对畸形 [[kb: 令牌失败关闭（有/无核验通道都拒绝）', async (t) => {
  const dir = temp(t);
  writeLocalArtifact(dir);
  writeFileSync(join(dir, 'spec.md'), '# 方案\n\n见 [[kb:shop|shop.rule.checkout@x|snap-shop-1]]。\n');
  const digest = await computeLocalArtifactDigest(dir, localRequest);
  const flow = { request: localRequest, content_digest: digest.digest, knowledge_refs: [] } as GateFlow;

  const withVerifier = await verifyApprovableArtifact({
    flow,
    workspaceDir: dir,
    verifyKnowledgeCitations: () => ({ ok: true }),
  });
  assert.equal(withVerifier.ok, false, '畸形令牌不得因核验通道存在而放行');
  if (!withVerifier.ok) assert.match(withVerifier.message, /畸形/);

  const withoutVerifier = await verifyApprovableArtifact({ flow, workspaceDir: dir });
  assert.equal(withoutVerifier.ok, false);
  if (!withoutVerifier.ok) assert.match(withoutVerifier.message, /畸形/);
});

test('work/47-1 复现：readFile 后、post stat 前的内容替换必须失败关闭（每文件窗口）', async (t) => {
  const dir = temp(t);
  writeLocalArtifact(dir);
  // 注入点：t1.md 的 readFile 返回 A 之后、post lstat 之前，写者把文件改为 B。
  // post lstat 与第二轮枚举都看到 B ⇒ 旧实现误判稳定（buffer 仍是 A）。
  const attempt = readLocalArtifactSnapshot(dir, localRequest, {
    afterFileRead: async (relPath) => {
      if (relPath === 'tickets/t1.md') {
        writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1（读后被替换为更长内容的 B 版本）\n\n用于复现窗口。');
      }
    },
  });
  await assert.rejects(attempt, (error: unknown) =>
    error instanceof ArtifactDigestError && error.code === 'changed_during_read');
  // 恢复文件，保证后续用例不受影响。
  writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1\n\n下单时展示会员价。');
});

test('work/47-1 复现：校验后、打开前的符号链接交换必须拒绝（不得读越界字节）', async (t) => {
  const dir = temp(t);
  writeLocalArtifact(dir);
  const outsideDir = mkdtempSync(join(tmpdir(), 'agent-os-out-swap-'));
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
  writeFileSync(join(outsideDir, 'stolen.md'), '# 工作区外的机密内容');
  // 注入点：spec 通过路径校验后、实际打开前，把 spec.md 换成指向工作区外的符号链接。
  const attempt = readLocalArtifactSnapshot(dir, localRequest, {
    afterValidate: async (relPath) => {
      if (relPath === 'spec.md') {
        rmSync(join(dir, 'spec.md'));
        symlinkSync(join(outsideDir, 'stolen.md'), join(dir, 'spec.md'));
      }
    },
  });
  await assert.rejects(attempt, (error: unknown) => error instanceof ArtifactDigestError);
  // 恢复 spec，保证后续用例不受影响。
  rmSync(join(dir, 'spec.md'));
  writeFileSync(join(dir, 'spec.md'), '# 方案\n\n下单流程优化。\n');
});

test('work/47-2: Spec 位于 tickets 目录时 manifest 只计一次；两次读取间修改 Spec 失败关闭', async (t) => {
  const dir = temp(t);
  mkdirSync(join(dir, 'tickets'), { recursive: true });
  writeFileSync(join(dir, 'tickets', 'spec.md'), '# 方案\n\nSpec 在 tickets 内。');
  writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1\n\n真实票据。');
  const request = { ...localRequest, specPath: 'tickets/spec.md' };

  // manifest 中 tickets/spec.md 只出现一次（不存在同路径双条目）。
  const digest = await computeLocalArtifactDigest(dir, request);
  const specEntries = digest.files.filter((file) => file.path === 'tickets/spec.md');
  assert.equal(specEntries.length, 1, 'Spec 不得在 manifest 中重复出现');
  assert.deepEqual(digest.files.map((file) => file.path), ['tickets/spec.md', 'tickets/t1.md']);

  // 时序负例：第一次读完后（第二轮复核前）修改 Spec ⇒ changed_during_read。
  await assert.rejects(
    readLocalArtifactSnapshot(dir, request, {
      afterRead: async () => { writeFileSync(join(dir, 'tickets', 'spec.md'), '# 方案（读后修改）'); },
    }),
    (error: unknown) => error instanceof ArtifactDigestError && error.code === 'changed_during_read',
  );
});

test('work/47-2: Spec 硬链接兼作唯一 Ticket 按文件身份拒绝（dev+ino）', async (t) => {
  const dir = temp(t);
  writeFileSync(join(dir, 'spec.md'), '# 方案\n');
  mkdirSync(join(dir, 'tickets'), { recursive: true });
  linkSync(join(dir, 'spec.md'), join(dir, 'tickets', 'hard.md')); // 不同 realPath、同一 inode
  await assert.rejects(
    computeLocalArtifactDigest(dir, localRequest),
    (error: unknown) => error instanceof ArtifactDigestError && error.code === 'tickets_empty',
  );
  // 增加一个真实独立票据后放行；硬链接别名不重复进入 manifest。
  writeFileSync(join(dir, 'tickets', 'real.md'), '## 真实票据');
  const digest = await computeLocalArtifactDigest(dir, localRequest);
  assert.deepEqual(digest.files.map((file) => file.path), ['spec.md', 'tickets/real.md']);
});

test('work/49-1: 解析窗口内祖先目录换成工作区外符号链接 ⇒ 拒绝且外部字节不进入快照', async (t) => {
  const dir = temp(t);
  writeLocalArtifact(dir);
  const outsideDir = mkdtempSync(join(tmpdir(), 'agent-os-out-ancestor-'));
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
  mkdirSync(join(outsideDir), { recursive: true });
  writeFileSync(join(outsideDir, 't1.md'), '外部机密 STOLEN CONTENT');
  // 精确窗口：t1.md 的 realpath 解析完成之后、解析后身份 lstat 之前，把 tickets
  // 目录换成指向工作区外的符号链接——旧实现会把外部 inode 记成“已校验身份”。
  const attempt = readLocalArtifactSnapshot(dir, localRequest, {
    afterResolve: async (label) => {
      if (label === 'tickets/t1.md') {
        rmSync(join(dir, 'tickets'), { recursive: true, force: true });
        symlinkSync(outsideDir, join(dir, 'tickets'));
      }
    },
  });
  await assert.rejects(attempt, (error: unknown) =>
    error instanceof ArtifactDigestError && (error.code === 'path_swapped' || error.code === 'symlink_not_allowed'));
  // 恢复目录结构后正常读取：内容为工作区正文，绝无外部字节。
  rmSync(join(dir, 'tickets'));
  mkdirSync(join(dir, 'tickets'), { recursive: true });
  writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1\n\n下单时展示会员价。');
  writeFileSync(join(dir, 'tickets', 't2.md'), '## 需求 2\n\n退款入口前置。');
  mkdirSync(join(dir, 'tickets', 'epic-1'), { recursive: true });
  writeFileSync(join(dir, 'tickets', 'epic-1', 't3.md'), '## 需求 3\n\n优惠券叠加。');
  const snapshot = await readLocalArtifactSnapshot(dir, localRequest);
  assert.ok(!snapshot.texts.join('\n').includes('STOLEN'), '外部字节不得进入快照正文');
  assert.ok(snapshot.digest.files.length >= 3);
});

test('work/49-1: 校验后、打开前祖先目录换成工作区外符号链接 ⇒ 打开即拒绝', async (t) => {
  const dir = temp(t);
  writeLocalArtifact(dir);
  const outsideDir = mkdtempSync(join(tmpdir(), 'agent-os-out-open-'));
  t.after(() => rmSync(outsideDir, { recursive: true, force: true }));
  writeFileSync(join(outsideDir, 't1.md'), '外部机密 STOLEN CONTENT');
  const attempt = readLocalArtifactSnapshot(dir, localRequest, {
    afterValidate: async (relPath) => {
      if (relPath === 'tickets/t1.md') {
        rmSync(join(dir, 'tickets'), { recursive: true, force: true });
        symlinkSync(outsideDir, join(dir, 'tickets'));
      }
    },
  });
  await assert.rejects(attempt, (error: unknown) =>
    error instanceof ArtifactDigestError && (error.code === 'path_swapped' || error.code === 'symlink_not_allowed'));
  rmSync(join(dir, 'tickets'));
  mkdirSync(join(dir, 'tickets'), { recursive: true });
  writeFileSync(join(dir, 'tickets', 't1.md'), '## 需求 1\n\n下单时展示会员价。');
  writeFileSync(join(dir, 'tickets', 't2.md'), '## 需求 2\n\n退款入口前置。');
  mkdirSync(join(dir, 'tickets', 'epic-1'), { recursive: true });
  writeFileSync(join(dir, 'tickets', 'epic-1', 't3.md'), '## 需求 3\n\n优惠券叠加。');
  const snapshot = await readLocalArtifactSnapshot(dir, localRequest);
  assert.ok(!snapshot.texts.join('\n').includes('STOLEN'), '外部字节不得进入快照正文');
});
