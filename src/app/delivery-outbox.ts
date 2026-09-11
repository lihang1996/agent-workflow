import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readJsonState, writeJsonState } from '../core/json-state.js';
import type { Bot } from '../im/lark.js';
import type { CardJson } from '../im/card.js';

const CommentSchema = z.object({ eventId: z.string(), fileToken: z.string(), fileType: z.string(), commentId: z.string(), replyId: z.string(), senderOpenId: z.string(), senderUnionId: z.string(), mentionedBot: z.boolean() });
const OperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('card'), messageId: z.string(), card: z.record(z.string(), z.unknown()),
    flow: z.object({ kind: z.enum(['clarification', 'product']), token: z.string() }).optional(),
  }),
  z.object({ type: z.literal('text'), messageId: z.string(), text: z.string(), replyInThread: z.boolean() }),
  z.object({ type: z.literal('mention'), messageId: z.string(), text: z.string(), replyInThread: z.boolean(), target: z.object({ openId: z.string(), name: z.string() }) }),
  z.object({ type: z.literal('comment'), comment: CommentSchema, text: z.string() }),
]);
export type DeliveryOperation = z.infer<typeof OperationSchema>;
export type CardDelivery = Extract<DeliveryOperation, { type: 'card' }>;
const DeliverySchema = z.object({ id: z.string(), botId: z.string(), sessionId: z.string(), dependsOn: z.string().optional(), operations: z.array(OperationSchema), cursor: z.number().int().nonnegative(), fallback: OperationSchema.optional(), fallbackSent: z.boolean().default(false) });
type Delivery = z.infer<typeof DeliverySchema>;

/** Durable, ordered result delivery. Retrying this queue never invokes an engine. */
export class DeliveryOutbox {
  private rows = new Map<string, Delivery>();
  private sending = new Map<string, Promise<boolean>>();
  constructor(
    private readonly resolveBot: (id: string) => Bot | undefined,
    private readonly filePath?: string,
    private readonly retryDelayMs = 100,
    private readonly resolveCard: (operation: CardDelivery) => CardJson = (operation) => operation.card,
  ) {
    for (const row of z.array(DeliverySchema).parse(readJsonState(filePath) ?? [])) this.rows.set(row.id, row);
  }
  pending(sessionId?: string): number {
    return [...this.rows.values()].filter((row) => row.cursor < row.operations.length && (!sessionId || row.sessionId === sessionId)).length;
  }
  latestCardDelivery(messageId: string): string | undefined {
    return [...this.rows.values()].filter((row) => row.operations.some((op) => op.type === 'card' && op.messageId === messageId)).at(-1)?.id;
  }
  async submit(options: Omit<Delivery, 'cursor' | 'fallbackSent'>): Promise<boolean> {
    if (!this.rows.has(options.id)) this.save({ ...options, cursor: 0, fallbackSent: false });
    return this.deliver(options.id);
  }
  async recover(): Promise<void> {
    const pending = [...this.rows.values()].filter((r) => r.cursor < r.operations.length);
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (index < pending.length) await this.deliver(pending[index++].id);
    }));
  }
  private deliver(id: string): Promise<boolean> {
    const previous = this.sending.get(id);
    if (previous) return previous;
    const pending = this.send(id).finally(() => this.sending.delete(id));
    this.sending.set(id, pending);
    return pending;
  }
  private async send(id: string): Promise<boolean> {
    let row = this.rows.get(id)!;
    const dependency = row.dependsOn ? this.rows.get(row.dependsOn) : undefined;
    if (dependency && dependency.cursor < dependency.operations.length) return false;
    const bot = this.resolveBot(row.botId);
    if (!bot) return false;
    while (row.cursor < row.operations.length) {
      let delivered = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.perform(bot, row.operations[row.cursor], `${id}:${row.cursor}`);
          delivered = true; break;
        } catch (error) {
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * (attempt + 1)));
          else console.warn('[结果通知] 已保留待补发:', (error as Error).message);
        }
      }
      if (!delivered) {
        if (row.fallback && !row.fallbackSent) {
          try {
            await this.perform(bot, row.fallback, `${id}:fallback`);
            this.save({ ...row, fallbackSent: true });
          } catch (error) { console.warn('[结果通知] 备用通知失败:', (error as Error).message); }
        }
        return false;
      }
      row = { ...row, cursor: row.cursor + 1 };
      this.save(row);
    }
    return true;
  }
  private async perform(bot: Bot, operation: DeliveryOperation, key: string): Promise<void> {
    const uuid = createHash('sha256').update(key).digest('hex').slice(0, 32);
    switch (operation.type) {
      case 'card': return bot.updateCard(operation.messageId, this.resolveCard(operation));
      case 'text': await bot.reply(operation.messageId, operation.text, operation.replyInThread, uuid); return;
      case 'mention': await bot.replyMention(operation.messageId, operation.target, operation.text, operation.replyInThread, uuid); return;
      case 'comment': return bot.replyToDocumentComment(operation.comment, operation.text);
    }
  }
  private save(row: Delivery): void {
    const previous = new Map(this.rows);
    this.rows.set(row.id, structuredClone(row));
    const done = [...this.rows.values()].filter((r) => r.cursor >= r.operations.length);
    for (const old of done.slice(0, Math.max(0, done.length - 1000))) this.rows.delete(old.id);
    try { writeJsonState(this.filePath, [...this.rows.values()]); }
    catch (error) { this.rows = previous; throw error; }
  }
}
