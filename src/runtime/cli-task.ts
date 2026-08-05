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
import { redactSecrets, sanitizeForLog } from '../core/log-inspection.js';
import { assertWorkdir } from '../core/workdir.js';
import type { AppContext } from './app-context.js';
import type { ActiveRun } from './types.js';
import {
  finishInterruptedRun,
  flushPersistActiveRuns,
  schedulePersistActiveRuns,
} from './active-runs.js';
import { markSessionIdle, truncate, workdirFor } from './sessions.js';

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
    onSuccess?: (answer: string) => Promise<void>;
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
    onSuccess,
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
      console.error('[工作流] 失败回调执行异常:', (callbackError as Error).message);
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
        console.error(`  [下载失败] ${res.key}:`, (e as Error).message);
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
      AGENT_OS_TOPIC_ID: msg.threadId || msg.rootId || msg.messageId,
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
      // 先标记成功，防止停机逻辑把绿卡盖成红卡。
      activeRun.terminalStatus = 'success';
      if (activeRun.heartbeat) clearInterval(activeRun.heartbeat);
      const finalCard = buildTaskCard({
        title: cardTitle,
        status: 'success',
        detail: '执行完成',
        progress: activeRun.tracker.snapshot(),
        answer: result.answer,
        stats: result.stats,
        recipientOpenId: msg.senderOpenId,
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
      if (!cardDelivered) {
        for (const chunk of splitLongText(`✅ ${cardTitle} 执行完成\n\n${result.answer}`)) {
          await bot.reply(msg.messageId, chunk, hasThread).catch((error) => {
            console.error(`[卡片] bot=${bot.id} 文本兜底发送失败:`, safeErrorMessage(error));
            return undefined;
          });
        }
      } else if (answerNeedsContinuation(result.answer)) {
        for (const chunk of splitLongText(answerContinuation(result.answer))) {
          await bot.reply(msg.messageId, chunk, hasThread).catch((error) => {
            console.error(`[卡片] bot=${bot.id} 长回答续发失败:`, safeErrorMessage(error));
            return undefined;
          });
        }
      }
      console.log(`[CLI:${bot.id}/${adapter.id}] 完成 session_id=${result.sessionId ?? '(无)'}`);
      if (ctx.activeRuns.get(session.id) === activeRun) ctx.activeRuns.delete(session.id);
      await flushPersistActiveRunsSafely(ctx);
      try {
        await markSessionIdle(ctx, session.id);
      } catch (error) {
        console.error('[会话] 保存空闲状态失败:', safeErrorMessage(error));
      }
      // 停机中禁止协作续跑，避免与收尾打架。
      if (!ctx.shuttingDown && onSuccess) {
        try {
          await onSuccess(result.answer);
        } catch (error) {
          const callbackError = new Error(safeErrorMessage(error));
          console.error('[工作流] 成功后的续跑失败:', callbackError.message);
          await reportFailure(callbackError);
          await bot.reply(msg.messageId, `任务本身已完成，但后续工作流失败：${callbackError.message}`, hasThread)
            .catch(() => undefined);
        }
      }
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
      await reportFailure(safeError);
    })
    .finally(async () => {
      if (activeRun.heartbeat) clearInterval(activeRun.heartbeat);
      if (ctx.activeRuns.get(session.id) === activeRun) ctx.activeRuns.delete(session.id);
      await flushPersistActiveRunsSafely(ctx);
      try {
        await markSessionIdle(ctx, session.id);
      } catch (error) {
        console.error('[会话] 保存空闲状态失败:', safeErrorMessage(error));
      }
      resolveDone();
    })
    .catch((error) => {
      console.error('[任务] 回传或收尾失败:', safeErrorMessage(error));
    });
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message.trim() || '未知错误').slice(-2_000);
}

async function flushPersistActiveRunsSafely(ctx: AppContext): Promise<void> {
  await flushPersistActiveRuns(ctx).catch((error) => {
    console.error('[任务] 持久化任务终态失败:', safeErrorMessage(error));
  });
}
