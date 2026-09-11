import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Bot } from '../im/lark.js';
import { buildCollaborationCard } from '../im/card.js';
import type { BotConfig } from '../core/bot-registry.js';
import type { CollaborationMessage } from '../core/collaboration.js';
import type { AppRuntime } from './runtime.js';
import { deliveryOutbox } from './result-delivery.js';

export interface CollaborationDispatch {
  dispatchId?: string;
  senderConfig: BotConfig;
  senderBot: Bot;
  replyToMessageId: string;
  targetBotId: string;
  taskId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  ownerBotId?: string;
  reportToBotId: string;
  objective: string;
  instruction: string;
  expectedOutput?: string;
  round: number;
  maxRounds: number;
  workspaceDir: string;
}

export class CollaborationService {
  private readonly sending = new Map<string, Promise<void>>();
  constructor(private readonly runtime: AppRuntime) {}

  async dispatch(options: CollaborationDispatch): Promise<void> {
    const dispatchId = options.dispatchId ?? randomUUID().replaceAll('-', '').slice(0, 12);
    const collaboration: CollaborationMessage = {
      dispatchId, taskId: options.taskId,
      ownerOpenId: options.ownerOpenId, ownerUnionId: options.ownerUnionId,
      ownerBotId: options.ownerBotId ?? options.senderConfig.id,
      fromBotId: options.senderConfig.id, toBotId: options.targetBotId,
      reportToBotId: options.reportToBotId, objective: options.objective,
      instruction: options.instruction, expectedOutput: options.expectedOutput,
      round: options.round, maxRounds: options.maxRounds, workspaceDir: options.workspaceDir,
      replyToMessageId: options.replyToMessageId,
    };
    // Persist before any network request. A timeout never discards the job.
    this.runtime.collaborationInbox.register(collaboration);
    await this.deliver(dispatchId);
  }

  async recover(): Promise<void> {
    for (const message of this.runtime.collaborationInbox.pending()) {
      try { await this.deliver(message.dispatchId); }
      catch (error) { console.warn(`[协作 ${message.dispatchId}] 待重试:`, (error as Error).message); }
    }
    for (const message of this.runtime.collaborationInbox.interrupted()) {
      const sender = this.runtime.botRuntimes.get(message.fromBotId);
      if (!sender || !message.replyToMessageId) continue;
      await deliveryOutbox(this.runtime, message.fromBotId, sender.bot).submit({
        id: `interrupted:${message.dispatchId}`, botId: message.fromBotId,
        sessionId: message.executionSessionId ?? message.taskId,
        operations: [{ type: 'text', messageId: message.replyToMessageId, replyInThread: true,
          text: `协作任务“${message.objective}”执行中断，结果不确定。请检查产物后发送新的指令；系统不会自动重复执行。` }],
      });
    }
  }

  private deliver(dispatchId: string): Promise<void> {
    const existing = this.sending.get(dispatchId);
    if (existing) return existing;
    const pending = this.send(dispatchId).finally(() => this.sending.delete(dispatchId));
    this.sending.set(dispatchId, pending);
    return pending;
  }

  private async send(dispatchId: string): Promise<void> {
    const inbox = this.runtime.collaborationInbox;
    if (inbox.hasConsumed(dispatchId)) return;
    const message = inbox.pending().find((item) => item.dispatchId === dispatchId);
    if (!message) return;
    if (!message.replyToMessageId) throw new Error('缺少协作原始消息，无法恢复派发');
    const sender = this.runtime.botRuntimes.get(message.fromBotId);
    const target = this.runtime.botRuntimes.get(message.toBotId);
    const reportTo = this.runtime.botRuntimes.get(message.reportToBotId);
    if (!sender || !target || !reportTo) throw new Error('协作成员尚未就绪');
    if (!message.cardMessageId) {
      const cardMessageId = await sender.bot.replyCard(message.replyToMessageId, buildCollaborationCard({
        senderName: sender.identity.name, targetName: target.identity.name,
        reportToName: reportTo.identity.name, workspaceName: basename(message.workspaceDir),
        objective: message.objective, instruction: message.instruction,
        expectedOutput: message.expectedOutput, round: message.round, maxRounds: message.maxRounds,
      }), true, `${dispatchId}-card`);
      if (!cardMessageId) throw new Error('飞书没有返回协作卡片 message_id');
      message.cardMessageId = cardMessageId;
      inbox.update(message);
    }
    message.attempts = (message.attempts ?? 0) + 1;
    inbox.update(message);
    const mentionMessageId = await sender.bot.replyMention(message.cardMessageId, target.identity,
      `协作任务：${message.objective}（任务编号：${dispatchId}），请查看上方卡片。`,
      true, `${dispatchId}-notice-${message.attempts}`);
    if (!mentionMessageId) throw new Error('飞书没有返回协作通知 message_id');
    console.log(`[协作] task=${message.taskId} ${message.fromBotId} -> ${message.toBotId} round=${message.round}/${message.maxRounds}`);
  }
}
