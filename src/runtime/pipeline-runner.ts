import { buildPipelineStepPrompt, filterRunnableSteps } from '../core/pipeline.js';
import type { Bot, IncomingMessage } from '../im/lark.js';
import type { AppContext } from './app-context.js';
import { runCollabReview } from './collab-runner.js';
import { startCliTask } from './cli-task.js';
import { ensureRunnableSession, topicIdOf, truncate } from './sessions.js';
import { buildSpecConfirmationCard } from '../im/workflow-card.js';

/** CEO 团队交付流水线：按步骤串联各角色，最后由 CEO 汇总。 */
export async function runTeamPipeline(
  ctx: AppContext,
  options: {
    ceo: Bot;
    msg: IncomingMessage;
    goal: string;
  },
): Promise<void> {
  const { ceo, msg, goal } = options;
  const hasThread = !!msg.threadId || !!msg.rootId;
  if (ctx.shuttingDown) throw new Error('服务正在停止，无法启动流水线');

  const available = new Set(ctx.botsById.keys());
  const steps = filterRunnableSteps(ctx.pipelineSteps, available);
  if (steps.length === 0) {
    throw new Error('没有可执行的流水线步骤，请检查 Bot 配置');
  }

  console.log(`[流水线] 目标=${truncate(goal, 60)} 步骤=${steps.map((s) => s.id).join(' → ')}`);
  await ceo.reply(
    msg.messageId,
    [
      '已启动团队交付流水线。',
      `目标：${goal}`,
      `步骤：${steps.map((s, i) => `${i + 1}.${s.title}`).join(' → ')}`,
    ].join('\n'),
    hasThread,
  );

  const priorOutputs: Record<string, string> = {};

  const runStep = async (stepIndex: number): Promise<void> => {
    if (ctx.shuttingDown) return;
    if (stepIndex >= steps.length) {
      await ceo.reply(msg.messageId, '团队交付流水线已全部完成。', hasThread);
      return;
    }

    const step = steps[stepIndex];
    const stepLabel = `步骤 ${stepIndex + 1}/${steps.length} · ${step.title}`;

    if (step.id === 'review') {
      await ceo.reply(msg.messageId, `${stepLabel}：启动评审协作。`, hasThread);
      await runCollabReview(ctx, {
        initiator: ceo,
        msg,
        task: buildPipelineStepPrompt(step, goal, priorOutputs),
        round: 1,
        onComplete: async ({ approved, answer }) => {
          priorOutputs.review = answer;
          await ceo.reply(
            msg.messageId,
            approved
              ? `${stepLabel} 已通过，继续下一步。`
              : `${stepLabel} 已结束（未完全通过或达轮次上限），继续下一步。`,
            hasThread,
          );
          await runStep(stepIndex + 1);
        },
      });
      return;
    }

    const actor = ctx.botsById.get(step.botId);
    if (!actor) {
      await ceo.reply(msg.messageId, `${stepLabel}：角色 ${step.botId} 未连接，跳过。`, hasThread);
      await runStep(stepIndex + 1);
      return;
    }

    const actorSession = await ensureRunnableSession(ctx, actor, msg);
    if (!actorSession) {
      await ceo.reply(
        msg.messageId,
        `${stepLabel}：${actor.name} 正忙，流水线中止。请稍后重试 /pipeline。`,
        hasThread,
      );
      return;
    }

    await ceo.reply(msg.messageId, `${stepLabel}：交给 ${actor.name}。`, hasThread);
    await startCliTask(ctx, {
      bot: actor,
      msg,
      session: actorSession,
      prompt: buildPipelineStepPrompt(step, goal, priorOutputs),
      onSuccess: async (answer) => {
        if (ctx.shuttingDown) return;
        priorOutputs[step.id] = answer;
        if (step.id === 'pm') {
          const spec = await ctx.specs.create({
            title: goal.slice(0, 80),
            content: answer,
            chatId: msg.chatId,
            topicId: topicIdOf(msg),
            messageId: msg.messageId,
            ownerOpenId: msg.senderOpenId,
            botId: actor.id,
          });
          await actor.replyCard(msg.messageId, buildSpecConfirmationCard(spec), hasThread);
          await ceo.reply(msg.messageId, `产品 Spec 已生成（${spec.id}），等待确认卡片操作。`, hasThread);
        }
        await runStep(stepIndex + 1);
      },
    });
  };

  await runStep(0);
}
