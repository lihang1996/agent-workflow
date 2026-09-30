import { flowMatchesSession } from './session-guard.js';
import type { BotConfig } from '../core/bot-registry.js';
import { isProductSpecOwner } from '../core/product-spec.js';
import type { Bot, IncomingDocumentComment } from '../im/lark.js';
import type { AppRuntime } from './runtime.js';
import { runProductDocumentComment } from './product-comment-runner.js';

export class ProductCommentScheduler {
  private readonly processed = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();
  constructor(private readonly runtime: AppRuntime, private readonly run = runProductDocumentComment) {}

  schedule(config: BotConfig, bot: Bot, comment: IncomingDocumentComment): void {
    if (!comment.mentionedBot) return;
    // 同一文档 URL 只允许对应唯一有效 pending flow：多条匹配时无法唯一定位
    // 评论目标，失败关闭（不静默取第一条，work/30）。
    const candidates = this.runtime.productSpecFlows.listPendingByDocument(config.id, comment.fileToken);
    if (candidates.length === 0) return;
    if (candidates.length > 1) {
      console.error(
        `[产品评论] 文档 ${comment.fileToken} 存在 ${candidates.length} 个待确认制品，无法唯一定位评论目标，拒绝处理（失败关闭）`,
      );
      return;
    }
    const flow = candidates[0];
    if (!flowMatchesSession(flow, this.runtime.sessions.get(flow.sessionId)) || !isProductSpecOwner(flow, {
      operatorOpenId: comment.senderOpenId, operatorUnionId: comment.senderUnionId, operatorBotId: config.id,
    })) return;
    const key = `${config.id}:${comment.eventId || [comment.fileToken, comment.commentId, comment.replyId].join(':')}`;
    if (this.processed.has(key)) return;
    const release = this.runtime.productSpecFlows.reserveComment(flow.token);
    if (!release) return;
    this.processed.add(key);
    if (this.processed.size > 1000) this.processed.delete(this.processed.values().next().value!);
    const previous = this.queues.get(flow.sessionId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      let reactionAdded = false;
      try {
        // Recheck after waiting: a newer proposal may have expired this one.
        if (this.runtime.productSpecFlows.get(flow.token)?.status !== 'pending') return;
        try { await bot.setDocumentCommentWorking(comment, true); reactionAdded = true; }
        catch (error) { console.warn('[产品评论] 表情失败，继续处理:', (error as Error).message); }
        await this.run({ runtime: this.runtime, bot, flow, comment });
      } catch (error) {
        this.processed.delete(key);
        console.error('[产品评论] 处理失败:', (error as Error).message);
        await bot.replyToDocumentComment(comment, `这条评论暂时没有处理完成：${(error as Error).message}`).catch(console.error);
      } finally {
        if (reactionAdded) await bot.setDocumentCommentWorking(comment, false).catch(console.error);
        release();
      }
    });
    this.queues.set(flow.sessionId, queued);
    void queued.finally(() => {
      if (this.queues.get(flow.sessionId) === queued) this.queues.delete(flow.sessionId);
    }).catch(console.error);
  }

  async drain(): Promise<void> { await Promise.allSettled([...this.queues.values()]); }
}
