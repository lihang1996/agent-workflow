/**
 * Agent OS 入口。
 * 飞书消息驱动 Claude Code / Codex 双引擎（含流式进度卡片）。
 */
import 'dotenv/config';
import { join, resolve } from 'node:path';
import { startBot } from './im/lark.js';
import { buildTaskCard, ThrottledCardUpdater } from './im/card.js';
import { resolveMentions, extractResourceKeys } from './im/message-parser.js';
import { parseCommand } from './core/command-parser.js';
import { SessionManager, type Session } from './core/session-manager.js';
import { JsonSessionStore } from './core/session-store.js';
import { createAdapter, getAdapter, listEngines } from './cli/registry.js';
import { runCli } from './cli/runner.js';
import { isCliId, type CliEvent, type CliId } from './cli/types.js';

const appId = process.env.BOT_A_APP_ID;
const appSecret = process.env.BOT_A_APP_SECRET;
const defaultCliId = parseDefaultCliId(process.env.DEFAULT_CLI);
const MAX_ACTIVITIES = 5;

if (!appId || !appSecret) {
  console.error('缺少 BOT_A_APP_ID / BOT_A_APP_SECRET，请检查 .env');
  process.exit(1);
}

function parseDefaultCliId(value: string | undefined): CliId {
  if (!value) return 'claude';
  const normalized = value.trim().toLowerCase();
  if (isCliId(normalized)) return normalized;
  console.warn(`[配置] 未知 DEFAULT_CLI=${value}，回退到 claude`);
  return 'claude';
}

function workdirFor(cliId: CliId): string {
  if (cliId === 'codex') {
    return resolve(process.env.CODEX_WORKDIR ?? process.env.CLAUDE_WORKDIR ?? process.cwd());
  }
  return resolve(process.env.CLAUDE_WORKDIR ?? process.cwd());
}

console.log('Agent OS 启动，正在建立飞书长连接…');
for (const engine of listEngines()) {
  console.log(`[CLI] ${engine.id}=${engine.command} cwd=${workdirFor(engine.id)}`);
}
console.log(`[CLI] 默认引擎=${defaultCliId}`);

const sessions = await SessionManager.open({
  store: new JsonSessionStore(join('data', 'sessions.json')),
  defaultCliId,
});
console.log(`[会话] 已恢复 ${sessions.size} 个会话`);
const activeRuns = new Map<string, AbortController>();

function truncate(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function bumpProgress(current: number, step = 8): number {
  return Math.min(90, current + step);
}

const STATUS_LABELS: Record<Session['status'], string> = {
  creating: '创建中',
  active: '执行中',
  idle: '空闲',
  closed: '已关闭',
};

function formatSessionStatus(session: Session): string {
  const adapter = getAdapter(session.cliId);
  return [
    `会话：${session.id}`,
    `状态：${STATUS_LABELS[session.status]}`,
    `执行引擎：${adapter.displayName} (${session.cliId})`,
    `CLI 会话：${session.cliSessionId ?? '(尚未建立)'}`,
    `工作目录：${workdirFor(session.cliId)}`,
    `话题：${session.threadId}`,
    `更新时间：${session.updatedAt}`,
  ].join('\n');
}

async function markSessionIdle(sessionId: string): Promise<void> {
  if (sessions.get(sessionId)?.status !== 'active') return;
  await sessions.transition(sessionId, 'idle');
  console.log(`[会话] id=${sessionId} status=idle`);
}

startBot({
  appId,
  appSecret,
  onMessage: async (msg, bot) => {
    const resolved = resolveMentions(msg.text, msg.mentions);
    const hasThread = !!msg.threadId || !!msg.rootId;
    const { session, isNew } = await sessions.resolve(msg);
    console.log(`[收到] chat=${msg.chatId} threadId=${msg.threadId} rootId=${msg.rootId} sender=${msg.senderOpenId}`);
    console.log(`  原文: ${msg.text}`);
    console.log(`  还原: ${resolved}`);
    console.log(`  mentions: ${msg.mentions.map(m => `${m.key}=${m.name}(${m.openId})`).join(', ') || '(无)'}`);
    console.log(`  [会话] ${isNew ? '新建' : '复用'} id=${session.id} status=${session.status} engine=${session.cliId}`);

    const command = parseCommand(resolved);
    if (command?.name === 'help') {
      await bot.reply(
        msg.messageId,
        [
          '/status 查看当前会话',
          '/engine claude|codex 切换执行引擎',
          '/close 关闭当前会话',
          '/help 查看命令',
        ].join('\n'),
        hasThread,
      );
      return;
    }
    if (command?.name === 'status') {
      await bot.reply(msg.messageId, formatSessionStatus(session), hasThread);
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
        console.log(`[引擎] session=${session.id} ${prev} → ${updated.cliId}`);
        await bot.reply(
          msg.messageId,
          `已切换到 ${getAdapter(updated.cliId).displayName}。后续任务将使用该引擎。`,
          hasThread,
        );
      } catch (error) {
        await bot.reply(msg.messageId, (error as Error).message, hasThread);
      }
      return;
    }
    if (command?.name === 'close') {
      activeRuns.get(session.id)?.abort();
      if (session.status !== 'closed') await sessions.transition(session.id, 'closed');
      await bot.reply(
        msg.messageId,
        '当前会话已关闭。需要继续时，请新开一个话题。',
        hasThread,
      );
      return;
    }

    if (session.status === 'closed') {
      await bot.reply(
        msg.messageId,
        '这个话题的会话已经关闭，请新开一个话题继续。',
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

    const adapter = createAdapter(session.cliId);
    const cardTitle = `${adapter.displayName} 任务`;
    const cwd = workdirFor(session.cliId);

    await sessions.transition(session.id, 'active');
    const run = new AbortController();
    activeRuns.set(session.id, run);

    // 图片/文件下载
    const resources = extractResourceKeys(msg.messageType, msg.rawContent);
    for (const res of resources) {
      try {
        const savePath = await bot.downloadResource(
          msg.messageId,
          res.key,
          res.type,
          join('data', 'downloads'),
          res.fileName,
        );
        console.log(`  [下载] ${res.type} → ${savePath}`);
      } catch (e) {
        console.error(`  [下载失败] ${res.key}:`, (e as Error).message);
      }
    }

    // 先回复一张卡片，让用户知道任务已经进入执行队列。
    let cardId: string | undefined;
    try {
      cardId = await bot.replyCard(msg.messageId, buildTaskCard({
        title: cardTitle,
        status: 'running',
        progress: 0,
        detail: `正在启动 ${adapter.displayName}`,
      }), hasThread);
    } catch (error) {
      if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);
      await markSessionIdle(session.id);
      throw error;
    }

    if (!cardId) {
      console.error('[卡片] 响应里没有 message_id，无法继续更新');
      if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);
      await markSessionIdle(session.id);
      return;
    }
    console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread} engine=${adapter.id}`);

    const cardUpdater = new ThrottledCardUpdater((card) => bot.updateCard(cardId, card));
    let progress = 5;
    let detail = `${adapter.displayName} 已启动`;
    const activities: string[] = [];

    const pushLiveCard = () => {
      cardUpdater.push(buildTaskCard({
        title: cardTitle,
        status: 'running',
        progress,
        detail,
        activities,
      }));
    };

    const onCliEvent = (event: CliEvent) => {
      switch (event.type) {
        case 'session':
          detail = '会话已建立，开始执行';
          progress = Math.max(progress, 10);
          activities.push(`会话 ${event.sessionId.slice(0, 8)}…`);
          console.log(`[CLI:${adapter.id}] session=${event.sessionId}`);
          break;
        case 'assistant': {
          const text = truncate(event.text);
          detail = text;
          progress = bumpProgress(progress, 6);
          activities.push(`模型：${text}`);
          console.log(`[CLI:${adapter.id}] assistant: ${text}`);
          break;
        }
        case 'tool': {
          const summary = event.inputSummary
            ? `${event.name} ${truncate(event.inputSummary, 60)}`
            : event.name;
          detail = `调用工具：${summary}`;
          progress = bumpProgress(progress, 10);
          activities.push(`工具：${summary}`);
          console.log(`[CLI:${adapter.id}] tool: ${summary}`);
          break;
        }
        case 'error':
          console.error(`[CLI:${adapter.id}] stream error: ${event.message}`);
          break;
        case 'result':
          console.log(`[CLI:${adapter.id}] result event received`);
          break;
      }
      while (activities.length > MAX_ACTIVITIES) activities.shift();
      if (event.type === 'session' || event.type === 'assistant' || event.type === 'tool') {
        pushLiveCard();
      }
    };

    // 让事件回调尽快返回，CLI 在后台继续执行。
    void runCli({
      adapter,
      prompt: resolved,
      cwd,
      sessionId: session.cliSessionId,
      signal: run.signal,
      onEvent: onCliEvent,
    })
      .then(async (result) => {
        if (result.sessionId && result.sessionId !== session.cliSessionId) {
          await sessions.setCliSessionId(session.id, result.sessionId);
        }
        await cardUpdater.finish(buildTaskCard({
          title: cardTitle,
          status: 'success',
          progress: 100,
          detail: '执行完成',
          activities,
        }));
        await bot.reply(msg.messageId, result.answer, hasThread);
        console.log(`[CLI:${adapter.id}] 完成 session_id=${result.sessionId ?? '(无)'}`);
      })
      .catch(async (error) => {
        if (run.signal.aborted) {
          console.log(`[CLI:${adapter.id}] 任务已取消`);
          await cardUpdater.finish(buildTaskCard({
            title: cardTitle,
            status: 'failed',
            progress,
            detail: '任务已取消',
            activities,
          })).catch(() => cardUpdater.cancel());
          return;
        }
        const message = (error as Error).message;
        console.error(`[CLI:${adapter.id}] 执行失败:`, message);
        await cardUpdater.finish(buildTaskCard({
          title: cardTitle,
          status: 'failed',
          progress: 0,
          detail: message,
          activities,
        }));
        await bot.reply(msg.messageId, `${adapter.displayName} 执行失败：${message}`, hasThread);
      })
      .finally(async () => {
        if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);
        try {
          await markSessionIdle(session.id);
        } catch (error) {
          console.error('[会话] 保存空闲状态失败:', (error as Error).message);
        }
      })
      .catch((error) => {
        console.error('[任务] 回传或收尾失败:', (error as Error).message);
      });
  },
});
