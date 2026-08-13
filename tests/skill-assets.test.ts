import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = process.cwd();
const skillNames = [
  'establish-delivery-contract',
  'design-risk-aware-change',
  'implement-traceable-change',
  'review-change-set',
  'verify-software-delivery',
  'audit-runtime-boundaries',
  'review-final-delivery',
];

function runScript(relativePath: string, args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [resolve(repoRoot, relativePath), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value));
}

test('七个 Skill 具有精简元数据、可发现界面和五类回归说明', async () => {
  for (const name of skillNames) {
    const root = join(repoRoot, 'skills', name);
    const markdown = await readFile(join(root, 'SKILL.md'), 'utf8');
    const lines = markdown.split('\n');
    assert.equal(lines[0], '---');
    assert.match(markdown, new RegExp('name: ' + name));
    assert.match(markdown, /description: /);
    assert.match(markdown, /## 回归验证/);
    for (const marker of ['真实失败', '通用案例', '不触发', '绕过案例', '修复案例']) {
      assert.match(markdown, new RegExp(marker));
    }
    assert.ok(lines.length < 500);
    const openaiYaml = await readFile(join(root, 'agents', 'openai.yaml'), 'utf8');
    assert.match(openaiYaml, /display_name:/);
    assert.match(openaiYaml, /short_description:/);
    assert.match(openaiYaml, /default_prompt:/);
  }
});

test('契约和设计脚本拒绝缺失验收、并发风险处置及伪造空计划', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-skill-contract-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', test: 'node --test' } }));
    const discovery = runScript('skills/establish-delivery-contract/scripts/discover-project.mjs', [root]);
    assert.equal(discovery.status, 0, discovery.stderr);
    assert.equal(JSON.parse(discovery.stdout).package.scripts.build, 'tsc');

    const badContract = join(root, 'bad-contract.json');
    await writeJson(badContract, {
      projectRoot: root,
      canonicalSpec: { id: 'spec', sha256: 'hash' },
      requirements: [{ id: 'RQ-1', source: 'user', priority: 'P1' }],
      requiredGateIds: ['design'],
      qualityCommands: [],
    });
    assert.equal(runScript('skills/establish-delivery-contract/scripts/validate-delivery-contract.mjs', [badContract]).status, 2);

    const goodPlan = join(root, 'plan.json');
    await writeJson(goodPlan, {
      contractHash: 'a'.repeat(64), projectFingerprint: 'b'.repeat(64), status: 'pass',
      requirementTrace: [{ requirementId: 'RQ-1', implementationPoints: ['src/api.ts'], verificationPoints: ['test/api.test.ts'] }],
      riskAssessments: [{ id: 'concurrency', disposition: 'applicable', evidence: 'read then write', control: 'conditional update', verification: 'parallel test' }],
      allowedPaths: ['src', 'test'], testPlan: ['parallel update'],
      checks: [{
        id: 'risk-scan', command: [process.execPath, '-e', 'process.exit(0)'], status: 'pass',
        required: true, exitCode: 0, cwd: root,
        startedAt: '2026-08-12T00:00:00.000Z', finishedAt: '2026-08-12T00:00:01.000Z',
      }],
    });
    assert.equal(runScript('skills/design-risk-aware-change/scripts/validate-change-plan.mjs', [goodPlan]).status, 0);
    await writeJson(goodPlan, {
      contractHash: 'a'.repeat(64), projectFingerprint: 'b'.repeat(64), status: 'pass', riskAssessments: [],
    });
    assert.equal(runScript('skills/design-risk-aware-change/scripts/validate-change-plan.mjs', [goodPlan]).status, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('实现和 QA 脚本阻止越界改动、质量配置绕过与危险测试资源', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-skill-verify-'));
  try {
    const scope = join(root, 'scope.json');
    await writeJson(scope, {
      allowedPaths: ['src'], forbiddenPaths: ['src/secrets'],
      changedFiles: ['src/app.ts', 'package.json'], approvedQualityConfigChanges: [],
    });
    const scopeRun = runScript('skills/implement-traceable-change/scripts/check-change-scope.mjs', [scope]);
    assert.equal(scopeRun.status, 2);
    assert.match(scopeRun.stdout, /unapproved-quality-config-change|outside-allowlist/);

    const resource = join(root, 'resource.json');
    await writeJson(resource, {
      destructive: true, connectionEnv: 'SKILL_TEST_DATABASE_URL', sentinelEnv: 'SKILL_TEST_SENTINEL',
    });
    const dangerous = runScript(
      'skills/verify-software-delivery/scripts/preflight-test-resources.mjs',
      [resource],
      { SKILL_TEST_DATABASE_URL: 'postgres://user:secret@localhost/production', SKILL_TEST_SENTINEL: 'false' },
    );
    assert.equal(dangerous.status, 3);
    assert.doesNotMatch(dangerous.stdout, /secret/);

    await writeJson(resource, {
      destructive: true,
      connectionEnv: 'SKILL_TEST_DATABASE_URL',
      runtimeConnectionEnvs: ['SKILL_RUNTIME_DATABASE_URL'],
      sentinelEnv: 'AGENT_INVENTED_SENTINEL',
    });
    const inventedSentinel = runScript(
      'skills/verify-software-delivery/scripts/preflight-test-resources.mjs',
      [resource],
      {
        SKILL_TEST_DATABASE_URL: 'postgres://user:secret@localhost/project_test',
        SKILL_RUNTIME_DATABASE_URL: 'postgres://user:secret@localhost/project_dev',
        AGENT_INVENTED_SENTINEL: 'true',
      },
    );
    assert.equal(inventedSentinel.status, 3);
    assert.match(inventedSentinel.stdout, /sentinelEnv must be AGENT_OS_TEST_RESOURCE_SENTINEL/);

    await writeJson(resource, {
      destructive: true,
      connectionEnv: 'SKILL_TEST_DATABASE_URL',
      runtimeConnectionEnvs: ['SKILL_RUNTIME_DATABASE_URL'],
      sentinelEnv: 'AGENT_OS_TEST_RESOURCE_SENTINEL',
    });
    const authorizedIsolatedResource = runScript(
      'skills/verify-software-delivery/scripts/preflight-test-resources.mjs',
      [resource],
      {
        SKILL_TEST_DATABASE_URL: 'postgres://user:secret@localhost/project_test',
        SKILL_RUNTIME_DATABASE_URL: 'postgres://user:secret@localhost/project_dev',
        AGENT_OS_TEST_RESOURCE_SENTINEL: 'true',
      },
    );
    assert.equal(authorizedIsolatedResource.status, 0, authorizedIsolatedResource.stdout);

    const gateConfig = join(root, 'gates.json');
    await writeJson(gateConfig, {
      projectRoot: root,
      checks: [{ id: 'real-exit-code', command: [process.execPath, '-e', 'process.exit(0)'] }],
    });
    const gateRun = runScript('skills/verify-software-delivery/scripts/run-quality-gates.mjs', [gateConfig]);
    assert.equal(gateRun.status, 0, gateRun.stderr);
    const executedCheck = JSON.parse(gateRun.stdout).checks[0];
    assert.equal(executedCheck.exitCode, 0);
    assert.equal(executedCheck.status, 'pass');
    assert.equal(executedCheck.required, true);
    assert.ok(executedCheck.cwd && executedCheck.startedAt && executedCheck.finishedAt);

    const manifest = join(root, 'implementation-manifest.json');
    const manifestBase = {
      contractHash: 'a'.repeat(64), planHash: 'b'.repeat(64),
      fingerprintBefore: 'c'.repeat(64), fingerprintAfter: 'd'.repeat(64), status: 'pass',
      changedFiles: ['src/app.ts'],
      requirementImplementations: [{ requirementId: 'RQ-1', files: ['src/app.ts'] }],
      riskControls: [], targetedCheckResults: [executedCheck],
    };
    await writeJson(manifest, manifestBase);
    assert.equal(runScript(
      'skills/implement-traceable-change/scripts/validate-implementation-manifest.mjs',
      [manifest],
    ).status, 0);

    const delegatedEnvironmentCheck = {
      ...executedCheck,
      id: 'browser-e2e',
      command: [process.execPath, '-e', 'process.exit(1)'],
      status: 'blocked',
      required: false,
      delegatedTo: 'verification',
      exitCode: 1,
    };
    await writeJson(manifest, {
      ...manifestBase,
      targetedCheckResults: [executedCheck, delegatedEnvironmentCheck],
    });
    assert.equal(runScript(
      'skills/implement-traceable-change/scripts/validate-implementation-manifest.mjs',
      [manifest],
    ).status, 0);
    await writeJson(manifest, {
      ...manifestBase,
      targetedCheckResults: [executedCheck, { ...delegatedEnvironmentCheck, required: true }],
    });
    const invalidDelegation = runScript(
      'skills/implement-traceable-change/scripts/validate-implementation-manifest.mjs',
      [manifest],
    );
    assert.equal(invalidDelegation.status, 2);
    assert.match(invalidDelegation.stdout, /delegatedTo requires verification \+ optional blocked\/unverified/);

    const blockedCheck = {
      ...executedCheck,
      id: 'browser-runtime',
      command: [process.execPath, '-e', 'process.exit(1)'],
      status: 'blocked',
      required: true,
      exitCode: 1,
    };
    await writeJson(manifest, {
      ...manifestBase,
      status: 'blocked',
      targetedCheckResults: [executedCheck, blockedCheck],
    });
    // P1 修复：本地脚本与控制器对齐，blocked 不再是合法 manifest status
    assert.equal(runScript(
      'skills/implement-traceable-change/scripts/validate-implementation-manifest.mjs',
      [manifest],
    ).status, 2);

    await writeJson(manifest, {
      ...manifestBase,
      targetedCheckResults: [executedCheck, blockedCheck],
    });
    const passWithBlocker = runScript(
      'skills/implement-traceable-change/scripts/validate-implementation-manifest.mjs',
      [manifest],
    );
    assert.equal(passWithBlocker.status, 2);
    assert.match(passWithBlocker.stdout, /pass manifest conflicts/);

    await writeJson(manifest, {
      ...manifestBase,
      status: 'blocked',
      targetedCheckResults: [executedCheck],
    });
    const blockedWithoutBlocker = runScript(
      'skills/implement-traceable-change/scripts/validate-implementation-manifest.mjs',
      [manifest],
    );
    // P1 修复：blocked 状态本身已被拒绝
    assert.equal(blockedWithoutBlocker.status, 2);
    assert.match(blockedWithoutBlocker.stdout, /status must be pass/);

    await writeJson(manifest, {
      ...manifestBase,
      targetedCheckResults: [{ ...executedCheck, command: 'node test.js' }],
    });
    assert.equal(runScript(
      'skills/implement-traceable-change/scripts/validate-implementation-manifest.mjs',
      [manifest],
    ).status, 2);

    const verification = join(root, 'verification-report.json');
    await writeJson(verification, {
      implementationHash: 'a'.repeat(64), changeReviewHash: 'b'.repeat(64),
      projectFingerprint: 'c'.repeat(64), buildHash: 'd'.repeat(64),
      buildArtifact: { path: join(root, 'dist'), sha256: 'd'.repeat(64) },
      status: 'pass', discoveredGates: [executedCheck.id],
      executedChecks: [executedCheck], unverified: [],
      resourcePreflight: { status: 'not-applicable', reason: 'no destructive resources' },
      findings: [], waivers: [],
      requirementResults: [{ id: 'RQ-1', status: 'blocked', evidence: ['tests/app.test.ts'] }],
    });
    assert.equal(runScript(
      'skills/verify-software-delivery/scripts/validate-verification-report.mjs',
      [verification],
    ).status, 2);
    await writeJson(verification, {
      implementationHash: 'a'.repeat(64), changeReviewHash: 'b'.repeat(64),
      projectFingerprint: 'c'.repeat(64), buildHash: 'd'.repeat(64),
      buildArtifact: { path: join(root, 'dist'), sha256: 'd'.repeat(64) },
      status: 'pass', discoveredGates: [executedCheck.id], executedChecks: [executedCheck], unverified: [],
      resourcePreflight: { status: 'not-applicable', reason: 'no destructive resources' },
      findings: [], waivers: [],
      requirementResults: [{ id: 'RQ-1', status: 'pass', evidence: ['tests/app.test.ts'] }],
    });
    assert.equal(runScript(
      'skills/verify-software-delivery/scripts/validate-verification-report.mjs',
      [verification],
    ).status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('变更审查脚本发现 untracked 范围差异并拒绝文本式批准', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-skill-review-'));
  try {
    const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(git(['init']).status, 0);
    assert.equal(git(['config', 'user.email', 'review@example.test']).status, 0);
    assert.equal(git(['config', 'user.name', 'Review Test']).status, 0);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'tracked.ts'), 'export const value = 1;\n');
    assert.equal(git(['add', '.']).status, 0);
    assert.equal(git(['commit', '-m', 'baseline']).status, 0);
    await writeFile(join(root, 'src', 'tracked.ts'), 'export const value = 2;\n');
    await writeFile(join(root, 'src', 'untracked.ts'), 'export const hidden = true;\n');

    const evidenceRoot = join(root, '.agent-os', 'evidence');
    await mkdir(join(root, '.agent-os'));
    await mkdir(evidenceRoot);
    const manifest = join(evidenceRoot, 'implementation-manifest.json');
    await writeJson(manifest, {
      fingerprintAfter: 'f'.repeat(64),
      changedFiles: ['src/tracked.ts'],
    });
    const config = join(evidenceRoot, 'review-scope-config.json');
    await writeJson(config, { projectRoot: root, implementationManifestPath: manifest, baselineRef: 'HEAD' });
    const discovery = runScript('skills/review-change-set/scripts/discover-review-scope.mjs', [config]);
    assert.equal(discovery.status, 0, discovery.stderr);
    const scope = JSON.parse(discovery.stdout);
    assert.deepEqual(scope.untracked, ['src/untracked.ts']);
    assert.deepEqual(scope.discrepancies.statusNotInManifest, ['src/untracked.ts']);

    const review = join(evidenceRoot, 'change-review.json');
    await writeJson(review, {
      implementationFingerprint: 'f'.repeat(64), reviewFingerprint: 'f'.repeat(64), baseline: 'HEAD',
      reviewScope: scope, requirementCoverage: [], relatedContracts: [], findings: [], removalPlans: [],
      notReviewed: [], residualRisks: [], decision: 'approved', status: 'pass',
    });
    const rejected = runScript('skills/review-change-set/scripts/validate-review-report.mjs', [review]);
    assert.equal(rejected.status, 2);
    assert.match(rejected.stdout, /scope has unresolved/);

    scope.discrepancies = { statusNotInManifest: [], manifestNotInStatus: [] };
    await writeJson(review, {
      implementationFingerprint: 'f'.repeat(64), reviewFingerprint: 'f'.repeat(64), baseline: 'HEAD',
      reviewScope: scope,
      requirementCoverage: [{ id: 'RQ-1', priority: 'P1', status: 'pass', evidence: ['src/tracked.ts:1'] }],
      relatedContracts: [], findings: [], removalPlans: [], notReviewed: [], residualRisks: [],
      decision: 'approved', status: 'pass',
    });
    assert.equal(runScript('skills/review-change-set/scripts/validate-review-report.mjs', [review]).status, 0);

    await writeJson(review, {
      implementationFingerprint: 'f'.repeat(64), reviewFingerprint: 'f'.repeat(64), baseline: 'HEAD',
      reviewScope: scope,
      requirementCoverage: [{ id: 'RQ-1', priority: 'P1', status: 'pass', evidence: ['src/tracked.ts:1'] }],
      relatedContracts: [],
      findings: [{
        id: 'FIND-001',
        severity: 'P2',
        status: 'open',
        category: 'totally-made-up-label',
        summary: 'unknown category must fail locally',
      }],
      removalPlans: [], notReviewed: [], residualRisks: [],
      decision: 'approved', status: 'pass',
    });
    const badCategory = runScript('skills/review-change-set/scripts/validate-review-report.mjs', [review]);
    assert.equal(badCategory.status, 2, badCategory.stdout);
    assert.match(badCategory.stdout, /category Invalid option/);

    // 已知近义别名应与控制器一样被接受（映射到枚举），避免「本地 pass / 控制器 fail」缺口
    await writeJson(review, {
      implementationFingerprint: 'f'.repeat(64), reviewFingerprint: 'f'.repeat(64), baseline: 'HEAD',
      reviewScope: scope,
      requirementCoverage: [{ id: 'RQ-1', priority: 'P1', status: 'pass', evidence: ['src/tracked.ts:1'] }],
      relatedContracts: [],
      findings: [{
        id: 'FIND-001',
        severity: 'P2',
        status: 'open',
        category: 'test-reliability',
        summary: 'local e2e reuses existing server',
      }],
      removalPlans: [], notReviewed: [], residualRisks: [],
      decision: 'approved', status: 'pass',
    });
    assert.equal(runScript('skills/review-change-set/scripts/validate-review-report.mjs', [review]).status, 0);

    await writeJson(review, {
      implementationFingerprint: 'f'.repeat(64), reviewFingerprint: 'f'.repeat(64), baseline: 'HEAD',
      reviewScope: scope,
      requirementCoverage: [{ id: 'RQ-1', priority: 'P1', status: 'pass', evidence: ['src/tracked.ts:1'] }],
      relatedContracts: [],
      findings: [{
        id: 'FIND-001',
        severity: 'P2',
        status: 'open',
        category: 'testing',
        summary: 'local e2e reuses existing server',
      }],
      removalPlans: [], notReviewed: [], residualRisks: [],
      decision: 'approved', status: 'pass',
    });
    assert.equal(runScript('skills/review-change-set/scripts/validate-review-report.mjs', [review]).status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('共享 finding 枚举与控制器 / 各阶段校验脚本对齐', async () => {
  const shared = await import(resolve(repoRoot, 'skills/_shared/finding-fields.mjs'));
  const { GATE_FINDING_CATEGORIES, GateFindingSchema } = await import('../src/core/quality-gates.js');
  assert.deepEqual([...shared.FINDING_CATEGORIES], [...GATE_FINDING_CATEGORIES]);

  const aliased = GateFindingSchema.parse({
    id: 'FIND-001',
    severity: 'P2',
    status: 'open',
    summary: 'docs drift',
    category: 'documentation-accuracy',
  });
  assert.equal(aliased.category, 'maintainability');

  assert.throws(() => GateFindingSchema.parse({
    id: 'FIND-002',
    severity: 'P2',
    status: 'open',
    summary: 'unknown label',
    category: 'totally-made-up',
  }), /category|Invalid option/i);

  const root = await mkdtemp(join(tmpdir(), 'agent-os-finding-enums-'));
  try {
    const findings = [{
      id: 'FIND-X',
      severity: 'P2',
      status: 'open',
      category: 'documentation-accuracy',
      summary: 'alias should pass local validators after normalize acceptance',
    }];
    // 本地脚本接受已知别名（与控制器同一套 normalize）
    const errors = shared.validateFindingsArray(findings, { allowPlanned: false });
    assert.deepEqual(errors, []);

    const unknown = shared.validateFindingsArray([{
      ...findings[0],
      category: 'totally-made-up',
    }], { allowPlanned: false });
    assert.match(unknown.join('\n'), /category Invalid option/);

    const plan = join(root, 'change-plan.json');
    await writeJson(plan, {
      contractHash: 'a'.repeat(64),
      projectFingerprint: 'b'.repeat(64),
      status: 'pass',
      requirementTrace: [{
        requirementId: 'RQ-1',
        implementationPoints: ['src/a.ts'],
        verificationPoints: ['test a'],
      }],
      riskAssessments: [{
        id: 'RISK-1',
        disposition: 'weird-disposition',
        evidence: ['src/a.ts'],
      }],
      allowedPaths: ['src'],
      testPlan: ['unit'],
      checks: [{
        id: 'validate-change-plan',
        command: ['node', 'x.mjs'],
        status: 'pass',
        required: true,
        exitCode: 0,
        cwd: root,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }],
    });
    const dispositionRejected = runScript(
      'skills/design-risk-aware-change/scripts/validate-change-plan.mjs',
      [plan],
    );
    assert.equal(dispositionRejected.status, 2);
    assert.match(dispositionRejected.stdout, /disposition must be one of/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('运行时与终审脚本拒绝状态缺口、旧快照和文本式批准', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-skill-final-'));
  try {
    const runtime = join(root, 'runtime.json');
    await writeJson(runtime, {
      environment: 'test', buildHash: 'a'.repeat(64), status: 'pass',
      projectFingerprint: 'b'.repeat(64), verificationHash: 'c'.repeat(64),
      surfaceMatrix: [{ priority: 'P1', requiredStates: ['normal', 'error'], results: [{ state: 'normal', status: 'pass' }] }],
      requiredBrowsers: ['chromium'], browserAndViewportResults: [], findings: [],
    });
    assert.equal(runScript('skills/audit-runtime-boundaries/scripts/validate-runtime-matrix.mjs', [runtime]).status, 2);

    await writeJson(runtime, {
      status: 'not-applicable',
      buildHash: 'c'.repeat(64), projectFingerprint: 'a'.repeat(64), verificationHash: 'b'.repeat(64),
      applicability: { reason: 'pure package', evidence: ['package.json has no runtime entrypoint'] },
      findings: [],
    });
    assert.equal(runScript('skills/audit-runtime-boundaries/scripts/validate-runtime-matrix.mjs', [runtime]).status, 0);
    await writeJson(runtime, {
      status: 'not-applicable',
      buildHash: 'c'.repeat(64), projectFingerprint: 'a'.repeat(64), verificationHash: 'b'.repeat(64),
      applicability: { reason: 'pure package', evidence: [] }, findings: [],
    });
    assert.equal(runScript('skills/audit-runtime-boundaries/scripts/validate-runtime-matrix.mjs', [runtime]).status, 2);

    const chain = join(root, 'evidence-chain.json');
    await writeJson(chain, {
      requiredGateIds: ['verification', 'runtime-audit'],
      gateRuns: [
        { gateId: 'verification', attempt: 1, status: 'pass' },
        { gateId: 'runtime-audit', attempt: 1, status: 'pass' },
      ],
      currentFingerprint: 'new', verifiedFingerprint: 'old', artifacts: [],
    });
    assert.equal(runScript('skills/review-final-delivery/scripts/verify-evidence-chain.mjs', [chain]).status, 2);

    const fingerprint = 'd'.repeat(64);
    const buildHash = 'e'.repeat(64);
    const artifact = async (
      gateId: string,
      fileName: string,
      value: Record<string, unknown>,
      kind: string,
    ) => {
      const artifactPath = join(root, fileName);
      const content = JSON.stringify(value);
      await writeFile(artifactPath, content);
      return {
        gateId,
        attempt: 1,
        path: artifactPath,
        sha256: createHash('sha256').update(content).digest('hex'),
        kind,
      };
    };
    const designArtifact = await artifact('design', 'change-plan.json', { status: 'pass' }, 'plan');
    const implementationArtifact = await artifact(
      'implementation', 'implementation-manifest.json', { status: 'pass' }, 'manifest',
    );
    const reviewArtifact = await artifact(
      'change-review', 'change-review.json', { status: 'pass' }, 'review-report',
    );
    const verificationArtifact = await artifact('verification', 'verification-report.json', {
      status: 'pass', buildHash,
    }, 'command-report');
    const runtimeArtifact = await artifact('runtime-audit', 'runtime-audit.json', {
      status: 'pass', buildHash, verificationHash: verificationArtifact.sha256,
    }, 'runtime-report');
    const requiredGateIds = ['design', 'implementation', 'change-review', 'verification', 'runtime-audit'];
    await writeJson(chain, {
      schemaVersion: '2.0', generatedBy: 'agent-os-controller', controllerOwned: true,
      workflowId: 'workflow-1', generatedAt: new Date().toISOString(),
      requiredGateIds,
      gateRuns: requiredGateIds.map((gateId) => ({
        gateId, attempt: 1, status: 'pass', projectFingerprint: fingerprint,
      })),
      currentFingerprint: fingerprint,
      verifiedFingerprint: fingerprint,
      artifacts: [
        designArtifact,
        implementationArtifact,
        reviewArtifact,
        verificationArtifact,
        runtimeArtifact,
      ],
    });
    assert.equal(
      runScript('skills/review-final-delivery/scripts/verify-evidence-chain.mjs', [chain]).status,
      0,
    );
    const chainReference = {
      path: chain,
      sha256: createHash('sha256').update(await readFile(chain)).digest('hex'),
    };

    const review = join(root, 'review.json');
    await writeJson(review, {
      finalFingerprint: 'new', reviewedDiff: 'base..head', decision: 'approved',
      requirementCoverage: [{ id: 'RQ-1', priority: 'P1', status: 'fail' }],
      findings: [{ id: 'SEC-1', severity: 'P1', status: 'open' }], waivers: [],
    });
    assert.equal(runScript('skills/review-final-delivery/scripts/validate-final-review.mjs', [review]).status, 2);

    await writeJson(review, {
      finalFingerprint: 'a'.repeat(64), reviewedDiff: 'base..head', decision: 'approved', status: 'pass',
      reviewScope: { changedFiles: ['src/app.ts'] },
      evidenceChain: chainReference,
      requirementCoverage: [{ id: 'RQ-1', priority: 'P1', status: 'pass' }],
      findings: [], waivers: [], notReviewed: [], residualRisks: [],
    });
    assert.equal(runScript('skills/review-final-delivery/scripts/validate-final-review.mjs', [review]).status, 0);

    await writeJson(review, {
      finalFingerprint: 'a'.repeat(64), reviewedDiff: 'base..head', decision: 'approved-with-waiver', status: 'pass',
      reviewScope: { changedFiles: ['src/app.ts'] },
      evidenceChain: chainReference,
      requirementCoverage: [{ id: 'RQ-1', priority: 'P1', status: 'pass' }],
      findings: [{ id: 'RISK-1', severity: 'P3', status: 'waived', summary: 'risk' }],
      waivers: [], notReviewed: [], residualRisks: [],
    });
    assert.equal(runScript('skills/review-final-delivery/scripts/validate-final-review.mjs', [review]).status, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
