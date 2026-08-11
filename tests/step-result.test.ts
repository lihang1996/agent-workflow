import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPipelineStepPrompt, DEFAULT_PIPELINE_STEPS } from '../src/core/pipeline.js';
import {
  extractAbsolutePathCandidates,
  hasExplicitStepResult,
  parseStepResult,
  resolveQualityHandoffTarget,
  isEnvironmentBlockReason,
} from '../src/core/step-result.js';
import { buildStepBlockedCard } from '../src/im/workflow-card.js';
import { buildTaskCard } from '../src/im/card.js';

test('parseStepResult 只认显式标记，避免误判', () => {
  assert.equal(parseStepResult('本轮未落地代码改动，因为目录不对').kind, 'done');
  assert.deepEqual(parseStepResult('说明\n[RESULT:blocked] 工作目录不可写\n完'), {
    kind: 'blocked',
    reason: '工作目录不可写',
  });
  assert.deepEqual(parseStepResult('[RESULT:failed|构建失败]'), {
    kind: 'failed',
    reason: '构建失败',
  });
  assert.equal(parseStepResult('[RESULT:done]').kind, 'done');
});

test('流水线可区分兼容性默认 done 与真实显式终态', () => {
  assert.equal(parseStepResult('普通完成说明').kind, 'done');
  assert.equal(hasExplicitStepResult('普通完成说明'), false);
  assert.equal(hasExplicitStepResult('完成\n[RESULT:done]'), true);
});

test('extractAbsolutePathCandidates 能抽出目标路径', () => {
  const paths = extractAbsolutePathCandidates(
    '请在 /Users/leon/Desktop/leon-blog 生成代码，不要改 /Users/leon/Desktop/dom/aiDemo/agent-os',
  );
  assert.deepEqual(paths, [
    '/Users/leon/Desktop/leon-blog',
    '/Users/leon/Desktop/dom/aiDemo/agent-os',
  ]);
});

test('开发/架构 prompt 要求 RESULT 标记，PM Spec 不要求', () => {
  const dev = buildPipelineStepPrompt(DEFAULT_PIPELINE_STEPS.find((s) => s.id === 'dev')!, '目标', {});
  assert.match(dev, /\[RESULT:blocked\]/);
  assert.match(dev, /禁止用 \[RESULT:blocked\] 表示/);
  assert.match(dev, /禁止用「已完成」口吻结束/);
  assert.match(dev, /implementation-manifest\.json/);
  assert.doesNotMatch(dev, /workflow-id\/report\.json/);
  const pm = buildPipelineStepPrompt(DEFAULT_PIPELINE_STEPS[0], '目标', {});
  assert.doesNotMatch(pm, /\[RESULT:done\]/);
});

test('运行时/QA 的代码缺陷应移交开发，目录问题不移交', () => {
  const rb = '运行时审计发现 P1：生产构建下 Auth.js UntrustedHost 导致 /api/auth/* 全部 500（FIND-RB-001）；需 implementation 修复 trustHost/AUTH_URL 后重跑本门禁';
  assert.equal(isEnvironmentBlockReason(rb), false);
  assert.equal(resolveQualityHandoffTarget('runtime_audit', rb), 'dev');
  assert.equal(resolveQualityHandoffTarget('qa', '工作目录不可写'), undefined);
  assert.equal(
    resolveQualityHandoffTarget('final_review', '方案不可行，需架构师重新做技术方案'),
    'architect',
  );
  assert.equal(resolveQualityHandoffTarget('dev', rb), undefined);
  assert.equal(
    resolveQualityHandoffTarget('final_review', 'Gate finding 与审查 artifact 不一致：FIND-205'),
    undefined,
  );
  assert.equal(
    resolveQualityHandoffTarget('review', '流水线步骤缺少显式 [RESULT:done|blocked|failed] 终态标记'),
    undefined,
  );
});

test('中间代码评审加载结构化变更审查 Skill 和 Gate 协议', () => {
  const review = buildPipelineStepPrompt(
    DEFAULT_PIPELINE_STEPS.find((step) => step.id === 'review')!,
    '修复权限问题',
    { dev: 'implementation manifest' },
  );
  assert.match(review, /review-change-set\/SKILL\.md/);
  assert.match(review, /gateId[^\n]*change-review/);
  assert.match(review, /完整变更范围和关联契约/);
});

test('流水线提示词只携带当前步骤所需且已去协议的有界上下文', () => {
  const qa = buildPipelineStepPrompt(
    DEFAULT_PIPELINE_STEPS.find((step) => step.id === 'qa')!,
    '验证登录',
    {
      architect: '不应传给 QA 的长方案',
      dev: `实现完成\n[RESULT:done]\n[GATE_RESULT] ${JSON.stringify({ gateId: 'implementation' })}`,
      review: '代码评审通过',
      workflow_context: '{"workflowId":"wf"}',
    },
  );
  assert.doesNotMatch(qa, /不应传给 QA 的长方案/);
  const priorContext = qa.match(/前置产出：\n([\s\S]*?)\n\n请做冒烟/)?.[1] ?? '';
  assert.doesNotMatch(priorContext, /GATE_RESULT|\[RESULT:/);
  assert.match(qa, /实现完成/);
  assert.match(qa, /代码评审通过/);
});

test('CEO 汇总优先保留 QA、运行时、终审与控制器路径，不被超长 Spec 挤掉', () => {
  const summary = buildPipelineStepPrompt(
    DEFAULT_PIPELINE_STEPS.find((step) => step.id === 'summary')!,
    '交付长规格',
    {
      pm: '很长的规格'.repeat(10_000),
      workflow_context: '{"canonicalSpec":{"path":"/project/canonical-spec.md"}}',
      quality_evidence: '[{"gateId":"verification","status":"pass"}]',
      final_review: '终审结论：有条件通过',
      runtime_audit: '运行时边界已验证',
      qa: 'QA 真实命令全部通过',
    },
  );
  assert.match(summary, /canonical-spec\.md/);
  assert.match(summary, /verification/);
  assert.match(summary, /终审结论：有条件通过/);
  assert.match(summary, /运行时边界已验证/);
  assert.match(summary, /QA 真实命令全部通过/);
});

test('阻塞卡与任务卡使用橙色已阻塞样式', () => {
  const blocked = buildTaskCard({
    title: '开发工程师 · Codex',
    status: 'blocked',
    detail: '工作目录不可写',
    answer: '本轮未落地\n[RESULT:blocked] 工作目录不可写',
  }) as any;
  assert.equal(blocked.header.template, 'orange');
  assert.match(blocked.header.title.content, /已阻塞/);

  const card = buildStepBlockedCard({
    workflowId: '11111111-1111-1111-1111-111111111111',
    stepId: 'dev',
    stepTitle: '开发实现',
    reason: '目标目录无代码仓库',
    suggestedWorkdir: '/Users/leon/Desktop/leon-blog',
    blockVersion: '2025-01-01T00:00:00.000Z',
  }) as any;
  assert.equal(card.header.template, 'orange');
  const actions = card.body.elements
    .filter((item: any) => item.tag === 'button')
    .map((item: any) => item.behaviors[0].value.action);
  assert.deepEqual(actions, [
    'retry_blocked_step_with_workdir',
    'retry_blocked_step',
    'abort_blocked_workflow',
  ]);
});
