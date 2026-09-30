import { beginTask, releaseTask, executeTask } from './task-lifecycle.js';
import { flowMatchesSession } from './session-guard.js';
import { deliveryOutbox } from './result-delivery.js';
import { getCliAdapter } from '../cli/registry.js';
import { isProductSpecOwner, type ProductSpecFlow } from '../core/product-spec.js';
import type { Bot, IncomingDocumentComment } from '../im/lark.js';
import { executeCli } from './cli-execution.js';
import { createProductionIsolationPreparer } from '../core/isolation.js';
import { createSessionIsolationSupplier } from './cli-execution.js';
import { applyModelDecision, planExecutionModel } from './execution-model.js';
import { applyArtifactRevision, commentRevisionReply, localArtifactReader } from './artifact-revision.js';

import type { AppRuntime } from './runtime.js';

export async function runProductDocumentComment(options: {
  runtime: AppRuntime;
  bot: Bot;
  flow: ProductSpecFlow;
  comment: IncomingDocumentComment;
  execute?: typeof executeCli;
  planModel?: typeof planExecutionModel;
}): Promise<void> {
  const { runtime, bot, flow, comment } = options;
  if (runtime.productSpecFlows.get(flow.token)?.status !== 'pending') throw new Error('这份制品已确认或失效，不能再修改');
  if (!isProductSpecOwner(flow, { operatorOpenId: comment.senderOpenId, operatorUnionId: comment.senderUnionId, operatorBotId: flow.botId })) throw new Error('只有任务发起人可以请求修改');
  const session = runtime.sessions.get(flow.sessionId);
  if (!session || !flowMatchesSession(flow, session)) {
    throw new Error('评论对应的产品会话已经失效');
  }
  if (session.status !== 'idle') {
    throw new Error('评论对应的会话仍在执行其他任务');
  }
  if (!session.cliSessionId) {
    throw new Error('评论对应的 CLI 会话不存在');
  }

  const run = await beginTask(runtime, session.id, flow, flow.sessionVersion ?? 0);

  try {
    const adapter = getCliAdapter(session.cliId);
    // 评论修订沿用生成方的角色模型配置；blocked 即失败给原因，recreate 不再
    // 续接旧原生会话（其模型已不可核验）。本入口的上下文重建锚定在待确认
    // 制品本身：documentCommentPrompt 携带文档 URL 并要求先读全文再改，
    // 不依赖原生会话历史，故不走台账摘要/阻断分支。
    const modelPlan = await (options.planModel ?? planExecutionModel)(
      runtime.botRuntimes.get(flow.botId)?.config.modelOverrides,
      session,
      { command: adapter.command },
    );
    const resumeCliSessionId = applyModelDecision(modelPlan);
    const result = await executeTask({ runtime, id: commentExecutionId(flow.botId, comment), sessionId: session.id, botId: flow.botId,
      modelSelection: modelPlan.modelSelection,
      freshNativeSession: resumeCliSessionId === undefined,
      execute: () => (options.execute ?? executeCli)(
        adapter,
        documentCommentPrompt(flow, comment),
        session.workspaceDir,
        resumeCliSessionId,
        run.signal,
        () => undefined,
        undefined,
        modelPlan.modelSelection,
        createSessionIsolationSupplier(
          runtime,
          session.id,
          runtime.isolationPreparer ?? createProductionIsolationPreparer(),
        ),
      ) });
    // T-019：评论修订后必须完整回读成功才重算并持久化摘要；回读失败（或
    // 飞书完整回读能力未核验 U-3）不更新摘要，回复不得声称「修改完成」。
    // 飞书路径当前没有已核验的完整文档 reader（生产不注入），恒为未核验。
    const verification = await applyArtifactRevision({
      flow,
      store: runtime.productSpecFlows,
      workspaceDir: session.workspaceDir,
      readFullDocument: flow.request.deliveryMode === 'local' ? localArtifactReader : undefined,
    });
    await deliveryOutbox(runtime, flow.botId, bot).submit({
      id: `reply:${commentExecutionId(flow.botId, comment)}`, botId: flow.botId, sessionId: session.id,
      operations: [{ type: 'comment', comment, text: commentRevisionReply(result.answer || '', verification) }],
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
    throw new Error('本地交付制品不能处理飞书文档评论');
  }
  const artifactLabel = (flow.artifact_kind ?? 'prd') === 'architecture' ? '架构设计' : '产品方案';
  return [
    `用户在待确认的飞书${artifactLabel}中通过评论明确提及了你。`,
    `文档 URL：${flow.request.documentUrl}`,
    `文档类型：${comment.fileType}`,
    `评论 ID：${comment.commentId}`,
    comment.replyId ? `触发回复 ID：${comment.replyId}` : '',
    '使用 lark-drive 读取这一条评论、完整回复和正文位置，再使用 lark-doc 精确修改原文档。',
    '最终回答只客观描述本次尝试的改动点（依据哪条评论、动了哪些章节内容），不要自行宣称「修改完成」「已更新」：给评论者的最终回复由 Agent OS 按服务端完整性核验结果生成，未经核验时不会转述完成类声明。',
    '不要调用评论回复或解决接口，评论是否解决由用户复查后决定。',
    '不要调用 request_spec_approval 或 request_architecture_review，不要生成新的确认卡；原待确认卡继续有效。',
  ].filter(Boolean).join('\n\n');
}
