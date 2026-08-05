import {
  buildFixFromReviewPrompt,
  buildFollowUpReviewPrompt,
  buildInitialReviewPrompt,
  collabTopicKey,
  isReviewApproved,
} from '../core/collab.js';
import type { Bot, IncomingMessage } from '../im/lark.js';
import type { AppContext } from './app-context.js';
import { startCliTask } from './cli-task.js';
import { ensureRunnableSession, topicIdOf } from './sessions.js';
import type { CliExecutionPolicy } from '../cli/types.js';

/** reviewer →（未通过则）dev → 复审，直到通过或达上限。 */
export async function runCollabReview(
  ctx: AppContext,
  options: {
    initiator: Bot;
    msg: IncomingMessage;
    task: string;
    round: number;
    priorDevResult?: string;
    executionPolicy?: CliExecutionPolicy;
    approvedScope?: string;
    /** 流水线使用工作流 ID 隔离轮次；独立 /review 默认仍按飞书话题隔离。 */
    stateKey?: string;
    /** 协作自然结束时回调（通过 / 触顶）；供流水线续跑。 */
    onComplete?: (result: { approved: boolean; answer: string }) => Promise<void>;
    onFailure?: (error: Error) => Promise<void>;
  },
): Promise<void> {
  const {
    initiator,
    msg,
    task,
    round,
    priorDevResult,
    executionPolicy = 'standard',
    approvedScope,
    stateKey,
    onComplete,
    onFailure,
  } = options;
  const hasThread = !!msg.threadId || !!msg.rootId;
  const reviewer = ctx.botsById.get('reviewer');
  const dev = ctx.botsById.get('dev');
  if (!reviewer || !dev) {
    throw new Error('协作需要同时配置 reviewer 与 dev 两个 Bot');
  }

  if (ctx.shuttingDown) {
    throw new Error('服务正在停止，无法启动协作');
  }

  const topicKey = stateKey ?? collabTopicKey(msg.chatId, topicIdOf(msg));
  const reviewerSession = await ensureRunnableSession(ctx, reviewer, msg);
  if (!reviewerSession) {
    throw new Error(`${reviewer.name} 正在执行任务，请稍后再发起评审`);
  }
  await ctx.collabStore.setRound(topicKey, round);
  let failureReported = false;
  const reportFailure = async (error: Error) => {
    await ctx.collabStore.clearRound(topicKey).catch((persistError) => {
      console.error('[协作] 清理失败轮次异常:', (persistError as Error).message);
    });
    if (failureReported) return;
    failureReported = true;
    if (onFailure) await onFailure(error);
  };

  const reviewPrompt = priorDevResult
    ? buildFollowUpReviewPrompt(task, round, priorDevResult)
    : buildInitialReviewPrompt(task, round);

  console.log(`[协作] 第 ${round}/${ctx.collabMaxRounds} 轮评审开始`);
  try {
    await initiator.reply(
      msg.messageId,
      `协作第 ${round}/${ctx.collabMaxRounds} 轮：交给 ${reviewer.name} 评审。`,
      hasThread,
    );

    await startCliTask(ctx, {
      bot: reviewer,
      msg,
      session: reviewerSession,
      prompt: reviewPrompt,
      executionPolicy,
      approvedScope,
      onFailure: reportFailure,
      onSuccess: async (reviewAnswer) => {
        if (ctx.shuttingDown) return;
        if (isReviewApproved(reviewAnswer)) {
          console.log(`[协作] 第 ${round} 轮评审通过`);
          await ctx.collabStore.clearRound(topicKey);
          await initiator.reply(
            msg.messageId,
            `第 ${round} 轮评审通过（[APPROVED]）。协作结束。`,
            hasThread,
          );
          if (onComplete) await onComplete({ approved: true, answer: reviewAnswer });
          return;
        }

        const devSession = await ensureRunnableSession(ctx, dev, msg);
        if (!devSession) {
          await initiator.reply(
            msg.messageId,
            `${dev.name} 正忙，评审意见未能自动回传。请稍后手动 /handoff dev。`,
            hasThread,
          );
          await reportFailure(new Error(`${dev.name} 正忙，评审意见未能自动回传。`));
          return;
        }

        console.log(`[协作] 第 ${round} 轮：评审意见回传开发`);
        await initiator.reply(
          msg.messageId,
          `第 ${round} 轮评审未通过，意见已自动回传给 ${dev.name}。`,
          hasThread,
        );

        await startCliTask(ctx, {
          bot: dev,
          msg,
          session: devSession,
          prompt: buildFixFromReviewPrompt(reviewer, reviewAnswer, round),
          executionPolicy,
          approvedScope,
          onFailure: reportFailure,
          onSuccess: async (devAnswer) => {
            if (ctx.shuttingDown) return;
            if (round >= ctx.collabMaxRounds) {
              console.log(`[协作] 已达最大轮次 ${ctx.collabMaxRounds}，停止自动循环`);
              await ctx.collabStore.clearRound(topicKey);
              await initiator.reply(
                msg.messageId,
                [
                  `已完成 ${round} 轮协作（达到上限 ${ctx.collabMaxRounds}）。`,
                  '如需继续，请再次发送 /review <任务>，或人工确认结果。',
                ].join('\n'),
                hasThread,
              );
              if (onComplete) await onComplete({ approved: false, answer: devAnswer });
              return;
            }

            const nextRound = round + 1;
            console.log(`[协作] 开发完成，进入第 ${nextRound} 轮复审`);
            await runCollabReview(ctx, {
              initiator,
              msg,
              task,
              round: nextRound,
              priorDevResult: devAnswer,
              executionPolicy,
              approvedScope,
              stateKey,
              onComplete,
              onFailure,
            });
          },
        });
      },
    });
  } catch (error) {
    await reportFailure(error as Error);
    throw error;
  }
}
