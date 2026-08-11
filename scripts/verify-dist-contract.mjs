#!/usr/bin/env node

/**
 * 生产启动前校验实际将被 node 执行的 dist 门禁契约，防止源码已修而旧编译产物仍放行。
 */
import {
  GateResultSchema,
  validateGatePass,
} from '../dist/core/quality-gates.js';

const expectRejected = (label, operation, messagePattern) => {
  try {
    operation();
  } catch (error) {
    if (messagePattern && !messagePattern.test(String(error?.message ?? error))) {
      throw new Error(`dist quality contract rejected ${label} for the wrong reason: ${error?.message ?? error}`);
    }
    return;
  }
  throw new Error(`dist quality contract is stale: ${label} was unexpectedly accepted`);
};

const artifact = {
  path: '/tmp/change-plan.json',
  sha256: 'a'.repeat(64),
  kind: 'plan',
};

expectRejected('ambiguous command string', () => GateResultSchema.parse({
  gateId: 'design',
  status: 'pass',
  summary: 'must reject string command',
  checks: [{ id: 'validate', command: 'node validate.mjs', exitCode: 0 }],
  artifacts: [artifact],
}));

expectRejected('accepted risk without explicit waiver', () => GateResultSchema.parse({
  gateId: 'design',
  status: 'pass',
  summary: 'must reject implicit waiver',
  artifacts: [artifact],
  findings: [{
    id: 'DIST-001',
    severity: 'P3',
    status: 'accepted',
    summary: 'implicit risk acceptance',
  }],
}));

expectRejected('relative artifact path', () => GateResultSchema.parse({
  gateId: 'design',
  status: 'pass',
  summary: 'artifact paths must be unambiguous',
  checks: [],
  artifacts: [{ ...artifact, path: '.agent-os/evidence/change-plan.json' }],
}));

const noExecutedCheck = GateResultSchema.parse({
  gateId: 'design',
  status: 'pass',
  summary: 'text and a hash are not execution evidence',
  checks: [],
  artifacts: [artifact],
});
expectRejected('gate without executed check', () => validateGatePass('architect', noExecutedCheck));

const selfAttestedWaiver = GateResultSchema.parse({
  gateId: 'design',
  status: 'pass',
  summary: 'agent metadata is not human approval',
  requirementIds: ['RQ-001'],
  checks: [{
    id: 'validate',
    command: ['node', 'validator.mjs'],
    status: 'pass',
    required: true,
    exitCode: 0,
    cwd: '/tmp',
    startedAt: '2020-08-11T00:00:00.000Z',
    finishedAt: '2020-08-11T00:00:01.000Z',
  }],
  evidence: ['/tmp/change-plan.json'],
  artifacts: [artifact],
  findings: [{
    id: 'DIST-WAIVER-001',
    severity: 'P3',
    status: 'waived',
    summary: 'must be bound to canonical Spec',
    evidence: ['/tmp/change-plan.json'],
    waiver: {
      owner: 'agent-claimed-owner',
      reason: 'agent-claimed-reason',
      scope: 'agent-claimed-scope',
      compensatingControl: 'agent-claimed-control',
      approvedAt: '2026-08-10T00:00:00.000Z',
      approvalEvidence: 'lark://self-attested',
      expiresAt: '2099-08-11T00:00:00.000Z',
    },
  }],
});
expectRejected(
  'self-attested waiver',
  () => validateGatePass('architect', selfAttestedWaiver),
  /canonical Spec 人工批准绑定/,
);

const plannedFinal = GateResultSchema.parse({
  gateId: 'final-review',
  status: 'pass',
  summary: 'must reject planned work at final review',
  checks: [],
  evidence: ['final-review.json'],
  artifacts: [{ ...artifact, path: '/tmp/final-review.json', kind: 'review-report' }],
  findings: [{
    id: 'DIST-002',
    severity: 'P1',
    status: 'planned',
    summary: 'not implemented',
    evidence: ['change-plan.json#implementationPoints'],
  }],
});
expectRejected('planned P1 at final review', () => validateGatePass('final_review', plannedFinal));

process.stdout.write('dist quality contract: ok\n');
