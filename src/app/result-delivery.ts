import { createHash } from 'node:crypto';
import { ThrottledCardUpdater, type CardJson, buildClarificationCard, buildClarificationContinuingCard,
  buildClarificationSupersededCard, buildProductSpecApprovalCard, buildProductSpecApprovedCard,
  buildProductSpecExpiredCard, buildSessionNoticeCard } from '../im/card.js';
import type { Bot } from '../im/lark.js';
import { DeliveryOutbox, type CardDelivery } from './delivery-outbox.js';
import type { AppRuntime } from './runtime.js';
import { flowMatchesSession } from './session-guard.js';

/** A timed-out patch may already be visible. Never overwrite a user's later answer/approval on retry. */
export function resolveResultCard(runtime: AppRuntime, operation: CardDelivery): CardJson {
  const reference = operation.flow;
  if (!reference) return operation.card;
  if (reference.kind === 'clarification') {
    const flow = runtime.clarificationFlows.get(reference.token);
    if (flow) {
      if (!flowMatchesSession(flow, runtime.sessions.get(flow.sessionId))) return buildClarificationSupersededCard(flow);
      return flow.currentIndex >= flow.request.questions.length
        ? buildClarificationContinuingCard(flow) : buildClarificationCard({ flow });
    }
  } else {
    const flow = runtime.productSpecFlows.get(reference.token);
    if (flow) {
      if (flow.status === 'approved') return buildProductSpecApprovedCard(flow);
      if (flow.status === 'expired' || !flowMatchesSession(flow, runtime.sessions.get(flow.sessionId))) return buildProductSpecExpiredCard(flow);
      return buildProductSpecApprovalCard(flow);
    }
  }
  return buildSessionNoticeCard({ title: '这张交互卡片已结束', template: 'grey', detail: '请查看当前话题中的最新结果。' });
}

export function deliveryOutbox(runtime: AppRuntime, botId: string, bot: Bot): DeliveryOutbox {
  return runtime.deliveries ??= new DeliveryOutbox(
    (id) => runtime.botRuntimes.get(id)?.bot ?? (id === botId ? bot : undefined),
    undefined, 100, (operation) => resolveResultCard(runtime, operation),
  );
}

export function createTaskCardUpdater(options: {
  runtime: AppRuntime; bot: Bot; botId: string; sessionId: string;
  cardId: string; replyToMessageId: string; replyInThread: boolean;
}) {
  const { runtime, bot, botId, sessionId, cardId, replyToMessageId, replyInThread } = options;
  const updater = new ThrottledCardUpdater((card) => bot.updateCard(cardId, card));
  return {
    push: (card: CardJson) => updater.push(card),
    cancel: () => updater.cancel(),
    async finish(card: CardJson, flow?: CardDelivery['flow']): Promise<void> {
      await updater.cancel();
      const hash = createHash('sha256').update(JSON.stringify(card)).digest('hex').slice(0, 16);
      await deliveryOutbox(runtime, botId, bot).submit({
        id: `card:${cardId}:${hash}`, botId, sessionId,
        operations: [{ type: 'card', messageId: cardId, card, flow }],
        fallback: { type: 'text', messageId: replyToMessageId, replyInThread,
          text: '本轮执行已结束，但结果卡暂时更新失败。结果已保存，系统会自动补发；请勿仅因卡片未更新而重复执行任务。' },
      });
    },
  };
}
