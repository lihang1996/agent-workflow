import {
  buildFixFromReviewPrompt,
  buildFollowUpReviewPrompt,
  buildInitialReviewPrompt,
  collabTopicKey,
  isReviewExplicitlyApproved,
  isReviewApproved,
} from '../core/collab.js';
import type { Bot, IncomingMessage } from '../im/lark.js';
import type { AppContext } from './app-context.js';
import { startCliTask } from './cli-task.js';
import { ensureRunnableSession, topicIdOf } from './sessions.js';
import type { CliExecutionPolicy } from '../cli/types.js';
import { sanitizeErrorForLog } from '../core/log-inspection.js';
import { parseStepResult } from '../core/step-result.js';

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
    /** 独立审查为 false，避免在完整交付门禁外自动修改代码。 */
    allowFixes?: boolean;
    /** 完整流水线启用；强制 RESULT 并让 blocked/failed 进入真实工作流终态。 */
    resultProtocol?: boolean;
    /** 流水线使用工作流 ID 隔离轮次；独立 /review 默认仍按飞书话题隔离。 */
    stateKey?: string;
    /** 协作自然结束时回调（通过 / 触顶）；供流水线续跑。 */
    onComplete?: (result: { approved: boolean; answer: string }) => Promise<void>;
    /** onComplete 已提交状态、当前任务卡落终态且会话释放后调用；供安全启动下一步骤。 */
    afterComplete?: (result: { approved: boolean; answer: string }) => Promise<void>;
    /** 在宣布通过前校验结构化审查证据；校验失败视为协作失败。 */
    validateApproval?: (answer: string) => Promise<void>;
    /** 在进入复审前校验并保存修复后的实现证据。 */
    validateFix?: (answer: string) => Promise<void>;
    /** 自动修复时附加的实现 Skill 与证据要求。 */
    fixInstruction?: string | (() => Promise<string>);
    onBlocked?: (result: { answer: string; reason?: string }) => Promise<void>;
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
    allowFixes = true,
    resultProtocol = false,
    stateKey,
    onComplete,
    afterComplete,
    validateApproval,
    validateFix,
    fixInstruction,
    onBlocked,
    onFailure,
  } = options;
  const hasThread = !!msg.threadId || !!msg.rootId;
  const reviewer = ctx.botsById.get('reviewer');
  const dev = ctx.botsById.get('dev');
  if (!reviewer) throw new Error('审查需要配置 reviewer Bot');
  if (allowFixes && !dev) throw new Error('自动修复协作需要同时配置 reviewer 与 dev 两个 Bot');

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
      console.error('[协作] 清理失败轮次异常:', sanitizeErrorForLog(persistError));
    });
    if (failureReported) return;
    failureReported = true;
    if (onFailure) await onFailure(error);
  };

  const reviewPrompt = priorDevResult
    ? buildFollowUpReviewPrompt(task, round, priorDevResult)
    : buildInitialReviewPrompt(task, round);
  let approvalValidated = false;
  let afterCurrentTask: (() => Promise<void>) | undefined;
  const approved = (answer: string) => validateApproval
    ? isReviewExplicitlyApproved(answer)
    : isReviewApproved(answer);

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
      resultProtocol,
      hideProtocolOutput: true,
      validateSuccess: validateApproval
        ? async (answer) => {
          if (!approved(answer)) return;
          await validateApproval(answer);
          approvalValidated = true;
        }
        : undefined,
      onFailure: reportFailure,
      onSuccess: async (reviewAnswer) => {
        if (ctx.shuttingDown) return;
        if (resultProtocol) {
          const result = parseStepResult(reviewAnswer);
          if (result.kind === 'blocked') {
            await ctx.collabStore.clearRound(topicKey);
            if (onBlocked) await onBlocked({ answer: reviewAnswer, reason: result.reason });
            else await reportFailure(new Error(result.reason || '评审协作报告阻塞'));
            return;
          }
        }
        if (approved(reviewAnswer)) {
          if (validateApproval && !approvalValidated) await validateApproval(reviewAnswer);
          console.log(`[协作] 第 ${round} 轮评审通过`);
          await ctx.collabStore.clearRound(topicKey);
          await initiator.reply(
            msg.messageId,
            `第 ${round} 轮评审通过（[APPROVED]）。协作结束。`,
            hasThread,
          );
          const completion = { approved: true, answer: reviewAnswer };
          if (onComplete) await onComplete(completion);
          if (afterComplete) afterCurrentTask = () => afterComplete(completion);
          return;
        }

        if (!allowFixes) {
          await ctx.collabStore.clearRound(topicKey);
          await initiator.reply(
            msg.messageId,
            '独立审查已完成但未通过；本命令不会自动修改代码。请使用 /squad 或 CEO 流水线落实修复并执行完整门禁。',
            hasThread,
          );
          const completion = { approved: false, answer: reviewAnswer };
          if (onComplete) await onComplete(completion);
          if (afterComplete) afterCurrentTask = () => afterComplete(completion);
          return;
        }

        const resolvedFixInstruction = typeof fixInstruction === 'function'
          ? await fixInstruction()
          : fixInstruction;
        afterCurrentTask = async () => {
          if (!dev) throw new Error('自动修复协作缺少 dev Bot');
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

          let fixValidated = false;
          let afterFixTask: (() => Promise<void>) | undefined;
          await startCliTask(ctx, {
            bot: dev,
            msg,
            session: devSession,
            prompt: buildFixFromReviewPrompt(reviewer, reviewAnswer, round, resolvedFixInstruction),
            executionPolicy,
            approvedScope,
            resultProtocol,
            hideProtocolOutput: true,
            validateSuccess: validateFix
              ? async (answer) => {
                await validateFix(answer);
                fixValidated = true;
              }
              : undefined,
            onFailure: reportFailure,
            onSuccess: async (devAnswer) => {
              if (ctx.shuttingDown) return;
              if (resultProtocol) {
                const result = parseStepResult(devAnswer);
                if (result.kind === 'blocked') {
                  await ctx.collabStore.clearRound(topicKey);
                  if (onBlocked) await onBlocked({ answer: devAnswer, reason: result.reason });
                  else await reportFailure(new Error(result.reason || '协作修复报告阻塞'));
                  return;
                }
              }
              if (validateFix && !fixValidated) await validateFix(devAnswer);
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
                const completion = { approved: false, answer: devAnswer };
                if (onComplete) await onComplete(completion);
                if (afterComplete) afterFixTask = () => afterComplete(completion);
                return;
              }

              const nextRound = round + 1;
              afterFixTask = async () => {
                console.log(`[协作] 开发完成，进入第 ${nextRound} 轮复审`);
                await runCollabReview(ctx, {
                  initiator,
                  msg,
                  task,
                  round: nextRound,
                  priorDevResult: devAnswer,
                  executionPolicy,
                  approvedScope,
                  allowFixes,
                  resultProtocol,
                  stateKey,
                  onComplete,
                  afterComplete,
                  validateApproval,
                  validateFix,
                  fixInstruction,
                  onBlocked,
                  onFailure,
                });
              };
            },
            afterSuccess: async () => {
              if (!afterFixTask) return;
              try {
                await afterFixTask();
              } catch (error) {
                await reportFailure(error instanceof Error ? error : new Error(String(error)));
              }
            },
          });
        };
      },
      afterSuccess: async () => {
        if (!afterCurrentTask) return;
        try {
          await afterCurrentTask();
        } catch (error) {
          await reportFailure(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
  } catch (error) {
    await reportFailure(error as Error);
    throw error;
  }
}
