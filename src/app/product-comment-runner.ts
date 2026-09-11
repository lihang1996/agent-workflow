import { beginTask, releaseTask, executeTask } from './task-lifecycle.js';
import { flowMatchesSession } from './session-guard.js';
import { deliveryOutbox } from './result-delivery.js';
import { getCliAdapter } from '../cli/registry.js';
import { isProductSpecOwner, type ProductSpecFlow } from '../core/product-spec.js';
import type { Bot, IncomingDocumentComment } from '../im/lark.js';
import { executeCli } from './cli-execution.js';

import type { AppRuntime } from './runtime.js';

export async function runProductDocumentComment(options: {
  runtime: AppRuntime;
  bot: Bot;
  flow: ProductSpecFlow;
  comment: IncomingDocumentComment;
  execute?: typeof executeCli;
}): Promise<void> {
  const { runtime, bot, flow, comment } = options;
  if (runtime.productSpecFlows.get(flow.token)?.status !== 'pending') throw new Error('产品方案已确认或失效，不能再修改');
  if (!isProductSpecOwner(flow, { operatorOpenId: comment.senderOpenId, operatorUnionId: comment.senderUnionId, operatorBotId: flow.botId })) throw new Error('只有任务发起人可以请求修改');
  const session = runtime.sessions.get(flow.sessionId);
  if (!session || !flowMatchesSession(flow, session)) {
    throw new Error('评论对应的产品会话已经失效');
  }
  if (session.status !== 'idle') {
    throw new Error('评论对应的产品会话仍在执行其他任务');
  }
  if (!session.cliSessionId) {
    throw new Error('评论对应的产品 CLI 会话不存在');
  }

  const run = await beginTask(runtime, session.id, flow, flow.sessionVersion ?? 0);

  try {
    const adapter = getCliAdapter(session.cliId);
    const result = await executeTask({ runtime, id: commentExecutionId(flow.botId, comment), sessionId: session.id, botId: flow.botId,
      execute: () => (options.execute ?? executeCli)(
      adapter,
      documentCommentPrompt(flow, comment),
      session.workspaceDir,
      session.cliSessionId,
      run.signal,
      () => undefined,
     ) });
    await deliveryOutbox(runtime, flow.botId, bot).submit({
      id: `reply:${commentExecutionId(flow.botId, comment)}`, botId: flow.botId, sessionId: session.id,
      operations: [{ type: 'comment', comment, text: result.answer || '已按评论更新原文档，请复查。' }],
    });
  } finally {
    await releaseTask(runtime, session.id, run);
  }
}

export function commentExecutionId(botId: string, comment: IncomingDocumentComment): string {
  return `comment:${botId}:${comment.fileToken}:${comment.commentId}:${comment.replyId}:${comment.eventId}`;
}

function documentCommentPrompt(
  flow: ProductSpecFlow,
  comment: IncomingDocumentComment,
): string {
  if (flow.request.deliveryMode !== 'lark-doc') {
    throw new Error('本地产品方案不能处理飞书文档评论');
  }
  return [
    '用户在待确认的飞书产品方案中通过评论明确提及了你。',
    `文档 URL：${flow.request.documentUrl}`,
    `文档类型：${comment.fileType}`,
    `评论 ID：${comment.commentId}`,
    comment.replyId ? `触发回复 ID：${comment.replyId}` : '',
    '使用 lark-drive 读取这一条评论、完整回复和正文位置，再使用 lark-doc 精确修改原文档。',
    '修改成功后，最终回答只写一段给评论者看的简短说明，讲清楚具体改了什么。Agent OS 会把最终回答写回原评论。',
    '不要调用评论回复或解决接口，评论是否解决由用户复查后决定。',
    '不要调用 request_spec_approval，不要生成新的确认卡；原待确认卡继续有效。',
  ].filter(Boolean).join('\n\n');
}
