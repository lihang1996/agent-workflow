/**
 * 飞书云文档 Spec 评审同步。
 *
 * Spec 确认后的两种路径：
 * 1. 「确认方案」→ 发布到云文档评审：
 *    publishSpecToDoc() → 创建飞书云文档 → 写入 Spec 正文
 *    用户在云文档评论修改意见 → handleDocumentComment() 回调
 *    approveSpecReview() → 标记 Spec 已批准
 * 2. 「确认并直接开始技术交付」→ confirmSpecAndStartDelivery
 *    跳过云文档，直接启动流水线
 *
 * 含 [RISK_WAIVER] 的 Spec 必须走云文档路径（不允许直接开始）。
 * 云文档操作坑：
 * - title 不能含换行（sanitizeDocumentTitle）
 * - client_token 必须是 UUID 形态
 * - Markdown→块后写嵌套块前必须删 merge_info
 */

import type { ProductSpec } from '../core/spec-store.js';
import { sanitizeForLog } from '../core/log-inspection.js';
import {
  CreatedDocumentWriteError,
  type Bot,
  type DocumentComment,
  type DocumentCommentEvent,
} from '../im/lark.js';
import { buildSpecReviewCard } from '../im/workflow-card.js';
import type { AppContext } from './app-context.js';
import {
  resumeWorkflowAfterProductReview,
  resumeWorkflowForSpecRevision,
} from './pipeline-runner.js';

export const CARD_REVIEW_COMMENT_PREFIX = '[Agent OS 卡片评审]';
const DEFAULT_SYNC_INTERVAL_MS = 60_000;
const MAX_REVIEW_COMMENTS_PER_REVISION = 20;
const MAX_REVIEW_COMMENT_LENGTH = 10_000;
const MAX_REVIEW_FEEDBACK_ITEM_LENGTH = 2_000;
const MAX_CARD_REVIEW_LENGTH = 4_000;
const specOperationTails = new Map<string, Promise<void>>();

function safeReviewError(error: unknown): string {
  return sanitizeForLog(error instanceof Error ? error.message : String(error));
}

function syncIntervalMs(): number {
  const parsed = Number(process.env.SPEC_REVIEW_SYNC_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : DEFAULT_SYNC_INTERVAL_MS;
}

function reviewBot(ctx: AppContext, spec: ProductSpec, fallback?: Bot): Bot | undefined {
  return ctx.botsById.get(spec.botId) ?? ctx.botsById.get('pm') ?? fallback;
}

function isInternalComment(comment: DocumentComment, bot: Bot): boolean {
  return comment.authorOpenId === bot.openId
    && !comment.content.trim().startsWith(CARD_REVIEW_COMMENT_PREFIX);
}

function unseenReviewComments(spec: ProductSpec, comments: DocumentComment[]): DocumentComment[] {
  const known = new Set(spec.comments.flatMap((comment) => comment.docCommentId ? [comment.docCommentId] : []));
  const seen = new Set<string>();
  const unseen: DocumentComment[] = [];
  for (const comment of comments) {
    const id = comment.id.trim();
    const rawContent = comment.content.trim();
    const content = rawContent.startsWith(CARD_REVIEW_COMMENT_PREFIX)
      ? rawContent.slice(CARD_REVIEW_COMMENT_PREFIX.length).trim()
      : rawContent;
    if (comment.resolved || !id || !content || known.has(id) || seen.has(id)) continue;
    if (id.length > 500) throw new Error('飞书评论 ID 超出本地存储上限。');
    seen.add(id);
    unseen.push({
      ...comment,
      id,
      commentId: comment.commentId.trim() || id,
      authorOpenId: (comment.authorOpenId.trim() || 'feishu-reviewer').slice(0, 200),
      content: content.slice(0, MAX_REVIEW_COMMENT_LENGTH),
    });
    if (unseen.length >= MAX_REVIEW_COMMENTS_PER_REVISION) break;
  }
  return unseen;
}

function reviewFeedback(comments: DocumentComment[]): string {
  return comments
    .map((comment) => `- ${comment.content.slice(0, MAX_REVIEW_FEEDBACK_ITEM_LENGTH)}`)
    .join('\n');
}

async function applyReviewComments(
  ctx: AppContext,
  specId: string,
  comments: DocumentComment[],
  fallbackBot?: Bot,
): Promise<ProductSpec> {
  return runSerialSpecOperation(specId, () =>
    applyReviewCommentsUnlocked(ctx, specId, comments, fallbackBot));
}

async function applyReviewCommentsUnlocked(
  ctx: AppContext,
  specId: string,
  comments: DocumentComment[],
  fallbackBot?: Bot,
): Promise<ProductSpec> {
  const spec = ctx.specs.get(specId);
  if (!spec) throw new Error(`Spec 不存在: ${specId}`);
  if (spec.status !== 'in_review') return spec;
  if (!spec.workflowId) throw new Error(`Spec ${spec.id} 没有关联交付工作流，无法把评审意见交给产品经理。`);
  const workflow = ctx.workflows.get(spec.workflowId);
  if (!workflow || workflow.status !== 'awaiting_doc_review' || workflow.specId !== spec.id) {
    throw new Error('交付工作流不在产品评审节点，无法处理云文档评论。');
  }

  const unseen = unseenReviewComments(spec, comments);
  if (unseen.length === 0) return spec;

  const changed = await ctx.specs.addComments(spec.id, unseen.map((comment) => ({
    authorOpenId: comment.authorOpenId,
    content: comment.content,
    docCommentId: comment.id,
  })));
  const unseenIds = new Set(unseen.map((comment) => comment.id));
  const localCommentIds = changed.comments
    .filter((comment) => !!comment.docCommentId && unseenIds.has(comment.docCommentId))
    .map((comment) => comment.id);
  await resumeWorkflowForSpecRevision(ctx, changed.id, reviewFeedback(unseen), localCommentIds);
  const latestWorkflow = ctx.workflows.get(workflow.id);
  if (latestWorkflow?.status === 'failed') {
    throw new Error(latestWorkflow.error ?? '产品经理修订工作流启动失败。');
  }

  const latest = ctx.specs.get(changed.id) ?? changed;
  const bot = reviewBot(ctx, latest, fallbackBot);
  if (bot) {
    await bot.replyCard(
      latest.messageId,
      buildSpecReviewCard(latest),
      latest.topicId !== latest.messageId,
    ).catch((error) => {
      console.error(`[产品评审] 回传 Spec ${latest.id} 卡片失败:`, safeReviewError(error));
      return undefined;
    });
  }
  return latest;
}

/** 已确认 Spec 首次创建云文档；修订后覆盖原文档，链接保持不变。 */
export async function publishSpecToDoc(ctx: AppContext, specId: string): Promise<ProductSpec> {
  return runSerialSpecOperation(specId, () => publishSpecToDocUnlocked(ctx, specId));
}

async function publishSpecToDocUnlocked(ctx: AppContext, specId: string): Promise<ProductSpec> {
  const spec = ctx.specs.get(specId);
  if (!spec) throw new Error(`Spec 不存在: ${specId}`);
  if (!spec.workflowId) throw new Error(`Spec ${spec.id} 没有关联交付工作流。`);
  const workflow = ctx.workflows.get(spec.workflowId);
  if (!workflow || workflow.status !== 'awaiting_doc_review' || workflow.specId !== spec.id) {
    throw new Error('交付工作流不在云文档评审节点，不能发布产品方案。');
  }
  if (spec.status === 'in_review' && spec.docId) return spec;
  if (spec.status !== 'confirmed') {
    throw new Error(`当前 Spec 状态为 ${spec.status}，仅已确认方案可以发布。`);
  }
  if (spec.comments.some((comment) => !comment.resolved)) {
    throw new Error('仍有未处理的产品评审意见，不能发布新版本。');
  }
  const bot = reviewBot(ctx, spec);
  if (!bot) throw new Error('产品经理 Bot 未连接，无法发布云文档。');

  if (spec.docId) {
    await bot.updateDocument(spec.docId, spec.content);
    const updated = await ctx.specs.updateIfStatus(spec.id, 'confirmed', {
      status: 'in_review',
      docUrl: spec.docUrl ?? `https://feishu.cn/docx/${spec.docId}`,
    });
    if (!updated) throw new Error('Spec 状态已变化，云文档修订结果未写入。');
    return updated;
  }

  try {
    const document = await bot.createDocument(`产品 Spec · ${spec.title}`, spec.content);
    const updated = await ctx.specs.updateIfStatus(spec.id, 'confirmed', {
      status: 'in_review',
      docId: document.documentId,
      docUrl: document.url,
    });
    if (!updated) throw new Error('Spec 状态已变化，云文档发布结果未写入。');
    return updated;
  } catch (error) {
    if (error instanceof CreatedDocumentWriteError) {
      await ctx.specs.updateIfStatus(spec.id, 'confirmed', {
        docId: error.documentId,
        docUrl: error.url,
      });
      throw new Error('云文档已创建但正文写入失败；请重试，系统会继续写入同一份文档。', { cause: error });
    }
    throw error;
  }
}

/** 评审通过前同步检查远端评论；与“要求修改”共用同一把 Spec 锁。 */
export async function approveSpecReview(ctx: AppContext, specId: string): Promise<ProductSpec> {
  return runSerialSpecOperation(specId, () => approveSpecReviewUnlocked(ctx, specId));
}

async function approveSpecReviewUnlocked(ctx: AppContext, specId: string): Promise<ProductSpec> {
  const spec = ctx.specs.get(specId);
  if (!spec) throw new Error('Spec 不存在或已被删除。');
  if (spec.status !== 'in_review') throw new Error(`当前 Spec 状态为 ${spec.status}，无法通过评审。`);
  if (!spec.workflowId) throw new Error(`Spec ${spec.id} 没有关联交付工作流。`);
  if (!spec.docId) throw new Error('Spec 尚未关联飞书云文档。');
  const workflow = ctx.workflows.get(spec.workflowId);
  if (!workflow || workflow.status !== 'awaiting_doc_review' || workflow.specId !== spec.id) {
    throw new Error('交付工作流不在产品评审节点，无法启动内部交付小队。');
  }
  if (spec.comments.some((comment) => !comment.resolved)) {
    throw new Error('仍有未处理的评审意见，不能通过评审。');
  }
  const bot = reviewBot(ctx, spec);
  if (!bot) throw new Error('产品经理 Bot 未连接，无法核对云文档评论。');
  const remoteComments = (await bot.listDocumentComments(spec.docId))
    .filter((comment) => !isInternalComment(comment, bot));
  if (unseenReviewComments(spec, remoteComments).length > 0) {
    await applyReviewCommentsUnlocked(ctx, spec.id, remoteComments, bot);
    throw new Error('发现新的云文档评审意见，已交给产品经理处理，本次不能通过。');
  }

  const approved = await ctx.specs.updateIfStatus(spec.id, 'in_review', { status: 'approved' });
  if (!approved) throw new Error(`当前 Spec 状态为 ${ctx.specs.get(spec.id)?.status ?? 'unknown'}，无法重复通过评审。`);
  try {
    await resumeWorkflowAfterProductReview(ctx, approved.id);
    return ctx.specs.get(approved.id) ?? approved;
  } catch (error) {
    if (ctx.workflows.get(workflow.id)?.status === 'awaiting_doc_review') {
      await ctx.specs.updateIfStatus(spec.id, 'approved', { status: 'in_review' });
    }
    throw error;
  }
}

/** 卡片中的修改意见先同步为云文档评论，再进入同一条 PM 修订工作流。 */
export async function requestSpecChangesFromCard(
  ctx: AppContext,
  specId: string,
  authorOpenId: string,
  content: string,
): Promise<ProductSpec> {
  return runSerialSpecOperation(specId, async () => {
    const normalized = content.trim();
    if (!normalized) throw new Error('请先填写修改意见。');
    if (normalized.length > MAX_CARD_REVIEW_LENGTH) throw new Error('修改意见不能超过 4000 字。');
    if (!authorOpenId.trim()) throw new Error('评审人身份缺失。');
    const spec = ctx.specs.get(specId);
    if (!spec) throw new Error('Spec 不存在或已被删除。');
    if (spec.status !== 'in_review') throw new Error(`当前 Spec 状态为 ${spec.status}，无法处理评审。`);
    if (!spec.docId) throw new Error('Spec 尚未关联飞书云文档，无法发起云文档评审。');
    if (!spec.workflowId) throw new Error(`Spec ${spec.id} 没有关联交付工作流。`);
    const workflow = ctx.workflows.get(spec.workflowId);
    if (!workflow || workflow.status !== 'awaiting_doc_review' || workflow.specId !== spec.id) {
      throw new Error('交付工作流不在产品评审节点，无法处理评审意见。');
    }
    const bot = reviewBot(ctx, spec);
    if (!bot) throw new Error('产品经理 Bot 未连接，无法处理评审意见。');
    const documentCommentId = await bot.createDocumentComment(
      spec.docId,
      `${CARD_REVIEW_COMMENT_PREFIX} ${normalized}`,
    );
    if (!documentCommentId?.trim()) throw new Error('飞书没有返回评论 ID，评审意见尚未进入处理流程，请重试。');
    const comment: DocumentComment = {
      id: documentCommentId,
      commentId: documentCommentId,
      authorOpenId,
      content: normalized,
      resolved: false,
    };
    return applyReviewCommentsUnlocked(ctx, spec.id, [comment], bot);
  });
}

/** 实时接收飞书云文档评论事件。 */
export async function handleDocumentComment(
  ctx: AppContext,
  event: DocumentCommentEvent,
  sourceBot: Bot,
): Promise<void> {
  const spec = ctx.specs.findByDocumentId(event.documentId);
  if (!spec || spec.status !== 'in_review') return;
  const bot = reviewBot(ctx, spec, sourceBot) ?? sourceBot;
  const comment = await bot.getDocumentComment(event.documentId, event.commentId, event.replyId);
  if (!comment || isInternalComment(comment, bot)) return;
  await applyReviewComments(ctx, spec.id, [comment], bot);
}

async function syncResolvedDocumentComments(ctx: AppContext, specId: string): Promise<void> {
  const spec = ctx.specs.get(specId);
  if (!spec?.docId) return;
  const bot = reviewBot(ctx, spec);
  if (!bot) return;
  const groups = new Map<string, string[]>();
  for (const comment of spec.comments) {
    if (!comment.resolved || !comment.docCommentId || comment.documentResolvedAt) continue;
    const documentCommentId = comment.docCommentId.split(':', 1)[0];
    groups.set(documentCommentId, [...(groups.get(documentCommentId) ?? []), comment.id]);
  }
  for (const [documentCommentId, localCommentIds] of groups) {
    try {
      await bot.resolveDocumentComment(spec.docId, documentCommentId);
      await ctx.specs.markDocumentCommentsResolved(spec.id, new Set(localCommentIds));
    } catch (error) {
      console.error(
        `[产品评审] 同步解决 Spec ${spec.id} 评论 ${documentCommentId} 失败:`,
        safeReviewError(error),
      );
    }
  }
}

async function resumePendingReviewRevision(ctx: AppContext, specId: string): Promise<void> {
  const spec = ctx.specs.get(specId);
  if (!spec || spec.status !== 'changes_requested') return;
  const comments = spec.comments.filter((comment) => !comment.resolved);
  if (comments.length === 0) return;
  await resumeWorkflowForSpecRevision(
    ctx,
    spec.id,
    comments.map((comment) => `- ${comment.content.slice(0, MAX_REVIEW_FEEDBACK_ITEM_LENGTH)}`).join('\n'),
    comments.map((comment) => comment.id),
  );
}

/** 轮询用于补偿服务离线期间、事件漏收和评论解决失败。 */
export async function runSpecReviewSync(ctx: AppContext): Promise<void> {
  if (ctx.shuttingDown || ctx.specReviewRunning) return;
  ctx.specReviewRunning = true;
  try {
    for (const spec of ctx.specs.listPendingDocumentResolution()) {
      try {
        await runSerialSpecOperation(spec.id, () => syncResolvedDocumentComments(ctx, spec.id));
      } catch (error) {
        console.error(`[产品评审] 同步解决 Spec ${spec.id} 评论失败:`, safeReviewError(error));
      }
    }
    for (const spec of ctx.specs.listPendingReviewRevision()) {
      try {
        await runSerialSpecOperation(spec.id, () => resumePendingReviewRevision(ctx, spec.id));
      } catch (error) {
        console.error(`[产品评审] 恢复 Spec ${spec.id} 修订流程失败:`, safeReviewError(error));
      }
    }
    for (const spec of ctx.specs.listInReview()) {
      const bot = reviewBot(ctx, spec);
      if (!bot || !spec.docId) continue;
      try {
        const comments = (await bot.listDocumentComments(spec.docId))
          .filter((comment) => !isInternalComment(comment, bot));
        await applyReviewComments(ctx, spec.id, comments, bot);
      } catch (error) {
        console.error(`[产品评审] 同步 Spec ${spec.id} 评论失败:`, safeReviewError(error));
      }
    }
  } finally {
    ctx.specReviewRunning = false;
  }
}

function runSerialSpecOperation<T>(specId: string, operation: () => Promise<T>): Promise<T> {
  const previous = specOperationTails.get(specId) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const tail = run.then(() => undefined, () => undefined);
  specOperationTails.set(specId, tail);
  void tail.then(() => {
    if (specOperationTails.get(specId) === tail) specOperationTails.delete(specId);
  });
  return run;
}

export function startSpecReviewSync(ctx: AppContext): void {
  if (ctx.specReviewTimer) return;
  const tick = () => void runSpecReviewSync(ctx).catch((error) => {
    console.error('[产品评审] 云文档评论同步任务异常:', safeReviewError(error));
  });
  ctx.specReviewTimer = setInterval(tick, syncIntervalMs());
  ctx.specReviewTimer.unref?.();
  tick();
  console.log('[产品评审] 云文档评论同步已启动');
}

export function stopSpecReviewSync(ctx: AppContext): void {
  if (!ctx.specReviewTimer) return;
  clearInterval(ctx.specReviewTimer);
  ctx.specReviewTimer = undefined;
  console.log('[产品评审] 云文档评论同步已停止');
}
