import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPipelineStepPrompt, DEFAULT_PIPELINE_STEPS } from '../src/core/pipeline.js';
import {
  classifyStepBlockReason,
  extractAbsolutePathCandidates,
  findMisroutedEnvironmentBlock,
  hasExplicitStepResult,
  parseStepResult,
  resolveQualityHandoffTarget,
  isEnvironmentBlockReason,
  shouldAcceptArchitectFailedAsDone,
  shouldAutoCorrectDevEnvironmentBlock,
  shouldTreatFailedResultAsDone,
} from '../src/core/step-result.js';
import { buildStepBlockedActionCard, buildStepBlockedCard } from '../src/im/workflow-card.js';
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
  assert.match(pm, /validate-spec-markdown\.mjs/);
  assert.match(pm, /不要出现 RISK_WAIVER 标记/);
  assert.match(pm, /同一 CLI 会话纠偏一次/);
});

test('架构师 planned findings 必须 RESULT:done，不得因 FIND 标 failed', () => {
  const architect = buildPipelineStepPrompt(
    DEFAULT_PIPELINE_STEPS.find((step) => step.id === 'architect')!,
    '修搜索框焦点样式',
    {},
  );
  assert.match(architect, /P0\/P1 登记为 planned 后必须输出 \[RESULT:done\]/);
  assert.match(architect, /同一 CLI 会话纠偏一次/);
  assert.match(architect, /禁止把「已规划给开发修的 FIND-\*」写成 \[RESULT:failed\]/);
  assert.match(architect, /设计门禁 planned P0\/P1 必须随 \[RESULT:done\] 通过/);
  assert.doesNotMatch(architect, /发现需改代码的缺陷时用这个/);
  assert.equal(shouldAcceptArchitectFailedAsDone('architect', 'failed', true), true);
  assert.equal(shouldAcceptArchitectFailedAsDone('architect', 'failed', false), false);
  assert.equal(shouldAcceptArchitectFailedAsDone('architect', 'done', true), false);
  assert.equal(shouldAcceptArchitectFailedAsDone('dev', 'failed', true), false);
  assert.equal(shouldTreatFailedResultAsDone('review'), true);
  assert.equal(shouldTreatFailedResultAsDone('summary'), true);
  assert.equal(shouldTreatFailedResultAsDone('architect'), false);
  assert.equal(shouldTreatFailedResultAsDone('qa'), false);
});

test('评审未通过必须 RESULT:done 回传开发，不得因 FIND 停掉流水线', () => {
  const review = buildPipelineStepPrompt(
    DEFAULT_PIPELINE_STEPS.find((step) => step.id === 'review')!,
    '审查实现',
    {},
  );
  assert.match(review, /输出 \[RESULT:done\] 且不要写 \[APPROVED\]/);
  assert.match(review, /禁止把「发现需开发修的 FIND-\*」写成 \[RESULT:failed\]/);
  assert.doesNotMatch(review, /发现需改代码的缺陷时用这个/);
});

test('CEO 汇总禁止用 RESULT:failed 把已通过流水线打成失败', () => {
  const summary = buildPipelineStepPrompt(
    DEFAULT_PIPELINE_STEPS.find((step) => step.id === 'summary')!,
    '交付汇总',
    {},
  );
  assert.match(summary, /禁止输出 \[RESULT:failed\]/);
  assert.match(summary, /汇总不能把已经通过门禁的流水线打成失败/);
  assert.doesNotMatch(summary, /发现需改代码的缺陷时用这个/);
});

test('开发、QA 与运行时审计 prompt 固定验证职责边界', () => {
  const promptFor = (id: 'dev' | 'qa' | 'runtime_audit') => buildPipelineStepPrompt(
    DEFAULT_PIPELINE_STEPS.find((step) => step.id === id)!,
    '验证网页交付',
    {},
  );

  const dev = promptFor('dev');
  assert.match(dev, /必需验证职责固定为：完整变更范围与需求追踪、本次改动的目标快速测试、静态检查与编译可行性/);
  assert.match(dev, /production build、dev\/production server、浏览器与普通功能 E2E 的验收责任属于 QA/);
  assert.match(dev, /required=false、status=blocked\/unverified 且 delegatedTo="verification"/);
  assert.match(dev, /完全相同的 check id、command argv 和 cwd[\s\S]*required=true\/status=pass\/exitCode=0/);
  assert.match(dev, /不得仅因这类环境缺证输出 \[RESULT:blocked\] 或 \[RESULT:failed\]/);
  assert.match(dev, /目标快速测试、静态\/编译检查真实失败[\s\S]*required=true \+ status=fail[\s\S]*\[RESULT:failed\]/);

  const qa = promptFor('qa');
  assert.match(qa, /负责完整交付验收[\s\S]*production build[\s\S]*浏览器普通功能 E2E/);
  assert.match(qa, /开发 artifact 中 required=false 的环境缺证只是交接信息，不是 QA 豁免/);
  assert.match(qa, /delegatedTo="verification"[\s\S]*完全相同的 id、command argv 和 cwd/);
  assert.match(qa, /required=true \+ status=blocked\/unverified[\s\S]*\[RESULT:blocked\]/);
  assert.match(qa, /产品代码或测试失败[\s\S]*status=fail[\s\S]*\[RESULT:failed\] 交回开发/);

  const runtimeAudit = promptFor('runtime_audit');
  assert.match(runtimeAudit, /只对适用的运行时边界做真实探测/);
  assert.match(runtimeAudit, /不得重复 QA 已完成的普通功能 E2E/);
  assert.match(runtimeAudit, /不得在本步重做完整 production build/);
});

test('开发纯环境阻塞只允许一次性契约纠偏，目录、资源与代码缺陷不适用', () => {
  const environmentReason = '沙箱禁止监听 localhost 且浏览器实例不可用，无法补齐 E2E 证据';
  assert.equal(shouldAutoCorrectDevEnvironmentBlock(
    'dev',
    environmentReason,
    '实现与目标测试均通过，未发现产品代码缺陷。\n[RESULT:blocked] 环境受限',
  ), true);
  assert.equal(shouldAutoCorrectDevEnvironmentBlock(
    'dev',
    '工作目录不可写，无法访问项目目录',
    '[RESULT:blocked] workdir 不可写',
  ), false);
  assert.equal(shouldAutoCorrectDevEnvironmentBlock(
    'dev',
    'migration/TRUNCATE 缺少隔离测试资源 sentinel 授权',
    '[RESULT:blocked] 等待授权',
  ), false);
  assert.equal(shouldAutoCorrectDevEnvironmentBlock(
    'dev',
    '沙箱禁止 localhost，且 migration/TRUNCATE 缺少隔离测试资源 sentinel 授权',
    '[RESULT:blocked] 等待测试资源授权',
  ), false);
  assert.equal(shouldAutoCorrectDevEnvironmentBlock(
    'dev',
    '沙箱禁止监听 localhost，但已确认产品代码缺陷需修改代码',
    '[RESULT:blocked] implementation 修复后才能通过',
  ), false);
  assert.equal(shouldAutoCorrectDevEnvironmentBlock(
    'dev',
    environmentReason,
    'typecheck 真实失败，required: true, status: fail\n[RESULT:blocked] 同时缺少浏览器',
  ), false);
  assert.equal(shouldAutoCorrectDevEnvironmentBlock(
    'dev',
    undefined,
    `当前 workdir 可写，目标快速测试与编译均通过；${environmentReason}\n[RESULT:blocked]`,
  ), true);
  assert.equal(shouldAutoCorrectDevEnvironmentBlock(
    'dev',
    environmentReason,
    'status: fail, exitCode: 1, required: true\n[RESULT:blocked] 同时缺少浏览器',
  ), false);
  assert.equal(shouldAutoCorrectDevEnvironmentBlock('qa', environmentReason, '[RESULT:blocked]'), false);

  const prompt = buildPipelineStepPrompt(
    DEFAULT_PIPELINE_STEPS.find((step) => step.id === 'dev')!,
    '验证网页交付',
    { dev_environment_autocorrect: '一次性纠偏：重建 pass manifest 与 Gate。' },
  );
  assert.match(prompt, /### dev_environment_autocorrect\n一次性纠偏/);
  assert.match(prompt, /不得复用上一轮 blocked manifest/);
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

  const sandboxBlock = '当前执行环境禁止监听本地端口并拒绝本地 PostgreSQL 访问，P0/P1 运行态验收证据无法完成';
  assert.equal(classifyStepBlockReason(sandboxBlock), 'environment');
  assert.equal(isEnvironmentBlockReason(sandboxBlock), true);
  assert.equal(resolveQualityHandoffTarget('qa', sandboxBlock), undefined);
  assert.equal(
    isEnvironmentBlockReason(`验收结论：环境阻塞，未发现已确认的产品代码缺陷。\n${sandboxBlock}`),
    true,
  );
  assert.equal(classifyStepBlockReason('当前 workdir 可写，但 sandbox 禁止监听本地端口'), 'environment');
  assert.equal(
    classifyStepBlockReason('Playwright 用例已运行，断言失败：按钮提交后没有显示成功状态'),
    'other',
  );
  assert.equal(
    resolveQualityHandoffTarget('qa', 'Playwright 用例已运行，断言失败：按钮提交后没有显示成功状态'),
    'dev',
  );

  const misrouted = findMisroutedEnvironmentBlock('dev', {
    quality_fix_request: `来源步骤：测试验收（qa）\n缺陷摘要：${sandboxBlock}`,
    blocked_qa: `验收结论：环境阻塞，未发现已确认的产品代码缺陷。\n${sandboxBlock}`,
  });
  assert.deepEqual(misrouted, { sourceStepId: 'qa', reason: sandboxBlock });
  assert.equal(findMisroutedEnvironmentBlock('dev', {
    quality_fix_request: `来源步骤：运行时审计（runtime_audit）\n缺陷摘要：${rb}`,
    blocked_runtime_audit: rb,
  }), undefined);
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

  const environmentCard = buildStepBlockedCard({
    workflowId: '22222222-2222-2222-2222-222222222222',
    stepId: 'qa',
    stepTitle: '测试验收',
    reason: '沙箱禁止监听 localhost，PostgreSQL 访问返回 EPERM',
    // 即使旧数据残留目录，环境卡也不能再显示绑定按钮。
    suggestedWorkdir: '/Users/leon/Desktop/leon-blog',
    blockVersion: '2025-01-01T00:00:00.000Z',
  }) as any;
  const environmentActions = environmentCard.body.elements
    .filter((item: any) => item.tag === 'button')
    .map((item: any) => ({
      action: item.behaviors[0].value.action,
      text: item.text.content,
    }));
  assert.deepEqual(environmentActions, [
    { action: 'retry_blocked_step', text: '环境就绪后重试' },
    { action: 'abort_blocked_workflow', text: '终止流水线' },
  ]);
  const environmentCopy = environmentCard.body.elements[0].content;
  assert.doesNotMatch(environmentCopy, /建议目录|\/workdir/);
  assert.doesNotMatch(environmentCopy, /sentinel|迁移\/清理/);

  const resourceAuthorizationCard = buildStepBlockedCard({
    workflowId: '33333333-3333-3333-3333-333333333333',
    stepId: 'qa',
    stepTitle: '测试验收',
    reason: '沙箱禁止 localhost；migration/TRUNCATE 缺少 sentinel 授权',
    blockKind: 'environment',
    testResourceAuthorizationAvailable: true,
    blockVersion: '2025-01-01T00:00:00.000Z',
  }) as any;
  const resourceActions = resourceAuthorizationCard.body.elements
    .filter((item: any) => item.tag === 'button')
    .map((item: any) => item.behaviors[0].value.action);
  assert.deepEqual(resourceActions, [
    'authorize_test_resource_and_retry',
    'retry_blocked_step',
    'abort_blocked_workflow',
  ]);
  assert.match(resourceAuthorizationCard.body.elements[0].content, /预检仍会拒绝开发\/生产库/);

  const retryingCard = buildStepBlockedActionCard({
    stepTitle: '测试验收',
    state: 'retrying',
    detail: '本次是普通重试，未附加测试资源授权。',
  }) as any;
  assert.equal(retryingCard.header.template, 'blue');
  assert.match(retryingCard.header.title.content, /重试中/);
  assert.match(retryingCard.body.elements[0].content, /未附加测试资源授权/);
  assert.equal(retryingCard.body.elements.some((item: any) => item.tag === 'button'), false);

  const authorizedCard = buildStepBlockedActionCard({
    stepTitle: '测试验收',
    state: 'authorized-retrying',
  }) as any;
  assert.match(authorizedCard.header.title.content, /已授权并重试/);
  assert.equal(authorizedCard.body.elements.some((item: any) => item.tag === 'button'), false);

  const inactiveCard = buildStepBlockedActionCard({
    stepTitle: '测试验收',
    state: 'inactive',
    detail: '流水线当前状态为 executing，未重复执行任何操作。',
  }) as any;
  assert.equal(inactiveCard.header.template, 'grey');
  assert.match(inactiveCard.header.title.content, /操作已失效/);
  assert.match(inactiveCard.body.elements[0].content, /未重复执行任何操作/);
  assert.equal(inactiveCard.body.elements.some((item: any) => item.tag === 'button'), false);

  const abortedCard = buildStepBlockedActionCard({
    stepTitle: '测试验收',
    state: 'aborted',
  }) as any;
  assert.equal(abortedCard.header.template, 'grey');
  assert.match(abortedCard.header.title.content, /已终止/);
  assert.equal(abortedCard.body.elements.some((item: any) => item.tag === 'button'), false);
});
