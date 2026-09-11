import type { Bot, BotIdentity } from "../im/lark.js";
import { createHash } from 'node:crypto';
import type { AppRuntime } from './runtime.js';
import { deliveryOutbox } from './result-delivery.js';

export async function sendResultNotification(options: {
  bot: Bot;
  replyToMessageId: string;
  target: BotIdentity;
  text: string;
  replyInThread: boolean;
  runtime?: AppRuntime;
  botId?: string;
  sessionId?: string;
  afterCardId?: string;
}): Promise<void> {
  if (options.runtime && options.botId && options.sessionId) {
    const id = createHash('sha256').update(JSON.stringify([options.replyToMessageId, options.target, options.text])).digest('hex');
    const outbox = deliveryOutbox(options.runtime, options.botId, options.bot);
    await outbox.submit({
      id: `notice:${options.botId}:${id}`, botId: options.botId, sessionId: options.sessionId,
      dependsOn: options.afterCardId ? outbox.latestCardDelivery(options.afterCardId) : undefined,
      operations: [{ type: 'mention', messageId: options.replyToMessageId, target: options.target, text: options.text, replyInThread: options.replyInThread }],
    });
    return;
  }
  try {
    await options.bot.replyMention(
      options.replyToMessageId,
      options.target,
      options.text,
      options.replyInThread,
    );
  } catch (error) {
    console.error("[通知] 结果通知发送失败:", (error as Error).message);
  }
}
