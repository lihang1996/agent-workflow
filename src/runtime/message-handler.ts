import { getAdapter } from '../cli/registry.js';
import { isCliId } from '../cli/types.js';
import { parseCommand } from '../core/command-parser.js';
import {
  buildHandoffPrompt,
  listHandoffTargets,
  parseHandoffArg,
  resolveHandoffTarget,
} from '../core/handoff.js';
import { collabTopicKey } from '../core/collab.js';
import { filterRunnableSteps } from '../core/pipeline.js';
import { requestTaskAbort } from '../core/task-abort.js';
import { assertWorkdir } from '../core/workdir.js';
import { formatScheduleInterval, formatScheduleRunStatus, parseScheduleInterval } from '../core/schedule-store.js';
import { assertLogFile, redactSecrets, sanitizeForLog } from '../core/log-inspection.js';
import { highRiskReason, isHighRiskTask } from '../core/risk.js';
import { assertOwnedBy, isAuthorizedOperator } from '../core/access.js';
import { resolveMentions } from '../im/message-parser.js';
import { isAddressedToBot, type Bot, type IncomingMessage } from '../im/lark.js';
import {
  buildApprovalCard,
  buildQuestionnaireCard,
  buildSpecConfirmationCard,
  buildSpecReviewCard,
  buildSpecStatusCard,
} from '../im/workflow-card.js';
import type { AppContext } from './app-context.js';
import {
  freezeRunCard,
  interruptedCard,
} from './active-runs.js';
import { startCliTask } from './cli-task.js';
import { runCollabReview } from './collab-runner.js';
import {
  runDeliverySquad,
  runTeamPipeline,
  confirmSpecForReview,
  continueDeliveryWorkflow,
  rejectSpecConfirmation,
  resumeWorkflowAfterQuestionnaire,
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
  if (!isAuthorizedOperator({ senderOpenId: msg.senderOpenId, chatType: msg.chatType })) {
    console.warn(`[拒绝] bot=${bot.id} 未授权用户 sender=${msg.senderOpenId || '(空)'}`);
    await bot.reply(msg.messageId, '当前用户没有操作这个 Agent OS 的权限。', !!msg.threadId || !!msg.rootId);
    return;
  }

  const resolved = resolveMentions(msg.text, msg.mentions);
  const hasThread = !!msg.threadId || !!msg.rootId;
  const { session, isNew } = await ctx.sessions.resolve({
    messageId: msg.messageId,
    topicId: topicIdOf(msg),
    chatId: msg.chatId,
    threadId: msg.threadId,
    rootId: msg.rootId,
    botId: bot.id,
  });

  console.log(`[收到] bot=${bot.id}(${bot.name}) chat=${msg.chatId} threadId=${msg.threadId} rootId=${msg.rootId} sender=${msg.senderOpenId}`);
  console.log(`  原文: ${sanitizeForLog(msg.text, 500)}`);
  console.log(`  还原: ${sanitizeForLog(resolved, 500)}`);
  console.log(`  mentions: ${sanitizeForLog(msg.mentions.map((m) => `${m.key}=${m.name}(${m.openId})`).join(', ') || '(无)', 500)}`);
  console.log(`  [会话] ${isNew ? '新建' : '复用'} id=${session.id} status=${session.status} engine=${session.cliId}`);

  const command = parseCommand(resolved);
  if (command?.name === 'help') {
    await bot.reply(msg.messageId, buildHelpText(bot), hasThread);
    return;
  }
  if (command?.name === 'status') {
    await bot.reply(msg.messageId, formatSessionStatus(ctx, session, bot, msg), hasThread);
    return;
  }
  if (command?.name === 'workdir') {
    const topicId = topicIdOf(msg);
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
      await bot.reply(
        msg.messageId,
        [
          `当前引擎：${getAdapter(session.cliId).displayName} (${session.cliId})`,
          '用法：/engine claude 或 /engine codex',
        ].join('\n'),
        hasThread,
      );
      return;
    }
    const next = command.arg.toLowerCase();
    if (!isCliId(next)) {
      await bot.reply(msg.messageId, '只支持 /engine claude 或 /engine codex', hasThread);
      return;
    }
    try {
      const prev = session.cliId;
      const updated = await ctx.sessions.setCliId(session.id, next);
      console.log(`[引擎] bot=${bot.id} session=${session.id} ${prev} → ${updated.cliId}`);
      await bot.reply(
        msg.messageId,
        `已切换到 ${getAdapter(updated.cliId).displayName}。CLI 上下文已清空，后续任务将使用该引擎。`,
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
      assertQuestionnaireAccess(questionnaire, msg.senderOpenId, msg.chatId, topicIdOf(msg));
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
      const spec = ctx.specs.get(specId);
      if (!spec || spec.chatId !== msg.chatId || spec.topicId !== topicIdOf(msg)) {
        await bot.reply(msg.messageId, `找不到本话题 Spec：${specId}`, hasThread);
        return;
      }
      await bot.replyCard(msg.messageId, buildSpecStatusCard(spec), hasThread);
      return;
    }
    if (subcommand === 'publish' && specId) {
      try {
        const spec = ctx.specs.get(specId);
        if (!spec || spec.chatId !== msg.chatId || spec.topicId !== topicIdOf(msg)) throw new Error(`找不到本话题 Spec：${specId}`);
        assertSpecOwner(spec.ownerOpenId, msg.senderOpenId);
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

    if (isHighRiskTask(parsed.task)) {
      try {
        await requestHighRiskApproval(ctx, {
          bot: target,
          msg,
          prompt: buildHandoffPrompt(bot, parsed.task),
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
        prompt: buildHandoffPrompt(bot, parsed.task),
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
          '流程：reviewer 评审 → 意见自动回传 dev 修改 → 未通过且未达上限则继续复审',
          `当前最大轮次：${ctx.collabMaxRounds}（可用 COLLAB_MAX_ROUNDS 配置）`,
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
      const preview = filterRunnableSteps(ctx.pipelineSteps, new Set(ctx.botsById.keys()))
        .map((s) => s.title)
        .join(' → ');
      await bot.reply(
        msg.messageId,
        [
          '用法：/pipeline <目标>',
          `当前步骤：${preview || '(无可用步骤)'}`,
          '可用 PIPELINE_STEPS 定制，例如：pm,architect,dev,review,qa,summary',
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
      await bot.reply(msg.messageId, '用法：/squad <目标>\n步骤：架构 → 开发 → 评审 → QA', hasThread);
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
    try {
      await requestHighRiskApproval(ctx, {
        bot,
        msg,
        prompt: command.arg,
        action: 'task',
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
      if (!job || job.message.chatId !== msg.chatId || (job.message.threadId || job.message.rootId || job.message.messageId) !== topicId) {
        await bot.reply(msg.messageId, `找不到本话题定时任务：${second}`, hasThread);
        return;
      }
      try {
        assertOwnedBy(job.ownerOpenId, msg.senderOpenId);
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
  if (command?.name === 'close') {
    const running = ctx.activeRuns.get(session.id);
    if (running) {
      running.cancelMode = 'close';
      running.interruptReason = '本次任务已停止，当前会话已经关闭。';
      running.controller.abort();
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
    try {
      await requestHighRiskApproval(ctx, {
        bot,
        msg,
        prompt: resolved,
        action: 'task',
        reason: highRiskReason(resolved),
      });
    } catch (error) {
      await bot.reply(msg.messageId, (error as Error).message, hasThread);
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
      '直接描述目标 → 启动交付流水线（PM→架构→开发→评审→测试→汇总）',
      '/pipeline <目标> 显式启动流水线',
      '/squad <目标> 启动开发内部交付小队',
      '/schedule … 创建/管理定时任务',
      '/approval <任务> 发起高风险操作审批',
      '/handoff <角色> <任务> 只交给某一个角色',
      '/status 查看当前会话',
      '/workdir [路径] 查看/设置本话题项目目录（clear 清除）',
      '/engine claude|codex 切换执行引擎',
      '/review <任务> 评审→开发协作（意见自动回传，可多轮）',
      '/reset /reopen /close /clean 会话管理',
      '执行中可点任务卡片「停止任务」（仅发起人）',
    ].join('\n');
  }

  return [
    `我是 ${bot.name}（${bot.id}）`,
    '团队需求请先 @CEO助手；我适合承接本角色的具体任务。',
    '/status 查看当前会话',
    '/workdir [路径] 查看/设置本话题项目目录（clear 清除）',
    '/engine claude|codex 切换执行引擎',
    '/handoff <角色> <任务> 交接给同话题其他角色',
    '/review <任务> 评审→开发协作（意见自动回传，可多轮）',
    '/squad <目标> 架构→开发→评审→QA 内部交付小队',
    '/schedule … 创建/管理定时任务',
    '/approval <任务> 发起高风险操作审批',
    '/reset /reopen /close /clean 会话管理',
    '执行中可点任务卡片「停止任务」（仅发起人）',
  ].join('\n');
}

/** 卡片「停止任务」按钮：仅发起人可停。 */
export async function handleCardAction(
  ctx: AppContext,
  action: {
    operatorOpenId: string;
    messageId: string;
    value: Record<string, unknown>;
    formValue: Record<string, unknown>;
  },
) {
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
        assertOwnedBy(approval.ownerOpenId, action.operatorOpenId);
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
        const rejected = await ctx.approvals.reject(approval.id, action.operatorOpenId);
        await settleApprovalSchedule(ctx, rejected, 'skipped', '负责人拒绝审批').catch((error) => {
          console.error(`[审批] ${rejected.id} 拒绝结算失败:`, redactSecrets((error as Error).message).slice(0, 2_000));
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
      const executing = await executeApprovedAction(ctx, approval.id, action.operatorOpenId);
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
          console.error(`[审批] ${latest.id} 定时任务结算失败:`, redactSecrets((settleError as Error).message).slice(0, 2_000));
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
      assertSpecOwner(spec.ownerOpenId, action.operatorOpenId);
      assertCurrentSpecCard(spec, action.value);
      if (spec.status !== 'in_review') throw new Error(`当前 Spec 状态为 ${spec.status}，无法处理评审。`);

      if (action.value.action === 'approve_spec_review') {
        const approved = await approveSpecReview(ctx, spec.id);
        return {
          toast: { type: 'success' as const, content: '产品评审已通过，内部交付小队开始执行。' },
          card: { type: 'raw' as const, data: buildSpecReviewCard(approved) },
        };
      }

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
  if (action.value.action === 'publish_spec') {
    const specId = typeof action.value.specId === 'string' ? action.value.specId : '';
    try {
      const spec = ctx.specs.get(specId);
      if (!spec) throw new Error('Spec 不存在或已被删除。');
      assertSpecOwner(spec.ownerOpenId, action.operatorOpenId);
      assertCurrentSpecCard(spec, action.value);
      const published = await publishSpecToDoc(ctx, spec.id);
      return {
        toast: { type: 'success' as const, content: '已发布到飞书云文档，进入产品评审。' },
        card: { type: 'raw' as const, data: buildSpecReviewCard(published) },
      };
    } catch (error) {
      return { toast: { type: 'error' as const, content: (error as Error).message } };
    }
  }
  if (action.value.action === 'confirm_spec' || action.value.action === 'reject_spec') {
    const specId = typeof action.value.specId === 'string' ? action.value.specId : '';
    if (!specId) return { toast: { type: 'error' as const, content: 'Spec ID 缺失。' } };
    try {
      const spec = ctx.specs.get(specId);
      if (!spec) throw new Error('Spec 不存在或已被删除。');
      assertSpecOwner(spec.ownerOpenId, action.operatorOpenId);
      assertCurrentSpecCard(spec, action.value);
      if (spec.status !== 'pending_confirmation') {
        return { toast: { type: 'info' as const, content: `Spec 当前状态：${spec.status}` } };
      }
      const confirmed = action.value.action === 'confirm_spec';
      const feedback = typeof action.formValue.confirmationFeedback === 'string'
        ? action.formValue.confirmationFeedback.trim()
        : '';
      if (!confirmed && !feedback) {
        return { toast: { type: 'warning' as const, content: '退回修改时请填写具体意见。' } };
      }
      const updated = confirmed
        ? await confirmSpecForReview(ctx, spec.id)
        : (await rejectSpecConfirmation(ctx, spec.id, feedback)).spec;
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
      assertQuestionnaireAccess(questionnaire, action.operatorOpenId);
      const answers: Record<string, string | string[]> = {};
      for (const question of questionnaire.questions) {
        const raw = action.formValue[question.id];
        if (typeof raw === 'string') answers[question.id] = raw;
        else if (Array.isArray(raw)) answers[question.id] = raw.filter((item): item is string => typeof item === 'string');
      }
      const result = await ctx.questionnaires.recordAnswers(questionnaireId, answers);
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
  if (action.operatorOpenId !== run.ownerOpenId) {
    return { toast: { type: 'warning' as const, content: '只有任务发起人可以停止它。' } };
  }
  if (run.controller.signal.aborted) {
    freezeRunCard(run);
    return { toast: { type: 'info' as const, content: '正在停止任务，请稍候。' } };
  }

  // 先冻结进度 patch，再 abort，并在回调响应里直接回取消卡（须 3 秒内完成）。
  freezeRunCard(run);
  run.terminalStatus = 'interrupted';
  run.cardSettledByCallback = true;
  const detail = '本次任务已停止。你可以继续在当前话题里提问。';
  run.interruptReason = detail;
  const outcome = requestTaskAbort(ctx.activeRuns, sessionId, action.operatorOpenId);
  if (outcome !== 'stopped' && outcome !== 'already_stopping') {
    return { toast: { type: 'info' as const, content: '任务已经结束，无需再次停止。' } };
  }

  return {
    toast: { type: 'success' as const, content: '已发送停止指令。' },
    card: { type: 'raw' as const, data: interruptedCard(run, detail) },
  };
}

/** 指定负责人优先；未指定时由提出需求的人确认。 */
function assertSpecOwner(specOwnerOpenId: string, operatorOpenId: string): void {
  assertOwnedBy(specOwnerOpenId, operatorOpenId);
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
  questionnaire: import('../core/questionnaire-store.js').Questionnaire,
  operatorOpenId: string,
  chatId?: string,
  topicId?: string,
): void {
  assertOwnedBy(questionnaire.ownerOpenId ?? '', operatorOpenId);
  if (chatId && questionnaire.chatId && questionnaire.chatId !== chatId) {
    throw new Error('问卷不属于当前会话。');
  }
  if (topicId && questionnaire.topicId && questionnaire.topicId !== topicId) {
    throw new Error('问卷不属于当前话题。');
  }
}

function runWorkflowContinuation(task: Promise<void>, label: string): void {
  void task.catch((error) => {
    console.error(`[工作流] ${label}失败:`, (error as Error).message);
  });
}
