/**
 * ★ 交付流水线状态机（项目最大文件，2660+ 行）。
 *
 * 管理从「CEO 发起目标」到「交付汇总」的完整 8 步流水线生命周期。
 *
 * 核心导出函数（按调用顺序）：
 *
 * 流水线启动：
 * - runTeamPipeline()           → CEO 发起 /pipeline <目标>
 * - runDeliverySquad()         → 开发/CEO 发起 /squad <目标>（跳过 PM 需求）
 *
 * PM 阶段：
 * - pipelineRunner 内部调 startCliTask → PM CLI 产出 Spec
 * - confirmSpecForReview()      → 用户确认 → 发布到云文档评审
 * - confirmSpecAndStartDelivery → 用户确认 → 直接开始技术交付
 * - rejectSpecConfirmation()    → 用户退回 → PM 修订
 * - resumeWorkflowAfterQuestionnaire → 问卷作答后恢复 PM
 *
 * 技术交付阶段（架构→开发→评审→QA→审计→终审）：
 * - continueDeliveryWorkflow()  → 推进到下一步骤
 * - resumeBlockedWorkflowStep() → 用户重试阻塞步骤
 * - handOffBlockedWorkflowIfQualityFix → 质量失败自动退回开发
 * - pauseWorkflowOnUserStop()   → 用户停止 → 标记 paused
 * - resumePausedOrOrphanedWorkflow → 重启恢复 paused 流水线
 *
 * 门禁校验（validateSuccess 回调）：
 * - createGateRun / assertGateLineage / assertPlannedFindingsClosed
 * - assertEvidenceChainComplete / assertFindingContinuity
 * - FingerprintDriftError（源码指纹漂移检测）
 *
 * 证据链管理：
 * - canonical-spec.md（控制器固化的需求规格）
 * - evidence-chain.json（v2 证据链）
 * - 各步骤的 artifact（change-plan / implementation-manifest / change-review 等）
 *
 * 核心概念：
 * - GATE_RESULT：步骤产出的门禁结果 JSON（pass/reject + findings）
 * - RESULT 标记：[RESULT:done|blocked|failed] 终态语义
 * - DECISION：[DECISION:approved|rejected] 评审决策
 * - HANDOFF：[HANDOFF:dev|review|architect] 协作回传目标
 * - blockVersion：阻塞卡版本（= workflow.updatedAt），防止旧卡放行
 * - quality_fix_request：质量失败退回开发的修复请求
 */
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PIPELINE_STEPS,
  DELIVERY_SQUAD_STEPS,
  buildPipelineStepPrompt,
  missingBotIdsForSteps,
  resolvePipelineActorId,
  logicalRoleForStep,
  resolveSkillsRoot,
  type PipelineStep,
} from '../core/pipeline.js';
import {
  assertEvidenceChainComplete,
  assertFindingContinuity,
  assertGateWaiversBoundToCanonicalSpec,
  assertGateAttemptBudget,
  assertGateChecksBelongToAttempt,
  assertGateLineage,
  assertOutstandingFindingsCarriedForward,
  assertPlannedFindingsClosed,
  buildEvidenceChainManifest,
  bindGateWaiversToCanonicalSpec,
  createGateRun,
  consolidateLatestGateFindings,
  FingerprintDriftError,
  gateIdForStep,
  isFingerprintDriftError,
  latestGateRuns,
  parseGateResult,
  parseCanonicalSpecWaivers,
  rewindStepIdFromDriftMessage,
  unresolvedOptionalCheckGapIds,
  validateGatePass,
  verifyGateArtifacts,
  type CanonicalSpecWaiverContext,
  type GateRun,
} from '../core/quality-gates.js';
import { compactAgentOutput } from '../core/agent-output.js';
import { fingerprintProject } from '../core/project-snapshot.js';
import { extractRequirementIds } from '../core/requirement-ids.js';
import {
  isRuntimeSourceChangedError,
  processRuntimeSourceGuard,
  RUNTIME_SOURCE_RESTART_MESSAGE,
} from '../core/runtime-source-guard.js';
import {
  isTestResourceSentinelAuthorized,
  TEST_RESOURCE_SENTINEL_ENV,
} from '../core/test-resource-policy.js';
import type { DeliveryWorkflow } from '../core/workflow-store.js';
import type { ProductSpec } from '../core/spec-store.js';
import { redactSecrets, sanitizeErrorForLog, sanitizeForLog } from '../core/log-inspection.js';
import {
  classifyStepBlockReason,
  extractAbsolutePathCandidates,
  findMisroutedEnvironmentBlock,
  handoffStepIdFromQualityMessage,
  hasExplicitStepResult,
  isOrchestrationFailureReason,
  parseStepOutcome,
  parseStepResult,
  requiresTestResourceAuthorization,
  resolveQualityHandoffTarget,
  resolveRejectedDecisionHandoff,
  shouldAutoCorrectDevEnvironmentBlock,
  shouldPauseAsEvidenceBlock,
} from '../core/step-result.js';
import { assertWorkdir } from '../core/workdir.js';
import { buildQuestionnaireCard, buildSpecConfirmationCard, buildStepBlockedCard } from '../im/workflow-card.js';
import type { Bot, IncomingMessage } from '../im/lark.js';
import type { AppContext } from './app-context.js';
import { runCollabReview } from './collab-runner.js';
import { startCliTask } from './cli-task.js';
import { ensureRunnableSession, topicIdOf, truncate } from './sessions.js';
import { finishApprovalExecution } from './approval-status.js';
import { cliPolicyForPipelineStep } from '../cli/execution-policy.js';

interface ApprovedWorkflowLaunch {
  executionPolicy?: DeliveryWorkflow['executionPolicy'];
  approvalId?: string;
  approvalAttempt?: number;
  scheduleJobId?: string;
  scheduleRunCount?: number;
}

interface WorkflowStepExpectation {
  stepIndex: number;
  stepId: PipelineStep['id'];
}

const FINGERPRINT_SCRIPT_PATH = fileURLToPath(
  new URL('../../scripts/fingerprint-project.mjs', import.meta.url),
);
const HASH_PATH_SCRIPT_PATH = fileURLToPath(
  new URL('../../scripts/hash-path.mjs', import.meta.url),
);

function devEnvironmentAutocorrectInstruction(reason: string): string {
  return [
    '控制器一次性自动纠偏：上一轮开发步骤把纯环境运行态缺证错误地报告成了 RESULT:blocked。',
    `上一轮原因：${reason}`,
    '请保留并重新验证开发职责内的 required 检查：变更范围/需求追踪、目标快速测试、静态检查与代码编译；这些项目真实失败时必须 RESULT:failed，不能降级。',
    '仅对因沙箱端口、浏览器、数据库或网络不可用而缺少的完整 production build、dev/production server、浏览器或普通功能 E2E 证据，改记 required=false + status=blocked/unverified，并明确移交 QA。',
    '废弃上一轮 blocked manifest/Gate，重新生成并校验 status=pass 的 implementation-manifest 与 GATE_RESULT；开发 required 项全部通过后输出 [RESULT:done]。',
    '如果复核发现明确产品代码缺陷，不得套用本纠偏，按 required=true + status=fail 输出 [RESULT:failed]。',
  ].join('\n');
}

/** CEO 团队交付流水线：按步骤串联各角色，关键人工节点会持久化暂停。 */
export async function runTeamPipeline(
  ctx: AppContext,
  options: { ceo: Bot; msg: IncomingMessage; goal: string } & ApprovedWorkflowLaunch,
): Promise<void> {
  return createAndStartWorkflow(ctx, {
    initiator: options.ceo,
    msg: options.msg,
    goal: options.goal,
    requestedSteps: ctx.pipelineSteps,
    name: '团队交付流水线',
    kind: 'team',
    executionPolicy: options.executionPolicy,
    approvalId: options.approvalId,
    approvalAttempt: options.approvalAttempt,
    scheduleJobId: options.scheduleJobId,
    scheduleRunCount: options.scheduleRunCount,
  });
}

/** 开发内部交付小队：聚焦技术方案、实现、评审与验收。 */
export async function runDeliverySquad(
  ctx: AppContext,
  options: { initiator: Bot; msg: IncomingMessage; goal: string } & ApprovedWorkflowLaunch,
): Promise<void> {
  const missingBotIds = missingBotIdsForSteps(DELIVERY_SQUAD_STEPS, new Set(ctx.botsById.keys()));
  if (missingBotIds.length > 0) {
    throw new Error(`内部交付小队缺少已连接角色：${missingBotIds.join('、')}`);
  }
  return createAndStartWorkflow(ctx, {
    ...options,
    requestedSteps: DELIVERY_SQUAD_STEPS,
    name: '开发内部交付小队',
    kind: 'squad',
  });
}

async function createAndStartWorkflow(
  ctx: AppContext,
  options: {
    initiator: Bot;
    msg: IncomingMessage;
    goal: string;
    requestedSteps: PipelineStep[];
    name: string;
    kind: 'team' | 'squad';
  } & ApprovedWorkflowLaunch,
): Promise<void> {
  const {
    initiator,
    msg,
    goal,
    requestedSteps,
    name,
    kind,
    executionPolicy = 'standard',
    approvalId,
    approvalAttempt,
    scheduleJobId,
    scheduleRunCount,
  } = options;
  if (ctx.shuttingDown) throw new Error('服务正在停止，无法启动流水线');
  if ((approvalId && !approvalAttempt) || (!approvalId && approvalAttempt)) {
    throw new Error('审批工作流缺少完整的审批编号或执行轮次。');
  }
  if ((scheduleJobId && !scheduleRunCount) || (!scheduleJobId && scheduleRunCount)) {
    throw new Error('定时工作流缺少完整的任务编号或运行轮次。');
  }
  const missingBotIds = missingBotIdsForSteps(requestedSteps, new Set(ctx.botsById.keys()));
  if (missingBotIds.length > 0) {
    throw new Error('交付流水线缺少已连接角色：' + missingBotIds.join('、'));
  }
  const steps = requestedSteps;
  const topicId = topicIdOf(msg);
  const configuredWorkdir = ctx.topics.getWorkdir(msg.chatId, topicId);
  if (!configuredWorkdir) {
    throw new Error('门禁交付必须先绑定真实项目目录：请使用 /workdir <绝对路径> 后重试。');
  }
  const projectRoot = await assertWorkdir(configuredWorkdir);

  const canonicalSpec = kind === 'squad' ? ctx.specs.findCanonical(projectRoot) : undefined;
  if (kind === 'squad' && (!canonicalSpec || canonicalSpec.status !== 'approved')) {
    throw new Error('内部交付小队需要当前项目已批准的 canonical Spec；请先由 CEO 完成需求与产品评审。');
  }
  if (canonicalSpec) assertSpecRequirementIds(canonicalSpec);

  let workflow = await ctx.workflows.create({
    kind,
    name,
    initiatorBotId: initiator.id,
    goal,
    stepIds: steps.map((step) => step.id),
    executionPolicy,
    qualityPolicy: 'gated',
    projectRoot,
    specId: canonicalSpec?.id,
    approvalId,
    approvalAttempt,
    scheduleJobId,
    scheduleRunCount,
    message: storedMessage(msg),
  });
  if (canonicalSpec && Object.keys(workflow.priorOutputs).length === 0) {
    try {
      workflow = await ctx.workflows.update(workflow.id, {
        priorOutputs: {
          pm: canonicalSpec.content,
          canonical_spec: JSON.stringify({
            id: canonicalSpec.id,
            version: canonicalSpec.version,
            sha256: canonicalSpec.contentHash,
          }),
        },
      });
    } catch (error) {
      await ctx.workflows.updateIfStatus(workflow.id, ['ready'], {
        status: 'failed',
        error: `写入 canonical Spec 上下文失败：${persistentErrorMessage(error, 2_000)}`,
      });
      throw error;
    }
  }
  try {
    await prepareEvidenceRoot(workflow);
  } catch (error) {
    await ctx.workflows.update(workflow.id, {
      status: 'failed',
      error: `创建门禁证据目录失败：${persistentErrorMessage(error, 2_000)}`,
    });
    throw error;
  }
  if (approvalId && approvalAttempt) {
    try {
      await ctx.approvals.attachWorkflow(approvalId, approvalAttempt, workflow.id);
    } catch (error) {
      await ctx.workflows.update(workflow.id, {
        status: 'failed',
        error: `绑定审批失败：${persistentErrorMessage(error, 2_000)}`,
      });
      throw error;
    }
  }
  console.log(`[${name}] workflow=${workflow.id} 目标=${truncate(sanitizeForLog(goal, 120), 60)} 步骤=${workflow.stepIds.join(' → ')}`);
  try {
    const boundWorkdir = workflow.projectRoot;
    await initiator.reply(
      msg.messageId,
      [
        `已启动${name}。`,
        `目标：${goal}`,
        `步骤：${steps.map((s, i) => `${i + 1}.${s.title}`).join(' → ')}`,
        boundWorkdir
          ? `话题目录：${boundWorkdir}`
          : '话题目录：未绑定',
      ].join('\n'),
      hasThread(msg),
    );
    await continueDeliveryWorkflow(ctx, workflow.id);
  } catch (error) {
    await failWorkflow(ctx, workflow.id, `启动失败：${(error as Error).message}`);
    throw error;
  }
}

/** 从持久化状态执行一个步骤；异步 CLI 完成后由回调推进下一步。 */
export async function continueDeliveryWorkflow(ctx: AppContext, workflowId: string): Promise<void> {
  if (ctx.shuttingDown) return;
  let claimedWorkflow: DeliveryWorkflow | undefined;
  try {
    const workflow = await ctx.workflows.claimReady(workflowId);
    if (!workflow) return;
    claimedWorkflow = workflow;
    const msg = messageForWorkflow(ctx, workflow);
    const initiator = ctx.botsById.get(workflow.initiatorBotId);
    if (!initiator) throw new Error(`发起 Bot 未连接：${workflow.initiatorBotId}`);
    const steps = stepsFor(workflow);
    const pendingStep = steps[workflow.nextStepIndex];
    // 必须先于话题目录/canonical Spec/项目 fingerprint 等业务项目读取执行。
    const hasEnteredTechnicalDelivery = workflow.stepIds.indexOf('pm') < 0
      || workflow.nextStepIndex > workflow.stepIds.indexOf('pm');
    if (
      workflow.qualityPolicy === 'gated'
      && hasEnteredTechnicalDelivery
      && (!pendingStep || pendingStep.id !== 'pm')
    ) {
      await assertRuntimeSourceCurrent(ctx);
    }
    if (workflow.qualityPolicy === 'gated') {
      const bound = ctx.topics.getWorkdir(msg.chatId, topicIdOf(msg));
      if (!bound || bound !== workflow.projectRoot) {
        throw new Error('工作流执行期间项目目录发生变化；为防止跨项目证据污染，请按新目录重新发起交付。');
      }
      if (workflow.stepIds[workflow.nextStepIndex] !== 'pm') assertCanonicalWorkflowSpec(ctx, workflow);
    }
    if (workflow.nextStepIndex >= steps.length) {
      let completionDisposition: DeliveryWorkflow['completionDisposition'] = 'clean';
      let completionDetail = '';
      if (workflow.qualityPolicy === 'gated') {
        if (!workflow.projectRoot) throw new Error('门禁工作流缺少项目根目录');
        const snapshot = await fingerprintProject(workflow.projectRoot);
        await assertControllerEvidenceChainUnmodified(workflow, snapshot.fingerprint);
        // 只校验各 gate 最新一次结果：历史 attempt 引用的同名证据文件常被后续轮次覆盖，
        // 用旧 hash 去对当前磁盘会误报「artifact hash 不匹配」。
        const latest = latestGateRuns(workflow.gateRuns);
        const canonicalSpec = assertCanonicalWorkflowSpec(ctx, workflow);
        const waiverContext = canonicalSpecWaiverContext(canonicalSpec);
        await verifyCanonicalSpecSnapshotFile(evidenceRootFor(workflow), canonicalSpec);
        for (const run of latest.values()) {
          await verifyGateArtifacts(evidenceRootFor(workflow), run.result, {
            projectRoot: workflow.projectRoot,
          });
          if (!run.projectFingerprint) throw new Error(`门禁 ${run.gateId} 缺少项目 fingerprint`);
          const runIndex = workflow.gateRuns.findIndex((candidate) => candidate.id === run.id);
          await assertGateLineage(run.stepId as PipelineStep['id'], run.result, {
            canonicalSpecHash: canonicalSpec.contentHash!,
            canonicalRequirementIds: extractRequirementIds(canonicalSpec.content),
            projectFingerprint: run.projectFingerprint,
            stepStartFingerprint: run.stepStartFingerprint,
            previousRuns: runIndex >= 0 ? workflow.gateRuns.slice(0, runIndex) : [],
          });
          assertFindingContinuity(
            runIndex >= 0 ? workflow.gateRuns.slice(0, runIndex) : [],
            run.result,
          );
          assertGateWaiversBoundToCanonicalSpec(run.result, waiverContext);
          validateGatePass(run.stepId as PipelineStep['id'], run.result);
        }
        const implementation = latest.get('implementation');
        if (implementation) {
          assertPlannedFindingsClosed('dev', workflow.gateRuns, implementation.result);
        }
        const finalReview = latest.get('final-review');
        if (finalReview) {
          assertOutstandingFindingsCarriedForward(workflow.gateRuns, finalReview.result);
        }
        assertEvidenceChainComplete(workflow.stepIds, workflow.gateRuns, snapshot.fingerprint);
        const findings = consolidateLatestGateFindings(workflow.gateRuns);
        const waivedIds = findings
          .filter((finding) => finding.status === 'waived')
          .map((finding) => finding.id);
        const openResidualIds = findings
          .filter((finding) => finding.status === 'open'
            && (finding.severity === 'P2' || finding.severity === 'P3'))
          .map((finding) => finding.id);
        const optionalGapIds = unresolvedOptionalCheckGapIds(workflow.gateRuns);
        if (waivedIds.length > 0 || openResidualIds.length > 0 || optionalGapIds.length > 0) {
          completionDisposition = 'conditional';
          completionDetail = [
            waivedIds.length > 0 ? `${waivedIds.length} 项有效 waiver` : '',
            openResidualIds.length > 0 ? `${openResidualIds.length} 项开放 P2/P3` : '',
            optionalGapIds.length > 0 ? `${optionalGapIds.length} 项可选检查未完成` : '',
          ].filter(Boolean).join('、');
        }
      }
      const completed = await ctx.workflows.updateIfStatus(workflow.id, 'executing', {
        status: 'completed',
        completionDisposition,
        error: undefined,
      });
      if (!completed) return;
      await settleWorkflowApproval(ctx, completed, 'succeeded');
      await settleWorkflowSchedule(ctx, completed, 'succeeded');
      const completionMessage = completionDisposition === 'conditional'
        ? `${workflow.name}已在披露残余风险的前提下有条件完成（${completionDetail}），请以最终汇总中的风险清单为准。`
        : `${workflow.name}已全部完成，未发现开放 finding、waiver 或未完成检查。`;
      await initiator.reply(msg.messageId, completionMessage, hasThread(msg)).catch((error) => {
        console.error(`[${workflow.name}] 完成通知发送失败:`, sanitizeErrorForLog(error));
      });
      return;
    }

    await ensureWorkflowTopicCliId(ctx, workflow, msg);
    const stepIndex = workflow.nextStepIndex;
    const step = steps[stepIndex];
    const stepLabel = `步骤 ${stepIndex + 1}/${steps.length} · ${step.title}`;
    if (workflow.qualityPolicy === 'gated') {
      assertGateAttemptBudget(step.id, workflow.gateRuns);
    }
    if (workflow.qualityPolicy === 'gated' && step.id === 'final_review') {
      await writeControllerEvidenceChain(ctx, workflow);
    }
    if (step.id === 'review') {
      const promptOutputs = await priorOutputsForPrompt(ctx, workflow);
      let reviewCompletion: { gateRun: GateRun; projectFingerprint: string } | undefined;
      let fixStepStartFingerprint: string | undefined;
      await initiator.reply(msg.messageId, `${stepLabel}：启动评审协作。`, hasThread(msg));
      await runCollabReview(ctx, {
        initiator,
        msg,
        task: buildPipelineStepPrompt(step, workflow.goal, promptOutputs),
        round: 1,
        executionPolicy: cliPolicyForPipelineStep(step.id, workflow.executionPolicy),
        fixExecutionPolicy: workflow.executionPolicy === 'approved' ? 'approved' : 'standard',
        evidenceRoot: optionalEvidenceRoot(workflow),
        approvedScope: workflow.executionPolicy === 'approved' ? workflow.goal : undefined,
        resultProtocol: workflow.qualityPolicy === 'gated',
        stateKey: `workflow:${workflow.id}`,
        workflowId: workflow.id,
        beforeTask: workflow.qualityPolicy === 'gated'
          ? () => assertRuntimeSourceCurrent(ctx)
          : undefined,
        fixInstruction: workflow.qualityPolicy === 'gated'
          ? async () => {
            const currentWorkflow = requireWorkflow(ctx, workflow.id);
            const fixOutputs = await priorOutputsForPrompt(ctx, currentWorkflow);
            fixStepStartFingerprint = stepStartFingerprintFromPrompt(fixOutputs);
            return buildPipelineStepPrompt(
              { id: 'dev', botId: 'dev', title: '开发实现' },
              workflow.goal,
              fixOutputs,
            );
          }
          : undefined,
        validateFix: workflow.qualityPolicy === 'gated'
          ? async (answer) => {
            await assertRuntimeSourceCurrent(ctx);
            assertExplicitSuccessfulStepResult(answer, 'dev');
            const completion = await buildGateCompletion(
              ctx,
              workflow.id,
              stepIndex,
              'dev',
              answer,
              {
                recordAttemptStepId: step.id,
                stepStartFingerprint: fixStepStartFingerprint,
              },
            );
            const recorded = await ctx.workflows.recordGateAttempt(
              workflow.id,
              stepIndex,
              step.id,
              completion.gateRun,
              completion.projectFingerprint,
            );
            if (!recorded) throw new Error('修复后的实现证据未能写入当前 review 步骤');
          }
          : undefined,
        validateApproval: workflow.qualityPolicy === 'gated'
          ? async (answer) => {
            await assertRuntimeSourceCurrent(ctx);
            assertExplicitSuccessfulStepResult(answer, 'review');
            reviewCompletion = await buildGateCompletion(
              ctx,
              workflow.id,
              stepIndex,
              step.id,
              answer,
            );
          }
          : undefined,
        onComplete: async ({ approved, answer }) => {
          if (workflow.qualityPolicy === 'gated') await assertRuntimeSourceCurrent(ctx);
          if (!approved) {
            await handOffQualityFix(
              ctx,
              workflow.id,
              {
                fromStepId: step.id,
                fromStepIndex: stepIndex,
                targetStepId: 'dev',
                reason: '变更审查未批准（含协作轮次用尽）',
                answer,
              },
              false,
            );
            return;
          }
          if (workflow.qualityPolicy === 'gated' && !reviewCompletion) {
            throw new Error('代码评审缺少已验证的结构化门禁结果');
          }
          await completeRegularStep(
            ctx,
            workflow.id,
            stepIndex,
            step.id,
            answer,
            reviewCompletion,
            false,
          );
        },
        afterComplete: async () => {
          const committed = ctx.workflows.get(workflow.id);
          if (committed?.status === 'ready') {
            await continueDeliveryWorkflow(ctx, committed.id);
          }
        },
        onBlocked: async ({ answer, reason }) => {
          if (workflow.qualityPolicy === 'gated') await assertRuntimeSourceCurrent(ctx);
          await pauseWorkflowForStepBlock(
            ctx,
            workflow.id,
            stepIndex,
            step.id,
            step.title,
            answer,
            reason,
          );
        },
        onFailure: async (error) => {
          await routePipelineCliFailure(ctx, workflow.id, error, {
            stepIndex,
            stepId: step.id,
            stepTitle: step.title,
          });
        },
      });
      return;
    }

    const actorId = resolvePipelineActorId(step, new Set(ctx.botsById.keys()));
    const actor = ctx.botsById.get(actorId);
    if (!actor) throw new Error(`角色 ${actorId} 未连接`);
    const actorSession = await ensureRunnableSession(ctx, actor, msg, {
      logicalRole: logicalRoleForStep(step),
    });
    if (!actorSession) {
      // P1 修复：actor busy 时不要直接 throw 导致 failWorkflow，而是延迟重试。
      // 设为 ready 状态让调度器在下一个 tick 重试。
      console.warn(`[工作流] ${workflow.id} 角色 ${actor.name} 正忙，延迟重试。`);
      await ctx.workflows.updateIfStatus(workflow.id, 'executing', {
        status: 'ready',
        error: `${actor.name} 正忙，将在稍后自动重试。`,
      });
      return;
    }

    await initiator.reply(msg.messageId, `${stepLabel}：交给 ${actor.name}。`, hasThread(msg));
    // P1 修复：捕获不可变的步骤启动时间，避免 workflow.updatedAt 在执行期间被更新后导致时间窗口校验不准。
    const stepStartedAt = new Date().toISOString();
    let preparedGateCompletion: { gateRun: GateRun; projectFingerprint: string } | undefined;
    const promptOutputs = await priorOutputsForPrompt(ctx, workflow);
    const stepStartFingerprint = stepStartFingerprintFromPrompt(promptOutputs);
    if (workflow.qualityPolicy === 'gated' && step.id !== 'pm') {
      await assertRuntimeSourceCurrent(ctx);
    }
    await startCliTask(ctx, {
      bot: actor,
      msg,
      session: actorSession,
      prompt: buildPipelineStepPrompt(step, workflow.goal, promptOutputs),
      workflowId: workflow.id,
      testResourceSentinelAuthorized: step.id === 'qa' && (
        isTestResourceSentinelAuthorized()
        || workflow.priorOutputs.test_resource_authorized === 'true'
      ),
      executionPolicy: cliPolicyForPipelineStep(step.id, workflow.executionPolicy),
      evidenceRoot: optionalEvidenceRoot(workflow),
      approvedScope: workflow.executionPolicy === 'approved' ? workflow.goal : undefined,
      // PM 步骤产出 Spec 正文，不解析 RESULT 标记
      resultProtocol: step.id !== 'pm',
      treatFailedResultAsDone: step.id === 'summary',
      validateSuccess: step.id === 'pm'
        ? async (answer) => {
          if (await ctx.questionnaires.latestAwaitingForWorkflow(workflow.id)) return;
          if (await ctx.questionnaires.recoverAwaitingFromProductOutput(answer, workflow.id)) return;
          assertProductStepSpecOutput(answer);
        }
        : workflow.qualityPolicy === 'gated' && gateIdForStep(step.id)
        ? async (answer) => {
          await assertRuntimeSourceCurrent(ctx);
          preparedGateCompletion = await buildGateCompletion(
            ctx,
            workflow.id,
            stepIndex,
            step.id,
            answer,
            { stepStartFingerprint, attemptStartedAt: stepStartedAt },
          );
        }
        : undefined,
      onSuccess: async (answer, normalizedResult) => {
        if (workflow.qualityPolicy === 'gated' && step.id !== 'pm') {
          await assertRuntimeSourceCurrent(ctx);
        }
        // PM 的 Spec 正文不应夹 RESULT 标记；其余步骤按显式标记决定推进/暂停/失败。
        if (step.id !== 'pm') {
          // P1 修复：使用 cli-task.ts 传入的已归一化 stepResult，避免重复解析导致不一致。
          const stepResult = normalizedResult ?? parseStepResult(answer);
          const outcome = parseStepOutcome(answer);
          const routingReason = stepResult.reason || outcome.reason || '';
          // 门禁已通过的 [RESULT:done] 禁止再因正文里的 sha256 / GATE_RESULT 假暂停。
          if (stepResult.kind !== 'done' && shouldPauseAsEvidenceBlock(step.id, routingReason, answer)) {
            await pauseWorkflowForStepBlock(
              ctx,
              workflow.id,
              stepIndex,
              step.id,
              step.title,
              answer,
              routingReason || '本步证据或格式不可用',
            );
            return;
          }
          if (stepResult.kind === 'failed') {
            if (isOrchestrationFailureReason(`${routingReason}\n${answer}`)) {
              await pauseWorkflowForStepBlock(
                ctx,
                workflow.id,
                stepIndex,
                step.id,
                step.title,
                answer,
                routingReason || 'CLI 编排层故障，当前步骤未完成',
              );
              return;
            }
            const handoff = resolveQualityHandoffTarget(step.id, routingReason, answer);
            if (handoff) {
              await handOffQualityFix(
                ctx,
                workflow.id,
                {
                  fromStepId: step.id,
                  fromStepIndex: stepIndex,
                  targetStepId: handoff,
                  reason: routingReason || '质量步骤报告失败，需修复后重跑',
                  answer,
                },
                false,
              );
              return;
            }
            await failWorkflow(
              ctx,
              workflow.id,
              routingReason || '步骤报告失败',
              { stepIndex, stepId: step.id },
            );
            return;
          }
          const rejectedHandoff = resolveRejectedDecisionHandoff(step.id, outcome, answer);
          if (rejectedHandoff) {
            await handOffQualityFix(
              ctx,
              workflow.id,
              {
                fromStepId: step.id,
                fromStepIndex: stepIndex,
                targetStepId: rejectedHandoff,
                reason: routingReason || '质量步骤拒绝批准，需修复后重跑',
                answer,
              },
              false,
            );
            return;
          }
          if (stepResult.kind === 'blocked') {
            const handoff = resolveQualityHandoffTarget(step.id, routingReason, answer);
            if (handoff) {
              await handOffQualityFix(
                ctx,
                workflow.id,
                {
                  fromStepId: step.id,
                  fromStepIndex: stepIndex,
                  targetStepId: handoff,
                  reason: stepResult.reason || '质量步骤发现需修复的缺陷',
                  answer,
                },
                false,
              );
              return;
            }
            if (shouldAutoCorrectDevEnvironmentBlock(step.id, stepResult.reason, answer)) {
              const blockReason = stepResult.reason?.trim()
                || compactAgentOutput(answer, 1_000)
                || '开发步骤报告纯环境运行态阻塞';
              const retried = await ctx.workflows.retryCurrentDevEnvironmentBlockOnce(
                workflow.id,
                stepIndex,
                devEnvironmentAutocorrectInstruction(blockReason),
                compactAgentOutput(answer, 6_000),
              );
              if (retried) {
                console.warn(`[工作流] ${workflow.id} 开发环境阻塞已自动纠偏，将原步骤重跑一次。`);
                await initiator.reply(
                  msg.messageId,
                  '检测到开发步骤把纯环境运行态缺证误报为阻塞；已自动纠偏，将在当前任务结束后重跑开发步骤一次，无需手工操作。',
                  hasThread(msg),
                ).catch((error) => {
                  console.error(`[工作流] ${workflow.id} 发送开发环境纠偏通知失败:`, sanitizeErrorForLog(error));
                });
                return;
              }
            }
            await pauseWorkflowForStepBlock(
              ctx,
              workflow.id,
              stepIndex,
              step.id,
              step.title,
              answer,
              stepResult.reason,
            );
            return;
          }
        }
        if (step.id === 'pm') {
          await completeProductStep(ctx, workflow.id, stepIndex, actor, answer);
          return;
        }
        const completion = workflow.qualityPolicy === 'gated' && gateIdForStep(step.id)
          ? preparedGateCompletion
            ?? await buildGateCompletion(
              ctx,
              workflow.id,
              stepIndex,
              step.id,
              answer,
              { stepStartFingerprint, attemptStartedAt: stepStartedAt },
            )
          : undefined;
        await completeRegularStep(ctx, workflow.id, stepIndex, step.id, answer, completion, false);
      },
      afterSuccess: async () => {
        const committed = ctx.workflows.get(workflow.id);
        if (committed?.status === 'ready') {
          await continueDeliveryWorkflow(ctx, committed.id);
        }
      },
      onFailure: async (error) => {
        await routePipelineCliFailure(ctx, workflow.id, error, {
          stepIndex,
          stepId: step.id,
          stepTitle: step.title,
        });
      },
    });
  } catch (error) {
    const workflow = claimedWorkflow ?? ctx.workflows.get(workflowId);
    if (!workflow) throw error;
    // P0 修复：完成边界（nextStepIndex === stepIds.length）时 currentStepId 为 undefined。
    // 旧代码用 nextStepIndex-1 做 expectedStep，但 updateIfCurrentStep 检查
    // current.nextStepIndex === expectedStep.stepIndex，即 stepIds.length !== stepIds.length-1，
    // 必然 CAS miss，导致 workflow 卡在 executing 且租约不释放。
    // 修正：完成边界不传 expectedStep，让 failWorkflow 走 updateIfStatus。
    const currentStepId = workflow.stepIds[workflow.nextStepIndex];
    const atCompletionBoundary = workflow.status === 'executing'
      && workflow.nextStepIndex === workflow.stepIds.length;
    const expectedStep = workflow.status === 'executing' && currentStepId && !atCompletionBoundary
      ? { stepIndex: workflow.nextStepIndex, stepId: currentStepId }
      : undefined;
    if (await pauseForRuntimeSourceChangeIfNeeded(
      ctx,
      workflow.id,
      error,
      expectedStep,
    )) return;
    if (await tryRewindForFingerprintDrift(
      ctx,
      workflow.id,
      error,
      expectedStep,
    )) {
      return;
    }
    await failWorkflow(
      ctx,
      workflow.id,
      (error as Error).message,
      expectedStep,
    );
  }
}

/**
 * 话题引擎是流水线所有角色的单一事实来源。
 * 升级前的话题没有该字段时，以发起角色当前引擎迁移，修复“CEO 已选 Codex、PM 又回落 Claude”。
 */
async function ensureWorkflowTopicCliId(
  ctx: AppContext,
  workflow: DeliveryWorkflow,
  msg: IncomingMessage,
): Promise<void> {
  const topicId = topicIdOf(msg);
  let cliId = ctx.topics.getCliId(msg.chatId, topicId);
  if (!cliId) {
    cliId = ctx.sessions.listByTopic(msg.chatId, topicId)
      .find((session) => session.botId === workflow.initiatorBotId)?.cliId
      ?? ctx.defaultCliId;
    await ctx.topics.setCliId(msg.chatId, topicId, cliId);
    console.log(
      `[引擎] 工作流 ${workflow.id} 将旧话题迁移为统一引擎 ${cliId}`,
    );
  }
  const update = await ctx.sessions.setCliIdForTopic(msg.chatId, topicId, cliId);
  for (const sessionId of update.updatedSessionIds) ctx.contextWindows.delete(sessionId);
  if (update.deferredBotIds.length > 0) {
    console.log(
      `[引擎] 工作流 ${workflow.id} 等待在途角色结束后对齐：${update.deferredBotIds.join('、')}`,
    );
  }
}

function assertExplicitSuccessfulStepResult(answer: string, stepId: PipelineStep['id']): void {
  if (!hasExplicitStepResult(answer)) {
    throw new Error(`流水线步骤 ${stepId} 缺少显式 [RESULT:done] 终态标记，不能按成功处理。`);
  }
  const result = parseStepResult(answer);
  if (result.kind !== 'done') {
    throw new Error(`流水线步骤 ${stepId} 报告 [RESULT:${result.kind}]，不能提交成功门禁${result.reason ? `：${result.reason}` : ''}`);
  }
}

export async function completeProductStep(
  ctx: AppContext,
  workflowId: string,
  stepIndex: number,
  actor: Bot,
  answer: string,
): Promise<void> {
  let workflow = requireWorkflow(ctx, workflowId);
  if (!isCurrentExecutingStep(workflow, stepIndex, 'pm')) return;
  const msg = messageForWorkflow(ctx, workflow);
  const initiator = ctx.botsById.get(workflow.initiatorBotId) ?? actor;
  let questionnaire = await ctx.questionnaires.latestAwaitingForWorkflow(workflow.id);
  if (!questionnaire) {
    const recovered = await ctx.questionnaires.recoverAwaitingFromProductOutput(answer, workflow.id);
    if (recovered) {
      questionnaire = await ctx.questionnaires.attachWorkflowContext(recovered.id, {
        workflowId: workflow.id,
        chatId: msg.chatId,
        topicId: topicIdOf(msg),
        ownerOpenId: msg.senderOpenId,
        botId: actor.id,
        messageId: msg.messageId,
      });
    }
  }
  workflow = requireWorkflow(ctx, workflowId);
  if (!isCurrentExecutingStep(workflow, stepIndex, 'pm')) return;
  if (questionnaire) {
    const paused = await ctx.workflows.updateIfCurrentStep(workflow.id, stepIndex, 'pm', {
      status: 'awaiting_questions',
      questionnaireId: questionnaire.id,
      error: undefined,
    });
    if (!paused) return;
    workflow = paused;
    let cardSent = true;
    await actor.replyCard(msg.messageId, buildQuestionnaireCard(questionnaire), hasThread(msg)).catch((error) => {
      cardSent = false;
      console.error(`[工作流] ${workflow.id} 问卷卡发送失败:`, sanitizeErrorForLog(error));
    });
    await initiator.reply(
      msg.messageId,
      cardSent
        ? `产品经理提出了结构化问题（${questionnaire.id}）。完成卡片后流水线会自动继续。`
        : [
          `产品经理提出了结构化问题（${questionnaire.id}）。问卷卡片发送失败，请发送：`,
          `/form ${questionnaire.id}`,
        ].join('\n'),
      hasThread(msg),
    );
    return;
  }

  // MCP 成功时上面的 questionnaire 分支会暂停流水线。没有问卷时，PM 输出必须已经是
  // 可确认的完整 Spec；禁止把“工具不可用 + 内联澄清问题”误存为待确认方案。
  assertProductStepSpecOutput(answer);

  const linkedById = workflow.specId ? ctx.specs.get(workflow.specId) : undefined;
  if (workflow.specId && !linkedById) {
    throw new Error(`工作流关联的 Spec 不存在: ${workflow.specId}`);
  }
  if (linkedById?.workflowId && linkedById.workflowId !== workflow.id) {
    throw new Error(`Spec ${linkedById.id} 不属于工作流 ${workflow.id}`);
  }
  const recovered = ctx.specs.findByWorkflowId(workflow.id);
  if (linkedById && recovered && linkedById.id !== recovered.id) {
    throw new Error(`工作流 ${workflow.id} 关联了多份产品 Spec`);
  }
  // 修复“Spec 已写入、工作流关联尚未写入”时的重启窗口，避免重复创建方案。
  const existing = linkedById ?? recovered;
  const handledCommentIds = new Set(
    (workflow.priorOutputs.review_comment_ids ?? '').split(',').map((id) => id.trim()).filter(Boolean),
  );
  const documentCommentGroups = new Map<string, string[]>();
  if (existing?.docId && handledCommentIds.size > 0) {
    for (const comment of existing.comments) {
      if (!handledCommentIds.has(comment.id) || !comment.docCommentId) continue;
      const documentCommentId = comment.docCommentId.split(':', 1)[0];
      documentCommentGroups.set(
        documentCommentId,
        [...(documentCommentGroups.get(documentCommentId) ?? []), comment.id],
      );
    }
  }
  let spec = existing
    ? await ctx.specs.update(existing.id, {
      content: answer,
      status: 'pending_confirmation',
      questionnaireId: workflow.questionnaireId,
      confirmationFeedback: undefined,
    })
    : await ctx.specs.create({
      title: workflow.goal.slice(0, 80),
      content: answer,
      projectId: workflow.projectRoot ?? `${msg.chatId}:${topicIdOf(msg)}`,
      chatId: msg.chatId,
      topicId: topicIdOf(msg),
      messageId: msg.messageId,
      ownerOpenId: msg.senderOpenId,
      botId: actor.id,
      questionnaireId: workflow.questionnaireId,
      workflowId: workflow.id,
    });
  if (existing && handledCommentIds.size > 0) {
    spec = await ctx.specs.resolveComments(existing.id, handledCommentIds);
  }
  const nextPriorOutputs = { ...workflow.priorOutputs };
  delete nextPriorOutputs.previous_spec;
  delete nextPriorOutputs.confirmation_feedback;
  delete nextPriorOutputs.review_comment_ids;
  const paused = await ctx.workflows.updateIfCurrentStep(workflow.id, stepIndex, 'pm', {
    status: 'awaiting_spec_confirmation',
    specId: spec.id,
    nextStepIndex: stepIndex + 1,
    priorOutputs: { ...nextPriorOutputs, pm: answer },
    error: undefined,
  });
  if (!paused) throw new Error('产品步骤状态已变化，已停止发送过期的方案确认卡。');
  workflow = paused;
  // P1 修复：发卡失败时加文本兼底，提示用户用 /spec show 恢复。
  try {
    await actor.replyCard(msg.messageId, buildSpecConfirmationCard(spec), hasThread(msg));
  } catch (cardError) {
    console.error('[工作流] 发送 Spec 确认卡失败，发文本兼底:', (cardError as Error).message);
    await actor.reply(
      msg.messageId,
      `产品 Spec 已生成（${spec.id}），但确认卡发送失败。请用 \`/spec show ${spec.id}\` 查看并确认。`,
      hasThread(msg),
    ).catch(() => undefined);
  }
  await initiator.reply(
    msg.messageId,
    `产品 Spec 已生成（${spec.id}）。确认前架构和开发步骤不会启动。`,
    hasThread(msg),
  );
  if (existing?.docId) {
    for (const [documentCommentId, localCommentIds] of documentCommentGroups) {
      try {
        await actor.resolveDocumentComment(existing.docId, documentCommentId);
        await ctx.specs.markDocumentCommentsResolved(existing.id, new Set(localCommentIds));
      } catch (error) {
        console.error(
          `[产品评审] 同步解决 Spec ${existing.id} 评论 ${documentCommentId} 失败，将由轮询重试:`,
          sanitizeErrorForLog(error),
        );
      }
    }
  }
}

function isCurrentExecutingStep(
  workflow: DeliveryWorkflow,
  stepIndex: number,
  stepId: PipelineStep['id'],
): boolean {
  return workflow.status === 'executing'
    && workflow.nextStepIndex === stepIndex
    && workflow.stepIds[stepIndex] === stepId;
}

async function completeRegularStep(
  ctx: AppContext,
  workflowId: string,
  stepIndex: number,
  stepId: PipelineStep['id'],
  answer: string,
  options?: { gateRun: GateRun; projectFingerprint: string },
  continueAfterCommit = true,
): Promise<void> {
  const contextAnswer = compactAgentOutput(answer, stepId === 'summary' ? 12_000 : 6_000);
  const advanced = await ctx.workflows.completeCurrentStep(
    workflowId,
    stepIndex,
    stepId,
    contextAnswer,
    options,
  );
  if (!advanced) return;
  if (continueAfterCommit) await continueDeliveryWorkflow(ctx, advanced.id);
}

async function buildGateCompletion(
  ctx: AppContext,
  workflowId: string,
  stepIndex: number,
  stepId: PipelineStep['id'],
  answer: string,
  options: {
    recordAttemptStepId?: PipelineStep['id'];
    stepStartFingerprint?: string;
    /** P1 修复：不可变的步骤启动时间，避免 workflow.updatedAt 在执行期间被更新后导致时间窗口校验不准。 */
    attemptStartedAt?: string;
  } = {},
): Promise<{ gateRun: GateRun; projectFingerprint: string }> {
  const workflow = requireWorkflow(ctx, workflowId);
  if (!workflow.projectRoot) throw new Error('门禁步骤缺少项目根目录');
  const evidenceRoot = await prepareEvidenceRoot(workflow);
  const parsedResult = await parseGateResult(answer, stepId, { evidenceRoot });
  const snapshot = await fingerprintProject(workflow.projectRoot);
  if ((stepId === 'architect' || stepId === 'dev')
    && !/^[a-f0-9]{64}$/.test(options.stepStartFingerprint ?? '')) {
    throw new Error(`${stepId} 门禁缺少控制器捕获的步骤启动 fingerprint`);
  }
  let result = parsedResult;
  let gateRun = createGateRun(
    stepId,
    result,
    workflow.gateRuns,
    snapshot.fingerprint,
    options.stepStartFingerprint,
  );
  try {
    const canonicalSpec = assertCanonicalWorkflowSpec(ctx, workflow);
    const waiverContext = canonicalSpecWaiverContext(canonicalSpec);
    result = bindGateWaiversToCanonicalSpec(parsedResult, waiverContext);
    gateRun = createGateRun(
      stepId,
      result,
      workflow.gateRuns,
      snapshot.fingerprint,
      options.stepStartFingerprint,
    );
    await verifyGateArtifacts(evidenceRoot, result, { projectRoot: workflow.projectRoot });
    await verifyCanonicalSpecSnapshotFile(evidenceRoot, canonicalSpec);
    const currentOrder = workflow.stepIds.indexOf(stepId);
    const upstreamRuns = [...latestGateRuns(workflow.gateRuns).values()]
      .filter((run) => {
        const runOrder = workflow.stepIds.indexOf(run.stepId as PipelineStep['id']);
        return runOrder >= 0 && runOrder < currentOrder;
      });
    // 每个下游门禁先重验最新上游 artifact，尽早发现跨角色覆盖、过期 waiver
    // 或历史证据被改写，避免一直跑到终审才暴露断链。
    for (const run of upstreamRuns) {
      await verifyGateArtifacts(evidenceRoot, run.result, { projectRoot: workflow.projectRoot });
      if (!run.projectFingerprint) throw new Error(`门禁 ${run.gateId} 缺少项目 fingerprint`);
      const runIndex = workflow.gateRuns.findIndex((candidate) => candidate.id === run.id);
      await assertGateLineage(run.stepId as PipelineStep['id'], run.result, {
        canonicalSpecHash: canonicalSpec.contentHash!,
        canonicalRequirementIds: extractRequirementIds(canonicalSpec.content),
        projectFingerprint: run.projectFingerprint,
        stepStartFingerprint: run.stepStartFingerprint,
        previousRuns: runIndex >= 0 ? workflow.gateRuns.slice(0, runIndex) : [],
      });
      assertFindingContinuity(
        runIndex >= 0 ? workflow.gateRuns.slice(0, runIndex) : [],
        run.result,
      );
      assertGateWaiversBoundToCanonicalSpec(run.result, waiverContext);
      validateGatePass(run.stepId as PipelineStep['id'], run.result);
      if (run.stepId === 'dev') {
        assertPlannedFindingsClosed('dev', workflow.gateRuns.slice(0, Math.max(0, runIndex)), run.result);
      }
    }
    await assertGateLineage(stepId, result, {
      canonicalSpecHash: canonicalSpec.contentHash!,
      canonicalRequirementIds: extractRequirementIds(canonicalSpec.content),
      projectFingerprint: snapshot.fingerprint,
      stepStartFingerprint: options.stepStartFingerprint,
      previousRuns: workflow.gateRuns,
    });
    assertFindingContinuity(workflow.gateRuns, result);
    assertGateWaiversBoundToCanonicalSpec(result, waiverContext);
    validateGatePass(stepId, result);
    assertGateChecksBelongToAttempt(result, options.attemptStartedAt ?? workflow.updatedAt);
    assertPlannedFindingsClosed(stepId, workflow.gateRuns, result);
    const latest = latestGateRuns(workflow.gateRuns);
    if (stepId === 'review') {
      const implementation = latest.get('implementation');
      if (!implementation || implementation.projectFingerprint !== snapshot.fingerprint) {
        throw new FingerprintDriftError(
          'implementation',
          'dev',
          '当前变更快照与最新 implementation gate 不一致，必须先重建实现证据',
        );
      }
    }
    if (stepId === 'qa') {
      const changeReview = latest.get('change-review');
      if (!changeReview || changeReview.projectFingerprint !== snapshot.fingerprint) {
        throw new FingerprintDriftError(
          'change-review',
          'review',
          'QA 执行时项目快照已偏离 change-review，必须重新评审',
        );
      }
    }
    if (stepId === 'runtime_audit') {
      const verification = latest.get('verification');
      if (!verification || verification.projectFingerprint !== snapshot.fingerprint) {
        throw new FingerprintDriftError(
          'verification',
          'qa',
          '运行时审计快照已偏离 QA 验证快照，必须重新验证',
        );
      }
    }
    if (stepId === 'final_review') {
      const latest = latestGateRuns(workflow.gateRuns);
      for (const run of latest.values()) {
        if (run.gateId === 'final-review') continue;
        await verifyGateArtifacts(evidenceRoot, run.result, { projectRoot: workflow.projectRoot });
        assertGateWaiversBoundToCanonicalSpec(run.result, waiverContext);
        validateGatePass(run.stepId as PipelineStep['id'], run.result);
      }
      await assertControllerEvidenceChainUnmodified(workflow, snapshot.fingerprint);
      assertOutstandingFindingsCarriedForward(workflow.gateRuns, result);
      assertEvidenceChainComplete(
        workflow.stepIds,
        [...workflow.gateRuns, gateRun],
        snapshot.fingerprint,
      );
    }
  } catch (error) {
    // P1 修复：上游证据校验错误（如 FingerprintDriftError）不应消耗当前 gate 的 attempt 额度。
    // 只记录当前 gate 自身校验失败为 failed attempt；上游错误直接抛出由调用方处理。
    if (error instanceof FingerprintDriftError) {
      throw error;
    }
    // 失败尝试不要记成 pass，避免污染 latestGateRuns
    const failedRun: GateRun = {
      ...gateRun,
      status: 'fail',
      result: {
        ...gateRun.result,
        status: 'fail',
        summary: (error as Error).message.slice(0, 10_000) || gateRun.result.summary,
      },
    };
    await ctx.workflows.recordGateAttempt(
      workflowId,
      stepIndex,
      options.recordAttemptStepId ?? stepId,
      failedRun,
      snapshot.fingerprint,
    );
    throw error;
  }
  return { gateRun, projectFingerprint: snapshot.fingerprint };
}

/**
 * 代码树偏离上游门禁证据时，退回对应步骤重建，而不是把整条流水线打成 failed。
 * 返回 true 表示已接管（已回复并续跑或已失败兜底）。
 */
async function tryRewindForFingerprintDrift(
  ctx: AppContext,
  workflowId: string,
  error: unknown,
  expectedStep?: { stepIndex: number; stepId: PipelineStep['id'] },
): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error);
  const rewindTo = (isFingerprintDriftError(error) && error.rewindToStepId)
    ? error.rewindToStepId
    : rewindStepIdFromDriftMessage(message);
  if (!rewindTo) return false;

  const workflow = ctx.workflows.get(workflowId);
  if (!workflow) return false;
  const targetIndex = workflow.stepIds.indexOf(rewindTo);
  if (targetIndex < 0) return false;

  const stepTitle = DEFAULT_PIPELINE_STEPS.find((step) => step.id === rewindTo)?.title ?? rewindTo;
  const reason = `${message}；已自动退回「${stepTitle}」重建证据后再继续。`;

  let rewound: DeliveryWorkflow | undefined;
  if (expectedStep && workflow.status === 'executing') {
    rewound = await ctx.workflows.updateIfCurrentStep(
      workflowId,
      expectedStep.stepIndex,
      expectedStep.stepId,
      {
        status: 'ready',
        nextStepIndex: targetIndex,
        error: undefined,
        priorOutputs: {
          ...workflow.priorOutputs,
          fingerprint_drift: reason,
        },
      },
    );
  } else if (workflow.status === 'failed' || workflow.status === 'ready') {
    rewound = await ctx.workflows.updateIfStatus(workflowId, workflow.status, {
      status: 'ready',
      nextStepIndex: targetIndex,
      error: undefined,
      priorOutputs: {
        ...workflow.priorOutputs,
        fingerprint_drift: reason,
      },
    });
  }

  if (!rewound) return false;

  const initiator = ctx.botsById.get(rewound.initiatorBotId);
  if (initiator) {
    const msg = messageForWorkflow(ctx, rewound);
    await initiator.reply(msg.messageId, `${rewound.name}：${reason}`, hasThread(msg)).catch(() => undefined);
  }
  console.warn(`[工作流] 指纹漂移，退回 ${rewindTo}: ${message}`);
  void continueDeliveryWorkflow(ctx, workflowId).catch(async (continueError) => {
    console.error('[工作流] 退回重建后续跑失败:', (continueError as Error).message);
    await failWorkflow(ctx, workflowId, (continueError as Error).message);
  });
  return true;
}

/**
 * CLI 进程级失败：编排故障停在当前步骤；代码缺陷才移交开发；其余 fail closed。
 */
async function routePipelineCliFailure(
  ctx: AppContext,
  workflowId: string,
  error: Error,
  options: {
    stepIndex: number;
    stepId: PipelineStep['id'];
    stepTitle: string;
  },
): Promise<void> {
  if (await pauseForRuntimeSourceChangeIfNeeded(
    ctx,
    workflowId,
    error,
    { stepIndex: options.stepIndex, stepId: options.stepId },
  )) return;
  if (await tryRewindForFingerprintDrift(ctx, workflowId, error, {
    stepIndex: options.stepIndex,
    stepId: options.stepId,
  })) {
    return;
  }
  if (isOrchestrationFailureReason(error.message)) {
    await pauseWorkflowForStepBlock(
      ctx,
      workflowId,
      options.stepIndex,
      options.stepId,
      options.stepTitle,
      error.message,
      error.message,
    );
    return;
  }
  const handoff = resolveQualityHandoffTarget(options.stepId, error.message)
    ?? ( /未处理 P0\/P1|仍有未处理 P0\/P1/.test(error.message)
      && !/与审查 artifact 不一致|findings 集合不一致|格式错误/.test(error.message)
      && (
        options.stepId === 'qa'
        || options.stepId === 'runtime_audit'
        || options.stepId === 'final_review'
        || options.stepId === 'review'
      )
      ? 'dev' as const
      : undefined);
  if (handoff) {
    await handOffQualityFix(ctx, workflowId, {
      fromStepId: options.stepId,
      fromStepIndex: options.stepIndex,
      targetStepId: handoff,
      reason: error.message,
    });
    return;
  }
  await failWorkflow(
    ctx,
    workflowId,
    error.message,
    { stepIndex: options.stepIndex, stepId: options.stepId },
  );
}

/**
 * 质量步骤发现需改代码的缺陷：记 bug 摘要并退回开发（或架构），不要弹绑目录重试卡。
 */
async function handOffQualityFix(
  ctx: AppContext,
  workflowId: string,
  options: {
    fromStepId: PipelineStep['id'];
    fromStepIndex: number;
    targetStepId: 'dev' | 'architect';
    reason: string;
    answer?: string;
  },
  continueAfterCommit = true,
): Promise<void> {
  const workflow = requireWorkflow(ctx, workflowId);
  const targetIndex = workflow.stepIds.indexOf(options.targetStepId);
  if (targetIndex < 0) {
    await failWorkflow(
      ctx,
      workflowId,
      options.reason,
      { stepIndex: options.fromStepIndex, stepId: options.fromStepId },
    );
    return;
  }

  const stepTitle = DEFAULT_PIPELINE_STEPS.find((step) => step.id === options.targetStepId)?.title
    ?? options.targetStepId;
  const fromTitle = DEFAULT_PIPELINE_STEPS.find((step) => step.id === options.fromStepId)?.title
    ?? options.fromStepId;
  const reason = options.reason.trim() || '质量步骤发现需修复的缺陷';
  const brief = [
    `来源步骤：${fromTitle}（${options.fromStepId}）`,
    `缺陷摘要：${reason}`,
    '请修复后输出完整 GATE_RESULT；修复完成后流水线会从该步骤重新向后推进（含后续评审/测试/运行时审计）。',
  ].join('\n');

  const nextPrior: Record<string, string> = { ...workflow.priorOutputs };
  delete nextPrior.blocked_workdir;
  nextPrior.quality_fix_request = brief;
  nextPrior[`blocked_${options.fromStepId}`] = compactAgentOutput(options.answer
    ?? workflow.priorOutputs[`blocked_${options.fromStepId}`]
    ?? reason, 6_000);

  const patch = {
    status: 'ready' as const,
    nextStepIndex: targetIndex,
    error: undefined,
    priorOutputs: nextPrior,
  };

  let handed: DeliveryWorkflow | undefined;
  if (workflow.status === 'executing') {
    handed = await ctx.workflows.updateIfCurrentStep(
      workflowId,
      options.fromStepIndex,
      options.fromStepId,
      patch,
    );
  } else if (workflow.status === 'awaiting_step_unblock' || workflow.status === 'failed' || workflow.status === 'ready') {
    handed = await ctx.workflows.updateIfStatus(workflowId, workflow.status, patch);
  }

  if (!handed) {
    // P1 修复：第一次 CAS 已失败说明 step 已变化，不要用相同 expectedStep 再做第二次 CAS（必然也 miss）。
    // 改用 updateIfStatus 覆盖任意非终态状态。
    await failWorkflow(ctx, workflowId, reason);
    return;
  }

  const initiator = ctx.botsById.get(handed.initiatorBotId);
  if (initiator) {
    const msg = messageForWorkflow(ctx, handed);
    await initiator.reply(
      msg.messageId,
      [
        `${handed.name}：${fromTitle}发现需改代码的问题，已记录并转交「${stepTitle}」修复。`,
        reason,
        `正在从步骤 ${options.targetStepId} 继续…`,
      ].join('\n'),
      hasThread(msg),
    ).catch(() => undefined);
  }
  console.warn(`[工作流] 质量缺陷移交 ${options.fromStepId} → ${options.targetStepId}: ${reason}`);
  if (continueAfterCommit) {
    void continueDeliveryWorkflow(ctx, workflowId).catch(async (continueError) => {
      console.error('[工作流] 移交修复后续跑失败:', (continueError as Error).message);
      await failWorkflow(ctx, workflowId, (continueError as Error).message);
    });
  }
}

/** 供 /workflow retry：若当前阻塞其实是代码缺陷，则移交开发/架构而不是重发绑目录卡。 */
export async function handOffBlockedWorkflowIfQualityFix(
  ctx: AppContext,
  workflowId: string,
): Promise<boolean> {
  const workflow = requireWorkflow(ctx, workflowId);
  if (workflow.status !== 'awaiting_step_unblock') return false;
  // 控制器源码漂移不是业务项目代码缺陷，必须留在原步骤等服务重启。
  if (workflow.priorOutputs.runtime_source_changed !== undefined) return false;
  const stepId = workflow.stepIds[workflow.nextStepIndex];
  if (!stepId) return false;
  const reason = workflow.error
    || workflow.priorOutputs[`blocked_${stepId}`]
    || '';
  const target = handoffStepIdFromQualityMessage(stepId, reason)
    || resolveQualityHandoffTarget(stepId, reason);
  if (!target) return false;
  await handOffQualityFix(ctx, workflowId, {
    fromStepId: stepId,
    fromStepIndex: workflow.nextStepIndex,
    targetStepId: target,
    reason: (workflow.error || reason).slice(0, 4_000),
    answer: workflow.priorOutputs[`blocked_${stepId}`],
  });
  return true;
}

async function priorOutputsForPrompt(
  ctx: AppContext,
  workflow: DeliveryWorkflow,
): Promise<Record<string, string>> {
  if (workflow.qualityPolicy !== 'gated') return workflow.priorOutputs;
  const currentStepIndex = workflow.nextStepIndex;
  // 退回 dev/review 时保留历史 attempt 作审计，但不把旧 QA/终审结论再喂给上游角色。
  const evidence = [...latestGateRuns(workflow.gateRuns).values()]
    .filter((run) => {
      const runStepIndex = workflow.stepIds.indexOf(run.stepId as PipelineStep['id']);
      return runStepIndex >= 0 && runStepIndex < currentStepIndex;
    })
    .map((run) => ({
    gateId: run.gateId,
    status: run.status,
    attempt: run.attempt,
    projectFingerprint: run.projectFingerprint,
    recordedAt: run.recordedAt,
    summary: run.result.summary.slice(0, 800),
    artifacts: run.result.artifacts.slice(0, 20),
    outstandingFindings: run.result.findings
      .filter((finding) => finding.status === 'open' || finding.status === 'waived')
      .slice(0, 50)
      .map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        status: finding.status,
        summary: finding.summary.slice(0, 500),
      })),
    }));
  const spec = workflow.specId ? ctx.specs.get(workflow.specId) : undefined;
  const canonical = spec?.canonical && spec.status === 'approved' ? spec : undefined;
  const canonicalSnapshot = canonical
    ? await ensureCanonicalSpecSnapshotFile(await prepareEvidenceRoot(workflow), canonical)
    : undefined;
  const canonicalSpec = canonical
    ? JSON.stringify({
      id: canonical.id,
      version: canonical.version,
      sha256: canonical.contentHash,
      projectId: canonical.projectId,
      status: canonical.status,
      source: 'agent-os-spec-store',
      contentKey: 'pm',
      snapshot: canonicalSnapshot,
    })
    : workflow.priorOutputs.canonical_spec;
  const stepId = workflow.stepIds[currentStepIndex];
  const snapshot = workflow.projectRoot && stepId !== 'pm'
    ? await fingerprintProject(workflow.projectRoot)
    : undefined;
  const evidenceChainPath = stepId === 'final_review'
    ? resolve(evidenceRootFor(workflow), 'evidence-chain.json')
    : undefined;
  const evidenceChainContent = evidenceChainPath
    ? await readFile(evidenceChainPath)
    : undefined;
  return {
    ...workflow.priorOutputs,
    ...(canonical ? { pm: canonical.content } : {}),
    ...(canonicalSpec ? { canonical_spec: canonicalSpec } : {}),
    workflow_context: JSON.stringify({
      workflowId: workflow.id,
      projectRoot: workflow.projectRoot,
      evidenceRoot: evidenceRootFor(workflow),
      skillsRoot: resolveSkillsRoot(),
      qualityProtocolVersion: '2.0',
      gateAttemptStartedAt: workflow.updatedAt,
      canonicalRequirementIds: canonical
        ? extractRequirementIds(canonical.content)
        : undefined,
      canonicalSpec: canonicalSnapshot,
      controllerEvidenceChain: evidenceChainPath && evidenceChainContent
        ? {
          path: evidenceChainPath,
          sha256: createHash('sha256').update(evidenceChainContent).digest('hex'),
        }
        : undefined,
      projectFingerprintBeforeStep: snapshot?.fingerprint,
      fingerprintCommand: snapshot
        ? [process.execPath, FINGERPRINT_SCRIPT_PATH, snapshot.projectRoot]
        : undefined,
      hashPathCommandPrefix: snapshot
        ? [process.execPath, HASH_PATH_SCRIPT_PATH]
        : undefined,
      testResourceSafety: {
        sentinelEnv: TEST_RESOURCE_SENTINEL_ENV,
        sentinelAuthorized: stepId === 'qa' && (
          isTestResourceSentinelAuthorized()
          || workflow.priorOutputs.test_resource_authorized === 'true'
        ),
        rule: '只有连接串命名符合 test/ci/e2e/tmp、且与开发/预览/生产连接均不相同时，才可凭此 sentinel 执行 migration/TRUNCATE/DROP/seed。',
      },
      rule: '所有结构化 artifact 必须写入 evidenceRoot，并在 GATE_RESULT 中提供真实 SHA-256。',
    }),
    quality_evidence: JSON.stringify(evidence),
  };
}

function stepStartFingerprintFromPrompt(outputs: Record<string, string>): string | undefined {
  const raw = outputs.workflow_context;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { projectFingerprintBeforeStep?: unknown };
    return typeof parsed.projectFingerprintBeforeStep === 'string'
      && /^[a-f0-9]{64}$/.test(parsed.projectFingerprintBeforeStep)
      ? parsed.projectFingerprintBeforeStep
      : undefined;
  } catch {
    return undefined;
  }
}

function evidenceRootFor(workflow: DeliveryWorkflow): string {
  if (!workflow.projectRoot) throw new Error('门禁工作流缺少项目根目录');
  return resolve(workflow.projectRoot, '.agent-os', 'evidence', workflow.id);
}

/** PM 尚未绑定目录时不要 throw；质检步骤有 projectRoot 才会注入 Claude 路径级写入。 */
function optionalEvidenceRoot(workflow: DeliveryWorkflow): string | undefined {
  return workflow.projectRoot ? evidenceRootFor(workflow) : undefined;
}

async function writeControllerEvidenceChain(ctx: AppContext, workflow: DeliveryWorkflow): Promise<string> {
  if (!workflow.projectRoot) throw new Error('门禁工作流缺少项目根目录');
  const evidenceRoot = await prepareEvidenceRoot(workflow);
  const latest = latestGateRuns(workflow.gateRuns);
  const canonicalSpec = assertCanonicalWorkflowSpec(ctx, workflow);
  const waiverContext = canonicalSpecWaiverContext(canonicalSpec);
  await verifyCanonicalSpecSnapshotFile(evidenceRoot, canonicalSpec);
  for (const run of latest.values()) {
    if (run.gateId === 'final-review') continue;
    await verifyGateArtifacts(evidenceRoot, run.result, { projectRoot: workflow.projectRoot });
    if (!run.projectFingerprint) throw new Error(`门禁 ${run.gateId} 缺少项目 fingerprint`);
    const runIndex = workflow.gateRuns.findIndex((candidate) => candidate.id === run.id);
    await assertGateLineage(run.stepId as PipelineStep['id'], run.result, {
      canonicalSpecHash: canonicalSpec.contentHash!,
      canonicalRequirementIds: extractRequirementIds(canonicalSpec.content),
      projectFingerprint: run.projectFingerprint,
      stepStartFingerprint: run.stepStartFingerprint,
      previousRuns: runIndex >= 0 ? workflow.gateRuns.slice(0, runIndex) : [],
    });
    assertFindingContinuity(
      runIndex >= 0 ? workflow.gateRuns.slice(0, runIndex) : [],
      run.result,
    );
    assertGateWaiversBoundToCanonicalSpec(run.result, waiverContext);
    validateGatePass(run.stepId as PipelineStep['id'], run.result);
  }
  const implementation = latest.get('implementation');
  if (implementation) assertPlannedFindingsClosed('dev', workflow.gateRuns, implementation.result);
  const snapshot = await fingerprintProject(workflow.projectRoot);
  const manifest = buildEvidenceChainManifest(
    workflow.id,
    workflow.stepIds,
    workflow.gateRuns,
    snapshot.fingerprint,
    controllerEvidenceGeneratedAt(workflow),
  );
  const path = resolve(evidenceRoot, 'evidence-chain.json');
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return path;
}

/** 终审角色只能读取控制器证据链；终审及汇总后都重新构造并做语义等值校验。 */
async function assertControllerEvidenceChainUnmodified(
  workflow: DeliveryWorkflow,
  currentFingerprint: string,
): Promise<void> {
  const evidenceRoot = await prepareEvidenceRoot(workflow);
  const path = resolve(evidenceRoot, 'evidence-chain.json');
  const stats = await lstat(path).catch(() => {
    throw new Error('控制器证据链不存在，必须重新生成后再终审');
  });
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('控制器证据链必须是普通文件且不能是符号链接');
  }
  let actual: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root must be object');
    actual = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error('控制器证据链不是有效 JSON：' + (error as Error).message);
  }
  const expected = JSON.parse(JSON.stringify(buildEvidenceChainManifest(
    workflow.id,
    workflow.stepIds,
    workflow.gateRuns,
    currentFingerprint,
    controllerEvidenceGeneratedAt(workflow),
  ))) as Record<string, unknown>;
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error('控制器证据链在生成后被改写或与当前门禁状态不一致');
  }
}

function controllerEvidenceGeneratedAt(workflow: DeliveryWorkflow): string {
  const timestamps = [...latestGateRuns(workflow.gateRuns).values()]
    .filter((run) => run.gateId !== 'final-review')
    .map((run) => run.recordedAt)
    .sort();
  const generatedAt = timestamps.at(-1);
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) {
    throw new Error('无法从上游门禁确定控制器证据链生成时间');
  }
  return generatedAt;
}

function assertCanonicalWorkflowSpec(ctx: AppContext, workflow: DeliveryWorkflow): ProductSpec {
  const spec = workflow.specId ? ctx.specs.get(workflow.specId) : undefined;
  if (
    !spec
    || spec.status !== 'approved'
    || !spec.canonical
    || spec.projectId !== workflow.projectRoot
    || !spec.contentHash
    || !spec.approvedAt
  ) {
    throw new Error('工作流缺少当前项目已批准且带 hash 的 canonical Spec，不能进入技术交付阶段。');
  }
  if (extractRequirementIds(spec.content).length === 0) {
    throw new Error('canonical Spec 缺少稳定需求 ID（例如 RQ-001），不能进入技术交付阶段。');
  }
  parseCanonicalSpecWaivers(spec.content);
  return spec;
}

function assertSpecRequirementIds(spec: Pick<ProductSpec, 'content'>): void {
  if (extractRequirementIds(spec.content).length === 0) {
    throw new Error('产品 Spec 缺少以条目开头声明的稳定需求 ID（例如 `### RQ-001 登录`），请先退回产品经理修订。');
  }
  parseCanonicalSpecWaivers(spec.content);
}

/** PM 没有创建问卷时，其最终输出必须能直接进入人工确认。 */
export function assertProductStepSpecOutput(answer: string): void {
  try {
    assertSpecRequirementIds({ content: answer });
  } catch (error) {
    throw new Error(
      '产品经理未创建结构化问卷，且输出不是可确认的产品 Spec；本次输出不会保存或显示确认卡。'
      + `若仍需澄清，请检查 MCP 权限；否则请修正 Spec 结构后重试。具体原因：${persistentErrorMessage(error, 2_000)}`,
    );
  }
}

function canonicalSpecWaiverContext(spec: ProductSpec): CanonicalSpecWaiverContext {
  if (!spec.contentHash || !spec.approvedAt) {
    throw new Error('canonical Spec 缺少 waiver 绑定所需的内容 hash 或批准时间');
  }
  return {
    specId: spec.id,
    version: spec.version,
    content: spec.content,
    contentHash: spec.contentHash,
    approvedAt: spec.approvedAt,
  };
}

interface CanonicalSpecSnapshot {
  path: string;
  sha256: string;
}

export async function ensureCanonicalSpecSnapshotFile(
  evidenceRoot: string,
  spec: ProductSpec,
): Promise<CanonicalSpecSnapshot> {
  if (!spec.contentHash) throw new Error('canonical Spec 缺少内容 hash');
  const path = resolve(evidenceRoot, 'canonical-spec.md');
  const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stats) {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, spec.content, 'utf8');
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
  return verifyCanonicalSpecSnapshotFile(evidenceRoot, spec);
}

async function verifyCanonicalSpecSnapshotFile(
  evidenceRoot: string,
  spec: ProductSpec,
): Promise<CanonicalSpecSnapshot> {
  if (!spec.contentHash) throw new Error('canonical Spec 缺少内容 hash');
  const path = resolve(evidenceRoot, 'canonical-spec.md');
  const stats = await lstat(path).catch(() => {
    throw new Error('控制器 canonical Spec 快照不存在');
  });
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('控制器 canonical Spec 快照必须是普通文件且不能是符号链接');
  }
  const content = await readFile(path);
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (sha256 !== spec.contentHash) {
    throw new Error('控制器 canonical Spec 快照被改写或已过期');
  }
  return { path, sha256 };
}

async function prepareEvidenceRoot(workflow: DeliveryWorkflow): Promise<string> {
  if (!workflow.projectRoot) throw new Error('门禁工作流缺少项目根目录');
  const projectRoot = await realpath(workflow.projectRoot);
  const agentRoot = resolve(projectRoot, '.agent-os');
  const evidenceRoot = resolve(agentRoot, 'evidence');
  const workflowRoot = evidenceRootFor({ ...workflow, projectRoot });
  for (const directory of [agentRoot, evidenceRoot, workflowRoot]) {
    const existing = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing?.isSymbolicLink()) throw new Error('证据目录不能是符号链接：' + directory);
    if (existing && !existing.isDirectory()) throw new Error('证据路径不是目录：' + directory);
    if (!existing) {
      await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
    const canonical = await realpath(directory);
    const rel = relative(projectRoot, canonical);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new Error('证据目录必须位于项目根目录内：' + directory);
    }
  }
  return workflowRoot;
}

/** 飞书表单完成后，用答案重新执行 PM 步骤。 */
export async function resumeWorkflowAfterQuestionnaire(ctx: AppContext, questionnaireId: string): Promise<void> {
  const questionnaire = await ctx.questionnaires.get(questionnaireId);
  if (!questionnaire || questionnaire.status !== 'answered' || !questionnaire.workflowId) return;
  const workflow = requireWorkflow(ctx, questionnaire.workflowId);
  if (workflow.status !== 'awaiting_questions' || workflow.questionnaireId !== questionnaire.id) return;
  const answers = questionnaire.questions.map((question) => {
    const answer = questionnaire.answers?.[question.id];
    return `- ${question.prompt}：${Array.isArray(answer) ? answer.join('、') : answer ?? '(未答)'}`;
  }).join('\n');
  const transitioned = await ctx.workflows.updateIfStatus(workflow.id, 'awaiting_questions', {
    status: 'ready',
    questionnaireId: questionnaire.id,
    priorOutputs: { ...workflow.priorOutputs, clarification: answers },
    error: undefined,
  });
  if (!transitioned || transitioned.questionnaireId !== questionnaire.id) return;
  await continueDeliveryWorkflow(ctx, transitioned.id);
}

/** 原子确认 Spec，并把交付工作流推进到云文档评审等待。 */
export async function confirmSpecForReview(ctx: AppContext, specId: string) {
  const spec = ctx.specs.get(specId);
  if (!spec) throw new Error(`Spec 不存在: ${specId}`);
  if (!spec.workflowId) throw new Error(`Spec ${spec.id} 没有关联交付工作流。`);
  assertSpecRequirementIds(spec);
  const workflow = requireWorkflow(ctx, spec.workflowId);
  if (workflow.status !== 'awaiting_spec_confirmation' || workflow.specId !== spec.id) {
    throw new Error('交付工作流不在方案确认节点。');
  }
  const confirmed = await ctx.specs.updateIfStatus(spec.id, 'pending_confirmation', {
    status: 'confirmed',
    confirmationFeedback: undefined,
  });
  if (!confirmed) throw new Error(`Spec 当前状态为 ${ctx.specs.get(spec.id)?.status ?? 'unknown'}，无法重复确认。`);
  try {
    const transitioned = await ctx.workflows.updateIfStatus(workflow.id, 'awaiting_spec_confirmation', {
      status: 'awaiting_doc_review',
      error: undefined,
    });
    if (!transitioned || transitioned.specId !== confirmed.id) {
      throw new Error('交付工作流状态已变化，方案确认未生效。');
    }
    return confirmed;
  } catch (error) {
    await ctx.specs.updateIfStatus(confirmed.id, 'confirmed', { status: 'pending_confirmation' })
      .catch((rollbackError) => {
        console.error(`[工作流] 回滚 Spec ${confirmed.id} 确认状态失败:`, sanitizeErrorForLog(rollbackError));
      });
    throw error;
  }
}

/** 确认方案并直接进入技术交付，跳过飞书云文档发布与评审。 */
export async function confirmSpecAndStartDelivery(ctx: AppContext, specId: string): Promise<void> {
  const spec = ctx.specs.get(specId);
  if (!spec) throw new Error(`Spec 不存在: ${specId}`);
  if (!spec.workflowId) throw new Error(`Spec ${spec.id} 没有关联交付工作流。`);
  if (spec.status !== 'pending_confirmation' && spec.status !== 'confirmed') {
    throw new Error(`当前 Spec 状态为 ${spec.status}，无法直接进入技术交付。`);
  }
  assertSpecRequirementIds(spec);
  if (parseCanonicalSpecWaivers(spec.content).length > 0) {
    throw new Error('该 Spec 含风险接受条款，必须发布到飞书云文档完成全文评审，不能从截断确认卡直接批准。');
  }
  const workflow = requireWorkflow(ctx, spec.workflowId);
  if (workflow.specId !== spec.id) throw new Error('Spec 与交付工作流关联不一致。');
  const originalWorkflowStatus = workflow.status;
  if (originalWorkflowStatus !== 'awaiting_spec_confirmation' && originalWorkflowStatus !== 'awaiting_doc_review') {
    throw new Error(`工作流当前状态为 ${originalWorkflowStatus}，无法直接进入技术交付。`);
  }
  const approved = await ctx.specs.updateIfStatus(spec.id, spec.status, {
    status: 'approved',
    confirmationFeedback: undefined,
  });
  if (!approved) throw new Error(`Spec 当前状态为 ${ctx.specs.get(spec.id)?.status ?? 'unknown'}，无法重复确认。`);
  let activated = false;
  try {
    await activateApprovedSpecWorkflow(ctx, approved, workflow, originalWorkflowStatus);
    activated = true;
    await continueDeliveryWorkflow(ctx, workflow.id);
  } catch (error) {
    if (!activated) {
      await ctx.specs.updateIfStatus(approved.id, 'approved', { status: spec.status })
        .catch((rollbackError) => {
          console.error(`[工作流] 回滚 Spec ${approved.id} 审批状态失败:`, sanitizeErrorForLog(rollbackError));
        });
    }
    throw error;
  }
}

/** 记录退回意见并把工作流安全地放回 PM 步骤；调用方再异步启动该步骤。 */
export async function rejectSpecConfirmation(
  ctx: AppContext,
  specId: string,
  feedback: string,
): Promise<{ spec: ProductSpec; workflowId: string }> {
  const normalized = feedback.trim();
  if (!normalized) throw new Error('退回修改时请填写具体意见。');
  if (normalized.length > 4_000) throw new Error('退回意见不能超过 4000 字。');
  const spec = ctx.specs.get(specId);
  if (!spec) throw new Error(`Spec 不存在: ${specId}`);
  if (!spec.workflowId) throw new Error(`Spec ${spec.id} 没有关联交付工作流。`);
  const workflow = requireWorkflow(ctx, spec.workflowId);
  if (workflow.status !== 'awaiting_spec_confirmation' || workflow.specId !== spec.id) {
    throw new Error('交付工作流不在方案确认节点。');
  }
  const changed = await ctx.specs.updateIfStatus(spec.id, 'pending_confirmation', {
    status: 'changes_requested',
    confirmationFeedback: normalized,
  });
  if (!changed) throw new Error(`Spec 当前状态为 ${ctx.specs.get(spec.id)?.status ?? 'unknown'}，无法重复退回。`);
  try {
    const transitioned = await prepareWorkflowForSpecRevision(ctx, changed, normalized, [], 'awaiting_spec_confirmation');
    if (!transitioned) throw new Error('交付工作流状态已变化，方案退回未生效。');
    return { spec: changed, workflowId: workflow.id };
  } catch (error) {
    await ctx.specs.updateIfStatus(changed.id, 'changes_requested', {
      status: 'pending_confirmation',
      confirmationFeedback: undefined,
    }).catch((rollbackError) => {
      console.error(`[工作流] 回滚 Spec ${changed.id} 退回状态失败:`, sanitizeErrorForLog(rollbackError));
    });
    throw error;
  }
}

/** Spec 被退回时回到 PM 步骤，根据确认意见生成同一份 Spec 的修订版。 */
export async function resumeWorkflowForSpecRevision(
  ctx: AppContext,
  specId: string,
  feedback: string,
  commentIds: string[] = [],
): Promise<void> {
  const spec = ctx.specs.get(specId);
  if (!spec?.workflowId || spec.status !== 'changes_requested') return;
  const workflow = requireWorkflow(ctx, spec.workflowId);
  const transitioned = await prepareWorkflowForSpecRevision(
    ctx,
    spec,
    feedback,
    commentIds,
    'awaiting_doc_review',
  );
  if (!transitioned) return;
  await continueDeliveryWorkflow(ctx, workflow.id);
}

async function prepareWorkflowForSpecRevision(
  ctx: AppContext,
  spec: ProductSpec,
  feedback: string,
  commentIds: string[],
  expectedStatus: DeliveryWorkflow['status'] | readonly DeliveryWorkflow['status'][],
): Promise<DeliveryWorkflow | undefined> {
  if (!spec.workflowId) return undefined;
  const workflow = requireWorkflow(ctx, spec.workflowId);
  if (workflow.specId !== spec.id) throw new Error('Spec 与交付工作流关联不一致。');
  const pmIndex = workflow.stepIds.indexOf('pm');
  if (pmIndex < 0) throw new Error('当前工作流没有产品经理步骤。');
  return ctx.workflows.updateIfStatus(workflow.id, expectedStatus, {
    status: 'ready',
    nextStepIndex: pmIndex,
    priorOutputs: {
      ...workflow.priorOutputs,
      previous_spec: spec.content,
      confirmation_feedback: feedback,
      ...(commentIds.length > 0 ? { review_comment_ids: commentIds.join(',') } : {}),
    },
    error: undefined,
  });
}

/** 产品评审通过后，启动架构、开发、评审、QA、运行时审计和最终审查。 */
export async function resumeWorkflowAfterProductReview(ctx: AppContext, specId: string): Promise<void> {
  const spec = ctx.specs.get(specId);
  if (!spec) throw new Error(`Spec 不存在: ${specId}`);
  if (!spec.workflowId) throw new Error(`Spec ${spec.id} 没有关联交付工作流。`);
  if (spec.status !== 'approved') throw new Error(`Spec ${spec.id} 尚未通过产品评审。`);
  assertSpecRequirementIds(spec);
  const workflow = requireWorkflow(ctx, spec.workflowId);
  if (workflow.status !== 'awaiting_doc_review' || workflow.specId !== spec.id) {
    throw new Error(`工作流当前状态为 ${workflow.status}，无法启动内部交付小队。`);
  }
  await activateApprovedSpecWorkflow(ctx, spec, workflow, 'awaiting_doc_review');
  await continueDeliveryWorkflow(ctx, workflow.id);
}

/** 在工作流存储锁内切换 canonical Spec 并取得项目级技术交付租约。 */
async function activateApprovedSpecWorkflow(
  ctx: AppContext,
  spec: ProductSpec,
  workflow: DeliveryWorkflow,
  expectedStatus: DeliveryWorkflow['status'] | readonly DeliveryWorkflow['status'][],
): Promise<DeliveryWorkflow> {
  assertSpecRequirementIds(spec);
  if (spec.status !== 'approved') throw new Error(`Spec ${spec.id} 尚未批准。`);
  if (workflow.specId !== spec.id || spec.workflowId !== workflow.id) {
    throw new Error('Spec 与交付工作流关联不一致。');
  }
  const previousCanonical = spec.projectId ? ctx.specs.findCanonical(spec.projectId) : undefined;
  let canonicalChanged = false;
  try {
    const transitioned = await ctx.workflows.activateTechnicalDelivery(
      workflow.id,
      expectedStatus,
      {
        priorOutputs: { ...workflow.priorOutputs, pm: spec.content },
        error: undefined,
      },
      async () => {
        if (ctx.specs.get(spec.id)?.canonical) return;
        await ctx.specs.markCanonical(spec.id);
        canonicalChanged = true;
      },
    );
    if (!transitioned || transitioned.specId !== spec.id) {
      throw new Error(`工作流当前状态为 ${ctx.workflows.get(workflow.id)?.status ?? 'unknown'}，无法启动内部交付。`);
    }
    return transitioned;
  } catch (error) {
    if (canonicalChanged) {
      if (previousCanonical && previousCanonical.id !== spec.id) {
        await ctx.specs.markCanonical(previousCanonical.id).catch((rollbackError) => {
          console.error('[工作流] 回滚规范版本失败:', sanitizeErrorForLog(rollbackError));
        });
      } else {
        await ctx.specs.clearCanonical(spec.id).catch((rollbackError) => {
          console.error('[工作流] 回滚规范版本失败:', sanitizeErrorForLog(rollbackError));
        });
      }
    }
    throw error;
  }
}

/** 服务重启后恢复尚未进入人工等待节点的流水线。 */
export async function resumeRecoverableWorkflows(ctx: AppContext): Promise<void> {
  await reconcileWorkflowSchedules(ctx);
  await reconcileWorkflowTopicCliIds(ctx);
  await reconcileWorkflowSpecStates(ctx);
  for (const workflow of ctx.workflows.listRecoverable()) {
    try {
      if (workflow.status === 'executing') {
        await ctx.workflows.update(workflow.id, {
          status: 'ready',
          error: '上次执行被服务重启中断，本次将从当前步骤重新检查并继续。',
        });
      }
      await continueDeliveryWorkflow(ctx, workflow.id);
    } catch (error) {
      await failWorkflow(ctx, workflow.id, `恢复失败：${(error as Error).message}`).catch((failError) => {
        console.error(`[工作流] ${workflow.id} 保存恢复失败状态异常:`, sanitizeErrorForLog(failError));
      });
    }
  }
}

/** 服务升级后，为所有尚未结束的旧工作流补齐话题级引擎并对齐已有角色。 */
export async function reconcileWorkflowTopicCliIds(ctx: AppContext): Promise<void> {
  const handledTopics = new Set<string>();
  const workflows = ctx.workflows.list()
    .filter((workflow) => workflow.status !== 'completed' && workflow.status !== 'failed')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const workflow of workflows) {
    const msg = messageForWorkflow(ctx, workflow);
    const key = `${msg.chatId}:${topicIdOf(msg)}`;
    if (handledTopics.has(key)) continue;
    await ensureWorkflowTopicCliId(ctx, workflow, msg);
    handledTopics.add(key);
  }
}

/** 修复 Spec 与工作流分文件写入之间的进程中断窗口。 */
export async function reconcileWorkflowSpecStates(ctx: AppContext): Promise<void> {
  for (const workflow of ctx.workflows.list()) {
    if (!workflow.specId) continue;
    try {
      const spec = ctx.specs.get(workflow.specId);
      if (!spec || spec.workflowId !== workflow.id) {
        throw new Error(`工作流 ${workflow.id} 的 Spec 关联损坏。`);
      }
      // 兼容修复前已经落库的“伪 Spec”：这类内容通常是 MCP 被拒后由 PM 内联输出的
      // 澄清问题。启动时自动退回同一个 PM 步骤；修订提示会要求重新创建结构化问卷，
      // 不再让用户点击确认后才撞稳定需求 ID 门禁。
      if (workflow.status === 'awaiting_spec_confirmation' && spec.status === 'pending_confirmation') {
        let validationError: unknown;
        try {
          assertSpecRequirementIds(spec);
        } catch (error) {
          validationError = error;
        }
        if (validationError) {
          const feedback = [
            '系统自动退回：上一版内容不符合可确认产品 Spec 契约，不能进入人工确认。',
            `校验原因：${persistentErrorMessage(validationError, 2_000)}`,
            '如果上一版包含尚未回答的澄清问题，请使用 propose_questions 生成飞书结构化问卷；答案充分后再输出带稳定需求 ID 的完整 Spec。',
          ].join('\n');
          await rejectSpecConfirmation(ctx, spec.id, feedback);
          console.warn(`[工作流] ${workflow.id} 已自动退回无效待确认 Spec ${spec.id} 给产品经理。`);
          continue;
        }
      }
      // 修复“Spec 已批准，但 canonical 切换或工作流推进尚未落盘”的崩溃窗口。
      // approved 已是人工决策终态，可安全幂等地补齐 canonical 并直接恢复技术交付。
      if (
        (workflow.status === 'awaiting_spec_confirmation' || workflow.status === 'awaiting_doc_review')
        && spec.status === 'approved'
      ) {
        assertSpecRequirementIds(spec);
        await activateApprovedSpecWorkflow(ctx, spec, workflow, workflow.status);
        continue;
      }
      if (
        workflow.status === 'awaiting_spec_confirmation'
        && (spec.status === 'confirmed' || spec.status === 'published' || spec.status === 'in_review')
      ) {
        await ctx.workflows.updateIfStatus(workflow.id, 'awaiting_spec_confirmation', {
          status: 'awaiting_doc_review',
          error: undefined,
        });
        continue;
      }
      if (workflow.status === 'awaiting_spec_confirmation' && spec.status === 'changes_requested' && spec.confirmationFeedback) {
        await prepareWorkflowForSpecRevision(
          ctx,
          spec,
          spec.confirmationFeedback,
          [],
          'awaiting_spec_confirmation',
        );
        continue;
      }
      if (workflow.status === 'awaiting_doc_review' && spec.status === 'changes_requested') {
        const comments = spec.comments.filter((comment) => !comment.resolved);
        if (comments.length > 0) {
          await prepareWorkflowForSpecRevision(
            ctx,
            spec,
            comments.map((comment) => `- ${comment.content.slice(0, 2_000)}`).join('\n'),
            comments.map((comment) => comment.id),
            'awaiting_doc_review',
          );
        }
        continue;
      }
    } catch (error) {
      const message = `Spec 状态恢复失败：${persistentErrorMessage(error, 4_000)}`;
      console.error(`[工作流] ${workflow.id} ${message}`);
      // 单份历史坏数据必须 fail closed，但不能阻断其他健康工作流的恢复。
      await failWorkflow(ctx, workflow.id, message).catch((failError) => {
        console.error(`[工作流] ${workflow.id} 保存 Spec 恢复失败状态异常:`, sanitizeErrorForLog(failError));
      });
    }
  }
}

async function assertRuntimeSourceCurrent(ctx: AppContext): Promise<void> {
  await (ctx.runtimeSourceGuard ?? processRuntimeSourceGuard).assertCurrent();
}

/**
 * 源码漂移属于运行中控制器失效，不是业务项目缺陷。只原子暂停当前非 PM 步骤，
 * 不读取/改绑工作目录，也不结算审批或定时任务；新进程可从同一步 retry。
 */
export async function pauseForRuntimeSourceChangeIfNeeded(
  ctx: AppContext,
  workflowId: string,
  error: unknown,
  expectedStep?: WorkflowStepExpectation,
): Promise<boolean> {
  if (!expectedStep || expectedStep.stepId === 'pm') return false;
  let sourceError = error;
  if (!isRuntimeSourceChangedError(sourceError)) {
    try {
      await assertRuntimeSourceCurrent(ctx);
      return false;
    } catch (currentError) {
      if (!isRuntimeSourceChangedError(currentError)) return false;
      sourceError = currentError;
    }
  }
  const workflow = ctx.workflows.get(workflowId);
  if (!workflow || workflow.qualityPolicy !== 'gated') return false;
  const detail = persistentErrorMessage(sourceError, 4_000);
  const atCompletionBoundary = workflow.status === 'executing'
    && workflow.nextStepIndex === workflow.stepIds.length
    && expectedStep.stepIndex === workflow.nextStepIndex - 1;
  const nextPriorOutputs = {
    ...workflow.priorOutputs,
    runtime_source_changed: RUNTIME_SOURCE_RESTART_MESSAGE,
    [`blocked_${expectedStep.stepId}`]: detail,
  };
  // summary 已提交但最终结算尚未完成时，原子退回 summary；旧 summary 不能跨重启复用。
  if (atCompletionBoundary) delete nextPriorOutputs[expectedStep.stepId];
  const pausePatch = {
    status: 'awaiting_step_unblock' as const,
    ...(atCompletionBoundary ? { nextStepIndex: expectedStep.stepIndex } : {}),
    priorOutputs: nextPriorOutputs,
    error: detail,
  };
  const paused = atCompletionBoundary
    ? await ctx.workflows.updateIfStatus(workflowId, 'executing', pausePatch)
    : await ctx.workflows.updateIfCurrentStep(
      workflowId,
      expectedStep.stepIndex,
      expectedStep.stepId,
      pausePatch,
    );
  // 迟到的同类错误不应把已经暂停/推进的工作流再覆盖成 failed。
  if (!paused) return true;

  console.warn(`[工作流] ${workflowId} 检测到运行时源码漂移，已暂停 ${expectedStep.stepId}。`);
  const initiator = ctx.botsById.get(paused.initiatorBotId);
  if (!initiator) return true;
  const msg = messageForWorkflow(ctx, paused);
  const stepTitle = stepsFor(paused)[expectedStep.stepIndex]?.title ?? expectedStep.stepId;
  let cardSent = true;
  await initiator.replyCard(
    msg.messageId,
    buildStepBlockedCard({
      workflowId,
      stepId: expectedStep.stepId,
      stepTitle,
      reason: detail,
      blockKind: 'other',
      blockVersion: paused.updatedAt,
    }),
    hasThread(msg),
  ).catch((cardError) => {
    cardSent = false;
    console.error(`[${paused.name}] 源码漂移阻塞卡发送失败:`, sanitizeErrorForLog(cardError));
  });
  if (!cardSent) {
    await initiator.reply(
      msg.messageId,
      `${detail}\n流水线已暂停在当前步骤；重启 Agent OS 后重试。`,
      hasThread(msg),
    ).catch(() => undefined);
  }
  return true;
}

async function failWorkflow(
  ctx: AppContext,
  workflowId: string,
  error: string,
  expectedStep?: WorkflowStepExpectation,
): Promise<void> {
  const normalizedError = persistentErrorMessage(error, 10_000);
  const failed = expectedStep
    ? await ctx.workflows.updateIfCurrentStep(
      workflowId,
      expectedStep.stepIndex,
      expectedStep.stepId,
      { status: 'failed', error: normalizedError },
    )
    : await ctx.workflows.updateIfStatus(
      workflowId,
      [
        'ready',
        'executing',
        'awaiting_questions',
        'awaiting_spec_confirmation',
        'awaiting_doc_review',
        'awaiting_step_unblock',
        'paused',
      ],
      { status: 'failed', error: normalizedError },
    );
  if (!failed) return;
  const initiator = ctx.botsById.get(failed.initiatorBotId);
  if (initiator) {
    const msg = messageForWorkflow(ctx, failed);
    await initiator.reply(msg.messageId, `${failed.name}已停止：${normalizedError}`, hasThread(msg)).catch(() => undefined);
  }
  await settleWorkflowApproval(ctx, failed, 'failed', normalizedError);
  await settleWorkflowSchedule(ctx, failed, 'failed', normalizedError);
}

async function settleWorkflowApproval(
  ctx: AppContext,
  workflow: DeliveryWorkflow,
  outcome: 'succeeded' | 'failed',
  error?: string,
): Promise<void> {
  if (!workflow.approvalId || !workflow.approvalAttempt) return;
  await finishApprovalExecution(
    ctx,
    workflow.approvalId,
    workflow.approvalAttempt,
    outcome,
    error,
  ).catch((settleError) => {
    console.error(`[审批] 工作流 ${workflow.id} 回写失败:`, sanitizeErrorForLog(settleError));
  });
}

async function settleWorkflowSchedule(
  ctx: AppContext,
  workflow: DeliveryWorkflow,
  outcome: 'succeeded' | 'failed',
  error?: string,
): Promise<void> {
  if (!workflow.scheduleJobId || !workflow.scheduleRunCount) return;
  const job = ctx.schedules.get(workflow.scheduleJobId);
  if (!job || job.lastStatus !== 'running' || job.runCount !== workflow.scheduleRunCount) return;
  await ctx.schedules.finishRun(
    job.id,
    outcome,
    outcome === 'failed' ? (error?.trim() || '交付工作流执行失败') : undefined,
    new Date(),
    workflow.scheduleRunCount,
  ).catch((settleError) => {
    console.error(`[定时任务] 工作流 ${workflow.id} 结算失败:`, sanitizeErrorForLog(settleError));
  });
}

function persistentErrorMessage(error: unknown, maxChars: number): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSecrets(message).trim() || '工作流执行失败';
  return redacted.slice(-maxChars);
}

export async function reconcileWorkflowSchedules(ctx: AppContext): Promise<void> {
  for (const workflow of ctx.workflows.list()) {
    if (!workflow.scheduleJobId || !workflow.scheduleRunCount) continue;
    await ctx.schedules.restoreInterruptedRun(workflow.scheduleJobId, workflow.scheduleRunCount);
    if (workflow.status === 'completed') {
      await settleWorkflowSchedule(ctx, workflow, 'succeeded');
    } else if (workflow.status === 'failed') {
      await settleWorkflowSchedule(ctx, workflow, 'failed', workflow.error);
    }
  }
}

async function pauseWorkflowForStepBlock(
  ctx: AppContext,
  workflowId: string,
  stepIndex: number,
  stepId: PipelineStep['id'],
  stepTitle: string,
  answer: string,
  reason?: string,
): Promise<void> {
  const workflow = requireWorkflow(ctx, workflowId);
  const msg = messageForWorkflow(ctx, workflow);
  const initiator = ctx.botsById.get(workflow.initiatorBotId);
  const blockReason = reason?.trim() || '步骤报告阻塞，需人工纠正后重试';
  const reasonKind = classifyStepBlockReason(blockReason);
  const blockKind = reasonKind === 'other' ? classifyStepBlockReason(answer) : reasonKind;
  const testResourceAuthorizationAvailable = requiresTestResourceAuthorization(
    `${blockReason}\n${answer}`,
  );
  // 只有明确的目录阻塞才从回答抽路径；环境报告中的项目路径不能变成“建议绑定目录”。
  const suggestedWorkdir = blockKind === 'workdir'
    ? await firstBindableWorkdir([
      ...extractAbsolutePathCandidates(answer),
      ...extractAbsolutePathCandidates(workflow.goal),
    ])
    : undefined;
  const nextPrior = {
    ...workflow.priorOutputs,
    [`blocked_${stepId}`]: compactAgentOutput(answer, 6_000),
  };
  if (suggestedWorkdir) nextPrior.blocked_workdir = suggestedWorkdir;
  else delete nextPrior.blocked_workdir;
  const paused = await ctx.workflows.updateIfCurrentStep(workflowId, stepIndex, stepId, {
    status: 'awaiting_step_unblock',
    priorOutputs: nextPrior,
    error: blockReason,
  });
  if (!paused || !initiator) return;
  let cardSent = true;
  await initiator.replyCard(
    msg.messageId,
    buildStepBlockedCard({
      workflowId,
      stepId,
      stepTitle,
      reason: blockReason,
      suggestedWorkdir,
      blockKind,
      testResourceAuthorizationAvailable,
      blockVersion: paused.updatedAt,
    }),
    hasThread(msg),
  ).catch((error) => {
    cardSent = false;
    console.error(`[${paused.name}] 阻塞卡发送失败:`, sanitizeErrorForLog(error));
  });
  // 卡片成功就不再发文本，避免「阻塞卡 + 同内容文本」双提示；失败时才文本兜底。
  if (!cardSent) {
    await initiator.reply(
      msg.messageId,
      [
        `步骤「${stepTitle}」已阻塞，流水线暂停：${blockReason}`,
        suggestedWorkdir
          ? `建议目录：${suggestedWorkdir}`
          : blockKind === 'environment' || blockKind === 'test-resource'
            ? testResourceAuthorizationAvailable
              ? '请准备本机测试环境；确认测试库完全隔离后，可在阻塞卡中授权本流水线重试'
              : '请准备本机测试环境后重试'
            : blockKind === 'gate-evidence'
              ? '请补齐或重新生成当前步骤的 Gate/artifact 证据'
              : blockKind === 'orchestration'
                ? '请等 Cursor/引擎配额或探活恢复后重试当前步骤，不要退回开发改代码'
                : '请解决上述前置条件',
        `用 \`/workflow retry ${workflowId}\` 重新发送阻塞卡。`,
      ].join('\n'),
      hasThread(msg),
    ).catch(() => undefined);
  }
}

async function restoreMisroutedEnvironmentBlock(
  ctx: AppContext,
  workflow: DeliveryWorkflow,
): Promise<{ workflow: DeliveryWorkflow; restored: boolean }> {
  const currentStepId = workflow.stepIds[workflow.nextStepIndex];
  const misrouted = findMisroutedEnvironmentBlock(currentStepId, workflow.priorOutputs);
  if (!misrouted || workflow.status !== 'awaiting_step_unblock') {
    return { workflow, restored: false };
  }
  const sourceIndex = workflow.stepIds.indexOf(misrouted.sourceStepId);
  if (sourceIndex < 0) return { workflow, restored: false };
  const nextPrior = { ...workflow.priorOutputs };
  delete nextPrior.quality_fix_request;
  delete nextPrior.blocked_workdir;
  const restored = await ctx.workflows.updateIfStatus(workflow.id, 'awaiting_step_unblock', {
    nextStepIndex: sourceIndex,
    priorOutputs: nextPrior,
    error: misrouted.reason,
  });
  if (!restored) return { workflow: requireWorkflow(ctx, workflow.id), restored: false };
  console.warn(`[工作流] 已纠正历史环境阻塞误移交：${currentStepId} → ${misrouted.sourceStepId}`);
  return { workflow: restored, restored: true };
}

/** 重新发送阻塞卡（用于 /workflow retry 或卡片发送失败后的恢复）。 */
export async function resendBlockedCard(
  ctx: AppContext,
  workflowId: string,
): Promise<void> {
  let workflow = requireWorkflow(ctx, workflowId);
  if (workflow.status !== 'awaiting_step_unblock') {
    throw new Error(`工作流当前状态为 ${workflow.status}，不在阻塞等待中。`);
  }
  if (workflow.priorOutputs.runtime_source_changed === undefined) {
    ({ workflow } = await restoreMisroutedEnvironmentBlock(ctx, workflow));
  }
  const msg = messageForWorkflow(ctx, workflow);
  const initiator = ctx.botsById.get(workflow.initiatorBotId);
  if (!initiator) throw new Error(`发起 Bot 未连接：${workflow.initiatorBotId}`);
  const stepIndex = workflow.nextStepIndex;
  const steps = stepsFor(workflow);
  const step = steps[stepIndex];
  const blockReason = workflow.error || '步骤报告阻塞，需人工纠正后重试';
  const blockedAnswer = workflow.priorOutputs[`blocked_${step.id}`] || '';
  const reasonKind = classifyStepBlockReason(blockReason);
  const blockKind = reasonKind === 'other' ? classifyStepBlockReason(blockedAnswer) : reasonKind;
  const testResourceAuthorizationAvailable = requiresTestResourceAuthorization(
    `${blockReason}\n${blockedAnswer}`,
  );
  const suggestedWorkdir = blockKind === 'workdir'
    ? workflow.priorOutputs.blocked_workdir || undefined
    : undefined;
  await initiator.replyCard(
    msg.messageId,
    buildStepBlockedCard({
      workflowId,
      stepId: step.id,
      stepTitle: step.title,
      reason: blockReason,
      ...(suggestedWorkdir ? { suggestedWorkdir } : {}),
      blockKind,
      testResourceAuthorizationAvailable,
      blockVersion: workflow.updatedAt,
    }),
    hasThread(msg),
  ).catch((error) => {
    console.error(`[工作流] 重发阻塞卡失败:`, sanitizeErrorForLog(error));
  });
}

/** 纠正目录后重跑同一步（不推进 nextStepIndex）。 */
export async function resumeBlockedWorkflowStep(
  ctx: AppContext,
  workflowId: string,
  options?: { workdir?: string; authorizeTestResource?: boolean },
): Promise<DeliveryWorkflow> {
  let workflow = requireWorkflow(ctx, workflowId);
  if (workflow.status !== 'awaiting_step_unblock') {
    throw new Error(`工作流当前状态为 ${workflow.status}，不能重试阻塞步骤。`);
  }
  const runtimeSourceBlocked = workflow.priorOutputs.runtime_source_changed !== undefined;
  // 在任何业务项目目录解析/绑定之前校验；同一个陈旧进程只能继续保持暂停。
  if (runtimeSourceBlocked) await assertRuntimeSourceCurrent(ctx);
  const normalized = runtimeSourceBlocked
    ? { workflow, restored: false }
    : await restoreMisroutedEnvironmentBlock(ctx, workflow);
  workflow = normalized.workflow;
  const currentStepId = workflow.stepIds[workflow.nextStepIndex];
  const blockedAnswer = workflow.priorOutputs[`blocked_${currentStepId}`] || '';
  if (
    options?.authorizeTestResource
    && !requiresTestResourceAuthorization(`${workflow.error || ''}\n${blockedAnswer}`)
  ) {
    throw new Error('当前阻塞不涉及破坏性测试资源，不能附加该授权。');
  }
  const msg = messageForWorkflow(ctx, workflow);
  // 历史错误卡可能携带从 QA 报告误抽取的目录；纠正游标后必须忽略它。
  const requestedWorkdir = !normalized.restored && options?.workdir
    ? await assertWorkdir(options.workdir)
    : undefined;
  const currentBinding = requestedWorkdir ?? ctx.topics.getWorkdir(msg.chatId, topicIdOf(msg));
  if (workflow.qualityPolicy === 'gated' && currentBinding !== workflow.projectRoot) {
    throw new Error('门禁工作流不能在中途切换项目目录；请在正确目录重新发起交付。');
  }
  // 先原子认领：防止并发重试两个按钮都通过前置检查再改目录
  const resumed = runtimeSourceBlocked
    ? await ctx.workflows.resumeCurrentRuntimeSourceBlock(
      workflowId,
      workflow.nextStepIndex,
      currentStepId,
    )
    : await ctx.workflows.updateIfStatus(workflowId, 'awaiting_step_unblock', {
      status: 'ready',
      error: undefined,
      ...(options?.authorizeTestResource ? {
        priorOutputs: {
          ...workflow.priorOutputs,
          test_resource_authorized: 'true',
        },
      } : {}),
    });
  if (!resumed) throw new Error('工作流状态已变化，请刷新后重试。');

  // 原子认领成功后再切目录；失败也不会影响已认领的状态
  if (requestedWorkdir) {
    await ctx.sessions.clearCliContextForTopic(msg.chatId, topicIdOf(msg));
    await ctx.topics.setWorkdir(msg.chatId, topicIdOf(msg), requestedWorkdir);
  }
  await continueDeliveryWorkflow(ctx, resumed.id);
  return requireWorkflow(ctx, resumed.id);
}

/** 用户点停止后暂停流水线；不进入 failed，也不进入可自动恢复集合。 */
export function workflowHasLiveCli(ctx: AppContext, workflowId: string): boolean {
  // 以 activeRuns 是否仍持有该工作流为准：abort 之后进程组可能还在写盘，
  // 不能只看 signal.aborted，否则 /workflow retry 会叠跑。
  return [...ctx.activeRuns.values()].some((run) => run.workflowId === workflowId);
}

export function userStopResumeHint(workflowId: string): string {
  return [
    '流水线已暂停，不会自动继续。',
    `需要从当前步骤恢复时，发送：/workflow retry ${workflowId}`,
  ].join('\n');
}

export async function pauseWorkflowOnUserStop(
  ctx: AppContext,
  workflowId: string,
): Promise<DeliveryWorkflow> {
  const current = requireWorkflow(ctx, workflowId);
  if (current.status === 'paused') return current;
  if (current.status !== 'executing') {
    throw new Error(`无法暂停：工作流当前状态为 ${current.status}，不是 executing`);
  }
  const paused = await ctx.workflows.updateIfStatus(workflowId, 'executing', {
    status: 'paused',
    error: '用户停止了当前步骤，流水线已暂停，不会自动继续。',
  });
  if (!paused) {
    throw new Error(
      `无法暂停：工作流当前状态为 ${ctx.workflows.get(workflowId)?.status ?? 'unknown'}，停止指令未能落地`,
    );
  }
  return paused;
}

export async function resumePausedOrOrphanedWorkflow(
  ctx: AppContext,
  workflowId: string,
): Promise<DeliveryWorkflow> {
  const workflow = requireWorkflow(ctx, workflowId);
  const orphanedExecuting = workflow.status === 'executing' && !workflowHasLiveCli(ctx, workflowId);
  if (workflow.status !== 'paused' && !orphanedExecuting) {
    throw new Error(`工作流当前状态为 ${workflow.status}，不在暂停中。`);
  }
  if (workflowHasLiveCli(ctx, workflowId)) {
    throw new Error('当前步骤的 CLI 仍在退出，请稍后再发送 /workflow retry。');
  }
  const currentStepId = workflow.stepIds[workflow.nextStepIndex];
  const misrouted = findMisroutedEnvironmentBlock(currentStepId, workflow.priorOutputs);
  const sourceIndex = misrouted ? workflow.stepIds.indexOf(misrouted.sourceStepId) : -1;
  const nextPrior = { ...workflow.priorOutputs };
  if (misrouted) {
    delete nextPrior.quality_fix_request;
    delete nextPrior.blocked_workdir;
  }
  const restored = await ctx.workflows.updateIfStatus(
    workflowId,
    workflow.status,
    {
      status: 'ready',
      error: undefined,
      ...(misrouted && sourceIndex >= 0 ? {
        nextStepIndex: sourceIndex,
        priorOutputs: nextPrior,
      } : {}),
    },
  );
  if (!restored) {
    throw new Error(`工作流当前状态为 ${ctx.workflows.get(workflowId)?.status ?? 'unknown'}，无法从暂停恢复。`);
  }
  if (misrouted && sourceIndex >= 0) {
    console.warn(`[工作流] 暂停恢复时纠正误移交：${currentStepId} → ${misrouted.sourceStepId}`);
  }
  return restored;
}

export async function abortBlockedWorkflow(
  ctx: AppContext,
  workflowId: string,
  reason = '用户终止流水线',
): Promise<DeliveryWorkflow> {
  const workflow = requireWorkflow(ctx, workflowId);
  // 支持任意非终态状态的终止（含 paused），不只是 awaiting_step_unblock。
  const terminalStatuses = new Set(['completed', 'failed']);
  if (terminalStatuses.has(workflow.status)) {
    throw new Error(`工作流当前状态为 ${workflow.status}，无需终止。`);
  }
  for (const run of ctx.activeRuns.values()) {
    if (run.workflowId !== workflowId) continue;
    run.cancelMode = 'stop';
    run.interruptReason = reason;
    if (!run.controller.signal.aborted) run.controller.abort();
  }
  await failWorkflow(ctx, workflowId, reason);
  const after = requireWorkflow(ctx, workflowId);
  if (after.status !== 'failed') {
    throw new Error(`无法终止：工作流当前状态为 ${after.status}。`);
  }
  return after;
}

async function firstBindableWorkdir(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      return await assertWorkdir(candidate);
    } catch {
      // 路径不存在或不在白名单时跳过，交给用户显式 /workdir。
    }
  }
  return undefined;
}

function requireWorkflow(ctx: AppContext, id: string): DeliveryWorkflow {
  const workflow = ctx.workflows.get(id);
  if (!workflow) throw new Error(`工作流不存在: ${id}`);
  return workflow;
}

function stepsFor(workflow: DeliveryWorkflow): PipelineStep[] {
  return workflow.stepIds.map((id) => {
    const step = DEFAULT_PIPELINE_STEPS.find((candidate) => candidate.id === id);
    if (!step) throw new Error(`未知工作流步骤: ${id}`);
    return step;
  });
}

function storedMessage(msg: IncomingMessage): DeliveryWorkflow['message'] {
  return {
    messageId: msg.messageId,
    topicId: topicIdOf(msg),
    chatId: msg.chatId,
    chatType: msg.chatType,
    rootId: msg.rootId,
    threadId: msg.threadId,
    senderOpenId: msg.senderOpenId,
  };
}

function messageForWorkflow(ctx: AppContext, workflow: DeliveryWorkflow): IncomingMessage {
  const scheduledMessage = workflow.scheduleJobId
    ? ctx.schedules.get(workflow.scheduleJobId)?.message
    : undefined;
  return {
    ...workflow.message,
    topicId: workflow.message.topicId
      || scheduledMessage?.topicId
      || scheduledMessage?.threadId
      || scheduledMessage?.rootId
      || scheduledMessage?.messageId,
    messageType: 'text',
    text: '',
    senderType: 'user',
    mentions: [],
    rawContent: JSON.stringify({ text: '' }),
  };
}

function hasThread(msg: IncomingMessage): boolean {
  return !!msg.threadId || !!msg.rootId;
}
