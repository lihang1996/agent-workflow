import { getAdapter } from '../cli/registry.js';
import { formatEngineChoices, formatEngineIds, isCliId } from '../cli/types.js';
import { parseCommand } from '../core/command-parser.js';
import {
  buildHandoffPrompt,
  listHandoffTargets,
  parseHandoffArg,
  resolveHandoffTarget,
} from '../core/handoff.js';
import { collabTopicKey } from '../core/collab.js';
import { requestTaskAbort } from '../core/task-abort.js';
import { assertWorkdir } from '../core/workdir.js';
import { isDeliveryMutationTask } from '../core/delivery-policy.js';
import { qualityRoleRejectsImplementationHandoff } from '../core/role-constitution.js';
import { DEFAULT_PIPELINE_STEPS } from '../core/pipeline.js';
import {
  formatScheduleInterval,
  formatScheduleRunStatus,
  parseScheduleInterval,
  scheduleMatchesTopic,
} from '../core/schedule-store.js';
import {
  assertLogFile,
  redactSecrets,
  sanitizeErrorForLog,
  sanitizeForLog,
} from '../core/log-inspection.js';
import { highRiskReason, isHighRiskTask } from '../core/risk.js';
import {
  assertCanControlOwnedResource,
  assertOwnedBy,
  canControlOwnedResource,
  isAuthorizedOperator,
} from '../core/access.js';
import { IdentityRegistry, type UserIdentity } from '../core/identity-registry.js';
import { resolveMentions } from '../im/message-parser.js';
import { isAddressedToBot, type Bot, type CardAction, type IncomingMessage } from '../im/lark.js';
import {
  buildApprovalCard,
  buildQuestionnaireCard,
  buildSpecConfirmationCard,
  buildSpecReviewCard,
  buildSpecStatusCard,
  buildStepBlockedActionCard,
} from '../im/workflow-card.js';
import type { AppContext } from './app-context.js';
import {
  freezeRunCard,
  interruptedCard,
} from './active-runs.js';
import { startCliTask } from './cli-task.js';
import { runCollabReview } from './collab-runner.js';
import { canonicalSpecHasRiskWaivers, rewindStepIdFromDriftMessage } from '../core/quality-gates.js';
import {
  findMisroutedEnvironmentBlock,
  requiresTestResourceAuthorization,
} from '../core/step-result.js';
import { assertManualWorkflowRetryAllowed } from '../core/workflow-store.js';
import { processRuntimeSourceGuard } from '../core/runtime-source-guard.js';
import {
  abortBlockedWorkflow,
  handOffBlockedWorkflowIfQualityFix,
  resendBlockedCard,
  runDeliverySquad,
  runTeamPipeline,
  confirmSpecForReview,
  confirmSpecAndStartDelivery,
  continueDeliveryWorkflow,
  pauseWorkflowOnUserStop,
  rejectSpecConfirmation,
  resumeBlockedWorkflowStep,
  resumePausedOrOrphanedWorkflow,
  resumeWorkflowAfterQuestionnaire,
  userStopResumeHint,
  workflowHasLiveCli,
} from './pipeline-runner.js';
import { approveSpecReview, publishSpecToDoc, requestSpecChangesFromCard } from './spec-review.js';
import { executeApprovedAction, requestHighRiskApproval } from './approval-runner.js';
import { settleApprovalSchedule } from './approval-status.js';
import {
  ensureRunnableSession,
  formatSessionStatus,
  topicIdOf,
  truncate,
  workdirFor,
} from './sessions.js';

/** 处理单条入站消息：命令或交给 CLI。 */
export async function handleMessage(
  ctx: AppContext,
  msg: IncomingMessage,
  bot: Bot,
): Promise<void> {
  // 进程内交接，不依赖 bot 互发；仍忽略飞书侧非用户消息，避免环路。
  if (msg.senderType && msg.senderType !== 'user') {
    console.log(`[忽略] bot=${bot.id} 非用户消息 senderType=${msg.senderType}`);
    return;
  }
  if (!isAddressedToBot(msg, bot)) {
    console.log(`[忽略] bot=${bot.id} 未被 @`);
    return;
  }
  const operator = messageIdentity(msg);
  const identities = ctx.identities ?? (ctx.identities = new IdentityRegistry());
  await identities.observe(operator);
  if (!isAuthorizedOperator({
    senderOpenId: msg.senderOpenId,
    senderUserId: msg.senderUserId,
    senderUnionId: msg.senderUnionId,
    chatType: msg.chatType,
  }, identities)) {
    console.warn(`[拒绝] bot=${bot.id} 未授权用户 sender=${msg.senderOpenId || '(空)'}`);
    await bot.reply(msg.messageId, '当前用户没有操作这个 Agent OS 的权限。', !!msg.threadId || !!msg.rootId);
    return;
  }

  const resolved = resolveMentions(msg.text, msg.mentions);
  const hasThread = !!msg.threadId || !!msg.rootId;
  const topicId = topicIdOf(msg);
  const preferredCliId = ctx.topics?.getCliId?.(msg.chatId, topicId);
  let { session, isNew } = await ctx.sessions.resolve({
    messageId: msg.messageId,
    topicId,
    chatId: msg.chatId,
    threadId: msg.threadId,
    rootId: msg.rootId,
    botId: bot.id,
  }, preferredCliId);

  console.log(`[收到] bot=${bot.id}(${bot.name}) chat=${msg.chatId} threadId=${msg.threadId} rootId=${msg.rootId} sender=${msg.senderOpenId}`);
  console.log(`  原文: ${sanitizeForLog(msg.text, 500)}`);
  console.log(`  还原: ${sanitizeForLog(resolved, 500)}`);
  console.log(`  mentions: ${sanitizeForLog(msg.mentions.map((m) => `${m.key}=${m.name}(${m.openId})`).join(', ') || '(无)', 500)}`);
  console.log(`  [会话] ${isNew ? '新建' : '复用'} id=${session.id} status=${session.status} engine=${session.cliId}`);

  const command = parseCommand(resolved);
  // 新话题首条消息是命令时不会启动 CLI，先结束 creating 状态，避免后续任务永久被挡住。
  if (command && session.status === 'creating') {
    session = await releaseCreatingSession(ctx, session);
  }
  if (command?.name === 'help') {
    await bot.reply(msg.messageId, buildHelpText(bot), hasThread);
    return;
  }
  if (command?.name === 'status') {
    await bot.reply(msg.messageId, formatSessionStatus(ctx, session, bot, msg), hasThread);
    return;
  }
  if (command?.name === 'workdir') {
    if (!command.arg) {
      const current = ctx.topics.getWorkdir(msg.chatId, topicId);
      const effective = workdirFor(ctx, session, bot, msg);
      await bot.reply(
        msg.messageId,
        [
          `话题项目目录：${current ?? '(未设置)'}`,
          `Bot 默认目录：${bot.workdir ?? '(未配置)'}`,
          `实际工作目录：${effective}`,
          '设置：/workdir /绝对或相对路径',
          '清除：/workdir clear',
        ].join('\n'),
        hasThread,
      );
      return;
    }
    const activePeers = ctx.sessions.listByTopic(msg.chatId, topicId)
      .filter((peer) => peer.status === 'active');
    if (activePeers.length > 0) {
      await bot.reply(
        msg.messageId,
        `本话题仍有角色在执行任务（${activePeers.map((peer) => peer.botId).join('、')}），请全部结束后再切换工作目录。`,
        hasThread,
      );
      return;
    }
    if (command.arg === 'clear' || command.arg === '-') {
      try {
        const hadBinding = !!ctx.topics.getWorkdir(msg.chatId, topicId);
        const cleared = hadBinding
          ? await ctx.sessions.clearCliContextForTopic(msg.chatId, topicId)
          : 0;
        await ctx.topics.clearWorkdir(msg.chatId, topicId);
        console.log(`[项目] bot=${bot.id} 清除话题目录 chat=${msg.chatId} topic=${topicId} clearedCtx=${cleared}`);
        await bot.reply(
          msg.messageId,
          [
            hadBinding ? '已清除本话题项目目录。' : '本话题未设置项目目录。',
            `已清理 ${cleared} 个角色的 CLI 上下文。`,
            `后续将回退到：${workdirFor(ctx, session, bot, msg)}`,
          ].join('\n'),
          hasThread,
        );
      } catch (error) {
        await bot.reply(msg.messageId, (error as Error).message, hasThread);
      }
      return;
    }
    try {
      const absolute = await assertWorkdir(command.arg);
      // 先清旧上下文，再切共享目录；即使目录落盘失败，也不会把旧上下文带到新项目。
      const cleared = await ctx.sessions.clearCliContextForTopic(msg.chatId, topicId);
      await ctx.topics.setWorkdir(msg.chatId, topicId, absolute);
      console.log(`[项目] bot=${bot.id} 话题目录=${absolute} chat=${msg.chatId} topic=${topicId} clearedCtx=${cleared}`);
      await bot.reply(
        msg.messageId,
        [
          `已绑定本话题项目目录：`,
          absolute,
          `同一话题下其他角色将共享此目录。`,
          cleared > 0 ? `已清理 ${cleared} 个角色的旧 CLI 上下文，下次任务将按新目录重新建立。` : '',
        ].filter(Boolean).join('\n'),
        hasThread,
      );
    } catch (error) {
      await bot.reply(msg.messageId, (error as Error).message, hasThread);
    }
    return;
  }
  if (command?.name === 'engine') {
    if (!command.arg) {
      const topicCliId = ctx.topics.getCliId(msg.chatId, topicId);
      const effectiveCliId = topicCliId ?? session.cliId;
      await bot.reply(
        msg.messageId,
        [
          `本话题统一引擎：${getAdapter(effectiveCliId).displayName} (${effectiveCliId})`,
          topicCliId ? '所有角色及后续新建角色都会继承此设置。' : '尚未保存话题级设置；当前仅显示本角色引擎。',
          `用法：${formatEngineChoices()}`,
        ].join('\n'),
        hasThread,
      );
      return;
    }
    const next = command.arg.toLowerCase();
    if (!isCliId(next)) {
      await bot.reply(msg.messageId, `只支持 ${formatEngineChoices()}`, hasThread);
      return;
    }
    try {
      const blockingPeers = ctx.sessions.listByTopic(msg.chatId, topicId)
        .filter((peer) => peer.status === 'active' && peer.cliId !== next);
      if (blockingPeers.length > 0) {
        await bot.reply(
          msg.messageId,
          `本话题仍有角色使用其他引擎执行任务（${blockingPeers.map((peer) => peer.botId).join('、')}），请任务结束后再统一切换。`,
          hasThread,
        );
        return;
      }
      const previousTopicCliId = ctx.topics.getCliId(msg.chatId, topicId);
      await ctx.topics.setCliId(msg.chatId, topicId, next);
      const update = await ctx.sessions.setCliIdForTopic(msg.chatId, topicId, next);
      for (const sessionId of update.updatedSessionIds) ctx.contextWindows.delete(sessionId);
      session = ctx.sessions.get(session.id) ?? session;
      console.log(
        `[引擎] bot=${bot.id} chat=${msg.chatId} topic=${topicId} ${previousTopicCliId ?? '(未设置)'} → ${next}`
        + ` updated=${update.updated} deferred=${update.deferredBotIds.join(',') || '(无)'}`,
      );
      await bot.reply(
        msg.messageId,
        [
          `已将本话题统一切换到 ${getAdapter(next).displayName}。`,
          `已更新 ${update.updated} 个现有角色会话，清空 ${update.clearedContexts} 个旧引擎上下文。`,
          '尚未创建的产品、架构、开发、评审、测试等角色也会自动继承该引擎。',
          update.deferredBotIds.length > 0
            ? `仍在执行的角色将在任务结束后自动对齐：${update.deferredBotIds.join('、')}`
            : '',
        ].filter(Boolean).join('\n'),
        hasThread,
      );
    } catch (error) {
      await bot.reply(msg.messageId, (error as Error).message, hasThread);
    }
    return;
  }
  if (command?.name === 'form') {
    if (!command.arg) {
      await bot.reply(msg.messageId, '用法：/form <questionnaireId>。问卷 ID 由产品经理调用 propose_questions 后生成。', hasThread);
      return;
    }
    try {
      const questionnaire = await ctx.questionnaires.get(command.arg.trim());
      if (!questionnaire) throw new Error(`问卷不存在: ${command.arg.trim()}`);
      assertQuestionnaireAccess(ctx, questionnaire, operator, msg.chatId, topicIdOf(msg));
      await bot.replyCard(msg.messageId, buildQuestionnaireCard(questionnaire), hasThread);
    } catch (error) {
      await bot.reply(msg.messageId, (error as Error).message, hasThread);
    }
    return;
  }
  if (command?.name === 'spec') {
    const [subcommand = 'list', specId] = command.arg?.trim().split(/\s+/, 2) ?? [];
    const topicSpecs = ctx.specs.listByTopic(msg.chatId, topicIdOf(msg));
    if (subcommand === 'list') {
      await bot.reply(
        msg.messageId,
        topicSpecs.length
          ? topicSpecs.map((spec) => `${spec.id} · ${spec.status} · ${spec.title}`).join('\n')
          : '当前话题还没有产品 Spec。产品经理完成流水线需求阶段后会自动生成。',
        hasThread,
      );
      return;
    }
    if (subcommand === 'show' && specId) {
      try {
        const spec = ctx.specs.get(specId);
        if (!spec || spec.chatId !== msg.chatId || spec.topicId !== topicIdOf(msg)) {
          await bot.reply(msg.messageId, `找不到本话题 Spec：${specId}`, hasThread);
          return;
        }
        await bot.replyCard(msg.messageId, buildSpecStatusCard(spec), hasThread);
      } catch (error) {
        await bot.reply(msg.messageId, `展示 Spec 失败：${(error as Error).message}`, hasThread);
      }
      return;
    }
    if (subcommand === 'publish' && specId) {
      try {
        const spec = ctx.specs.get(specId);
        if (!spec || spec.chatId !== msg.chatId || spec.topicId !== topicIdOf(msg)) throw new Error(`找不到本话题 Spec：${specId}`);
        assertSpecOwner(ctx, spec.ownerOpenId, operator);
        const published = await publishSpecToDoc(ctx, spec.id);
        await bot.replyCard(msg.messageId, buildSpecReviewCard(published), hasThread);
      } catch (error) {
        await bot.reply(msg.messageId, (error as Error).message, hasThread);
      }
      return;
    }
    await bot.reply(msg.messageId, '用法：/spec list、/spec show <specId> 或 /spec publish <specId>', hasThread);
    return;
  }
  if (command?.name === 'handoff') {
    const parsed = parseHandoffArg(command.arg);
    if (!parsed) {
      await bot.reply(
        msg.messageId,
        [
          '用法：/handoff <角色> <任务>',
          `可选角色：${listHandoffTargets(ctx.botsById.values())}`,
          '示例：/handoff dev 根据当前仓库写一段 README 大纲',
        ].join('\n'),
        hasThread,
      );
      return;
    }
    const target = resolveHandoffTarget(parsed.target, ctx.botsById.values());
    if (!target) {
      await bot.reply(
        msg.messageId,
        `找不到角色「${parsed.target}」。可选：${listHandoffTargets(ctx.botsById.values())}`,
        hasThread,
      );
      return;
    }
    if (target.id === bot.id) {
      await bot.reply(msg.messageId, '不能交接给自己。', hasThread);
      return;
    }

    if (isDeliveryMutationTask(parsed.task) || qualityRoleRejectsImplementationHandoff(target.id, parsed.task)) {
      await bot.reply(
        msg.messageId,
        '交接命令不能绕过交付门禁执行项目修改。请由 CEO 发起流水线，或由开发工程师使用 /squad <目标>。',
        hasThread,
      );
      return;
    }

    if (isHighRiskTask(parsed.task)) {
      try {
        await requestHighRiskApproval(ctx, {
          bot: target,
          msg,
          prompt: buildHandoffPrompt(bot, parsed.task, target),
          action: 'task',
          reason: highRiskReason(parsed.task),
        });
      } catch (error) {
        await bot.reply(msg.messageId, (error as Error).message, hasThread);
      }
      return;
    }

    try {
      const targetSession = await ensureRunnableSession(ctx, target, msg);
      if (!targetSession) {
        await bot.reply(
          msg.messageId,
          `${target.name} 正在执行任务，请稍后再交接。`,
          hasThread,
        );
        return;
      }

      console.log(`[交接] ${bot.id} → ${target.id} task=${truncate(parsed.task, 120)}`);
      await bot.reply(
        msg.messageId,
        [
          `已交接给 ${target.name}（${target.id}）`,
          `任务：${parsed.task}`,
        ].join('\n'),
        hasThread,
      );

      await startCliTask(ctx, {
        bot: target,
        msg,
        session: targetSession,
        prompt: buildHandoffPrompt(bot, parsed.task, target),
      });
    } catch (error) {
      await bot.reply(msg.messageId, (error as Error).message, hasThread);
    }
    return;
  }
  if (command?.name === 'review') {
    if (!command.arg) {
      await bot.reply(
        msg.messageId,
        [
          '用法：/review <任务>',
          '这不是流水线门禁：reviewer 做只读独立审查，不会自动改代码。',
          '通过只认独立一行 [APPROVED] 或 [DECISION:approved]；LGTM、「通过」、「可以合并」不算。',
          '示例：/review 审查 README.md 是否完整准确',
        ].join('\n'),
        hasThread,
      );
      return;
    }
    if (isHighRiskTask(command.arg)) {
      try {
        await requestHighRiskApproval(ctx, {
          bot,
          msg,
          prompt: command.arg,
          action: 'review',
          reason: highRiskReason(command.arg),
        });
      } catch (error) {
        await bot.reply(msg.messageId, (error as Error).message, hasThread);
      }
      return;
    }
    try {
      const topicKey = collabTopicKey(msg.chatId, topicIdOf(msg));
      const previous = ctx.collabStore.getRound(topicKey);
      if (previous) {
        console.log(`[协作] 话题上次停在第 ${previous} 轮，本次重新从第 1 轮开始`);
      }
      await runCollabReview(ctx, {
        initiator: bot,
        msg,
        task: command.arg,
        round: 1,
        allowFixes: false,
        executionPolicy: 'read-only',
      });
    } catch (error) {
      await bot.reply(msg.messageId, (error as Error).message, hasThread);
    }
    return;
  }
  if (command?.name === 'pipeline') {
    if (bot.id !== 'ceo') {
      await bot.reply(
        msg.messageId,
        '团队流水线请 @CEO助手 使用：/pipeline <目标>',
        hasThread,
      );
      return;
    }
    if (!command.arg) {
      const preview = ctx.pipelineSteps.map((s) => s.title).join(' → ');
      await bot.reply(
        msg.messageId,
        [
          '用法：/pipeline <目标>',
          `当前步骤：${preview || '(无可用步骤)'}`,
          'PIPELINE_STEPS 仅允许声明完整固定顺序，质量门禁不可裁剪或重排。',
          '示例：/pipeline 给 README 补一节快速开始说明',
        ].join('\n'),
        hasThread,
      );
      return;
    }
    if (isHighRiskTask(command.arg)) {
      try {
        await requestHighRiskApproval(ctx, {
          bot,
          msg,
          prompt: command.arg,
          action: 'pipeline',
          reason: highRiskReason(command.arg),
        });
      } catch (error) {
        await bot.reply(msg.messageId, (error as Error).message, hasThread);
      }
      return;
    }
    try {
      await runTeamPipeline(ctx, { ceo: bot, msg, goal: command.arg });
    } catch (error) {
      await bot.reply(msg.messageId, (error as Error).message, hasThread);
    }
    return;
  }
  if (command?.name === 'squad') {
    if (bot.id !== 'dev' && bot.id !== 'ceo') {
      await bot.reply(msg.messageId, '内部交付小队请由开发工程师或 CEO 发起：/squad <目标>', hasThread);
      return;
    }
    if (!command.arg) {
      await bot.reply(msg.messageId, '用法：/squad <目标>\n步骤：架构 → 开发 → 评审 → QA → 运行时审计 → 最终审查', hasThread);
      return;
    }
    if (isHighRiskTask(command.arg)) {
      try {
        await requestHighRiskApproval(ctx, {
          bot,
          msg,
          prompt: command.arg,
          action: 'squad',
          reason: highRiskReason(command.arg),
        });
      } catch (error) {
        await bot.reply(msg.messageId, (error as Error).message, hasThread);
      }
      return;
    }
    try {
      await runDeliverySquad(ctx, { initiator: bot, msg, goal: command.arg });
    } catch (error) {
      await bot.reply(msg.messageId, (error as Error).message, hasThread);
    }
    return;
  }
  if (command?.name === 'approval') {
    if (!command.arg) {
      await bot.reply(msg.messageId, '用法：/approval <高风险任务>。批准后才会执行。', hasThread);
      return;
    }
    const deliveryMutation = isDeliveryMutationTask(command.arg);
    if (deliveryMutation && bot.id !== 'ceo' && bot.id !== 'dev') {
      await bot.reply(msg.messageId, '高风险交付请由 CEO 或开发工程师发起，确保审批后仍进入完整门禁。', hasThread);
      return;
    }
    try {
      await requestHighRiskApproval(ctx, {
        bot,
        msg,
        prompt: command.arg,
        action: deliveryMutation ? (bot.id === 'ceo' ? 'pipeline' : 'squad') : 'task',
        reason: '用户显式要求审批',
      });
    } catch (error) {
      await bot.reply(msg.messageId, (error as Error).message, hasThread);
    }
    return;
  }
  if (command?.name === 'schedule') {
    const arg = command.arg?.trim();
    const topicId = topicIdOf(msg);
    if (!arg || arg === 'help') {
      await bot.reply(
        msg.messageId,
        [
          '定时任务：',
          '/schedule every 1h <任务>',
          '/schedule pipeline 1h <目标>（仅 CEO）',
          '/schedule logs 1h </path/server.log>',
          '/schedule list | pause <id> | resume <id> | remove <id>',
        ].join('\n'),
        hasThread,
      );
      return;
    }
    const [operationToken, second, ...rest] = arg.split(/\s+/);
    const operation = operationToken.toLowerCase();
    if (operation === 'list') {
      const jobs = ctx.schedules.listByTopic(msg.chatId, topicId);
      await bot.reply(
        msg.messageId,
        jobs.length
          ? jobs.map((job) => [
            `${job.id} · ${job.enabled ? '已启用' : '已暂停'} · ${job.kind}`,
            `每 ${formatScheduleInterval(job.intervalMs)} · 下次 ${job.nextRunAt}`,
            `上次 ${formatScheduleRunStatus(job.lastStatus)} · 已触发 ${job.runCount} 次${job.lastError ? ` · ${job.lastError}` : ''}`,
          ].join(' · ')).join('\n')
          : '当前话题没有定时任务。',
        hasThread,
      );
      return;
    }
    if ((operation === 'pause' || operation === 'resume' || operation === 'remove') && second) {
      const job = ctx.schedules.get(second);
      if (!job || !scheduleMatchesTopic(job, msg.chatId, topicId)) {
        await bot.reply(msg.messageId, `找不到本话题定时任务：${second}`, hasThread);
        return;
      }
      try {
        assertCanControlOwnedResource(job.ownerOpenId, operator, ctx.identities);
        if (operation === 'remove') {
          if (job.lastStatus === 'running') throw new Error('定时任务正在执行，请等待本轮结束或先停止对应任务卡片。');
          await ctx.schedules.remove(job.id);
          await bot.reply(msg.messageId, `已删除定时任务 ${job.id}。`, hasThread);
        } else {
          const updated = await ctx.schedules.setEnabled(job.id, operation === 'resume');
          await bot.reply(msg.messageId, `定时任务 ${updated.id} 已${updated.enabled ? '恢复' : '暂停'}。`, hasThread);
        }
      } catch (error) {
        await bot.reply(msg.messageId, (error as Error).message, hasThread);
      }
      return;
    }
    if (operation !== 'every' && operation !== 'pipeline' && operation !== 'logs') {
      await bot.reply(msg.messageId, '无法识别的 /schedule 命令，发送 /schedule help 查看用法。', hasThread);
      return;
    }
    const intervalMs = second ? parseScheduleInterval(second) : undefined;
    let prompt = rest.join(' ').trim();
    if (!intervalMs || !prompt) {
      await bot.reply(msg.messageId, '间隔使用 15m、1h、2d 等格式，且必须提供任务内容。', hasThread);
      return;
    }
    if (operation === 'pipeline' && bot.id !== 'ceo') {
      await bot.reply(msg.messageId, '定时团队流水线仅 CEO 可创建。', hasThread);
      return;
    }
    if (operation === 'logs') {
      try {
        prompt = await assertLogFile(prompt);
      } catch (error) {
        await bot.reply(msg.messageId, (error as Error).message, hasThread);
        return;
      }
    }
    if (operation === 'every' && isDeliveryMutationTask(prompt)) {
      await bot.reply(
        msg.messageId,
        '会修改项目的定时任务不能使用普通 task。请由 CEO 使用 /schedule pipeline <间隔> <目标>。',
        hasThread,
      );
      return;
    }
    const kind = operation === 'pipeline' ? 'pipeline' : operation === 'logs' ? 'log_inspection' : 'task';
    try {
      const job = await ctx.schedules.create({
        botId: bot.id,
        ownerOpenId: process.env.OWNER_OPEN_ID?.trim() || msg.senderOpenId,
        kind,
        prompt,
        intervalMs,
        message: {
          messageId: msg.messageId,
          topicId,
          chatId: msg.chatId,
          chatType: msg.chatType,
          rootId: msg.rootId,
          threadId: msg.threadId,
          senderOpenId: msg.senderOpenId,
        },
      });
      await bot.reply(msg.messageId, `已创建定时任务 ${job.id}：每 ${formatScheduleInterval(job.intervalMs)} 执行一次，下次 ${job.nextRunAt}。`, hasThread);
    } catch (error) {
      await bot.reply(msg.messageId, `创建定时任务失败：${(error as Error).message}`, hasThread);
    }
    return;
  }
  if (command?.name === 'reset') {
    try {
      await ctx.sessions.clearCliContext(session.id);
      console.log(`[会话] bot=${bot.id} reset CLI 上下文 session=${session.id}`);
      await bot.reply(
        msg.messageId,
        '已清理 CLI 上下文。会话保留，下次任务会新建引擎会话。',
        hasThread,
      );
    } catch (error) {
      await bot.reply(msg.messageId, (error as Error).message, hasThread);
    }
    return;
  }
  if (command?.name === 'reopen') {
    try {
      const updated = await ctx.sessions.reopen(session.id);
      console.log(`[会话] bot=${bot.id} reopen session=${updated.id}`);
      await bot.reply(
        msg.messageId,
        '会话已重新打开，CLI 上下文已清空，可以继续下达任务。',
        hasThread,
      );
    } catch (error) {
      await bot.reply(msg.messageId, (error as Error).message, hasThread);
    }
    return;
  }
  if (command?.name === 'clean') {
    const removed = await ctx.sessions.purgeClosed();
    console.log(`[会话] bot=${bot.id} purgeClosed removed=${removed}`);
    await bot.reply(
      msg.messageId,
      removed > 0
        ? `已清理 ${removed} 条已关闭会话记录。`
        : '没有可清理的已关闭会话。',
      hasThread,
    );
    return;
  }
  if (command?.name === 'workflow') {
    const [subcommand = '', ...rest] = (command.arg?.trim().split(/\s+/) ?? []);
    const workflowId = rest[0]?.trim();
    if (subcommand === 'retry' && workflowId) {
      try {
        const workflow = ctx.workflows.get(workflowId);
        if (!workflow) throw new Error(`工作流不存在: ${workflowId}`);
        assertCanControlOwnedResource(workflow.message.senderOpenId, operator, ctx.identities);
        if (workflow.status === 'failed') {
          assertManualWorkflowRetryAllowed(workflow);
          const currentStepId = workflow.stepIds[workflow.nextStepIndex];
          const misrouted = findMisroutedEnvironmentBlock(currentStepId, workflow.priorOutputs);
          const requiresResourceApproval = !!misrouted && requiresTestResourceAuthorization([
            misrouted.reason,
            workflow.priorOutputs[`blocked_${misrouted.sourceStepId}`],
          ].filter(Boolean).join('\n'));
          const driftRewindTo = rewindStepIdFromDriftMessage(workflow.error);
          const rewindTo = misrouted?.sourceStepId ?? driftRewindTo;
          const nextStepIndex = rewindTo && workflow.stepIds.includes(rewindTo)
            ? workflow.stepIds.indexOf(rewindTo)
            : workflow.nextStepIndex;
          const nextPrior = { ...workflow.priorOutputs };
          if (misrouted) {
            delete nextPrior.quality_fix_request;
            delete nextPrior.blocked_workdir;
          } else if (driftRewindTo) {
            nextPrior.fingerprint_drift = workflow.error ?? `退回 ${driftRewindTo} 重建证据`;
          }
          const restored = await ctx.workflows.updateIfStatus(workflowId, 'failed', {
            status: requiresResourceApproval ? 'awaiting_step_unblock' : 'ready',
            error: requiresResourceApproval ? misrouted?.reason : undefined,
            nextStepIndex,
            ...(misrouted || driftRewindTo ? { priorOutputs: nextPrior } : {}),
          });
          if (!restored) throw new Error(`工作流当前状态为 ${ctx.workflows.get(workflowId)?.status ?? 'unknown'}，无法重试。`);
          if (requiresResourceApproval) {
            await resendBlockedCard(ctx, workflowId);
            await bot.reply(
              msg.messageId,
              `检测到旧版本曾把 QA 环境阻塞误转开发；已恢复到 ${misrouted?.sourceStepId}，请在新卡片确认隔离测试库后授权重试。`,
              hasThread,
            );
            return;
          }
          const stepName = restored.stepIds[restored.nextStepIndex] ?? '(结束)';
          const hint = misrouted
            ? `（检测到环境阻塞曾被误转开发，已回到 ${misrouted.sourceStepId} 重试）`
            : driftRewindTo
              ? `（检测到证据指纹漂移，已退回 ${driftRewindTo} 重建后再继续）`
              : '';
          // P1 修复：通知失败不应阻止续跑；workflow 已在 ready，续跑必须执行。
          try {
            await bot.reply(
              msg.messageId,
              `工作流已从失败恢复，正在从步骤 ${stepName} 继续…${hint}`,
              hasThread,
            );
          } catch (notifyError) {
            console.error('[工作流] retry 通知发送失败，仍继续续跑:', (notifyError as Error).message);
          }
          void continueDeliveryWorkflow(ctx, workflowId).catch(async (error) => {
            const message = (error as Error).message;
            console.error(`[工作流] retry 续跑失败:`, message);
            await bot.reply(msg.messageId, `续跑失败：${message}`, hasThread).catch(() => undefined);
          });
          return;
        }
        try {
          const restored = await resumePausedOrOrphanedWorkflow(ctx, workflowId);
          const stepName = restored.stepIds[restored.nextStepIndex] ?? '(结束)';
          try {
            await bot.reply(
              msg.messageId,
              `流水线已从暂停恢复，正在从步骤 ${stepName} 继续…`,
              hasThread,
            );
          } catch (notifyError) {
            console.error('[工作流] retry 暂停恢复通知失败，仍继续续跑:', (notifyError as Error).message);
          }
          void continueDeliveryWorkflow(ctx, workflowId).catch(async (error) => {
            const message = (error as Error).message;
            console.error(`[工作流] retry 续跑失败:`, message);
            await bot.reply(msg.messageId, `续跑失败：${message}`, hasThread).catch(() => undefined);
          });
          return;
        } catch (pausedError) {
          if (workflow.status === 'executing' && workflowHasLiveCli(ctx, workflowId)) {
            await bot.reply(
              msg.messageId,
              '当前步骤仍在执行，无需 retry。若要重来请先点卡片「停止任务」。',
              hasThread,
            );
            return;
          }
          if (workflow.status !== 'awaiting_step_unblock') {
            throw pausedError;
          }
        }
        if (await handOffBlockedWorkflowIfQualityFix(ctx, workflowId)) {
          await bot.reply(
            msg.messageId,
            '当前阻塞实为代码缺陷（非目录问题），已记录并转交开发/架构修复，正在续跑…',
            hasThread,
          );
          return;
        }
        await resendBlockedCard(ctx, workflowId);
        await bot.reply(msg.messageId, `已重新发送阻塞卡，请在新卡片上操作。`, hasThread);
      } catch (error) {
        await bot.reply(msg.messageId, (error as Error).message, hasThread);
      }
      return;
    }
    if (subcommand === 'abort' && workflowId) {
      try {
        const workflow = ctx.workflows.get(workflowId);
        if (!workflow) throw new Error(`工作流不存在: ${workflowId}`);
        assertCanControlOwnedResource(workflow.message.senderOpenId, operator, ctx.identities);
        const aborted = await abortBlockedWorkflow(ctx, workflowId, '用户发送 /workflow abort 终止流水线');
        await bot.reply(
          msg.messageId,
          [
            `已终止工作流 ${aborted.id}，技术交付占用已释放。`,
            '若另一条产品 Spec 仍待确认，可再次点「确认并直接开始技术交付」。',
          ].join('\n'),
          hasThread,
        );
      } catch (error) {
        await bot.reply(msg.messageId, (error as Error).message, hasThread);
      }
      return;
    }
    await bot.reply(
      msg.messageId,
      [
        '用法：',
        '/workflow retry <工作流ID> — 从失败、暂停或阻塞处继续当前步骤',
        '/workflow abort <工作流ID> — 终止未完成流水线并释放项目占用',
        '工作流 ID 可在终端日志、占用报错或 data/workflows.json 中查找。',
      ].join('\n'),
      hasThread,
    );
    return;
  }
  if (command?.name === 'close') {
    const running = ctx.activeRuns.get(session.id);
    if (running) {
      running.cancelMode = 'close';
      running.interruptReason = running.workflowId
        ? userStopResumeHint(running.workflowId)
        : '本次任务已停止，当前会话已经关闭。';
      running.controller.abort();
      if (running.workflowId) {
        try {
          await pauseWorkflowOnUserStop(ctx, running.workflowId);
        } catch (error) {
          console.error('[工作流] 停止后暂停流水线失败:', (error as Error).message);
        }
      }
    }
    if (session.status !== 'closed') await ctx.sessions.transition(session.id, 'closed');
    await bot.reply(
      msg.messageId,
      '当前会话已关闭。同话题继续请发 /reopen；或新开话题重新开始。',
      hasThread,
    );
    return;
  }

  if (session.status === 'closed') {
    await bot.reply(
      msg.messageId,
      '这个话题的会话已经关闭。发送 /reopen 重新打开，或新开一个话题。',
      hasThread,
    );
    return;
  }
  if (!isNew && session.status === 'creating') {
    await bot.reply(
      msg.messageId,
      '当前会话正在准备，请稍后再追问。',
      hasThread,
    );
    return;
  }
  if (session.status === 'active') {
    await bot.reply(
      msg.messageId,
      '当前会话还在执行，请等任务结束后再追问。',
      hasThread,
    );
    return;
  }

  // CEO 统一入口：自然语言目标直接进团队流水线（仍可用 /pipeline 显式启动）。
  if (bot.id === 'ceo') {
    session = await releaseCreatingSession(ctx, session);
    const goal = resolved.trim();
    if (!goal) {
      await bot.reply(
        msg.messageId,
        '请直接描述目标，我会启动团队流水线；或发送 /help 查看命令。',
        hasThread,
      );
      return;
    }
    if (isHighRiskTask(goal)) {
      try {
        await requestHighRiskApproval(ctx, {
          bot,
          msg,
          prompt: goal,
          action: 'pipeline',
          reason: highRiskReason(goal),
        });
      } catch (error) {
        await bot.reply(msg.messageId, (error as Error).message, hasThread);
      }
      return;
    }
    try {
      await runTeamPipeline(ctx, { ceo: bot, msg, goal });
    } catch (error) {
      await bot.reply(msg.messageId, (error as Error).message, hasThread);
    }
    return;
  }

  if (isHighRiskTask(resolved)) {
    session = await releaseCreatingSession(ctx, session);
    if (isDeliveryMutationTask(resolved) && bot.id !== 'dev') {
      await bot.reply(
        msg.messageId,
        '该高风险交付请求必须同时经过审批与完整门禁。请改由 @CEO助手 发起。',
        hasThread,
      );
      return;
    }
    try {
      await requestHighRiskApproval(ctx, {
        bot,
        msg,
        prompt: resolved,
        action: isDeliveryMutationTask(resolved) ? 'squad' : 'task',
        reason: highRiskReason(resolved),
      });
    } catch (error) {
      await bot.reply(msg.messageId, (error as Error).message, hasThread);
    }
    return;
  }

  // 会产生项目改动的自然语言任务不能绕过结构化交付门禁。
  if (isDeliveryMutationTask(resolved)) {
    session = await releaseCreatingSession(ctx, session);
    if (bot.id === 'dev') {
      try {
        await runDeliverySquad(ctx, { initiator: bot, msg, goal: resolved.trim() });
      } catch (error) {
        await bot.reply(msg.messageId, (error as Error).message, hasThread);
      }
    } else {
      await bot.reply(
        msg.messageId,
        '该请求会产生项目交付物，不能绕过质量门禁。请 @CEO助手 描述目标，或由开发工程师使用 /squad <目标>。',
        hasThread,
      );
    }
    return;
  }

  await startCliTask(ctx, {
    bot,
    msg,
    session,
    prompt: resolved,
    downloadResources: true,
  });
}

/** 按角色生成 /help：CEO 强调统一入口，其他角色引导先找 CEO。 */
function buildHelpText(bot: Bot): string {
  if (bot.id === 'ceo') {
    return [
      `我是 ${bot.name}（${bot.id}）· 团队统一入口`,
      '直接描述目标 → 启动交付流水线（PM→架构→开发→评审→测试→运行时审计→终审→汇总）',
      '/pipeline <目标> 显式启动流水线',
      '/squad <目标> 启动开发内部交付小队',
      '/schedule … 创建/管理定时任务',
      '/approval <任务> 发起高风险操作审批',
      '/handoff <角色> <任务> 只交给某一个角色',
      '/status 查看当前会话',
      '/workdir [路径] 查看/设置本话题项目目录（clear 清除）',
      `/engine ${formatEngineIds()} 统一切换本话题所有角色的执行引擎`,
      '/review <任务> 只读独立审查（只认 [APPROVED]/[DECISION:approved]，修复请进入 /squad）',
      '/workflow retry|abort <工作流ID> 续跑或终止流水线',
      '/reset /reopen /close /clean 会话管理',
      '执行中可点任务卡片「停止任务」（仅发起人）',
    ].join('\n');
  }

  return [
    `我是 ${bot.name}（${bot.id}）`,
    '团队需求请先 @CEO助手；我适合承接本角色的具体任务。',
    '/status 查看当前会话',
    '/workdir [路径] 查看/设置本话题项目目录（clear 清除）',
    `/engine ${formatEngineIds()} 统一切换本话题所有角色的执行引擎`,
    '/handoff <角色> <任务> 交接给同话题其他角色',
    '/review <任务> 只读独立审查（只认 [APPROVED]/[DECISION:approved]，修复请进入 /squad）',
    '/squad <目标> 架构→开发→评审→QA→运行时审计→终审',
    '/schedule … 创建/管理定时任务',
    '/approval <任务> 发起高风险操作审批',
    '/workflow retry|abort <工作流ID> 续跑或终止流水线',
    '/reset /reopen /close /clean 会话管理',
    '执行中可点任务卡片「停止任务」（仅发起人）',
  ].join('\n');
}

/** 卡片「停止任务」按钮：仅发起人可停。 */
export async function handleCardAction(
  ctx: AppContext,
  action: CardAction,
) {
  const operator = cardActionIdentity(action);
  const identities = ctx.identities ?? (ctx.identities = new IdentityRegistry());
  await identities.observe(operator);
  if (
    action.value.action === 'approve_high_risk'
    || action.value.action === 'reject_high_risk'
    || action.value.action === 'retry_high_risk'
  ) {
    const approvalId = typeof action.value.approvalId === 'string' ? action.value.approvalId : '';
    try {
      let approval = ctx.approvals.get(approvalId);
      if (!approval) throw new Error('审批不存在或已被删除。');
      try {
        assertOwnedBy(approval.ownerOpenId, operator, ctx.identities);
      } catch {
        return { toast: { type: 'warning' as const, content: '只有指定负责人可以处理该审批。' } };
      }
      if (!approval.cardMessageId) {
        throw new Error('审批卡绑定缺失，不能执行；请重新发起审批。');
      }
      if (!action.messageId || action.messageId !== approval.cardMessageId) {
        throw new Error('只能在最初绑定的审批卡上处理该任务。');
      }
      if (action.value.action === 'reject_high_risk') {
        const rejected = await ctx.approvals.reject(
          approval.id,
          action.operatorOpenId,
          (ownerOpenId) => {
            try {
              assertOwnedBy(ownerOpenId, operator, ctx.identities);
              return true;
            } catch {
              return false;
            }
          },
        );
        await settleApprovalSchedule(ctx, rejected, 'skipped', '负责人拒绝审批').catch((error) => {
          console.error(`[审批] ${rejected.id} 拒绝结算失败:`, sanitizeErrorForLog(error));
        });
        return {
          toast: { type: 'info' as const, content: '已拒绝，高风险任务不会执行。' },
          card: { type: 'raw' as const, data: buildApprovalCard(rejected) },
        };
      }

      if (action.value.action === 'retry_high_risk' && approval.status !== 'failed') {
        return {
          toast: { type: 'info' as const, content: `审批当前状态为 ${approval.status}，无需重试。` },
          card: { type: 'raw' as const, data: buildApprovalCard(approval) },
        };
      }
      if (action.value.action === 'approve_high_risk' && approval.status === 'failed') {
        return {
          toast: { type: 'info' as const, content: '上次执行已失败，请使用最新卡片上的重试按钮。' },
          card: { type: 'raw' as const, data: buildApprovalCard(approval) },
        };
      }
      if (action.value.action === 'retry_high_risk' && approval.scheduleJobId) {
        return {
          toast: { type: 'info' as const, content: '定时任务会自动补偿重试，请使用下一张审批卡。' },
          card: { type: 'raw' as const, data: buildApprovalCard(approval) },
        };
      }
      const executing = await executeApprovedAction(ctx, approval.id, operator);
      if (executing.status === 'failed') {
        return {
          toast: { type: 'error' as const, content: `启动失败：${executing.executionError ?? '未知错误'}，可在卡片上重试。` },
          card: { type: 'raw' as const, data: buildApprovalCard(executing) },
        };
      }
      return {
        toast: { type: 'success' as const, content: '已批准，任务开始执行。' },
        card: { type: 'raw' as const, data: buildApprovalCard(executing) },
      };
    } catch (error) {
      const latest = approvalId ? ctx.approvals.get(approvalId) : undefined;
      if (latest?.status === 'expired' || latest?.status === 'rejected') {
        await settleApprovalSchedule(ctx, latest, 'skipped', latest.executionError).catch((settleError) => {
          console.error(`[审批] ${latest.id} 定时任务结算失败:`, sanitizeErrorForLog(settleError));
        });
      }
      return {
        toast: { type: 'error' as const, content: (error as Error).message },
        ...(latest ? { card: { type: 'raw' as const, data: buildApprovalCard(latest) } } : {}),
      };
    }
  }
  if (action.value.action === 'approve_spec_review' || action.value.action === 'request_spec_changes') {
    const specId = typeof action.value.specId === 'string' ? action.value.specId : '';
    try {
      const spec = ctx.specs.get(specId);
      if (!spec) throw new Error('Spec 不存在或已被删除。');
      assertCurrentSpecCard(spec, action.value);
      if (spec.status !== 'in_review') throw new Error(`当前 Spec 状态为 ${spec.status}，无法处理评审。`);

      if (action.value.action === 'approve_spec_review') {
        assertSpecApprovalAuthority(ctx, spec, operator);
        const approved = await approveSpecReview(ctx, spec.id);
        return {
          toast: { type: 'success' as const, content: '产品评审已通过，内部交付小队开始执行。' },
          card: { type: 'raw' as const, data: buildSpecReviewCard(approved) },
        };
      }

      assertSpecOwner(ctx, spec.ownerOpenId, operator);
      const comment = typeof action.formValue.reviewComment === 'string'
        ? action.formValue.reviewComment.trim()
        : '';
      if (!comment) return { toast: { type: 'warning' as const, content: '请先填写修改意见。' } };
      const changed = await requestSpecChangesFromCard(
        ctx,
        spec.id,
        action.operatorOpenId,
        comment,
      );
      return {
        toast: { type: 'success' as const, content: '评审意见已交给产品经理处理。' },
        card: { type: 'raw' as const, data: buildSpecReviewCard(changed) },
      };
    } catch (error) {
      return { toast: { type: 'error' as const, content: (error as Error).message } };
    }
  }
  if (action.value.action === 'confirm_spec_start') {
    const specId = typeof action.value.specId === 'string' ? action.value.specId : '';
    if (!specId) return { toast: { type: 'error' as const, content: 'Spec ID 缺失。' } };
    try {
      const spec = ctx.specs.get(specId);
      if (!spec) throw new Error('Spec 不存在或已被删除。');
      assertSpecApprovalAuthority(ctx, spec, operator);
      assertCurrentSpecCard(spec, action.value);
      await confirmSpecAndStartDelivery(ctx, spec.id);
      const latest = ctx.specs.get(specId);
      if (!latest) throw new Error('Spec 确认后读取失败。');
      return {
        toast: { type: 'success' as const, content: '方案已确认并直接开始技术交付。' },
        card: { type: 'raw' as const, data: buildSpecStatusCard(latest) },
      };
    } catch (error) {
      const latest = specId ? ctx.specs.get(specId) : undefined;
      return {
        toast: { type: 'error' as const, content: (error as Error).message },
        ...(latest ? { card: { type: 'raw' as const, data: buildSpecStatusCard(latest) } } : {}),
      };
    }
  }
  if (action.value.action === 'publish_spec') {
    const specId = typeof action.value.specId === 'string' ? action.value.specId : '';
    try {
      const spec = ctx.specs.get(specId);
      if (!spec) throw new Error('Spec 不存在或已被删除。');
      assertSpecOwner(ctx, spec.ownerOpenId, operator);
      assertCurrentSpecCard(spec, action.value);
      const published = await publishSpecToDoc(ctx, spec.id);
      return {
        toast: { type: 'success' as const, content: '已发布到飞书云文档，进入产品评审。' },
        card: { type: 'raw' as const, data: buildSpecReviewCard(published) },
      };
    } catch (error) {
      // 半成功写入会更新 docId/updatedAt；必须刷新卡片，否则旧卡按钮立刻「已过期」。
      const latest = specId ? ctx.specs.get(specId) : undefined;
      return {
        toast: { type: 'error' as const, content: (error as Error).message },
        ...(latest ? { card: { type: 'raw' as const, data: buildSpecStatusCard(latest) } } : {}),
      };
    }
  }
  if (action.value.action === 'confirm_spec' || action.value.action === 'reject_spec') {
    const specId = typeof action.value.specId === 'string' ? action.value.specId : '';
    if (!specId) return { toast: { type: 'error' as const, content: 'Spec ID 缺失。' } };
    try {
      const spec = ctx.specs.get(specId);
      if (!spec) throw new Error('Spec 不存在或已被删除。');
      if (action.value.action === 'confirm_spec') {
        assertSpecApprovalAuthority(ctx, spec, operator);
      } else {
        assertSpecOwner(ctx, spec.ownerOpenId, operator);
      }
      assertCurrentSpecCard(spec, action.value);
      if (spec.status !== 'pending_confirmation') {
        return { toast: { type: 'info' as const, content: `Spec 当前状态：${spec.status}` } };
      }
      const confirmed = action.value.action === 'confirm_spec';
      let updated: Awaited<ReturnType<typeof confirmSpecForReview>>;
      if (confirmed) {
        updated = await confirmSpecForReview(ctx, spec.id);
      } else {
        const feedback = typeof action.formValue.confirmationFeedback === 'string'
          ? action.formValue.confirmationFeedback.trim()
          : '';
        if (!feedback) {
          return { toast: { type: 'warning' as const, content: '退回修改时请填写具体意见。' } };
        }
        updated = (await rejectSpecConfirmation(ctx, spec.id, feedback)).spec;
      }
      if (!confirmed) {
        const workflowId = updated.workflowId;
        if (!workflowId) throw new Error(`Spec ${updated.id} 没有关联交付工作流。`);
        runWorkflowContinuation(
          continueDeliveryWorkflow(ctx, workflowId),
          `退回 Spec ${updated.id} 给产品经理`,
        );
      }
      return {
        toast: { type: confirmed ? 'success' as const : 'info' as const, content: confirmed ? '方案已确认。' : '已退回产品经理修改。' },
        card: { type: 'raw' as const, data: buildSpecConfirmationCard(updated) },
      };
    } catch (error) {
      return { toast: { type: 'error' as const, content: (error as Error).message } };
    }
  }
  if (action.value.action === 'submit_questionnaire') {
    const questionnaireId = typeof action.value.questionnaireId === 'string'
      ? action.value.questionnaireId
      : '';
    if (!questionnaireId) return { toast: { type: 'error' as const, content: '问卷 ID 缺失。' } };
    try {
      const questionnaire = await ctx.questionnaires.get(questionnaireId);
      if (!questionnaire) throw new Error('问卷不存在或已被删除。');
      assertQuestionnaireAccess(ctx, questionnaire, operator);
      assertCurrentQuestionnaireCard(questionnaire, action.value);
      const answers: Record<string, string | string[]> = {};
      for (const question of questionnaire.questions) {
        const raw = action.formValue[question.id];
        if (typeof raw === 'string') answers[question.id] = raw;
        else if (Array.isArray(raw)) answers[question.id] = raw.filter((item): item is string => typeof item === 'string');
      }
      const result = await ctx.questionnaires.recordAnswers(
        questionnaireId,
        answers,
        questionnaire.updatedAt,
      );
      if (result.questionnaire.status === 'answered') {
        runWorkflowContinuation(
          resumeWorkflowAfterQuestionnaire(ctx, questionnaireId),
          `恢复问卷 ${questionnaireId} 对应工作流`,
        );
      }
      return {
        toast: {
          type: result.questionnaire.status === 'answered' ? 'success' as const : 'warning' as const,
          content: result.questionnaire.status === 'answered' ? '需求澄清已完成。' : `仍缺必答项：${result.missingRequired.join('、')}`,
        },
        card: { type: 'raw' as const, data: buildQuestionnaireCard(result.questionnaire) },
      };
    } catch (error) {
      return { toast: { type: 'error' as const, content: (error as Error).message } };
    }
  }
  if (
    action.value.action === 'retry_blocked_step'
    || action.value.action === 'retry_blocked_step_with_workdir'
    || action.value.action === 'authorize_test_resource_and_retry'
    || action.value.action === 'abort_blocked_workflow'
  ) {
    const workflowId = typeof action.value.workflowId === 'string' ? action.value.workflowId : '';
    if (!workflowId) return { toast: { type: 'error' as const, content: '工作流 ID 缺失。' } };
    try {
      const workflow = ctx.workflows.get(workflowId);
      if (!workflow) throw new Error('工作流不存在或已被删除。');
      assertCanControlOwnedResource(workflow.message.senderOpenId, operator, ctx.identities);

      // 防止旧阻塞卡重放到新阻塞步骤：必须携带 stepId + blockVersion 且与当前一致
      const cardStepId = typeof action.value.stepId === 'string' ? action.value.stepId : '';
      const cardBlockVersion = typeof action.value.blockVersion === 'string' ? action.value.blockVersion : '';
      if (!cardStepId || !cardBlockVersion) {
        throw new Error('这张阻塞卡缺少版本信息，请重新触发阻塞或联系管理员。');
      }
      const cardStepTitle = DEFAULT_PIPELINE_STEPS.find((step) => step.id === cardStepId)?.title
        ?? cardStepId;
      if (workflow.status !== 'awaiting_step_unblock') {
        return {
          toast: { type: 'info' as const, content: `流水线当前状态为 ${workflow.status}，旧阻塞卡已失效。` },
          card: {
            type: 'raw' as const,
            data: buildStepBlockedActionCard({
              stepTitle: cardStepTitle,
              state: 'inactive',
              detail: `流水线当前状态为 ${workflow.status}，未重复执行任何操作。`,
            }),
          },
        };
      }
      const currentStepId = workflow.stepIds[workflow.nextStepIndex];
      if (cardStepId !== currentStepId || cardBlockVersion !== workflow.updatedAt) {
        throw new Error('这张阻塞卡已过期，流水线当前阻塞步骤与卡片不匹配。');
      }

      if (action.value.action === 'abort_blocked_workflow') {
        await abortBlockedWorkflow(ctx, workflowId);
        return {
          toast: { type: 'info' as const, content: '已终止阻塞中的流水线。' },
          card: {
            type: 'raw' as const,
            data: buildStepBlockedActionCard({
              stepTitle: cardStepTitle,
              state: 'aborted',
            }),
          },
        };
      }

      // 陈旧进程不能先把卡片切成“重试中”再异步失败；新进程校验通过后才接受重试。
      if (workflow.priorOutputs.runtime_source_changed !== undefined) {
        await (ctx.runtimeSourceGuard ?? processRuntimeSourceGuard).assertCurrent();
      }

      // 代码缺陷误进绑目录卡：点「重试」也改为记 bug 并移交开发/架构
      if (await handOffBlockedWorkflowIfQualityFix(ctx, workflowId)) {
        return {
          toast: {
            type: 'info' as const,
            content: '这是代码缺陷而非目录问题，已转交开发/架构修复。',
          },
          card: {
            type: 'raw' as const,
            data: buildStepBlockedActionCard({
              stepTitle: cardStepTitle,
              state: 'rerouted',
              detail: '这是代码缺陷而非目录问题，已转交开发/架构修复。',
            }),
          },
        };
      }

      if (action.value.action === 'authorize_test_resource_and_retry') {
        // migration/TRUNCATE/DROP 属于高风险操作，只认当前负责人；普通白名单不能代批。
        assertOwnedBy(workflow.message.senderOpenId, operator, ctx.identities);
        const authorizationEvidence = [
          workflow.error,
          workflow.priorOutputs.quality_fix_request,
          ...Object.entries(workflow.priorOutputs)
            .filter(([key]) => key.startsWith('blocked_'))
            .map(([, value]) => value),
        ].filter(Boolean).join('\n');
        if (!requiresTestResourceAuthorization(authorizationEvidence)) {
          throw new Error('当前阻塞不涉及 migration/TRUNCATE/DROP 等测试资源操作，不能附加该授权。');
        }
        const initiator = ctx.botsById.get(workflow.initiatorBotId);
        runWorkflowContinuation(
          resumeBlockedWorkflowStep(ctx, workflowId, { authorizeTestResource: true }),
          `授权隔离测试资源并重试 workflow=${workflowId}`,
          (error) => {
            notifyBlockedRetryFailure(
              ctx,
              workflowId,
              initiator,
              action.messageId,
              `授权后的 QA 重试失败：${error.message}`,
            );
          },
        );
        return {
          toast: {
            type: 'info' as const,
            content: '已授权本流水线对通过隔离预检的测试资源执行迁移/清理，正在重试 QA。',
          },
          card: {
            type: 'raw' as const,
            data: buildStepBlockedActionCard({
              stepTitle: cardStepTitle,
              state: 'authorized-retrying',
              detail: '授权仅用于当前工作流中通过隔离预检的测试资源；开发库和生产库仍会被拒绝。',
            }),
          },
        };
      }

      const workdir = action.value.action === 'retry_blocked_step_with_workdir'
        && !findMisroutedEnvironmentBlock(
          workflow.stepIds[workflow.nextStepIndex],
          workflow.priorOutputs,
        )
        ? (typeof action.value.workdir === 'string' && action.value.workdir.trim()
          ? action.value.workdir.trim()
          : workflow.priorOutputs.blocked_workdir)
        : undefined;
      const initiator = ctx.botsById.get(workflow.initiatorBotId);
      runWorkflowContinuation(
        resumeBlockedWorkflowStep(ctx, workflowId, workdir ? { workdir } : undefined),
        `重试阻塞步骤 workflow=${workflowId}`,
        (error) => {
          notifyBlockedRetryFailure(
            ctx,
            workflowId,
            initiator,
            action.messageId,
            `重试阻塞步骤失败：${error.message}`,
          );
        },
      );
      const authorizationEvidence = [
        workflow.error,
        workflow.priorOutputs.quality_fix_request,
        ...Object.entries(workflow.priorOutputs)
          .filter(([key]) => key.startsWith('blocked_'))
          .map(([, value]) => value),
      ].filter(Boolean).join('\n');
      return {
        toast: {
          type: 'info' as const,
          content: workdir ? `已绑定 ${workdir}，正在重试当前步骤…` : '正在按当前话题目录重试当前步骤…',
        },
        card: {
          type: 'raw' as const,
          data: buildStepBlockedActionCard({
            stepTitle: cardStepTitle,
            state: 'retrying',
            detail: workdir
              ? `已绑定目录 ${workdir}。`
              : requiresTestResourceAuthorization(authorizationEvidence)
                ? '本次是普通重试，未附加 migration/TRUNCATE/DROP 测试资源授权；需要时流水线会再次请求负责人确认。'
                : '正在使用当前话题绑定的项目目录重新执行。',
          }),
        },
      };
    } catch (error) {
      return { toast: { type: 'error' as const, content: (error as Error).message } };
    }
  }

  if (action.value.action !== 'abort_task') return {};

  const sessionId =
    typeof action.value.sessionId === 'string' ? action.value.sessionId : '';
  const run = ctx.activeRuns.get(sessionId);
  console.log(
    `[卡片] 停止回调 session=${sessionId || '(空)'} operator=${action.operatorOpenId} found=${!!run}`,
  );

  if (!run) {
    return { toast: { type: 'info' as const, content: '任务已经结束，无需再次停止。' } };
  }
  if (!canControlOwnedResource(run.ownerOpenId, operator, ctx.identities)) {
    return { toast: { type: 'warning' as const, content: '只有任务发起人或授权用户可以停止它。' } };
  }
  if (run.controller.signal.aborted) {
    freezeRunCard(run);
    return { toast: { type: 'info' as const, content: '正在停止任务，请稍候。' } };
  }

  // 先冻结进度 patch，再 abort，并在回调响应里直接回取消卡（须 3 秒内完成）。
  freezeRunCard(run);
  run.terminalStatus = 'interrupted';
  run.cardSettledByCallback = true;
  const detail = run.workflowId
    ? userStopResumeHint(run.workflowId)
    : '本次任务已停止。你可以继续在当前话题里提问。';
  run.interruptReason = detail;
  const outcome = requestTaskAbort(ctx.activeRuns, sessionId, operator, ctx.identities);
  if (outcome !== 'stopped' && outcome !== 'already_stopping') {
    return { toast: { type: 'info' as const, content: '任务已经结束，无需再次停止。' } };
  }
  let pausedOk = false;
  if (run.workflowId) {
    try {
      await pauseWorkflowOnUserStop(ctx, run.workflowId);
      pausedOk = true;
    } catch (error) {
      console.error('[工作流] 停止后暂停流水线失败:', (error as Error).message);
    }
  }

  return {
    toast: {
      type: pausedOk || !run.workflowId ? 'success' as const : 'warning' as const,
      content: run.workflowId
        ? (pausedOk
          ? '已暂停当前步骤，不会自动继续。'
          : '已停止 CLI，但流水线状态未能暂停，请查看日志或稍后 /workflow retry。')
        : '已发送停止指令。',
    },
    card: { type: 'raw' as const, data: interruptedCard(run, detail, !!run.workflowId) },
  };
}

/** 指定负责人优先；未指定时由提出需求的人确认。 */
function assertSpecOwner(ctx: AppContext, specOwnerOpenId: string, operator: UserIdentity): void {
  assertCanControlOwnedResource(specOwnerOpenId, operator, ctx.identities);
}

/** 含风险接受条款的 Spec 与高风险执行使用同一负责人边界，普通白名单不能代拍板。 */
function assertSpecApprovalAuthority(
  ctx: AppContext,
  spec: import('../core/spec-store.js').ProductSpec,
  operator: UserIdentity,
): void {
  if (canonicalSpecHasRiskWaivers(spec.content)) {
    assertOwnedBy(spec.ownerOpenId, operator, ctx.identities);
    return;
  }
  assertSpecOwner(ctx, spec.ownerOpenId, operator);
}

async function releaseCreatingSession(
  ctx: AppContext,
  session: import('../core/session-manager.js').Session,
): Promise<import('../core/session-manager.js').Session> {
  const latest = ctx.sessions.get(session.id) ?? session;
  return latest.status === 'creating'
    ? ctx.sessions.transition(latest.id, 'idle')
    : latest;
}

function assertCurrentSpecCard(
  spec: import('../core/spec-store.js').ProductSpec,
  value: Record<string, unknown>,
): void {
  const version = typeof value.specVersion === 'string' ? value.specVersion.trim() : '';
  if (!version || version !== spec.updatedAt) {
    throw new Error(`这张 Spec 卡片已过期，请发送 /spec show ${spec.id} 获取最新版。`);
  }
}

function assertQuestionnaireAccess(
  ctx: AppContext,
  questionnaire: import('../core/questionnaire-store.js').Questionnaire,
  operator: UserIdentity,
  chatId?: string,
  topicId?: string,
): void {
  assertCanControlOwnedResource(questionnaire.ownerOpenId ?? '', operator, ctx.identities);
  if (chatId && questionnaire.chatId && questionnaire.chatId !== chatId) {
    throw new Error('问卷不属于当前会话。');
  }
  if (topicId && questionnaire.topicId && questionnaire.topicId !== topicId) {
    throw new Error('问卷不属于当前话题。');
  }
}

function messageIdentity(msg: IncomingMessage): UserIdentity {
  return {
    openId: msg.senderOpenId,
    userId: msg.senderUserId,
    unionId: msg.senderUnionId,
  };
}

function cardActionIdentity(action: CardAction): UserIdentity {
  return {
    openId: action.operatorOpenId,
    userId: action.operatorUserId,
    unionId: action.operatorUnionId,
  };
}

function assertCurrentQuestionnaireCard(
  questionnaire: import('../core/questionnaire-store.js').Questionnaire,
  value: Record<string, unknown>,
): void {
  const version = typeof value.questionnaireVersion === 'string'
    ? value.questionnaireVersion.trim()
    : '';
  if (!version || version !== questionnaire.updatedAt) {
    throw new Error(`这张问卷卡片已过期，请发送 /form ${questionnaire.id} 获取最新版。`);
  }
}

function runWorkflowContinuation(
  task: Promise<unknown>,
  label: string,
  onError?: (error: Error) => void,
): void {
  void task.catch((error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`[工作流] ${label}失败:`, sanitizeErrorForLog(err));
    onError?.(err);
  });
}

function notifyBlockedRetryFailure(
  ctx: AppContext,
  workflowId: string,
  initiator: Bot | undefined,
  messageId: string,
  message: string,
): void {
  void (async () => {
    await initiator?.reply(messageId, message, true).catch(() => undefined);
    // 回调卡已结算为不可交互状态；若认领前失败，补发一张新的可操作阻塞卡。
    if (ctx.workflows.get(workflowId)?.status === 'awaiting_step_unblock') {
      await resendBlockedCard(ctx, workflowId).catch((error) => {
        console.error(`[工作流] ${workflowId} 重试失败后的阻塞卡恢复失败:`, sanitizeErrorForLog(error));
      });
    }
  })();
}
