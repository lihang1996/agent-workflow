import { resolve } from 'node:path';
import { createAdapter } from '../cli/registry.js';
import { runCli } from '../cli/runner.js';
import type { CliEvent, CliExecutionPolicy } from '../cli/types.js';
import {
  answerContinuation,
  answerNeedsContinuation,
  buildTaskCard,
  splitLongText,
  ThrottledCardUpdater,
} from '../im/card.js';
import { extractResourceKeys } from '../im/message-parser.js';
import type { Bot, IncomingMessage } from '../im/lark.js';
import type { Session } from '../core/session-manager.js';
import { TaskProgressTracker } from '../core/task-progress.js';
import { sanitizeErrorForLog, sanitizeForLog } from '../core/log-inspection.js';
import { hasExplicitStepResult, parseStepResult } from '../core/step-result.js';
import { displayAgentOutput } from '../core/agent-output.js';
import { assertWorkdir } from '../core/workdir.js';
import type { AppContext } from './app-context.js';
import type { ActiveRun } from './types.js';
import {
  finishInterruptedRun,
  flushPersistActiveRuns,
  schedulePersistActiveRuns,
} from './active-runs.js';
import { markSessionIdle, topicIdOf, truncate, workdirFor } from './sessions.js';

/** 发卡 + 跑 CLI + 流式更新；支持完成后回调。 */
export async function startCliTask(
  ctx: AppContext,
  options: {
    bot: Bot;
    msg: IncomingMessage;
    session: Session;
    prompt: string;
    downloadResources?: boolean;
    workflowId?: string;
    executionPolicy?: CliExecutionPolicy;
    approvedScope?: string;
    /** 是否解析 [RESULT:done|blocked|failed] 标记；仅流水线非 PM 步骤启用 */
    resultProtocol?: boolean;
    /** 是否在卡片/续发文本中隐藏 RESULT、GATE_RESULT、DSML 等机器协议。 */
    hideProtocolOutput?: boolean;
    /** 在成功卡变绿前执行语义/门禁校验；抛错会落失败卡并进入 onFailure。 */
    validateSuccess?: (answer: string) => Promise<void>;
    onSuccess?: (answer: string) => Promise<void>;
    /** 当前任务终态卡已经提交且会话已释放后执行；适合启动同一 Bot 的下一流水线步骤。 */
    afterSuccess?: (answer: string) => Promise<void>;
    onFailure?: (error: Error) => Promise<void>;
  },
): Promise<void> {
  if (ctx.shuttingDown) {
    throw new Error('服务正在停止，无法启动新任务');
  }

  const {
    bot,
    msg,
    downloadResources = false,
    workflowId,
    executionPolicy = 'standard',
    approvedScope,
    resultProtocol = false,
    hideProtocolOutput = resultProtocol,
    validateSuccess,
    onSuccess,
    afterSuccess,
    onFailure,
  } = options;
  let taskPrompt = options.prompt.trim();
  let session = options.session;
  const hasThread = !!msg.threadId || !!msg.rootId;

  // 再次确认最新状态，避免交接瞬间并发
  const latest = ctx.sessions.get(session.id);
  if (!latest || latest.status === 'active') {
    throw new Error(`${bot.name} 当前正忙，请稍后再交接`);
  }
  if (latest.status === 'closed') {
    session = await ctx.sessions.reopen(latest.id);
  } else {
    session = latest;
  }

  const adapter = createAdapter(session.cliId);
  const cardTitle = `${bot.name} · ${adapter.displayName}`;
  // 持久化路径可能在服务运行期间被删除或被符号链接改向；每次执行前重新校验。
  const cwd = await assertWorkdir(workdirFor(ctx, session, bot, msg));
  console.log(`[项目] bot=${bot.id} 本次 cwd=${cwd}`);

  await ctx.sessions.transition(session.id, 'active');
  const controller = new AbortController();
  let resolveDone = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const tracker = new TaskProgressTracker(
    Date.now,
    ctx.contextWindows.get(session.id),
    executionPolicy === 'input-only' || !session.cliSessionId,
  );

  // 先发卡并同步落盘，再下载资源，缩短孤儿卡窗口。
  let cardId: string | undefined;
  try {
    cardId = await bot.replyCard(msg.messageId, buildTaskCard({
      title: cardTitle,
      status: 'running',
      detail: `正在启动 ${adapter.displayName}`,
      progress: tracker.snapshot(),
      abortSessionId: session.id,
    }), hasThread);
  } catch (error) {
    await markSessionIdle(ctx, session.id);
    resolveDone();
    throw error;
  }

  if (!cardId) {
    console.error('[卡片] 响应里没有 message_id，无法继续更新');
    await markSessionIdle(ctx, session.id);
    resolveDone();
    throw new Error('飞书未返回任务卡片 message_id，任务没有启动');
  }
  console.log(`[卡片] bot=${bot.id} message_id=${cardId} inThread=${hasThread} engine=${adapter.id}`);

  let activeRun!: ActiveRun;
  const reportFailure = async (error: Error) => {
    if (!onFailure) return;
    try {
      await onFailure(error);
    } catch (callbackError) {
      console.error('[工作流] 失败回调执行异常:', safeErrorMessage(callbackError));
    }
  };
  const cardUpdater = new ThrottledCardUpdater(async (card, options) => {
    // 进度 patch：终态后丢弃，避免盖掉取消/成功卡。
    // finish({ final: true })：必须放行，否则成功/失败卡永远写不上去。
    if (activeRun.terminalStatus && !options?.final) return;
    await bot.updateCard(cardId, card);
  });
  activeRun = {
    controller,
    ownerOpenId: msg.senderOpenId,
    bot,
    cardId,
    cardTitle,
    cardUpdater,
    tracker,
    lastEventAt: Date.now(),
    done,
    resolveDone,
  };
  ctx.activeRuns.set(session.id, activeRun);
  try {
    await flushPersistActiveRuns(ctx);
  } catch (error) {
    const launchError = new Error(`无法保存任务恢复快照，任务未启动：${safeErrorMessage(error)}`);
    activeRun.terminalStatus = 'failed';
    ctx.activeRuns.delete(session.id);
    await cardUpdater.finish(buildTaskCard({
      title: cardTitle,
      status: 'failed',
      detail: '任务恢复快照保存失败，CLI 没有启动。请检查 data 目录后重试。',
      technicalDetail: launchError.message,
      progress: tracker.snapshot(),
    })).catch((cardError) => {
      console.error(`[卡片] bot=${bot.id} 写入启动失败状态异常:`, safeErrorMessage(cardError));
    });
    await markSessionIdle(ctx, session.id).catch((stateError) => {
      console.error('[会话] 恢复启动失败状态异常:', safeErrorMessage(stateError));
    });
    resolveDone();
    await reportFailure(launchError);
    throw launchError;
  }

  if (downloadResources) {
    const resources = extractResourceKeys(msg.messageType, msg.rawContent);
    const downloadedPaths: string[] = [];
    for (const res of resources) {
      try {
        const savePath = await bot.downloadResource(
          msg.messageId,
          res.key,
          res.type,
          resolve('data', 'downloads'),
          res.fileName,
        );
        const absolutePath = resolve(savePath);
        downloadedPaths.push(absolutePath);
        console.log(`  [下载] ${res.type} → ${absolutePath}`);
      } catch (e) {
        console.error(`  [下载失败] ${sanitizeForLog(res.key, 200)}:`, safeErrorMessage(e));
      }
    }
    if (downloadedPaths.length > 0) {
      const resourceContext = [
        '消息中的资源已下载到以下路径，请按需读取或处理：',
        ...downloadedPaths.map((path) => `- ${path}`),
      ].join('\n');
      taskPrompt = taskPrompt
        ? `${taskPrompt}\n\n${resourceContext}`
        : resourceContext;
    } else if (!taskPrompt) {
      taskPrompt = '请根据当前消息完成任务。';
    }
  }

  if (ctx.shuttingDown) {
    await finishInterruptedRun(activeRun, '服务已停止，任务中断');
    ctx.activeRuns.delete(session.id);
    await flushPersistActiveRunsSafely(ctx);
    await markSessionIdle(ctx, session.id);
    resolveDone();
    return;
  }

  const pushLiveCard = () => {
    if (activeRun.terminalStatus) return;
    const snapshot = activeRun.tracker.snapshot();
    cardUpdater.push(buildTaskCard({
      title: cardTitle,
      status: 'running',
      detail: snapshot.current,
      progress: snapshot,
      abortSessionId: session.id,
    }));
    schedulePersistActiveRuns(ctx);
  };

  activeRun.heartbeat = setInterval(() => {
    if (activeRun.terminalStatus || ctx.shuttingDown) return;
    pushLiveCard();
  }, ctx.progressHeartbeatMs);
  activeRun.heartbeat.unref?.();

  const onCliEvent = (event: CliEvent) => {
    activeRun.lastEventAt = Date.now();
    switch (event.type) {
      case 'session':
        console.log(`[CLI:${bot.id}/${adapter.id}] session=${event.sessionId}`);
        break;
      case 'assistant':
        console.log(`[CLI:${bot.id}/${adapter.id}] assistant: ${truncate(sanitizeForLog(event.text, 500))}`);
        break;
      case 'tool_start':
        console.log(`[CLI:${bot.id}/${adapter.id}] tool_start: ${event.label}`);
        activeRun.tracker.accept(event);
        pushLiveCard();
        break;
      case 'tool_end':
        activeRun.tracker.accept(event);
        pushLiveCard();
        break;
      case 'context':
        activeRun.tracker.accept(event);
        pushLiveCard();
        break;
      case 'tool': {
        // 兼容旧适配器：合成 start/end 对，避免进度空白
        const toolUseId = `legacy-${event.name}-${Date.now()}`;
        activeRun.tracker.accept({
          type: 'tool_start',
          toolUseId,
          toolName: event.name,
          label: event.name,
          ...(event.inputSummary ? { detail: truncate(event.inputSummary, 60) } : {}),
          sessionId: event.sessionId,
        });
        activeRun.tracker.accept({
          type: 'tool_end',
          toolUseId,
          failed: false,
          sessionId: event.sessionId,
        });
        console.log(`[CLI:${bot.id}/${adapter.id}] tool: ${event.name}`);
        pushLiveCard();
        break;
      }
      case 'error':
        console.error(`[CLI:${bot.id}/${adapter.id}] stream error: ${safeErrorMessage(event.message)}`);
        break;
      case 'result':
        console.log(`[CLI:${bot.id}/${adapter.id}] result event received`);
        break;
    }
  };

  void runCli({
    adapter,
    prompt: taskPrompt,
    cwd,
    sessionId: executionPolicy === 'input-only' ? undefined : session.cliSessionId,
    signal: controller.signal,
    onEvent: onCliEvent,
    executionPolicy,
    approvedScope: executionPolicy === 'approved' ? (approvedScope ?? options.prompt) : undefined,
    env: {
      AGENT_OS_CHAT_ID: msg.chatId,
      AGENT_OS_TOPIC_ID: topicIdOf(msg),
      AGENT_OS_OWNER_OPEN_ID: msg.senderOpenId,
      AGENT_OS_BOT_ID: bot.id,
      AGENT_OS_MESSAGE_ID: msg.messageId,
      ...(workflowId ? { AGENT_OS_WORKFLOW_ID: workflowId } : {}),
    },
  })
    .then(async (result) => {
      if (
        executionPolicy !== 'input-only'
        && result.sessionId
        && result.sessionId !== session.cliSessionId
      ) {
        try {
          await ctx.sessions.setCliSessionId(session.id, result.sessionId);
        } catch (error) {
          console.error('[会话] 保存 CLI 上下文失败:', safeErrorMessage(error));
        }
      }
      if (executionPolicy !== 'input-only' && result.stats?.contextWindowTokens) {
        ctx.contextWindows.set(session.id, result.stats.contextWindowTokens);
      }
      // 仅流水线非 PM 步骤解析 RESULT 标记（resultProtocol=true 时）；
      // PM 产出的是 Spec 正文，普通聊天/handoff/定时/巡检也不解析，
      // 避免 Agent 在回答中举例 [RESULT:failed] 被误判为任务失败。
      const stepResult = resultProtocol ? parseStepResult(result.answer) : { kind: 'done' as const };
      if (resultProtocol && !hasExplicitStepResult(result.answer)) {
        throw new Error('流水线步骤缺少显式 [RESULT:done|blocked|failed] 终态标记，不能按成功处理。');
      }
      const visibleAnswer = hideProtocolOutput ? displayAgentOutput(result.answer) : result.answer;
      // CLI exit 0 只代表进程完成；结构化门禁也通过后，卡片才允许显示绿色成功。
      if (stepResult.kind === 'done' && validateSuccess) {
        await validateSuccess(result.answer);
      }
      if (activeRun.heartbeat) clearInterval(activeRun.heartbeat);
      if (!ctx.shuttingDown) {
        if (stepResult.kind !== 'failed' && onSuccess) {
          // 先原子提交业务/工作流终态；提交失败时不能显示绿色成功卡。
          await onSuccess(result.answer);
        }
      }

      // 只有语义校验与控制器提交均成功后，才渲染最终颜色。
      const cardStatus = stepResult.kind === 'blocked'
        ? 'blocked' as const
        : stepResult.kind === 'failed'
          ? 'failed' as const
          : 'success' as const;
      const cardDetail = stepResult.kind === 'blocked'
        ? (stepResult.reason || '任务阻塞，等待人工处理')
        : stepResult.kind === 'failed'
          ? (stepResult.reason || '步骤报告失败')
          : '执行完成';
      const finalCard = buildTaskCard({
        title: cardTitle,
        status: cardStatus,
        detail: cardDetail,
        progress: activeRun.tracker.snapshot(),
        answer: visibleAnswer,
        stats: result.stats,
        recipientOpenId: msg.senderOpenId,
        ...(cardStatus === 'failed' && stepResult.reason
          ? { technicalDetail: stepResult.reason }
          : {}),
      });
      let cardDelivered = false;
      try {
        await cardUpdater.finish(finalCard);
        cardDelivered = true;
      } catch (error) {
        console.error(`[卡片] bot=${bot.id} 写入成功终态失败:`, safeErrorMessage(error));
        try {
          await bot.updateCard(cardId, finalCard);
          cardDelivered = true;
        } catch (retryError) {
          console.error(`[卡片] bot=${bot.id} 重试成功终态失败:`, safeErrorMessage(retryError));
        }
      }
      const fallbackPrefix = cardStatus === 'blocked'
        ? `⏸️ ${cardTitle} 已阻塞`
        : cardStatus === 'failed'
          ? `❌ ${cardTitle} 步骤失败`
          : `✅ ${cardTitle} 执行完成`;
      if (!cardDelivered) {
        for (const chunk of splitLongText(`${fallbackPrefix}\n\n${visibleAnswer}`)) {
          await bot.reply(msg.messageId, chunk, hasThread).catch((error) => {
            console.error(`[卡片] bot=${bot.id} 文本兜底发送失败:`, safeErrorMessage(error));
            return undefined;
          });
        }
      } else if (answerNeedsContinuation(visibleAnswer)) {
        for (const chunk of splitLongText(answerContinuation(visibleAnswer))) {
          await bot.reply(msg.messageId, chunk, hasThread).catch((error) => {
            console.error(`[卡片] bot=${bot.id} 长回答续发失败:`, safeErrorMessage(error));
            return undefined;
          });
        }
      }
      activeRun.terminalStatus = cardStatus === 'failed' ? 'failed' : 'success';
      await flushPersistActiveRunsSafely(ctx);
      await markSessionIdle(ctx, session.id);
      if (!ctx.shuttingDown && stepResult.kind === 'failed') {
        // 先落失败卡并释放会话，再允许失败回调启动返工；否则旧任务可能把新任务写回 idle。
        await reportFailure(new Error(stepResult.reason || '步骤报告 [RESULT:failed]'));
      } else if (!ctx.shuttingDown && afterSuccess) {
        // 下一任务已经越过本任务的提交边界。此处异常不得反向覆盖已经成功提交的终态；
        // 续跑方应自行持久化恢复状态，服务重启也会继续拾取 ready 工作流。
        try {
          await afterSuccess(result.answer);
        } catch (error) {
          console.error('[任务] 成功后的续跑动作异常:', safeErrorMessage(error));
        }
      }
      console.log(
        `[CLI:${bot.id}/${adapter.id}] 完成 session_id=${result.sessionId ?? '(无)'} result=${stepResult.kind}`,
      );
    })
    .catch(async (error) => {
      if (activeRun.heartbeat) clearInterval(activeRun.heartbeat);
      if (controller.signal.aborted) {
        const detail = activeRun.interruptReason
          ?? (activeRun.cancelMode === 'close'
            ? '本次任务已停止，当前会话已经关闭。'
            : '本次任务已停止。你可以继续在当前话题里提问。');
        console.log(`[CLI:${bot.id}/${adapter.id}] ${detail}`);
        if (!ctx.shuttingDown && !activeRun.cardSettledByCallback) {
          await finishInterruptedRun(activeRun, detail);
        }
        if (!ctx.shuttingDown) await reportFailure(new Error(detail));
        return;
      }
      activeRun.terminalStatus = 'failed';
      const message = safeErrorMessage(error);
      const safeError = new Error(message);
      console.error(`[CLI:${bot.id}/${adapter.id}] 执行失败:`, message);
      try {
        await cardUpdater.finish(buildTaskCard({
          title: cardTitle,
          status: 'failed',
          detail: '执行没有完成。你可以调整指令后，在当前话题里重试。',
          technicalDetail: message,
          progress: activeRun.tracker.snapshot(),
        }));
      } catch (cardError) {
        console.error(`[卡片] bot=${bot.id} 写入失败终态异常:`, safeErrorMessage(cardError));
        await bot.reply(msg.messageId, `❌ ${cardTitle} 执行失败：${message}`, hasThread).catch(() => undefined);
      }
      // 失败回调可能立即把 runtime_audit 退回同一个 qa Bot 重跑；必须先释放旧会话，
      // 否则续跑会把“会话仍 active”误判成永久工作流失败。finally 用所有权检查避免覆盖新任务。
      await markSessionIdle(ctx, session.id).catch((stateError) => {
        console.error('[会话] 释放失败任务会话异常:', safeErrorMessage(stateError));
      });
      await reportFailure(safeError);
    })
    .finally(async () => {
      if (activeRun.heartbeat) clearInterval(activeRun.heartbeat);
      const stillOwnsSession = ctx.activeRuns.get(session.id) === activeRun;
      if (stillOwnsSession) ctx.activeRuns.delete(session.id);
      await flushPersistActiveRunsSafely(ctx);
      // onSuccess 可能已经让同一 Bot 启动下一步骤；旧任务不得把新任务的 active 状态覆盖成 idle。
      if (stillOwnsSession) {
        try {
          await markSessionIdle(ctx, session.id);
        } catch (error) {
          console.error('[会话] 保存空闲状态失败:', safeErrorMessage(error));
        }
      }
      resolveDone();
    })
    .catch((error) => {
      console.error('[任务] 回传或收尾失败:', safeErrorMessage(error));
    });
}

function safeErrorMessage(error: unknown): string {
  return sanitizeErrorForLog(error);
}

async function flushPersistActiveRunsSafely(ctx: AppContext): Promise<void> {
  await flushPersistActiveRuns(ctx).catch((error) => {
    console.error('[任务] 持久化任务终态失败:', safeErrorMessage(error));
  });
}
