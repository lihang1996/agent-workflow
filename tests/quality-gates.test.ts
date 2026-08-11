import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  GateResultSchema,
  assertEvidenceChainComplete,
  assertFindingContinuity,
  assertGateWaiversBoundToCanonicalSpec,
  assertGateAttemptBudget,
  assertGateChecksBelongToAttempt,
  assertGateLineage,
  assertOutstandingFindingsCarriedForward,
  assertPlannedFindingsClosed,
  bindGateWaiversToCanonicalSpec,
  consolidateLatestGateFindings,
  createGateRun,
  parseGateResult,
  parseCanonicalSpecWaivers,
  rewindStepIdFromDriftMessage,
  validateGatePass,
  verifyGateArtifacts,
} from '../src/core/quality-gates.js';
import { DEFAULT_PIPELINE_STEPS } from '../src/core/pipeline.js';
import { hashPathArtifact } from '../src/core/project-snapshot.js';
import { JsonWorkflowStore } from '../src/core/workflow-store.js';

function passingCheck(id = 'validate') {
  const finishedAt = new Date(Date.now() - 1_000).toISOString();
  const startedAt = new Date(Date.now() - 2_000).toISOString();
  return {
    id,
    command: ['node', 'validator.mjs'],
    status: 'pass' as const,
    required: true,
    exitCode: 0,
    cwd: '/tmp',
    startedAt,
    finishedAt,
  };
}

function result(gateId: 'design' | 'implementation' | 'change-review' | 'verification' | 'runtime-audit' | 'final-review') {
  const review = gateId === 'change-review' || gateId === 'final-review';
  return GateResultSchema.parse({
    gateId,
    status: 'pass',
    summary: 'verified',
    requirementIds: ['RQ-001'],
    checks: [{ ...passingCheck('build'), command: ['pnpm', 'build'] }],
    evidence: ['/tmp/report.json'],
    artifacts: [{ path: '/tmp/report.json', sha256: 'a'.repeat(64), kind: review ? 'review-report' : 'other' }],
    findings: [],
  });
}

test('设计门禁允许 planned P0/P1，实现门禁必须同 id 闭环', () => {
  const planned = {
    id: 'FIND-001',
    severity: 'P1' as const,
    status: 'planned' as const,
    summary: '登录态校验缺口',
    evidence: ['change-plan.json#implementationPoints', 'change-plan.json#verificationPoints'],
  };
  const design = GateResultSchema.parse({
    gateId: 'design',
    status: 'pass',
    summary: 'plan ready',
    requirementIds: ['RQ-1'],
    checks: [passingCheck('validate-plan')],
    evidence: ['change-plan.json'],
    artifacts: [{ path: '/tmp/plan.json', sha256: 'a'.repeat(64), kind: 'plan' }],
    findings: [planned],
  });
  assert.doesNotThrow(() => validateGatePass('architect', design));
  assert.throws(
    () => validateGatePass('architect', GateResultSchema.parse({
      ...design,
      findings: [{ ...planned, status: 'open', evidence: [] }],
    })),
    /P0\/P1/,
  );

  const designRun = createGateRun('architect', design, [], 'a'.repeat(64));
  const emptyImpl = GateResultSchema.parse({
    gateId: 'implementation',
    status: 'pass',
    summary: 'done',
    requirementIds: ['RQ-1'],
    checks: [passingCheck('validate-plan')],
    evidence: ['e'],
    artifacts: [{ path: '/tmp/manifest.json', sha256: 'a'.repeat(64), kind: 'manifest' }],
    findings: [],
  });
  assert.throws(
    () => assertPlannedFindingsClosed('dev', [designRun], emptyImpl),
    /FIND-001/,
  );
  const closedImpl = GateResultSchema.parse({
    ...emptyImpl,
    findings: [{
      id: 'FIND-001',
      severity: 'P1',
      status: 'resolved',
      summary: 'fixed',
      evidence: ['src/auth.ts:10', 'tests/auth.test.ts:1'],
    }],
  });
  assert.doesNotThrow(() => assertPlannedFindingsClosed('dev', [designRun], closedImpl));
  assert.doesNotThrow(() => assertPlannedFindingsClosed('review', [designRun], emptyImpl));
});

test('findings 的 disposition 字段会归一化为 status', () => {
  const parsed = GateResultSchema.parse({
    gateId: 'design',
    status: 'pass',
    summary: 'plan',
    requirementIds: ['RQ-1'],
    checks: [passingCheck('validate-plan')],
    evidence: ['change-plan.json'],
    artifacts: [{ path: '/tmp/plan.json', sha256: 'a'.repeat(64), kind: 'plan' }],
    findings: [
      { id: 'FIND-001', severity: 'P1', summary: '已闭环', disposition: 'resolved', evidence: ['src/a.ts:1'] },
      { id: 'FIND-002', severity: 'P2', summary: '已协调', disposition: 'fixed', evidence: ['tests/a.test.ts:1'] },
    ],
  });
  assert.equal(parsed.findings.find((item) => item.id === 'FIND-001')?.status, 'resolved');
  assert.equal(parsed.findings.find((item) => item.id === 'FIND-002')?.status, 'resolved');
  assert.doesNotThrow(() => validateGatePass('architect', parsed));
});

test('waiver 只能绑定人工确认前 canonical Spec 中的同 ID 风险条款', () => {
  const declarations = [
    {
      findingId: 'DFIND-005',
      owner: 'security-owner',
      reason: '兼容窗口内接受残余风险',
      scope: '仅限当前 CSP inline script 配置',
      compensatingControl: '保持 CSP 上报与周度审查',
      expiresAt: '2099-11-08T23:59:59.000Z',
    },
    {
      findingId: 'FIND-005',
      owner: 'leon (CEO/负责人)',
      reason: '文档化权衡，nonce 方案后续再做',
      scope: '仅限 next.config.ts 的现有 CSP 配置',
      compensatingControl: '开启 CSP report-only 监控并限制变更权限',
      expiresAt: '2099-11-08T23:59:59.000Z',
    },
  ];
  const content = [
    '### RQ-001 CSP 兼容',
    ...declarations.map((item) => `[RISK_WAIVER] ${JSON.stringify(item)}`),
  ].join('\n');
  const context = {
    specId: 'spec-1',
    version: 2,
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    approvedAt: '2026-08-11T00:00:00.000Z',
  };
  const unbound = GateResultSchema.parse({
    ...result('design'),
    findings: declarations.map((item) => ({
      id: item.findingId,
      severity: 'P3',
      status: 'waived',
      summary: item.reason,
      evidence: ['canonical-spec.md'],
      waiver: {
        owner: item.owner,
        reason: item.reason,
        scope: item.scope,
        compensatingControl: item.compensatingControl,
        expiresAt: item.expiresAt,
      },
    })),
  });

  assert.equal(parseCanonicalSpecWaivers(content).length, 2);
  const bound = bindGateWaiversToCanonicalSpec(unbound, context);
  assert.match(bound.findings[0]?.waiver?.approvalEvidence ?? '', /^canonical-spec:spec-1:v2:sha256:/);
  assert.equal(bound.findings[0]?.waiver?.approvedAt, context.approvedAt);
  assert.doesNotThrow(() => assertGateWaiversBoundToCanonicalSpec(bound, context));
  assert.doesNotThrow(() => validateGatePass('architect', bound));

  const forged = GateResultSchema.parse({
    ...bound,
    findings: bound.findings.map((finding, index) => index === 0
      ? { ...finding, waiver: { ...finding.waiver!, approvalEvidence: 'canonical-spec:forged' } }
      : finding),
  });
  assert.throws(
    () => assertGateWaiversBoundToCanonicalSpec(forged, context),
    /批准绑定缺失、过期或被改写/,
  );
  assert.throws(
    () => bindGateWaiversToCanonicalSpec(GateResultSchema.parse({
      ...unbound,
      findings: [{ ...unbound.findings[0], id: 'FIND-NOT-APPROVED' }],
    }), context),
    /未在人工批准前/,
  );
  assert.throws(
    () => parseCanonicalSpecWaivers('### RQ-001\n[RISK_WAIVER] {"findingId":"FIND-1"}'),
    /格式错误/,
  );
});

test('findings 兼容 INFO severity 与 title/detail 别名', () => {
  const parsed = GateResultSchema.parse({
    gateId: 'design',
    status: 'pass',
    summary: 'plan',
    requirementIds: ['RQ-1'],
    checks: [passingCheck('validate-plan')],
    evidence: ['change-plan.json'],
    artifacts: [{ path: '/tmp/plan.json', sha256: 'a'.repeat(64), kind: 'plan' }],
    findings: [
      {
        id: 'DFIND-001',
        severity: 'INFO',
        title: '契约指纹差异已解释',
        detail: '当前树与 QA implementationHash 一致',
        evidence: ['change-plan.json#fingerprint'],
      },
      {
        id: 'DFIND-002',
        priority: 'p1',
        summary: '需实现的风险点',
        evidence: ['change-plan.json#implementationPoints'],
        status: 'planned',
      },
    ],
  });
  assert.equal(parsed.findings[0]?.severity, 'P3');
  assert.equal(parsed.findings[0]?.status, 'resolved');
  assert.match(parsed.findings[0]?.summary ?? '', /契约指纹差异已解释/);
  assert.equal(parsed.findings[1]?.severity, 'P1');
  assert.doesNotThrow(() => validateGatePass('architect', parsed));
});

test('GATE_RESULT 兼容低风险形状，但拒绝不可复现的 command 字符串', () => {
  assert.throws(() => GateResultSchema.parse({
    gateId: 'design',
    status: 'pass',
    summary: 'ambiguous command',
    checks: { id: 'validate', command: 'node scripts/validate.mjs plan.json', exitCode: 0 },
    artifacts: { path: '/tmp/change-plan.json', sha256: 'a'.repeat(64), kind: 'plan' },
  }), /command/);

  const parsed = GateResultSchema.parse({
    gateId: 'Design',
    status: 'PASS',
    summary: '架构门禁通过',
    requirementIds: 'RQ-001',
    checks: {
      id: 'validate',
      command: ['node', 'scripts/validate.mjs', 'plan.json'],
      exitCode: '0',
      durationMs: '12',
      cwd: '/tmp',
      startedAt: new Date(Date.now() - 2_000).toISOString(),
      finishedAt: new Date(Date.now() - 1_000).toISOString(),
    },
    evidence: '/tmp/change-plan.json',
    artifacts: {
      path: '/tmp/change-plan.json',
      sha256: 'A'.repeat(64),
      kind: 'change-plan',
    },
    findings: [
      {
        id: 'DFIND-001',
        severity: 'P1',
        status: 'resolved',
        summary: 'CI 顺序已修',
        evidence: '/Users/leon/Desktop/leon-blog/.github/workflows/ci.yml:52-75',
      },
      {
        id: 'DFIND-002',
        severity: 'P2',
        status: 'open',
        summary: 'E2E blocked',
        evidence: '/tmp/verification-report.json:e2e=blocked',
      },
      {
        id: 'DFIND-005',
        severity: 'P3',
        status: 'accepted',
        summary: 'CSP residual',
        evidence: 'next.config.ts:54; docs/csp.md',
        waiver: {
          owner: 'security-owner',
          reason: '兼容窗口内接受残余风险',
          scope: '仅限当前 CSP inline script 配置',
          compensatingControl: '保持 CSP 上报与周度审查',
          approvedAt: '2020-08-10T00:00:00.000Z',
          approvalEvidence: 'lark://approval/CSP-005',
          expiresAt: '2099-11-08T23:59:59.000Z',
        },
      },
      {
        id: 'FIND-005',
        severity: 'P3',
        status: 'waived',
        summary: "CSP script-src 'unsafe-inline' 为文档化权衡",
        evidence: ['/Users/leon/Desktop/leon-blog/next.config.ts:54'],
        waiver: {
          owner: 'leon (CEO/负责人)',
          reason: '文档化权衡，nonce 方案后续再做',
          scope: '仅限 next.config.ts 的现有 CSP 配置',
          compensatingControl: '开启 CSP report-only 监控并限制变更权限',
          approvedAt: '2020-08-10T00:00:00.000Z',
          approvalEvidence: 'lark://approval/FIND-005',
          expiresAt: '2099-11-08T23:59:59.000Z',
        },
      },
    ],
  });

  assert.deepEqual(parsed.requirementIds, ['RQ-001']);
  assert.deepEqual(parsed.evidence, ['/tmp/change-plan.json']);
  assert.equal(parsed.checks[0]?.exitCode, 0);
  assert.deepEqual(parsed.checks[0]?.command, ['node', 'scripts/validate.mjs', 'plan.json']);
  assert.equal(parsed.artifacts[0]?.kind, 'plan');
  assert.equal(parsed.artifacts[0]?.sha256, 'a'.repeat(64));
  assert.deepEqual(parsed.findings[0]?.evidence, [
    '/Users/leon/Desktop/leon-blog/.github/workflows/ci.yml:52-75',
  ]);
  assert.equal(parsed.findings[2]?.status, 'waived');
  assert.deepEqual(parsed.findings[2]?.evidence, ['next.config.ts:54', 'docs/csp.md']);
  assert.equal(parsed.findings[3]?.status, 'waived');
  assert.equal(parsed.findings[3]?.waiver?.expiresAt, '2099-11-08T23:59:59.000Z');
  assert.throws(
    () => validateGatePass('architect', parsed),
    /canonical Spec 人工批准绑定/,
  );
});

test('waiverId + 顶层 waivers[] 会补全 waived，且与审查 artifact 比对一致', async () => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'agent-os-waiver-id-'));
  try {
    const reportPath = join(evidenceRoot, 'final-review.json');
    const chainPath = join(evidenceRoot, 'evidence-chain.json');
    const chainContent = JSON.stringify({
      schemaVersion: '2.0',
      generatedBy: 'agent-os-controller',
      controllerOwned: true,
    });
    await writeFile(chainPath, chainContent);
    const report = {
      status: 'pass',
      decision: 'approved-with-waiver',
      finalFingerprint: 'f'.repeat(64),
      reviewedDiff: 'HEAD',
      reviewScope: { changedFiles: ['src/app.ts'] },
      evidenceChain: {
        path: chainPath,
        sha256: createHash('sha256').update(chainContent).digest('hex'),
      },
      requirementCoverage: [{ id: 'RQ-001', status: 'pass' }],
      notReviewed: [],
      residualRisks: [],
      findings: [
        {
          id: 'FIND-205',
          severity: 'P3',
          status: 'waived',
          waiverId: 'WAIVER-205',
          summary: '动态段软 404',
          evidence: ['src/app/(site)/posts/[slug]/page.tsx:42'],
        },
      ],
      waivers: [
        {
          findingId: 'WAIVER-205',
          owner: 'leon（CEO）',
          reason: 'Next PPR 已知限制',
          scope: '仅限动态文章不存在时的软 404',
          compensatingControl: '监控 404 响应并保留回滚开关',
          approvedAt: '2020-08-10T00:00:00.000Z',
          approvalEvidence: 'lark://approval/WAIVER-205',
          expiresAt: '2099-11-08T23:59:59.000Z',
        },
      ],
    };
    await writeFile(reportPath, JSON.stringify(report));
    const sha256 = createHash('sha256').update(JSON.stringify(report)).digest('hex');
    // GATE_RESULT 也只带 waiverId，不内嵌 waiver 对象
    const gate = GateResultSchema.parse({
      gateId: 'final-review',
      status: 'pass',
      summary: '终审通过',
      requirementIds: ['RQ-001'],
      evidence: [reportPath],
      artifacts: [{ path: reportPath, sha256, kind: 'review-report' }],
      findings: [
        {
          id: 'FIND-205',
          severity: 'P3',
          status: 'waived',
          waiverId: 'WAIVER-205',
          summary: '动态段软 404（已登记 waiver）',
          evidence: [reportPath],
        },
      ],
      waivers: report.waivers,
    });
    assert.equal(gate.findings[0]?.status, 'waived');
    assert.equal(gate.findings[0]?.waiver?.owner, 'leon（CEO）');
    assert.equal(gate.findings[0]?.waiver?.expiresAt, '2099-11-08T23:59:59.000Z');

    const hydrated = await parseGateResult(
      `[GATE_RESULT] ${JSON.stringify({
        gateId: 'final-review',
        status: 'pass',
        summary: '终审通过',
        requirementIds: ['RQ-001'],
        checks: [],
        evidence: [reportPath],
        artifacts: [{ path: reportPath, sha256: '0'.repeat(64), kind: 'review-report' }],
        findings: gate.findings,
        waivers: report.waivers,
      })}`,
      'final_review',
      { evidenceRoot },
    );
    assert.equal(hydrated.findings[0]?.status, 'waived');
    await assert.doesNotReject(verifyGateArtifacts(evidenceRoot, hydrated));

    const forgedReport = {
      ...report,
      evidenceChain: { ...report.evidenceChain, sha256: 'f'.repeat(64) },
    };
    const forgedContent = JSON.stringify(forgedReport);
    await writeFile(reportPath, forgedContent);
    const forgedGate = GateResultSchema.parse({
      ...gate,
      artifacts: [{
        path: reportPath,
        sha256: createHash('sha256').update(forgedContent).digest('hex'),
        kind: 'review-report',
      }],
    });
    await assert.rejects(
      verifyGateArtifacts(evidenceRoot, forgedGate),
      /evidenceChain hash 与控制器证据链不一致/,
    );
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});

test('门禁结果必须是匹配步骤的可解析结构化 JSON', async () => {
  await assert.rejects(() => parseGateResult('[RESULT:done]', 'qa'), /缺少可解析的 \[GATE_RESULT\]/);
  await assert.rejects(
    () => parseGateResult('[GATE_RESULT] {"gateId":"design","status":"pass","summary":"x","artifacts":[{"path":"/tmp/a","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"other"}]}', 'qa'),
    /gateId=design|必须报告 gateId=verification|期望 verification/,
  );
  const parsed = await parseGateResult(
    '[RESULT:done]\n[GATE_RESULT] {"gateId":"verification","status":"pass","summary":"ok","requirementIds":[],"checks":[{"id":"test","command":["pnpm","test"],"exitCode":0}],"evidence":["report"],"artifacts":[{"path":"/tmp/report.json","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","kind":"command-report"}],"findings":[]}',
    'qa',
  );
  assert.equal(parsed.gateId, 'verification');
});

test('GATE_RESULT 可用括号匹配提取，容忍行尾 DSML/工具调用垃圾与多行 JSON', async () => {
  const payload = {
    gateId: 'change-review',
    status: 'pass',
    summary: '变更审查通过',
    requirementIds: ['RQ-001'],
    checks: [{ id: 'validate-review-report', command: ['node', 'validate.mjs', 'report.json'], exitCode: 0 }],
    evidence: ['/tmp/change-review.json'],
    artifacts: [{
      path: '/tmp/change-review.json',
      sha256: 'b'.repeat(64),
      kind: 'review-report',
    }],
    findings: [],
  };
  const polluted = [
    '评审结论正文',
    '[APPROVED]',
    '[RESULT:done]',
    `[GATE_RESULT] ${JSON.stringify(payload)}]`,
    '</｜｜DSML｜｜parameter>',
    '</｜｜DSML｜｜invoke>',
    '</｜｜DSML｜｜tool_calls>',
  ].join('\n');
  const parsed = await parseGateResult(polluted, 'review');
  assert.equal(parsed.gateId, 'change-review');
  assert.equal(parsed.checks[0]?.id, 'validate-review-report');

  const multiline = [
    '[GATE_RESULT] {',
    '  "gateId": "change-review",',
    '  "status": "pass",',
    '  "summary": "多行 JSON",',
    '  "requirementIds": [],',
    '  "checks": [{"id":"v","command":["node","v.mjs"],"exitCode":0}],',
    '  "evidence": ["x"],',
    '  "artifacts": [{"path":"/tmp/a.json","sha256":"' + 'c'.repeat(64) + '","kind":"review-report"}],',
    '  "findings": []',
    '}',
  ].join('\n');
  const multi = await parseGateResult(multiline, 'review');
  assert.equal(multi.summary, '多行 JSON');
});

test('答案完全缺少 GATE_RESULT 时可从证据目录主 artifact 恢复', async () => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'agent-os-gate-recover-'));
  try {
    const reportPath = join(evidenceRoot, 'change-review.json');
    const report = {
      status: 'pass',
      decision: 'approved',
      implementationFingerprint: 'a'.repeat(64),
      reviewFingerprint: 'a'.repeat(64),
      reviewScope: {
        changedFiles: ['src/a.ts'],
        staged: [],
        unstaged: [],
        untracked: [],
        deleted: [],
        discrepancies: { statusNotInManifest: [], manifestNotInStatus: [] },
      },
      requirementCoverage: [{ id: 'RQ-001', status: 'pass' }],
      relatedContracts: [],
      notReviewed: [],
      residualRisks: [],
      checks: [{
        id: 'validate-review-report',
        command: ['node', 'validate-review-report.mjs', 'change-review.json'],
        status: 'pass',
        required: true,
        exitCode: 0,
        cwd: evidenceRoot,
        startedAt: '2020-08-10T00:00:00.000Z',
        finishedAt: '2020-08-10T00:00:01.000Z',
      }],
      findings: [
        {
          id: 'FIND-1',
          severity: 'P2',
          status: 'open',
          summary: 'residual',
          evidence: ['src/a.ts:1'],
        },
      ],
    };
    await writeFile(reportPath, JSON.stringify(report));
    const parsed = await parseGateResult(
      '评审完成，已写入 change-review.json。\n[RESULT:done]\n[APPROVED]',
      'review',
      { evidenceRoot },
    );
    assert.equal(parsed.gateId, 'change-review');
    assert.equal(parsed.status, 'pass');
    assert.equal(parsed.artifacts[0]?.path, reportPath);
    assert.equal(parsed.artifacts[0]?.kind, 'review-report');
    assert.equal(parsed.findings[0]?.id, 'FIND-1');
    await assert.doesNotReject(verifyGateArtifacts(evidenceRoot, parsed));
    assert.doesNotThrow(() => validateGatePass('review', parsed));
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});

test('GATE_RESULT 对证据目录内 artifact 会按文件内容重算错误长度的 sha256', async () => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'agent-os-gate-sha-'));
  try {
    const scopePath = join(evidenceRoot, 'scope.json');
    const manifestPath = join(evidenceRoot, 'implementation-manifest.json');
    const scopeContent = JSON.stringify({ allowedPaths: ['src/**'], notes: 'scope' });
    const targetedCheck = passingCheck('targeted-test');
    const manifestContent = JSON.stringify({
      contractHash: 'a'.repeat(64),
      planHash: 'b'.repeat(64),
      fingerprintBefore: 'c'.repeat(64),
      fingerprintAfter: 'd'.repeat(64),
      changedFiles: ['src/a.ts'],
      requirementImplementations: [{ requirementId: 'RQ-1', files: ['src/a.ts'] }],
      targetedCheckResults: [targetedCheck],
      status: 'pass',
    });
    await writeFile(scopePath, scopeContent);
    await writeFile(manifestPath, manifestContent);
    const realScopeSha = createHash('sha256').update(scopeContent).digest('hex');
    const realManifestSha = createHash('sha256').update(manifestContent).digest('hex');
    // 复现线上失败：LLM 给出 66 位假 hex（本例在真实 64 位前多写了 "66"）
    const fakeScopeSha = `66${realScopeSha}`;
    assert.equal(fakeScopeSha.length, 66);

    const payload = {
      gateId: 'implementation',
      status: 'pass',
      summary: 'implementation verified',
      requirementIds: ['RQ-1'],
      checks: [targetedCheck],
      evidence: [manifestPath],
      artifacts: [
        { path: manifestPath, sha256: realManifestSha, kind: 'manifest' },
        { path: scopePath, sha256: fakeScopeSha, kind: 'other' },
      ],
      findings: [],
    };
    const answer = `[GATE_RESULT] ${JSON.stringify(payload)}`;

    await assert.rejects(
      () => parseGateResult(answer, 'dev'),
      /artifacts\.1\.sha256/,
    );

    const parsed = await parseGateResult(answer, 'dev', { evidenceRoot });
    assert.equal(parsed.artifacts[0]?.sha256, realManifestSha);
    assert.equal(parsed.artifacts[1]?.sha256, realScopeSha);
    assert.equal(parsed.artifacts[1]?.sha256.length, 64);
    await assert.doesNotReject(verifyGateArtifacts(evidenceRoot, parsed));
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});

test('GATE_RESULT 兼容 sha256 前缀与大小写，但不盲目截断超长 hex', () => {
  const wrapped = GateResultSchema.parse({
    gateId: 'design',
    status: 'pass',
    summary: 'ok',
    artifacts: [{
      path: '/tmp/plan.json',
      sha256: `SHA-256: ${'Ab'.repeat(32)}`,
      kind: 'plan',
    }],
  });
  assert.equal(wrapped.artifacts[0]?.sha256, 'ab'.repeat(32));

  assert.throws(
    () => GateResultSchema.parse({
      gateId: 'design',
      status: 'pass',
      summary: 'ok',
      artifacts: [{
        path: '/tmp/plan.json',
        sha256: `66${'a'.repeat(64)}`,
        kind: 'plan',
      }],
    }),
    /sha256/i,
  );
});

test('伪造 pass 不能绕过真实命令证据或开放 P0/P1', () => {
  assert.throws(
    () => validateGatePass('qa', GateResultSchema.parse({
      gateId: 'verification', status: 'pass', summary: 'claimed', checks: [], evidence: [],
      requirementIds: ['RQ-1'],
      artifacts: [{ path: '/tmp/a', sha256: 'a'.repeat(64), kind: 'other' }], findings: [],
    })),
    /真实校验命令/,
  );
  assert.throws(
    () => validateGatePass('final_review', GateResultSchema.parse({
      gateId: 'final-review', status: 'pass', summary: 'claimed', checks: [], evidence: ['review'],
      requirementIds: ['RQ-1'],
      artifacts: [{ path: '/tmp/a', sha256: 'a'.repeat(64), kind: 'other' }],
      findings: [{ id: 'SEC-1', severity: 'P1', summary: 'open issue', status: 'open', evidence: [] }],
    })),
    /P0\/P1/,
  );
  assert.throws(
    () => validateGatePass('review', GateResultSchema.parse({
      gateId: 'change-review', status: 'pass', summary: 'text only', checks: [], evidence: ['review'],
      requirementIds: ['RQ-1'],
      artifacts: [{ path: '/tmp/a', sha256: 'a'.repeat(64), kind: 'review-report' }], findings: [],
    })),
    /校验命令/,
  );
});

test('设计以外不得用 planned 掩盖未完成项，可选检查失败会保留但不冒充必需检查', () => {
  const planned = GateResultSchema.parse({
    gateId: 'implementation', status: 'pass', summary: 'not really complete', checks: [], evidence: ['manifest'],
    requirementIds: ['RQ-1'],
    artifacts: [{ path: '/tmp/implementation-manifest.json', sha256: 'a'.repeat(64), kind: 'manifest' }],
    findings: [{
      id: 'FIND-PLANNED', severity: 'P2', status: 'planned', summary: 'still planned',
      evidence: ['change-plan.json#implementationPoints'],
    }],
  });
  assert.throws(() => validateGatePass('dev', planned), /只有设计门禁可以登记 planned/);

  const requiredPass = {
    id: 'unit', command: ['pnpm', 'test'], status: 'pass' as const, required: true, exitCode: 0,
    cwd: '/tmp/project',
    startedAt: '2020-08-10T00:00:00.000Z',
    finishedAt: '2020-08-10T00:00:01.000Z',
  };
  const optionalBlocked = {
    id: 'browser-e2e', command: ['pnpm', 'e2e'], status: 'blocked' as const, required: false, exitCode: null,
    cwd: '/tmp/project',
    startedAt: '2020-08-10T00:00:00.000Z',
    finishedAt: '2020-08-10T00:00:01.000Z',
  };
  const qa = GateResultSchema.parse({
    gateId: 'verification', status: 'pass', summary: 'required checks pass', evidence: ['report'],
    requirementIds: ['RQ-1'],
    checks: [requiredPass, optionalBlocked], findings: [],
    artifacts: [{ path: '/tmp/verification-report.json', sha256: 'a'.repeat(64), kind: 'command-report' }],
  });
  assert.doesNotThrow(() => validateGatePass('qa', qa));
  assert.throws(() => GateResultSchema.parse({
    ...qa,
    checks: [{ ...optionalBlocked, exitCode: 0 }],
  }), /不能声称 exitCode=0/);
});

test('最终审查必须继承上游残余风险且不得降级，后续 resolved 可闭环', () => {
  const fingerprint = 'a'.repeat(64);
  const upstreamResult = GateResultSchema.parse({
    ...result('verification'),
    findings: [{
      id: 'RISK-001', severity: 'P2', status: 'open', summary: 'browser not verified', evidence: ['qa.json#browser'],
    }],
  });
  const upstream = [createGateRun('qa', upstreamResult, [], fingerprint)];
  const emptyFinal = GateResultSchema.parse({ ...result('final-review'), findings: [] });
  assert.throws(
    () => assertOutstandingFindingsCarriedForward(upstream, emptyFinal),
    /未继承上游残余风险 RISK-001/,
  );
  const downgradedFinal = GateResultSchema.parse({
    ...emptyFinal,
    findings: [{
      id: 'RISK-001', severity: 'P3', status: 'open', summary: 'downgraded', evidence: ['final.json#risk'],
    }],
  });
  assert.throws(
    () => assertOutstandingFindingsCarriedForward(upstream, downgradedFinal),
    /不得静默降低/,
  );
  const resolvedFinal = GateResultSchema.parse({
    ...emptyFinal,
    findings: [{
      id: 'RISK-001', severity: 'P2', status: 'resolved', summary: 'verified later', evidence: ['e2e.log'],
    }],
  });
  assert.doesNotThrow(() => assertOutstandingFindingsCarriedForward(upstream, resolvedFinal));
  const runs = [...upstream, createGateRun('final_review', resolvedFinal, upstream, fingerprint)];
  assert.equal(consolidateLatestGateFindings(runs)[0]?.status, 'resolved');
});

test('finding 不能跨门禁静默降级，resolved 也必须有定位证据', () => {
  const upstreamResult = GateResultSchema.parse({
    ...result('verification'),
    findings: [{
      id: 'RISK-TRACE', severity: 'P2', status: 'open', summary: '边界尚未验证', evidence: ['qa.json#risk'],
    }],
  });
  const runs = [createGateRun('qa', upstreamResult, [], 'a'.repeat(64))];
  const downgraded = GateResultSchema.parse({
    ...result('runtime-audit'),
    findings: [{
      id: 'RISK-TRACE', severity: 'P3', status: 'resolved', summary: '声称已解决', evidence: ['runtime.json#risk'],
    }],
  });
  assert.throws(() => assertFindingContinuity(runs, downgraded), /不得静默降低/);

  const noEvidence = GateResultSchema.parse({
    ...result('runtime-audit'),
    findings: [{ id: 'RISK-TRACE', severity: 'P2', status: 'resolved', summary: '缺少证据' }],
  });
  assert.throws(() => validateGatePass('runtime_audit', noEvidence), /必须包含可定位证据/);
});

test('当前 Gate 不能复用步骤启动前的旧命令时间戳', () => {
  const gate = GateResultSchema.parse({
    ...result('verification'),
    checks: [{
      ...passingCheck('stale-test'),
      startedAt: '2020-08-10T00:00:00.000Z',
      finishedAt: '2020-08-10T00:00:01.000Z',
    }],
  });
  assert.throws(
    () => assertGateChecksBelongToAttempt(gate, '2026-08-11T00:00:00.000Z'),
    /旧轮次/,
  );
  assert.doesNotThrow(() => assertGateChecksBelongToAttempt(gate, '2020-08-10T00:00:00.000Z'));
});

test('同一质量门禁达到尝试预算后停止自动返工', () => {
  const fingerprint = 'a'.repeat(64);
  let runs: ReturnType<typeof createGateRun>[] = [];
  for (let index = 0; index < 3; index += 1) {
    runs = [...runs, createGateRun('dev', result('implementation'), runs, fingerprint)];
  }
  assert.doesNotThrow(() => assertGateAttemptBudget('dev', runs, 4));
  assert.throws(() => assertGateAttemptBudget('dev', runs, 3), /尝试上限/);
  assert.doesNotThrow(() => assertGateAttemptBudget('summary', runs, 0));
});

test('审查 artifact 中的无效 finding 必须 fail closed，不能在水合时消失', async () => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'agent-os-invalid-finding-'));
  try {
    const reportPath = join(evidenceRoot, 'final-review.json');
    const report = {
      status: 'pass', decision: 'approved-with-waiver', requirementCoverage: [{ id: 'RQ-1', status: 'pass' }],
      notReviewed: [], residualRisks: [], waivers: [],
      findings: [{
        id: 'RISK-BAD', severity: 'P3', status: 'waived', summary: 'missing real approval', evidence: ['x'],
      }],
    };
    const content = JSON.stringify(report);
    await writeFile(reportPath, content);
    await assert.rejects(
      parseGateResult(`[GATE_RESULT] ${JSON.stringify({
        gateId: 'final-review', status: 'pass', summary: 'claimed', checks: [], evidence: [reportPath],
        artifacts: [{
          path: reportPath,
          sha256: createHash('sha256').update(content).digest('hex'),
          kind: 'review-report',
        }],
        findings: [],
      })}`, 'final_review', { evidenceRoot }),
      /findings\[0\].*waiver|findings\.0\.waiver/,
    );
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});

test('artifact 中任一无效 check 必须 fail closed，不能只保留可解析项', async () => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'agent-os-invalid-check-'));
  try {
    const reportPath = join(evidenceRoot, 'runtime-audit.json');
    const report = {
      status: 'pass',
      environment: 'test',
      buildHash: 'a'.repeat(64),
      surfaceMatrix: [{ priority: 'P2', requiredStates: [], results: [] }],
      requiredBrowsers: [],
      browserAndViewportResults: [],
      unverified: [],
      findings: [],
      checks: [passingCheck('valid'), { id: 'ambiguous', command: 'node test.js', exitCode: 0 }],
    };
    const content = JSON.stringify(report);
    await writeFile(reportPath, content);
    await assert.rejects(
      parseGateResult(`[GATE_RESULT] ${JSON.stringify({
        gateId: 'runtime-audit', status: 'pass', summary: 'claimed', checks: [], evidence: [reportPath],
        artifacts: [{
          path: reportPath,
          sha256: createHash('sha256').update(content).digest('hex'),
          kind: 'runtime-report',
        }],
        findings: [],
      })}`, 'runtime_audit', { evidenceRoot }),
      /artifact checks\[1\].*command/,
    );
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});

test('artifact 必须位于工作流证据目录且内容 hash 匹配', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-gate-artifact-'));
  try {
    const evidenceRoot = join(root, 'evidence');
    await mkdir(evidenceRoot);
    const artifactPath = join(evidenceRoot, 'change-plan.json');
    const content = `${JSON.stringify({
      contractHash: 'a'.repeat(64),
      projectFingerprint: 'b'.repeat(64),
      requirementTrace: [{
        requirementId: 'RQ-1',
        implementationPoints: ['src/app.ts'],
        verificationPoints: ['tests/app.test.ts'],
      }],
      riskAssessments: [],
      allowedPaths: ['src/**'],
      testPlan: ['pnpm test'],
      status: 'pass',
    })}\n`;
    await writeFile(artifactPath, content);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const gateResult = GateResultSchema.parse({
      gateId: 'design', status: 'pass', summary: 'verified', checks: [], evidence: [], findings: [],
      requirementIds: ['RQ-1'],
      artifacts: [{ path: artifactPath, sha256, kind: 'plan' }],
    });
    await assert.doesNotReject(verifyGateArtifacts(evidenceRoot, gateResult));
    const forged = GateResultSchema.parse({
      ...gateResult,
      artifacts: [{ path: artifactPath, sha256: 'f'.repeat(64), kind: 'plan' }],
    });
    await assert.rejects(verifyGateArtifacts(evidenceRoot, forged), /hash 不匹配/);
    const outside = join(root, 'outside.json');
    await writeFile(outside, content);
    await assert.rejects(verifyGateArtifacts(evidenceRoot, GateResultSchema.parse({
      ...gateResult,
      artifacts: [
        { path: artifactPath, sha256, kind: 'plan' },
        { path: outside, sha256, kind: 'other' },
      ],
    })), /必须位于/);
    const controllerSpecPath = join(evidenceRoot, 'canonical-spec.md');
    await writeFile(controllerSpecPath, 'controller owned');
    await assert.rejects(verifyGateArtifacts(evidenceRoot, GateResultSchema.parse({
      ...gateResult,
      artifacts: [
        { path: artifactPath, sha256, kind: 'plan' },
        {
          path: controllerSpecPath,
          sha256: createHash('sha256').update('controller owned').digest('hex'),
          kind: 'other',
        },
      ],
    })), /不得声明控制器拥有的 artifact/);

    const commandPath = join(evidenceRoot, 'verification-report.json');
    const executedCheck = {
      id: 'test',
      command: ['pnpm', 'test'],
      status: 'pass',
      required: true,
      exitCode: 0,
      cwd: root,
      startedAt: '2020-08-10T00:00:00.000Z',
      finishedAt: '2020-08-10T00:00:01.000Z',
    };
    const commandContent = JSON.stringify({
      status: 'pass',
      implementationHash: 'a'.repeat(64),
      changeReviewHash: 'b'.repeat(64),
      projectFingerprint: 'c'.repeat(64),
      buildHash: 'c'.repeat(64),
      checks: [executedCheck],
      discoveredGates: ['test'],
      requirementResults: [{ id: 'RQ-1', status: 'pass', evidence: ['tests/app.test.ts'] }],
      resourcePreflight: { status: 'not-applicable', reason: 'no destructive test resource' },
      findings: [],
      unverified: [],
    });
    await writeFile(commandPath, commandContent);
    const commandHash = createHash('sha256').update(commandContent).digest('hex');
    const qa = GateResultSchema.parse({
      gateId: 'verification', status: 'pass', summary: 'verified', evidence: [], findings: [],
      requirementIds: ['RQ-1'],
      checks: [executedCheck],
      artifacts: [{ path: commandPath, sha256: commandHash, kind: 'command-report' }],
    });
    await assert.doesNotReject(verifyGateArtifacts(evidenceRoot, qa, { projectRoot: root }));
    await assert.rejects(verifyGateArtifacts(evidenceRoot, GateResultSchema.parse({
      ...qa,
      checks: [{ ...executedCheck, cwd: tmpdir() }],
    }), { projectRoot: root }), /cwd 必须位于当前项目根目录内/);
    await assert.rejects(verifyGateArtifacts(evidenceRoot, GateResultSchema.parse({
      ...qa,
      checks: [{ ...executedCheck, status: 'fail', exitCode: 1 }],
    })), /证据与 artifact 不一致/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('QA 登记独立构建产物后，控制器会在下游重新计算并发现替换', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-build-artifact-'));
  try {
    const evidenceRoot = join(root, '.agent-os', 'evidence', 'workflow');
    const buildRoot = join(root, 'dist');
    await mkdir(evidenceRoot, { recursive: true });
    await mkdir(buildRoot);
    await writeFile(join(buildRoot, 'app.js'), 'export const version = 1;\n');
    const build = await hashPathArtifact(buildRoot);
    const reportPath = join(evidenceRoot, 'verification-report.json');
    const check = passingCheck('build');
    check.cwd = root;
    const report = {
      status: 'pass',
      implementationHash: 'a'.repeat(64),
      changeReviewHash: 'b'.repeat(64),
      projectFingerprint: 'c'.repeat(64),
      buildHash: build.sha256,
      buildArtifact: { path: build.path, sha256: build.sha256 },
      checks: [check],
      discoveredGates: ['build'],
      requirementResults: [{ id: 'RQ-1', status: 'pass', evidence: ['tests/build.test.ts'] }],
      resourcePreflight: { status: 'not-applicable', reason: 'no destructive test resource' },
      findings: [],
      unverified: [],
    };
    const content = JSON.stringify(report);
    await writeFile(reportPath, content);
    const gate = GateResultSchema.parse({
      gateId: 'verification', status: 'pass', summary: 'build verified',
      requirementIds: ['RQ-1'], checks: [check], findings: [],
      artifacts: [{
        path: reportPath,
        sha256: createHash('sha256').update(content).digest('hex'),
        kind: 'command-report',
      }],
    });
    await assert.doesNotReject(verifyGateArtifacts(evidenceRoot, gate, { projectRoot: root }));

    await writeFile(join(buildRoot, 'app.js'), 'export const version = 2;\n');
    await assert.rejects(
      verifyGateArtifacts(evidenceRoot, gate, { projectRoot: root }),
      /buildArtifact 已变化/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('规范主 artifact 不能用符号链接绕过步骤所有权', async () => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'agent-os-gate-symlink-'));
  try {
    const targetPath = join(evidenceRoot, 'shared.json');
    const primaryPath = join(evidenceRoot, 'change-plan.json');
    const content = '{"status":"pass"}\n';
    await writeFile(targetPath, content);
    await symlink(targetPath, primaryPath);
    const gate = GateResultSchema.parse({
      gateId: 'design', status: 'pass', summary: 'symlinked', checks: [], evidence: [], findings: [],
      requirementIds: ['RQ-1'],
      artifacts: [{
        path: primaryPath,
        sha256: createHash('sha256').update(content).digest('hex'),
        kind: 'plan',
      }],
    });
    await assert.rejects(verifyGateArtifacts(evidenceRoot, gate), /符号链接/);
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});

test('变更审查 artifact 不能隐藏开放 finding 或范围差异', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-change-review-artifact-'));
  try {
    const evidenceRoot = join(root, 'evidence');
    await mkdir(evidenceRoot);
    const artifactPath = join(evidenceRoot, 'change-review.json');
    const baseReport = {
      implementationFingerprint: 'a'.repeat(64),
      reviewFingerprint: 'a'.repeat(64),
      baseline: 'HEAD',
      reviewScope: {
        changedFiles: ['src/app.ts'],
        staged: [], unstaged: ['src/app.ts'], untracked: [], deleted: [],
        discrepancies: { statusNotInManifest: [], manifestNotInStatus: [] },
      },
      requirementCoverage: [{ id: 'RQ-1', priority: 'P1', status: 'pass' }],
      relatedContracts: [], findings: [], removalPlans: [], notReviewed: [], residualRisks: [],
      decision: 'approved', status: 'pass',
    };
    const writeReview = async (report: unknown) => {
      const content = JSON.stringify(report);
      await writeFile(artifactPath, content);
      return createHash('sha256').update(content).digest('hex');
    };
    const gateResult = (sha256: string, findings: unknown[] = []) => GateResultSchema.parse({
      gateId: 'change-review', status: 'pass', summary: 'reviewed',
      requirementIds: ['RQ-1'],
      checks: [{ id: 'validate-review', command: ['node', 'validate-review-report.mjs'], exitCode: 0 }],
      evidence: ['src/app.ts:1'], findings,
      artifacts: [{ path: artifactPath, sha256, kind: 'review-report' }],
    });
    await assert.doesNotReject(verifyGateArtifacts(evidenceRoot, gateResult(await writeReview(baseReport))));

    const hiddenP1 = {
      ...baseReport,
      findings: [{
        id: 'REL-1', severity: 'P1', status: 'open', category: 'reliability', summary: 'hidden',
        evidence: ['src/app.ts:1'], impact: 'incorrect result', confidence: 'high',
      }],
    };
    await assert.rejects(
      verifyGateArtifacts(evidenceRoot, gateResult(await writeReview(hiddenP1))),
      /开放 P0\/P1/,
    );

    const scopeGap = {
      ...baseReport,
      reviewScope: {
        ...baseReport.reviewScope,
        discrepancies: { statusNotInManifest: ['src/hidden.ts'], manifestNotInStatus: [] },
      },
    };
    await assert.rejects(
      verifyGateArtifacts(evidenceRoot, gateResult(await writeReview(scopeGap))),
      /范围差异/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('最终证据链要求全部门禁通过且 QA、运行审计和终审快照一致', () => {
  const fingerprint = 'a'.repeat(64);
  let runs = [] as ReturnType<typeof createGateRun>[];
  const entries = [
    ['architect', result('design')],
    ['dev', result('implementation')],
    ['review', result('change-review')],
    ['qa', result('verification')],
    ['runtime_audit', result('runtime-audit')],
    ['final_review', result('final-review')],
  ] as const;
  for (const [stepId, gateResult] of entries) {
    runs = [...runs, createGateRun(stepId, gateResult, runs, fingerprint)];
  }
  const stepIds = ['architect', 'dev', 'review', 'qa', 'runtime_audit', 'final_review'] as const;
  assert.doesNotThrow(() => assertEvidenceChainComplete(stepIds, runs, fingerprint));
  assert.throws(() => assertEvidenceChainComplete(stepIds, runs, 'b'.repeat(64)), /快照已变化/);
  assert.throws(() => assertEvidenceChainComplete(stepIds, runs.slice(0, -1), fingerprint), /final-review/);
});

test('门禁 lineage 拒绝旧 Spec、旧计划或旧评审报告', async () => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'agent-os-lineage-'));
  try {
    const specHash = '1'.repeat(64);
    const requirementIds = ['RQ-1'];
    const before = '2'.repeat(64);
    const after = '3'.repeat(64);
    const writeArtifact = async (fileName: string, value: Record<string, unknown>) => {
      const path = join(evidenceRoot, fileName);
      const content = JSON.stringify(value);
      await writeFile(path, content);
      return { path, sha256: createHash('sha256').update(content).digest('hex') };
    };
    const designArtifact = await writeArtifact('change-plan.json', {
      contractHash: specHash, projectFingerprint: before,
    });
    const design = GateResultSchema.parse({
      gateId: 'design', status: 'pass', summary: 'design', checks: [passingCheck()],
      requirementIds, artifacts: [{ ...designArtifact, kind: 'plan' }], findings: [],
    });
    await assert.doesNotReject(assertGateLineage('architect', design, {
      canonicalSpecHash: specHash,
      canonicalRequirementIds: requirementIds,
      projectFingerprint: before,
      stepStartFingerprint: before,
      previousRuns: [],
    }));
    await assert.rejects(assertGateLineage('architect', design, {
      canonicalSpecHash: specHash,
      canonicalRequirementIds: requirementIds,
      projectFingerprint: before,
      stepStartFingerprint: '7'.repeat(64),
      previousRuns: [],
    }), /保持源码只读/);
    await assert.rejects(assertGateLineage('architect', design, {
      canonicalSpecHash: '9'.repeat(64), canonicalRequirementIds: requirementIds,
      projectFingerprint: before, previousRuns: [],
    }), /contractHash/);
    const designRun = createGateRun('architect', design, [], before);

    const implementationArtifact = await writeArtifact('implementation-manifest.json', {
      contractHash: specHash,
      planHash: designArtifact.sha256,
      fingerprintBefore: before,
      fingerprintAfter: after,
    });
    const implementation = GateResultSchema.parse({
      gateId: 'implementation', status: 'pass', summary: 'implementation', checks: [passingCheck()],
      requirementIds, artifacts: [{ ...implementationArtifact, kind: 'manifest' }], findings: [],
    });
    await assert.doesNotReject(assertGateLineage('dev', implementation, {
      canonicalSpecHash: specHash, canonicalRequirementIds: requirementIds,
      projectFingerprint: after, previousRuns: [designRun],
    }));
    const implementationRun = createGateRun('dev', implementation, [designRun], after);

    const externalStart = '4'.repeat(64);
    const rerunAfter = '5'.repeat(64);
    const rerunArtifact = await writeArtifact('implementation-manifest.json', {
      contractHash: specHash,
      planHash: designArtifact.sha256,
      fingerprintBefore: externalStart,
      fingerprintAfter: rerunAfter,
    });
    const rerun = GateResultSchema.parse({
      gateId: 'implementation', status: 'pass', summary: 'implementation rerun', checks: [passingCheck()],
      requirementIds, artifacts: [{ ...rerunArtifact, kind: 'manifest' }], findings: [],
    });
    await assert.doesNotReject(assertGateLineage('dev', rerun, {
      canonicalSpecHash: specHash,
      canonicalRequirementIds: requirementIds,
      projectFingerprint: rerunAfter,
      stepStartFingerprint: externalStart,
      previousRuns: [designRun, implementationRun],
    }));
    const rerunRun = createGateRun(
      'dev',
      rerun,
      [designRun, implementationRun],
      rerunAfter,
      externalStart,
    );
    assert.equal(rerunRun.stepStartFingerprint, externalStart);
    await assert.rejects(assertGateLineage('dev', rerun, {
      canonicalSpecHash: specHash,
      canonicalRequirementIds: requirementIds,
      projectFingerprint: rerunAfter,
      previousRuns: [designRun, implementationRun],
    }), /fingerprintBefore/);

    const reviewArtifact = await writeArtifact('change-review.json', { status: 'pass' });
    const review = GateResultSchema.parse({
      gateId: 'change-review', status: 'pass', summary: 'review', checks: [passingCheck()], evidence: ['review'],
      requirementIds, artifacts: [{ ...reviewArtifact, kind: 'review-report' }], findings: [],
    });
    const reviewRun = createGateRun('review', review, [designRun, implementationRun], after);
    const buildHash = '6'.repeat(64);
    const qaReport = {
      implementationHash: implementationArtifact.sha256,
      changeReviewHash: reviewArtifact.sha256,
      projectFingerprint: after,
      buildHash,
    };
    const qaArtifact = await writeArtifact('verification-report.json', qaReport);
    const qa = GateResultSchema.parse({
      gateId: 'verification', status: 'pass', summary: 'qa', checks: [passingCheck()],
      requirementIds, artifacts: [{ ...qaArtifact, kind: 'command-report' }], findings: [],
    });
    await assert.doesNotReject(assertGateLineage('qa', qa, {
      canonicalSpecHash: specHash,
      canonicalRequirementIds: requirementIds,
      projectFingerprint: after,
      previousRuns: [designRun, implementationRun, reviewRun],
    }));
    await writeFile(qaArtifact.path, JSON.stringify({
      implementationHash: implementationArtifact.sha256,
      changeReviewHash: '8'.repeat(64),
      projectFingerprint: after,
    }));
    await assert.rejects(assertGateLineage('qa', qa, {
      canonicalSpecHash: specHash,
      canonicalRequirementIds: requirementIds,
      projectFingerprint: after,
      previousRuns: [designRun, implementationRun, reviewRun],
    }), /changeReviewHash/);
    await writeFile(qaArtifact.path, JSON.stringify(qaReport));

    const qaRun = createGateRun('qa', qa, [designRun, implementationRun, reviewRun], after);
    const runtimeArtifact = await writeArtifact('runtime-audit.json', {
      buildHash,
      projectFingerprint: after,
      verificationHash: qaArtifact.sha256,
    });
    const runtime = GateResultSchema.parse({
      gateId: 'runtime-audit', status: 'pass', summary: 'runtime', checks: [passingCheck()],
      requirementIds, evidence: ['runtime'],
      artifacts: [{ ...runtimeArtifact, kind: 'runtime-report' }], findings: [],
    });
    const runtimePrevious = [designRun, implementationRun, reviewRun, qaRun];
    await assert.doesNotReject(assertGateLineage('runtime_audit', runtime, {
      canonicalSpecHash: specHash,
      canonicalRequirementIds: requirementIds,
      projectFingerprint: after,
      previousRuns: runtimePrevious,
    }));
    await writeFile(runtimeArtifact.path, JSON.stringify({
      buildHash: '7'.repeat(64),
      projectFingerprint: after,
      verificationHash: qaArtifact.sha256,
    }));
    await assert.rejects(assertGateLineage('runtime_audit', runtime, {
      canonicalSpecHash: specHash,
      canonicalRequirementIds: requirementIds,
      projectFingerprint: after,
      previousRuns: runtimePrevious,
    }), /buildHash/);
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true });
  }
});

test('纯库可用带证据的 not-applicable 通过运行时适用性节点', () => {
  const runtime = GateResultSchema.parse({
    gateId: 'runtime-audit', status: 'not-applicable', summary: 'pure library',
    requirementIds: ['RQ-001'],
    checks: [passingCheck('validate-applicability')],
    evidence: ['package.json has no server/browser entrypoint'], findings: [],
    artifacts: [{ path: '/tmp/applicability.json', sha256: 'a'.repeat(64), kind: 'runtime-report' }],
  });
  assert.doesNotThrow(() => validateGatePass('runtime_audit', runtime));
  const fingerprint = 'a'.repeat(64);
  const runs = [
    createGateRun('architect', result('design'), [], fingerprint),
    createGateRun('dev', result('implementation'), [], fingerprint),
    createGateRun('review', result('change-review'), [], fingerprint),
    createGateRun('qa', result('verification'), [], fingerprint),
    createGateRun('runtime_audit', runtime, [], fingerprint),
    createGateRun('final_review', result('final-review'), [], fingerprint),
  ];
  assert.doesNotThrow(() => assertEvidenceChainComplete(
    ['architect', 'dev', 'review', 'qa', 'runtime_audit', 'final_review'],
    runs,
    fingerprint,
  ));
});

test('指纹漂移文案可映射回退步骤', () => {
  assert.equal(
    rewindStepIdFromDriftMessage('当前变更快照与最新 implementation gate 不一致，必须先重建实现证据'),
    'dev',
  );
  assert.equal(
    rewindStepIdFromDriftMessage('QA 执行时项目快照已偏离 change-review，必须重新评审'),
    'review',
  );
  assert.equal(rewindStepIdFromDriftMessage('无关错误'), undefined);
});

test('修复后的实现快照必须和变更审查、QA 快照一致', () => {
  const oldFingerprint = 'a'.repeat(64);
  const fixedFingerprint = 'b'.repeat(64);
  const staleRuns = [
    createGateRun('architect', result('design'), [], oldFingerprint),
    createGateRun('dev', result('implementation'), [], oldFingerprint),
    createGateRun('review', result('change-review'), [], fixedFingerprint),
    createGateRun('qa', result('verification'), [], fixedFingerprint),
  ];
  assert.throws(
    () => assertEvidenceChainComplete(['architect', 'dev', 'review', 'qa'], staleRuns, fixedFingerprint),
    /最新实现证据不一致/,
  );
  const refreshed = [
    ...staleRuns,
    createGateRun('dev', result('implementation'), staleRuns, fixedFingerprint),
  ];
  assert.doesNotThrow(() => assertEvidenceChainComplete(
    ['architect', 'dev', 'review', 'qa'],
    refreshed,
    fixedFingerprint,
  ));
});

test('门禁工作流不能裁剪步骤且结构化证据可持久化', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-quality-workflow-'));
  const path = join(root, 'workflows.json');
  try {
    const store = await JsonWorkflowStore.open(path);
    const common = {
      kind: 'team' as const,
      name: 'gated delivery',
      initiatorBotId: 'ceo',
      goal: 'change app',
      projectRoot: root,
      qualityPolicy: 'gated' as const,
      message: {
        messageId: 'om', chatId: 'oc', chatType: 'group', rootId: '', threadId: '', senderOpenId: 'ou',
      },
    };
    await assert.rejects(store.create({ ...common, stepIds: ['dev'] }), /不能裁剪或重排/);
    const workflow = await store.create({
      ...common,
      stepIds: DEFAULT_PIPELINE_STEPS.map((step) => step.id),
    });
    await store.claimReady(workflow.id);
    const designRun = createGateRun('architect', result('design'), [], 'c'.repeat(64));
    await store.completeCurrentStep(workflow.id, 0, 'pm', 'spec');
    await store.claimReady(workflow.id);
    await store.completeCurrentStep(workflow.id, 1, 'architect', 'plan', {
      gateRun: designRun,
      projectFingerprint: 'c'.repeat(64),
    });
    const reopened = await JsonWorkflowStore.open(path);
    assert.equal(reopened.get(workflow.id)?.gateRuns[0]?.gateId, 'design');
    assert.equal(reopened.get(workflow.id)?.projectFingerprint, 'c'.repeat(64));

    const rows = JSON.parse(await readFile(path, 'utf8')) as Array<Record<string, any>>;
    rows[0].gateRuns[0].attempt = 2;
    await writeFile(path, JSON.stringify(rows));
    await assert.rejects(JsonWorkflowStore.open(path), /尝试序号必须连续/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
