/**
 * Agent OS 入口。
 * 多 Bot 入群 + 话题项目目录 + 任务交接 + CEO 团队流水线 + Claude/Codex 双引擎。
 */
import 'dotenv/config';
import { join, resolve } from 'node:path';
import { startBot, isAddressedToBot, type Bot, type IncomingMessage } from './im/lark.js';
import { buildTaskCard, ThrottledCardUpdater } from './im/card.js';
import { resolveMentions, extractResourceKeys } from './im/message-parser.js';
import { parseCommand } from './core/command-parser.js';
import { loadBotConfigs } from './core/bot-config.js';
import {
  buildHandoffPrompt,
  listHandoffTargets,
  parseHandoffArg,
  resolveHandoffTarget,
} from './core/handoff.js';
import {
  buildFixFromReviewPrompt,
  buildFollowUpReviewPrompt,
  buildInitialReviewPrompt,
  collabTopicKey,
  isReviewApproved,
  parseMaxRounds,
} from './core/collab.js';
import {
  JsonActiveRunStore,
  type PersistedActiveRun,
} from './core/active-run-store.js';
import { JsonCollabStore } from './core/collab-store.js';
import {
  buildPipelineStepPrompt,
  filterRunnableSteps,
  parsePipelineSteps,
} from './core/pipeline.js';
import { SessionManager, type Session } from './core/session-manager.js';
import { JsonSessionStore } from './core/session-store.js';
import { JsonTopicStore } from './core/topic-store.js';
import { assertWorkdir, resolveWorkdir } from './core/workdir.js';
import { createAdapter, getAdapter, listEngines } from './cli/registry.js';
import { runCli } from './cli/runner.js';
import { isCliId, type CliEvent, type CliId } from './cli/types.js';

const defaultCliId = parseDefaultCliId(process.env.DEFAULT_CLI);
const MAX_ACTIVITIES = 5;
const COLLAB_MAX_ROUNDS = parseMaxRounds(process.env.COLLAB_MAX_ROUNDS);
const PIPELINE_STEPS = parsePipelineSteps(process.env.PIPELINE_STEPS);
const SHUTDOWN_GRACE_MS = 15_000;
const ACTIVE_RUN_PERSIST_DEBOUNCE_MS = 800;
const THINKING_HEARTBEAT_MS = 15_000;
const botConfigs = loadBotConfigs();
const botsById = new Map<string, Bot>();

if (botConfigs.length === 0) {
  console.error('未找到任何 Bot 凭证，请在 .env 配置 BOT_DEV_* / BOT_A_* 等');
  process.exit(1);
}

/** 解析 DEFAULT_CLI，非法值回退 claude。 */
function parseDefaultCliId(value: string | undefined): CliId {
  if (!value) return 'claude';
  const normalized = value.trim().toLowerCase();
  if (isCliId(normalized)) return normalized;
  console.warn(`[配置] 未知 DEFAULT_CLI=${value}，回退到 claude`);
  return 'claude';
}

/** 话题 ID：thread > root > message。 */
function topicIdOf(msg: IncomingMessage): string {
  return msg.threadId || msg.rootId || msg.messageId;
}

/** 按优先级解析本次任务工作目录。 */
function workdirFor(session: Session, bot: Bot, msg: IncomingMessage): string {
  return resolveWorkdir({
    topicWorkdir: topics.getWorkdir(msg.chatId, topicIdOf(msg)),
    botWorkdir: bot.workdir,
    cliId: session.cliId,
  });
}

console.log('Agent OS 启动，正在建立飞书长连接…');
for (const engine of listEngines()) {
  console.log(`[CLI] ${engine.id}=${engine.command} fallbackCwd=${resolveWorkdir({ cliId: engine.id })}`);
}
console.log(`[CLI] 默认引擎=${defaultCliId}`);
console.log(`[协作] 最大轮次=${COLLAB_MAX_ROUNDS}`);
console.log(`[流水线] 步骤=${PIPELINE_STEPS.map((s) => s.id).join(' → ')}`);
console.log(`[Bot] 将启动 ${botConfigs.length} 个角色: ${botConfigs.map((b) => b.id).join(', ')}`);
for (const config of botConfigs) {
  if (config.workdir) console.log(`[Bot] ${config.id} 默认工作目录=${config.workdir}`);
}

const sessions = await SessionManager.open({
  store: new JsonSessionStore(join('data', 'sessions.json')),
  defaultCliId,
});
const topics = await JsonTopicStore.open(join('data', 'topics.json'));
const collabStore = await JsonCollabStore.open(join('data', 'collab-rounds.json'));
const activeRunStore = new JsonActiveRunStore(join('data', 'active-runs.json'));
console.log(
  `[会话] 已恢复 ${sessions.size} 个会话，${topics.size} 个话题项目目录，${collabStore.size} 个协作轮次`,
);

type TerminalStatus = 'success' | 'failed' | 'interrupted';

interface ActiveRun {
  controller: AbortController;
  bot: Bot;
  cardId: string;
  cardTitle: string;
  cardUpdater: ThrottledCardUpdater;
  progress: number;
  detail: string;
  activities: string[];
  lastEventAt: number;
  heartbeat?: ReturnType<typeof setInterval>;
  terminalStatus?: TerminalStatus;
  interruptReason?: string;
  done: Promise<void>;
  resolveDone: () => void;
}

const activeRuns = new Map<string, ActiveRun>();
let shuttingDown = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

/** 导出未成功结束的进行中任务快照。 */
function snapshotActiveRuns(): PersistedActiveRun[] {
  const now = new Date().toISOString();
  return [...activeRuns.entries()]
    .filter(([, run]) => run.terminalStatus !== 'success')
    .map(([sessionId, run]) => ({
      sessionId,
      botId: run.bot.id,
      cardId: run.cardId,
      cardTitle: run.cardTitle,
      progress: run.progress,
      detail: run.detail,
      activities: [...run.activities],
      updatedAt: now,
    }));
}

/** 立即写入 active-runs.json。 */
async function persistActiveRuns(): Promise<void> {
  try {
    const runs = snapshotActiveRuns();
    if (runs.length === 0) await activeRunStore.clear();
    else await activeRunStore.save(runs);
  } catch (error) {
    console.error('[任务] 持久化进行中卡片失败:', (error as Error).message);
  }
}

/** 防抖落盘，避免每个工具事件都写磁盘。 */
function schedulePersistActiveRuns(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void persistActiveRuns();
  }, ACTIVE_RUN_PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
}

/** 取消防抖并立刻落盘（发卡/收尾时用）。 */
async function flushPersistActiveRuns(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  await persistActiveRuns();
}

/** 构造「已中断」失败卡片。 */
function interruptedCard(run: Pick<ActiveRun, 'cardTitle' | 'progress' | 'detail' | 'activities'>, detail: string) {
  return buildTaskCard({
    title: run.cardTitle,
    status: 'failed',
    progress: run.progress,
    detail,
    activities: run.activities,
  });
}

/** 把进行中任务卡片刷成失败；已成功的跳过。 */
async function finishInterruptedRun(run: ActiveRun, detail: string): Promise<void> {
  if (run.terminalStatus === 'success') return;
  run.terminalStatus = 'interrupted';
  try {
    await run.cardUpdater.finish(interruptedCard(run, detail));
  } catch {
    try {
      await run.bot.updateCard(run.cardId, interruptedCard(run, detail));
    } catch {
      await run.cardUpdater.cancel();
    }
  }
}

/** 启动时收尾上次遗留的任务卡片。 */
async function reconcileOrphanedCards(): Promise<void> {
  const orphans = await activeRunStore.load();
  if (orphans.length === 0) return;

  console.log(`[任务] 发现 ${orphans.length} 张上次未收尾的任务卡片，正在标记为中断…`);
  for (const orphan of orphans) {
    const bot = botsById.get(orphan.botId);
    if (!bot) {
      console.warn(`[任务] 无法收尾卡片 bot=${orphan.botId} card=${orphan.cardId}（Bot 未连接）`);
      continue;
    }
    try {
      await bot.updateCard(orphan.cardId, buildTaskCard({
        title: orphan.cardTitle,
        status: 'failed',
        progress: orphan.progress,
        detail: '上次服务异常退出，任务已中断',
        activities: orphan.activities,
      }));
      console.log(`[任务] 已收尾遗留卡片 bot=${orphan.botId} card=${orphan.cardId}`);
    } catch (error) {
      console.error(
        `[任务] 收尾遗留卡片失败 bot=${orphan.botId} card=${orphan.cardId}:`,
        (error as Error).message,
      );
    }
  }
  await activeRunStore.clear();
}

/** SIGTERM/异常退出时中断未完成任务并刷卡。 */
async function shutdownActiveRuns(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const entries = [...activeRuns.entries()];
  if (entries.length === 0) {
    await flushPersistActiveRuns().catch(() => undefined);
    return;
  }

  const toInterrupt = entries.filter(([, run]) => run.terminalStatus !== 'success');
  console.log(
    `[任务] 停机收尾：共 ${entries.length} 个任务，中断 ${toInterrupt.length} 个（已成功 ${entries.length - toInterrupt.length} 个跳过）`,
  );
  for (const [, run] of toInterrupt) {
    run.interruptReason = reason;
    run.controller.abort();
  }

  await Promise.race([
    Promise.all(entries.map(([, run]) => run.done)),
    new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
  ]);

  for (const [sessionId, run] of entries) {
    if (run.heartbeat) clearInterval(run.heartbeat);
    if (run.terminalStatus !== 'success') {
      await finishInterruptedRun(run, reason);
    }
    activeRuns.delete(sessionId);
    try {
      await markSessionIdle(sessionId);
    } catch (error) {
      console.error('[会话] 停机收尾失败:', (error as Error).message);
    }
    run.resolveDone();
  }
  await flushPersistActiveRuns().catch(() => undefined);
}

/** 单行截断，供卡片/日志展示。 */
function truncate(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** 进度条递增，完成前最高 90%。 */
function bumpProgress(current: number, step = 8): number {
  return Math.min(90, current + step);
}

const STATUS_LABELS: Record<Session['status'], string> = {
  creating: '创建中',
  active: '执行中',
  idle: '空闲',
  closed: '已关闭',
};

/** 拼 /status 回复文案。 */
function formatSessionStatus(session: Session, bot: Bot, msg: IncomingMessage): string {
  const adapter = getAdapter(session.cliId);
  const topicId = topicIdOf(msg);
  const topicWorkdir = topics.getWorkdir(msg.chatId, topicId);
  const effective = workdirFor(session, bot, msg);
  const peers = sessions.listByTopic(msg.chatId, topicId);
  const peerLine = peers.length
    ? peers.map((s) => `${s.botId}:${STATUS_LABELS[s.status]}`).join('，')
    : '(无)';
  return [
    `角色：${bot.name} (${bot.id})`,
    `会话：${session.id}`,
    `状态：${STATUS_LABELS[session.status]}`,
    `执行引擎：${adapter.displayName} (${session.cliId})`,
    `CLI 上下文：${session.cliSessionId ? `已建立 (${session.cliSessionId.slice(0, 8)}…)` : '空（下次任务将新建）'}`,
    `话题项目目录：${topicWorkdir ?? '(未设置，可用 /workdir <路径>)'}`,
    `Bot 默认目录：${bot.workdir ?? '(未配置)'}`,
    `实际工作目录：${effective}`,
    `本话题角色：${peerLine}`,
    `话题：${session.threadId}`,
    `创建：${session.createdAt}`,
    `更新：${session.updatedAt}`,
  ].join('\n');
}

/** active → idle（已是 idle 则忽略）。 */
async function markSessionIdle(sessionId: string): Promise<void> {
  if (sessions.get(sessionId)?.status !== 'active') return;
  await sessions.transition(sessionId, 'idle');
  console.log(`[会话] id=${sessionId} status=idle`);
}

/** 取可执行会话；忙则返回 undefined，已关闭则 reopen。 */
async function ensureRunnableSession(bot: Bot, msg: IncomingMessage): Promise<Session | undefined> {
  const { session } = await sessions.resolve({
    messageId: msg.messageId,
    chatId: msg.chatId,
    threadId: msg.threadId,
    rootId: msg.rootId,
    botId: bot.id,
  });
  if (session.status === 'closed') {
    return sessions.reopen(session.id);
  }
  if (session.status === 'active') return undefined;
  return session;
}

/** 发卡 + 跑 CLI + 流式更新；支持完成后回调。 */
async function startCliTask(options: {
  bot: Bot;
  msg: IncomingMessage;
  session: Session;
  prompt: string;
  downloadResources?: boolean;
  onSuccess?: (answer: string) => Promise<void>;
}): Promise<void> {
  if (shuttingDown) {
    throw new Error('服务正在停止，无法启动新任务');
  }

  const { bot, msg, downloadResources = false, onSuccess } = options;
  let taskPrompt = options.prompt.trim();
  let session = options.session;
  const hasThread = !!msg.threadId || !!msg.rootId;

  // 再次确认最新状态，避免交接瞬间并发
  const latest = sessions.get(session.id);
  if (!latest || latest.status === 'active') {
    throw new Error(`${bot.name} 当前正忙，请稍后再交接`);
  }
  if (latest.status === 'closed') {
    session = await sessions.reopen(latest.id);
  } else {
    session = latest;
  }

  const adapter = createAdapter(session.cliId);
  const cardTitle = `${bot.name} · ${adapter.displayName}`;
  const cwd = workdirFor(session, bot, msg);
  console.log(`[项目] bot=${bot.id} 本次 cwd=${cwd}`);

  await sessions.transition(session.id, 'active');
  const controller = new AbortController();
  let resolveDone = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  // 先发卡并同步落盘，再下载资源，缩短孤儿卡窗口。
  let cardId: string | undefined;
  try {
    cardId = await bot.replyCard(msg.messageId, buildTaskCard({
      title: cardTitle,
      status: 'running',
      progress: 0,
      detail: `正在启动 ${adapter.displayName}`,
    }), hasThread);
  } catch (error) {
    await markSessionIdle(session.id);
    resolveDone();
    throw error;
  }

  if (!cardId) {
    console.error('[卡片] 响应里没有 message_id，无法继续更新');
    await markSessionIdle(session.id);
    resolveDone();
    return;
  }
  console.log(`[卡片] bot=${bot.id} message_id=${cardId} inThread=${hasThread} engine=${adapter.id}`);

  const cardUpdater = new ThrottledCardUpdater((card) => bot.updateCard(cardId, card));
  const activeRun: ActiveRun = {
    controller,
    bot,
    cardId,
    cardTitle,
    cardUpdater,
    progress: 5,
    detail: `${adapter.displayName} 已启动`,
    activities: [],
    lastEventAt: Date.now(),
    done,
    resolveDone,
  };
  activeRuns.set(session.id, activeRun);
  await flushPersistActiveRuns();

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

  if (shuttingDown) {
    await finishInterruptedRun(activeRun, '服务已停止，任务中断');
    activeRuns.delete(session.id);
    await flushPersistActiveRuns();
    await markSessionIdle(session.id);
    resolveDone();
    return;
  }

  const pushLiveCard = () => {
    if (activeRun.terminalStatus) return;
    cardUpdater.push(buildTaskCard({
      title: cardTitle,
      status: 'running',
      progress: activeRun.progress,
      detail: activeRun.detail,
      activities: activeRun.activities,
    }));
    schedulePersistActiveRuns();
  };

  activeRun.heartbeat = setInterval(() => {
    if (activeRun.terminalStatus || shuttingDown) return;
    if (Date.now() - activeRun.lastEventAt < THINKING_HEARTBEAT_MS) return;
    activeRun.detail = '模型处理中，请稍候…';
    activeRun.progress = Math.min(90, Math.max(activeRun.progress, activeRun.progress + 1));
    if (!activeRun.activities.includes('模型处理中…')) {
      activeRun.activities.push('模型处理中…');
      while (activeRun.activities.length > MAX_ACTIVITIES) activeRun.activities.shift();
    }
    pushLiveCard();
  }, THINKING_HEARTBEAT_MS);
  activeRun.heartbeat.unref?.();

  const onCliEvent = (event: CliEvent) => {
    activeRun.lastEventAt = Date.now();
    switch (event.type) {
      case 'session':
        activeRun.detail = '会话已建立，开始执行';
        activeRun.progress = Math.max(activeRun.progress, 10);
        activeRun.activities.push(`会话 ${event.sessionId.slice(0, 8)}…`);
        console.log(`[CLI:${bot.id}/${adapter.id}] session=${event.sessionId}`);
        break;
      case 'assistant': {
        const text = truncate(event.text);
        activeRun.detail = text;
        activeRun.progress = bumpProgress(activeRun.progress, 6);
        activeRun.activities.push(`模型：${text}`);
        console.log(`[CLI:${bot.id}/${adapter.id}] assistant: ${text}`);
        break;
      }
      case 'tool': {
        const summary = event.inputSummary
          ? `${event.name} ${truncate(event.inputSummary, 60)}`
          : event.name;
        activeRun.detail = `调用工具：${summary}`;
        activeRun.progress = bumpProgress(activeRun.progress, 10);
        activeRun.activities.push(`工具：${summary}`);
        console.log(`[CLI:${bot.id}/${adapter.id}] tool: ${summary}`);
        break;
      }
      case 'error':
        console.error(`[CLI:${bot.id}/${adapter.id}] stream error: ${event.message}`);
        break;
      case 'result':
        console.log(`[CLI:${bot.id}/${adapter.id}] result event received`);
        break;
    }
    while (activeRun.activities.length > MAX_ACTIVITIES) activeRun.activities.shift();
    if (event.type === 'session' || event.type === 'assistant' || event.type === 'tool') {
      pushLiveCard();
    }
  };

  void runCli({
    adapter,
    prompt: taskPrompt,
    cwd,
    sessionId: session.cliSessionId,
    signal: controller.signal,
    onEvent: onCliEvent,
  })
    .then(async (result) => {
      if (result.sessionId && result.sessionId !== session.cliSessionId) {
        await sessions.setCliSessionId(session.id, result.sessionId);
      }
      // 先标记成功，防止停机逻辑把绿卡盖成红卡。
      activeRun.terminalStatus = 'success';
      if (activeRun.heartbeat) clearInterval(activeRun.heartbeat);
      await cardUpdater.finish(buildTaskCard({
        title: cardTitle,
        status: 'success',
        progress: 100,
        detail: '执行完成',
        activities: activeRun.activities,
      }));
      await bot.reply(msg.messageId, result.answer, hasThread);
      console.log(`[CLI:${bot.id}/${adapter.id}] 完成 session_id=${result.sessionId ?? '(无)'}`);
      if (activeRuns.get(session.id) === activeRun) activeRuns.delete(session.id);
      await flushPersistActiveRuns();
      await markSessionIdle(session.id);
      // 停机中禁止协作续跑，避免与收尾打架。
      if (!shuttingDown && onSuccess) await onSuccess(result.answer);
    })
    .catch(async (error) => {
      if (activeRun.heartbeat) clearInterval(activeRun.heartbeat);
      if (controller.signal.aborted) {
        const detail = activeRun.interruptReason ?? '任务已取消';
        console.log(`[CLI:${bot.id}/${adapter.id}] ${detail}`);
        if (!shuttingDown) {
          await finishInterruptedRun(activeRun, detail);
        }
        return;
      }
      activeRun.terminalStatus = 'failed';
      const message = (error as Error).message;
      console.error(`[CLI:${bot.id}/${adapter.id}] 执行失败:`, message);
      await cardUpdater.finish(buildTaskCard({
        title: cardTitle,
        status: 'failed',
        progress: 0,
        detail: message,
        activities: activeRun.activities,
      }));
      await bot.reply(msg.messageId, `${bot.name} / ${adapter.displayName} 执行失败：${message}`, hasThread);
    })
    .finally(async () => {
      if (activeRun.heartbeat) clearInterval(activeRun.heartbeat);
      if (activeRuns.get(session.id) === activeRun) activeRuns.delete(session.id);
      await flushPersistActiveRuns();
      try {
        await markSessionIdle(session.id);
      } catch (error) {
        console.error('[会话] 保存空闲状态失败:', (error as Error).message);
      }
      resolveDone();
    })
    .catch((error) => {
      console.error('[任务] 回传或收尾失败:', (error as Error).message);
    });
}

/** reviewer →（未通过则）dev → 复审，直到通过或达上限。 */
async function runCollabReview(options: {
  initiator: Bot;
  msg: IncomingMessage;
  task: string;
  round: number;
  priorDevResult?: string;
  /** 协作自然结束时回调（通过 / 触顶）；供流水线续跑。 */
  onComplete?: (result: { approved: boolean; answer: string }) => Promise<void>;
}): Promise<void> {
  const { initiator, msg, task, round, priorDevResult, onComplete } = options;
  const hasThread = !!msg.threadId || !!msg.rootId;
  const reviewer = botsById.get('reviewer');
  const dev = botsById.get('dev');
  if (!reviewer || !dev) {
    throw new Error('协作需要同时配置 reviewer 与 dev 两个 Bot');
  }

  if (shuttingDown) {
    throw new Error('服务正在停止，无法启动协作');
  }

  const topicKey = collabTopicKey(msg.chatId, topicIdOf(msg));
  await collabStore.setRound(topicKey, round);

  const reviewerSession = await ensureRunnableSession(reviewer, msg);
  if (!reviewerSession) {
    throw new Error(`${reviewer.name} 正在执行任务，请稍后再发起评审`);
  }

  const reviewPrompt = priorDevResult
    ? buildFollowUpReviewPrompt(task, round, priorDevResult)
    : buildInitialReviewPrompt(task, round);

  console.log(`[协作] 第 ${round}/${COLLAB_MAX_ROUNDS} 轮评审开始`);
  await initiator.reply(
    msg.messageId,
    `协作第 ${round}/${COLLAB_MAX_ROUNDS} 轮：交给 ${reviewer.name} 评审。`,
    hasThread,
  );

  await startCliTask({
    bot: reviewer,
    msg,
    session: reviewerSession,
    prompt: reviewPrompt,
    onSuccess: async (reviewAnswer) => {
      if (shuttingDown) return;
      if (isReviewApproved(reviewAnswer)) {
        console.log(`[协作] 第 ${round} 轮评审通过`);
        await collabStore.clearRound(topicKey);
        await initiator.reply(
          msg.messageId,
          `第 ${round} 轮评审通过（[APPROVED]）。协作结束。`,
          hasThread,
        );
        if (onComplete) await onComplete({ approved: true, answer: reviewAnswer });
        return;
      }

      const devSession = await ensureRunnableSession(dev, msg);
      if (!devSession) {
        await initiator.reply(
          msg.messageId,
          `${dev.name} 正忙，评审意见未能自动回传。请稍后手动 /handoff dev。`,
          hasThread,
        );
        return;
      }

      console.log(`[协作] 第 ${round} 轮：评审意见回传开发`);
      await initiator.reply(
        msg.messageId,
        `第 ${round} 轮评审未通过，意见已自动回传给 ${dev.name}。`,
        hasThread,
      );

      await startCliTask({
        bot: dev,
        msg,
        session: devSession,
        prompt: buildFixFromReviewPrompt(reviewer, reviewAnswer, round),
        onSuccess: async (devAnswer) => {
          if (shuttingDown) return;
          if (round >= COLLAB_MAX_ROUNDS) {
            console.log(`[协作] 已达最大轮次 ${COLLAB_MAX_ROUNDS}，停止自动循环`);
            await collabStore.clearRound(topicKey);
            await initiator.reply(
              msg.messageId,
              [
                `已完成 ${round} 轮协作（达到上限 ${COLLAB_MAX_ROUNDS}）。`,
                '如需继续，请再次发送 /review <任务>，或人工确认结果。',
              ].join('\n'),
              hasThread,
            );
            if (onComplete) await onComplete({ approved: false, answer: devAnswer });
            return;
          }

          const nextRound = round + 1;
          console.log(`[协作] 开发完成，进入第 ${nextRound} 轮复审`);
          await runCollabReview({
            initiator,
            msg,
            task,
            round: nextRound,
            priorDevResult: devAnswer,
            onComplete,
          });
        },
      });
    },
  });
}

/** CEO 团队交付流水线：按步骤串联各角色，最后由 CEO 汇总。 */
async function runTeamPipeline(options: {
  ceo: Bot;
  msg: IncomingMessage;
  goal: string;
}): Promise<void> {
  const { ceo, msg, goal } = options;
  const hasThread = !!msg.threadId || !!msg.rootId;
  if (shuttingDown) throw new Error('服务正在停止，无法启动流水线');

  const available = new Set(botsById.keys());
  const steps = filterRunnableSteps(PIPELINE_STEPS, available);
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
    if (shuttingDown) return;
    if (stepIndex >= steps.length) {
      await ceo.reply(msg.messageId, '团队交付流水线已全部完成。', hasThread);
      return;
    }

    const step = steps[stepIndex];
    const stepLabel = `步骤 ${stepIndex + 1}/${steps.length} · ${step.title}`;

    if (step.id === 'review') {
      await ceo.reply(msg.messageId, `${stepLabel}：启动评审协作。`, hasThread);
      await runCollabReview({
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

    const actor = botsById.get(step.botId);
    if (!actor) {
      await ceo.reply(msg.messageId, `${stepLabel}：角色 ${step.botId} 未连接，跳过。`, hasThread);
      await runStep(stepIndex + 1);
      return;
    }

    const actorSession = await ensureRunnableSession(actor, msg);
    if (!actorSession) {
      await ceo.reply(
        msg.messageId,
        `${stepLabel}：${actor.name} 正忙，流水线中止。请稍后重试 /pipeline。`,
        hasThread,
      );
      return;
    }

    await ceo.reply(msg.messageId, `${stepLabel}：交给 ${actor.name}。`, hasThread);
    await startCliTask({
      bot: actor,
      msg,
      session: actorSession,
      prompt: buildPipelineStepPrompt(step, goal, priorOutputs),
      onSuccess: async (answer) => {
        if (shuttingDown) return;
        priorOutputs[step.id] = answer;
        await runStep(stepIndex + 1);
      },
    });
  };

  await runStep(0);
}

/** 处理单条入站消息：命令或交给 CLI。 */
async function handleMessage(msg: IncomingMessage, bot: Bot): Promise<void> {
  // 进程内交接，不依赖 bot 互发；仍忽略飞书侧非用户消息，避免环路。
  if (msg.senderType && msg.senderType !== 'user') {
    console.log(`[忽略] bot=${bot.id} 非用户消息 senderType=${msg.senderType}`);
    return;
  }
  if (!isAddressedToBot(msg, bot)) {
    console.log(`[忽略] bot=${bot.id} 未被 @`);
    return;
  }

  const resolved = resolveMentions(msg.text, msg.mentions);
  const hasThread = !!msg.threadId || !!msg.rootId;
  const { session, isNew } = await sessions.resolve({
    messageId: msg.messageId,
    chatId: msg.chatId,
    threadId: msg.threadId,
    rootId: msg.rootId,
    botId: bot.id,
  });

  console.log(`[收到] bot=${bot.id}(${bot.name}) chat=${msg.chatId} threadId=${msg.threadId} rootId=${msg.rootId} sender=${msg.senderOpenId}`);
  console.log(`  原文: ${msg.text}`);
  console.log(`  还原: ${resolved}`);
  console.log(`  mentions: ${msg.mentions.map((m) => `${m.key}=${m.name}(${m.openId})`).join(', ') || '(无)'}`);
  console.log(`  [会话] ${isNew ? '新建' : '复用'} id=${session.id} status=${session.status} engine=${session.cliId}`);

  const command = parseCommand(resolved);
  if (command?.name === 'help') {
    const lines = [
      `我是 ${bot.name}（${bot.id}）`,
      '/status 查看当前会话',
      '/workdir [路径] 查看/设置本话题项目目录（clear 清除）',
      '/engine claude|codex 切换执行引擎',
      '/handoff <角色> <任务> 交接给同话题其他角色',
      '/review <任务> 评审→开发协作（意见自动回传，可多轮）',
    ];
    if (bot.id === 'ceo') {
      lines.push('/pipeline <目标> 启动团队交付流水线（PM→架构→开发→评审→测试→汇总）');
    }
    lines.push(
      '/reset 清理 CLI 上下文（保留会话）',
      '/reopen 重新打开已关闭会话',
      '/close 关闭当前会话',
      '/clean 清理所有已关闭会话记录',
      '/help 查看命令',
    );
    await bot.reply(msg.messageId, lines.join('\n'), hasThread);
    return;
  }
  if (command?.name === 'status') {
    await bot.reply(msg.messageId, formatSessionStatus(session, bot, msg), hasThread);
    return;
  }
  if (command?.name === 'workdir') {
    const topicId = topicIdOf(msg);
    if (!command.arg) {
      const current = topics.getWorkdir(msg.chatId, topicId);
      const effective = workdirFor(session, bot, msg);
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
    if (command.arg === 'clear' || command.arg === '-') {
      await topics.clearWorkdir(msg.chatId, topicId);
      const cleared = await sessions.clearCliContextForTopic(msg.chatId, topicId);
      console.log(`[项目] bot=${bot.id} 清除话题目录 chat=${msg.chatId} topic=${topicId} clearedCtx=${cleared}`);
      await bot.reply(
        msg.messageId,
        [
          `已清除本话题项目目录。`,
          `已清理 ${cleared} 个角色的 CLI 上下文。`,
          `后续将回退到：${workdirFor(session, bot, msg)}`,
        ].join('\n'),
        hasThread,
      );
      return;
    }
    if (session.status === 'active') {
      await bot.reply(msg.messageId, '任务执行中，请结束后再切换工作目录。', hasThread);
      return;
    }
    try {
      const absolute = await assertWorkdir(command.arg);
      await topics.setWorkdir(msg.chatId, topicId, absolute);
      const cleared = await sessions.clearCliContextForTopic(msg.chatId, topicId);
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
      const updated = await sessions.setCliId(session.id, next);
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
  if (command?.name === 'handoff') {
    const parsed = parseHandoffArg(command.arg);
    if (!parsed) {
      await bot.reply(
        msg.messageId,
        [
          '用法：/handoff <角色> <任务>',
          `可选角色：${listHandoffTargets(botsById.values())}`,
          '示例：/handoff dev 根据当前仓库写一段 README 大纲',
        ].join('\n'),
        hasThread,
      );
      return;
    }
    const target = resolveHandoffTarget(parsed.target, botsById.values());
    if (!target) {
      await bot.reply(
        msg.messageId,
        `找不到角色「${parsed.target}」。可选：${listHandoffTargets(botsById.values())}`,
        hasThread,
      );
      return;
    }
    if (target.id === bot.id) {
      await bot.reply(msg.messageId, '不能交接给自己。', hasThread);
      return;
    }

    try {
      const targetSession = await ensureRunnableSession(target, msg);
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

      await startCliTask({
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
          `当前最大轮次：${COLLAB_MAX_ROUNDS}（可用 COLLAB_MAX_ROUNDS 配置）`,
          '示例：/review 审查 README.md 是否完整准确',
        ].join('\n'),
        hasThread,
      );
      return;
    }
    try {
      const topicKey = collabTopicKey(msg.chatId, topicIdOf(msg));
      const previous = collabStore.getRound(topicKey);
      if (previous) {
        console.log(`[协作] 话题上次停在第 ${previous} 轮，本次重新从第 1 轮开始`);
      }
      await runCollabReview({
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
      const preview = filterRunnableSteps(PIPELINE_STEPS, new Set(botsById.keys()))
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
    try {
      await runTeamPipeline({ ceo: bot, msg, goal: command.arg });
    } catch (error) {
      await bot.reply(msg.messageId, (error as Error).message, hasThread);
    }
    return;
  }
  if (command?.name === 'reset') {
    try {
      await sessions.clearCliContext(session.id);
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
      const updated = await sessions.reopen(session.id);
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
    const removed = await sessions.purgeClosed();
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
    const running = activeRuns.get(session.id);
    if (running) {
      running.interruptReason = '任务已取消';
      running.controller.abort();
    }
    if (session.status !== 'closed') await sessions.transition(session.id, 'closed');
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

  await startCliTask({
    bot,
    msg,
    session,
    prompt: resolved,
    downloadResources: true,
  });
}

for (const config of botConfigs) {
  try {
    const bot = await startBot({
      config,
      onMessage: handleMessage,
    });
    botsById.set(bot.id, bot);
    console.log(
      `[Bot] 已连接 id=${bot.id} name=${bot.name} open_id=${bot.openId || '(未知，将按名称匹配 @)'}`,
    );
  } catch (error) {
    console.error(`[Bot] 启动失败 id=${config.id}:`, (error as Error).message);
  }
}

await reconcileOrphanedCards();

/** 收尾进行中任务后退出进程。 */
async function shutdownAndExit(reason: string, exitCode = 0): Promise<void> {
  console.log(`[进程] ${reason}，开始收尾进行中任务…`);
  try {
    await shutdownActiveRuns(reason);
  } catch (error) {
    console.error('[进程] 收尾失败:', (error as Error).message);
  } finally {
    process.exit(exitCode);
  }
}

process.once('SIGINT', () => {
  void shutdownAndExit('服务已停止（SIGINT），任务中断');
});
process.once('SIGTERM', () => {
  void shutdownAndExit('服务已停止（SIGTERM），任务中断');
});
process.once('uncaughtException', (error) => {
  console.error('[进程] uncaughtException:', error);
  void shutdownAndExit('服务异常退出（uncaughtException），任务中断', 1);
});
process.once('unhandledRejection', (reason) => {
  console.error('[进程] unhandledRejection:', reason);
  void shutdownAndExit('服务异常退出（unhandledRejection），任务中断', 1);
});
