import type { ProductSpec } from '../core/spec-store.js';
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
const specOperationTails = new Map<string, Promise<void>>();

function syncIntervalMs(): number {
  const parsed = Number(process.env.SPEC_REVIEW_SYNC_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : DEFAULT_SYNC_INTERVAL_MS;
}

function reviewBot(ctx: AppContext, spec: ProductSpec, fallback?: Bot): Bot | undefined {
  return ctx.botsById.get(spec.botId) ?? ctx.botsById.get('pm') ?? fallback;
}

function isInternalComment(comment: DocumentComment, bot: Bot): boolean {
  return comment.authorOpenId === bot.openId || comment.content.startsWith(CARD_REVIEW_COMMENT_PREFIX);
}

async function applyReviewComments(
  ctx: AppContext,
  spec: ProductSpec,
  comments: DocumentComment[],
  fallbackBot?: Bot,
): Promise<ProductSpec> {
  if (spec.status !== 'in_review') return spec;
  if (!spec.workflowId) throw new Error(`Spec ${spec.id} 没有关联交付工作流，无法把评审意见交给产品经理。`);
  const known = new Set(spec.comments.flatMap((comment) => comment.docCommentId ? [comment.docCommentId] : []));
  const unseen = comments.filter((comment) => !comment.resolved && !known.has(comment.id));
  if (unseen.length === 0) return spec;

  let changed = spec;
  const localCommentIds: string[] = [];
  for (const comment of unseen) {
    changed = await ctx.specs.addComment(
      changed.id,
      comment.authorOpenId || 'feishu-reviewer',
      comment.content,
      comment.id,
    );
    const local = changed.comments.find((candidate) => candidate.docCommentId === comment.id);
    if (local) localCommentIds.push(local.id);
  }
  const feedback = unseen.map((comment) => `- ${comment.content}`).join('\n');
  await resumeWorkflowForSpecRevision(ctx, changed.id, feedback, localCommentIds);

  const bot = reviewBot(ctx, changed, fallbackBot);
  if (bot) {
    await bot.replyCard(
      changed.messageId,
      buildSpecReviewCard(ctx.specs.get(changed.id) ?? changed),
      changed.topicId !== changed.messageId,
    ).catch((error) => {
      console.error(`[产品评审] 回传 Spec ${changed.id} 卡片失败:`, (error as Error).message);
      return undefined;
    });
  }
  return ctx.specs.get(changed.id) ?? changed;
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

/** 校验工作流后落产品评审结果；续跑失败时恢复为可重试的评审中状态。 */
export async function approveSpecReview(ctx: AppContext, specId: string): Promise<ProductSpec> {
  const spec = ctx.specs.get(specId);
  if (!spec) throw new Error('Spec 不存在或已被删除。');
  if (spec.status !== 'in_review') throw new Error(`当前 Spec 状态为 ${spec.status}，无法通过评审。`);
  if (!spec.workflowId) throw new Error(`Spec ${spec.id} 没有关联交付工作流。`);
  const workflow = ctx.workflows.get(spec.workflowId);
  if (!workflow || workflow.status !== 'awaiting_doc_review' || workflow.specId !== spec.id) {
    throw new Error('交付工作流不在产品评审节点，无法启动内部交付小队。');
  }
  const approved = await ctx.specs.update(spec.id, { status: 'approved' });
  try {
    await resumeWorkflowAfterProductReview(ctx, approved.id);
    return approved;
  } catch (error) {
    if (ctx.workflows.get(workflow.id)?.status === 'awaiting_doc_review') {
      await ctx.specs.update(spec.id, { status: 'in_review' });
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
  const spec = ctx.specs.get(specId);
  if (!spec) throw new Error('Spec 不存在或已被删除。');
  if (spec.status !== 'in_review') throw new Error(`当前 Spec 状态为 ${spec.status}，无法处理评审。`);
  if (!spec.docId) throw new Error('Spec 尚未关联飞书云文档，无法发起云文档评审。');
  const bot = reviewBot(ctx, spec);
  if (!bot) throw new Error('产品经理 Bot 未连接，无法处理评审意见。');
  const documentCommentId = await bot.createDocumentComment(
    spec.docId,
    `${CARD_REVIEW_COMMENT_PREFIX} ${content}`,
  );
  if (!documentCommentId) throw new Error('飞书没有返回评论 ID，评审意见尚未进入处理流程，请重试。');
  const comment: DocumentComment = {
    id: documentCommentId,
    commentId: documentCommentId,
    authorOpenId,
    content,
    resolved: false,
  };
  return applyReviewComments(ctx, spec, [comment], bot);
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
  await applyReviewComments(ctx, spec, [comment], bot);
}

/** 轮询用于补偿服务离线期间或飞书事件配置遗漏的评论。 */
export async function runSpecReviewSync(ctx: AppContext): Promise<void> {
  if (ctx.shuttingDown || ctx.specReviewRunning) return;
  ctx.specReviewRunning = true;
  try {
    for (const spec of ctx.specs.listInReview()) {
      const bot = reviewBot(ctx, spec);
      if (!bot || !spec.docId) continue;
      try {
        const comments = (await bot.listDocumentComments(spec.docId))
          .filter((comment) => !isInternalComment(comment, bot));
        await applyReviewComments(ctx, spec, comments, bot);
      } catch (error) {
        console.error(`[产品评审] 同步 Spec ${spec.id} 评论失败:`, (error as Error).message);
      }
    }
  } finally {
    ctx.specReviewRunning = false;
  }
}

export function startSpecReviewSync(ctx: AppContext): void {
  if (ctx.specReviewTimer) return;
  ctx.specReviewTimer = setInterval(() => void runSpecReviewSync(ctx), syncIntervalMs());
  ctx.specReviewTimer.unref?.();
  void runSpecReviewSync(ctx);
  console.log('[产品评审] 云文档评论同步已启动');
}

export function stopSpecReviewSync(ctx: AppContext): void {
  if (!ctx.specReviewTimer) return;
  clearInterval(ctx.specReviewTimer);
  ctx.specReviewTimer = undefined;
  console.log('[产品评审] 云文档评论同步已停止');
}
