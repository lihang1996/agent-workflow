/**
 * 会话辅助函数。
 *
 * 提供会话相关的工具函数，被 cli-task.ts 和 message-handler.ts 调用：
 * - topicIdOf()：提取话题 ID（thread > root > message）
 * - workdirFor()：解析本次任务的工作目录（话题 > Bot > CLI 回退 > cwd）
 * - ensureRunnableSession()：确保会话可运行（空闲或已关闭）
 * - formatSessionStatus()：格式化会话状态文本
 * - markSessionIdle()：把会话标记为空闲
 * - truncate()：截断文本（用于日志）
 */

import { getAdapter } from '../cli/registry.js';
import { resolveWorkdir } from '../core/workdir.js';
import type { Session } from '../core/session-manager.js';
import type { Bot, IncomingMessage } from '../im/lark.js';
import type { AppContext } from './app-context.js';

/** 话题 ID：thread > root > message。 */
export function topicIdOf(msg: IncomingMessage): string {
  return msg.topicId?.trim() || msg.threadId || msg.rootId || msg.messageId;
}

/** 按优先级解析本次任务工作目录。 */
export function workdirFor(ctx: AppContext, session: Session, bot: Bot, msg: IncomingMessage): string {
  return resolveWorkdir({
    topicWorkdir: ctx.topics.getWorkdir(msg.chatId, topicIdOf(msg)),
    botWorkdir: bot.workdir,
    cliId: session.cliId,
  });
}

/** 单行截断，供日志展示。 */
export function truncate(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export const STATUS_LABELS: Record<Session['status'], string> = {
  creating: '创建中',
  active: '执行中',
  idle: '空闲',
  closed: '已关闭',
};

/** 拼 /status 回复文案。 */
export function formatSessionStatus(
  ctx: AppContext,
  session: Session,
  bot: Bot,
  msg: IncomingMessage,
): string {
  const adapter = getAdapter(session.cliId);
  const topicId = topicIdOf(msg);
  const topicWorkdir = ctx.topics.getWorkdir(msg.chatId, topicId);
  const effective = workdirFor(ctx, session, bot, msg);
  const peers = ctx.sessions.listByTopic(msg.chatId, topicId);
  const peerLine = peers.length
    ? peers.map((s) => {
      const role = s.logicalRole && s.logicalRole !== s.botId ? `${s.botId}::${s.logicalRole}` : s.botId;
      return `${role}:${STATUS_LABELS[s.status]}`;
    }).join('，')
    : '(无)';
  const roleLabel = session.logicalRole && session.logicalRole !== session.botId
    ? `${bot.name} (${bot.id}::${session.logicalRole})`
    : `${bot.name} (${bot.id})`;
  return [
    `角色：${roleLabel}`,
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
export async function markSessionIdle(ctx: AppContext, sessionId: string): Promise<void> {
  if (ctx.sessions.get(sessionId)?.status !== 'active') return;
  await ctx.sessions.transition(sessionId, 'idle');
  console.log(`[会话] id=${sessionId} status=idle`);
}

/** 取可执行会话；忙则返回 undefined，已关闭则 reopen。 */
export async function ensureRunnableSession(
  ctx: AppContext,
  bot: Bot,
  msg: IncomingMessage,
  options?: { logicalRole?: string },
): Promise<Session | undefined> {
  const topicId = topicIdOf(msg);
  const preferredCliId = ctx.topics?.getCliId?.(msg.chatId, topicId);
  const { session } = await ctx.sessions.resolve({
    messageId: msg.messageId,
    topicId,
    chatId: msg.chatId,
    threadId: msg.threadId,
    rootId: msg.rootId,
    botId: bot.id,
    logicalRole: options?.logicalRole?.trim() || bot.id,
  }, preferredCliId);
  if (session.status === 'closed') {
    return ctx.sessions.reopen(session.id);
  }
  if (session.status === 'active') return undefined;
  return session;
}
