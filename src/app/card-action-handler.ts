import { beginTask } from './task-lifecycle.js';
import { canManageSession, flowMatchesSession } from './session-guard.js';
import type { CardAction, CardActionResponse } from '../im/lark.js';
import {
  buildArchitectureHandoffCard,
  buildClarificationCard,
  buildClarificationContinuingCard,
  buildClarificationRetryCard,
  buildCodingAuthorizationActiveCard,
  buildCodingAuthorizationDraftCard,
  buildCodingAuthorizationInactiveCard,
  buildProductSpecApprovedCard,
  buildProductSpecExpiredCard,
  buildProductSpecUnusableApprovalCard,
  buildResumeCard,
} from '../im/card.js';
import type {
  BotConfig,
  ProductDeliveryMode,
} from '../core/bot-registry.js';
import { isClarificationOwner } from '../core/clarification.js';
import { isProductSpecOwner } from '../core/product-spec.js';
import { verifyApprovableArtifact } from '../core/artifact-digest.js';
import { verifyArtifactCitations } from '../core/kb-prefetch.js';
import { openArchitectureHandoff } from '../core/architecture-handoff.js';
import { verifyArchitectureCitations, verifyArchitectureUpstreamAtApproval } from './architecture-flow.js';
import {
  confirmCodingAuthorization,
  createCodingAuthorizationDraft,
  effectiveStatus,
  revokeCodingAuthorization,
} from '../core/coding-authorization.js';
import { requestTaskAbort } from '../core/task-abort.js';
import { getCliAdapter } from '../cli/registry.js';
import { listNativeCliSessions } from '../cli/native-sessions.js';
import { createProductionIsolationPreparer } from '../core/isolation.js';
import { continueClarificationFlow } from './clarification-runner.js';
import type { AppRuntime } from './runtime.js';

export function createCardActionHandler(options: {
  runtime: AppRuntime;
  config: BotConfig;
  defaultProductDeliveryMode: ProductDeliveryMode;
  continueFlow?: typeof continueClarificationFlow;
}): (action: CardAction) => Promise<CardActionResponse | undefined> {
  const { runtime, config, defaultProductDeliveryMode } = options;
  return async (action) => {
    if (action.value.action === 'approve_product_spec') {
      const flowToken = typeof action.value.flowToken === 'string'
        ? action.value.flowToken
        : '';
      const flow = runtime.productSpecFlows.get(flowToken);
      if (!flow || flow.botId !== config.id || !action.messageId) {
        return { toast: { type: 'error', content: '这份产品方案已经失效。' } };
      }
      if (flow.status === 'expired' || (flow.status === 'pending' && !flowMatchesSession(flow, runtime.sessions.get(flow.sessionId)))) {
        return {
          toast: { type: 'warning', content: '这份产品方案已经失效。' },
          card: {
            type: 'raw',
            data: buildProductSpecExpiredCard(flow),
          },
        };
      }
      if (flow.status === 'invalidated') {
        // W5 返修：失效 flow 的展示与处理都标不可用，不给「重新确认」的错觉。
        return {
          toast: { type: 'warning', content: '这份产品方案已失效，不能确认。' },
          card: {
            type: 'raw',
            data: buildProductSpecUnusableApprovalCard(flow),
          },
        };
      }
      if (!isProductSpecOwner(flow, { ...action, operatorBotId: config.id })) {
        return { toast: { type: 'warning', content: '只有任务发起人可以确认。' } };
      }
      if (flow.status === 'approved') {
        // 旧 approved 未绑定摘要：确认记录不可用，不得当作有效版本展示。
        if (flow.content_digest == null) {
          return {
            toast: { type: 'warning', content: '这份确认记录没有绑定内容摘要，不能作为有效版本使用。' },
            card: { type: 'raw', data: buildProductSpecUnusableApprovalCard(flow) },
          };
        }
        return { toast: { type: 'info', content: '产品方案已经确认。' }, card: { type: 'raw', data: buildProductSpecApprovedCard(flow) } };
      }
      if (runtime.sessions.get(flow.sessionId)?.status === 'active') {
        return { toast: { type: 'warning', content: '产品会话仍在修改方案，请完成后再确认。' } };
      }
      if (!runtime.productSpecFlows.beginApproval(flowToken)) {
        return { toast: { type: 'warning', content: '评论修改仍在处理中，请稍后确认。' } };
      }
      try {
        // G1：批准动作前回读完整制品重算摘要；无摘要、无法回读、漂移、知识引用
        // 不可核验（含从固定制品正文提取的实际引用与任务/会话/作用域绑定）、
        // 飞书完整回读能力未核验（U-3）一律拒绝确认（失败关闭）。
        const gate = await verifyApprovableArtifact({
          flow,
          workspaceDir: runtime.sessions.get(flow.sessionId)?.workspaceDir,
          verifyKnowledgeCitations: runtime.knowledgePrefetch
            ? ({ artifactTexts, declaredRefs }) => verifyArtifactCitations({
                artifactTexts,
                declaredRefs,
                ledger: runtime.knowledgePrefetch!,
                binding: { taskId: flow.taskId, sessionId: flow.sessionId },
              })
            : undefined,
        });
        if (!gate.ok) {
          return { toast: { type: gate.level, content: gate.message } };
        }
        // 确认即终点：只记录状态，后续实现由用户自行 @ 开发。
        const approved = runtime.productSpecFlows.approve(flowToken, action.messageId);
        if (!approved) {
          return { toast: { type: 'warning', content: '方案状态已经更新。' } };
        }
        return {
          toast: { type: 'success', content: '产品方案已确认。' },
          card: {
            type: 'raw',
            data: buildProductSpecApprovedCard(approved),
          },
        };
      } finally {
        runtime.productSpecFlows.endApproval(flowToken);
      }
    }

    if (action.value.action === 'handoff_architecture') {
      const flowToken = typeof action.value.flowToken === 'string'
        ? action.value.flowToken
        : '';
      const flow = runtime.productSpecFlows.get(flowToken);
      if (!flow || flow.botId !== config.id || !action.messageId) {
        return { toast: { type: 'error', content: '这份产品方案已经失效。' } };
      }
      if ((flow.artifact_kind ?? 'prd') !== 'prd') {
        return { toast: { type: 'warning', content: '只有产品方案（PRD）可以转架构设计。' } };
      }
      if (!isProductSpecOwner(flow, { ...action, operatorBotId: config.id })) {
        return { toast: { type: 'warning', content: '只有任务发起人可以发起架构交接。' } };
      }
      const handoffs = runtime.architectureHandoffs;
      if (!handoffs) {
        return { toast: { type: 'error', content: '架构交接服务不可用，本次交接没有创建。' } };
      }
      try {
        // 交接只由已批准 PRD 卡片发起（卡片回调携带服务端 flowToken，不可伪造）；
        // pending/失效/无摘要（旧记录）一律拒绝，零候选失败关闭。
        const handoff = openArchitectureHandoff({
          flows: runtime.productSpecFlows,
          handoffs,
          prdToken: flowToken,
          operator: { ...action, operatorBotId: config.id },
        });
        return {
          toast: { type: 'success', content: '架构交接已创建，请把交接码带给开发成员。' },
          card: {
            type: 'raw',
            data: buildArchitectureHandoffCard({ handoffToken: handoff.token, flow: runtime.productSpecFlows.get(flowToken) ?? flow }),
          },
        };
      } catch (error) {
        return { toast: { type: 'error', content: (error as Error).message } };
      }
    }

    if (action.value.action === 'approve_architecture') {
      const flowToken = typeof action.value.flowToken === 'string'
        ? action.value.flowToken
        : '';
      const flow = runtime.productSpecFlows.get(flowToken);
      if (!flow || flow.botId !== config.id || !action.messageId) {
        return { toast: { type: 'error', content: '这份架构设计已经失效。' } };
      }
      if ((flow.artifact_kind ?? 'prd') !== 'architecture') {
        return { toast: { type: 'warning', content: '这个确认动作只适用于架构设计。' } };
      }
      if (flow.status === 'expired' || (flow.status === 'pending' && !flowMatchesSession(flow, runtime.sessions.get(flow.sessionId)))) {
        return {
          toast: { type: 'warning', content: '这份架构设计已经失效。' },
          card: { type: 'raw', data: buildProductSpecExpiredCard(flow) },
        };
      }
      if (flow.status === 'invalidated') {
        return {
          toast: { type: 'warning', content: '这份架构设计已失效，不能确认。' },
          card: { type: 'raw', data: buildProductSpecUnusableApprovalCard(flow) },
        };
      }
      if (!isProductSpecOwner(flow, { ...action, operatorBotId: config.id })) {
        return { toast: { type: 'warning', content: '只有任务发起人可以确认。' } };
      }
      if (flow.status === 'approved') {
        if (flow.content_digest == null) {
          return {
            toast: { type: 'warning', content: '这份确认记录没有绑定内容摘要，不能作为有效版本使用。' },
            card: { type: 'raw', data: buildProductSpecUnusableApprovalCard(flow) },
          };
        }
        return { toast: { type: 'info', content: '架构设计已经确认。' }, card: { type: 'raw', data: buildProductSpecApprovedCard(flow) } };
      }
      if (runtime.sessions.get(flow.sessionId)?.status === 'active') {
        return { toast: { type: 'warning', content: '会话仍在修改架构设计，请完成后再确认。' } };
      }
      if (!runtime.productSpecFlows.beginApproval(flowToken)) {
        return { toast: { type: 'warning', content: '评论修改仍在处理中，请稍后确认。' } };
      }
      try {
        // 上游门禁：PRD 仍唯一、已批准、版本一致且文件未漂移——PRD 确认绝不
        // 自动解释成架构批准；上游失效即拦下架构确认。
        const upstreamGate = await verifyArchitectureUpstreamAtApproval({
          flow,
          flows: runtime.productSpecFlows,
          prdWorkspaceDir: flow.upstream
            ? runtime.sessions.get(flow.upstream.prdSessionId)?.workspaceDir
            : undefined,
        });
        if (!upstreamGate.ok) {
          return { toast: { type: 'warning', content: upstreamGate.reason } };
        }
        // G1（架构分支）：完整回读重算摘要 + 继承知识引用核验（绑定沿用上游
        // PRD 的台账任务/会话；引用存在而台账缺失时失败关闭）。
        const gate = await verifyApprovableArtifact({
          flow,
          workspaceDir: runtime.sessions.get(flow.sessionId)?.workspaceDir,
          verifyKnowledgeCitations: runtime.knowledgePrefetch && flow.upstream
            ? ({ artifactTexts, declaredRefs }) => verifyArchitectureCitations({
                artifactTexts,
                declaredRefs,
                ledger: runtime.knowledgePrefetch!,
                upstream: flow.upstream!,
              })
            : undefined,
        });
        if (!gate.ok) {
          return { toast: { type: gate.level, content: gate.message } };
        }
        // 确认即终点：架构确认不派发实现，也不构成编码授权（授权通道未开放）。
        const approved = runtime.productSpecFlows.approve(flowToken, action.messageId);
        if (!approved) {
          return { toast: { type: 'warning', content: '架构设计状态已经更新。' } };
        }
        return {
          toast: { type: 'success', content: '架构设计已确认。' },
          card: {
            type: 'raw',
            data: buildProductSpecApprovedCard(approved),
          },
        };
      } finally {
        runtime.productSpecFlows.endApproval(flowToken);
      }
    }

    if (action.value.action === 'authorize_coding') {
      // T-021：显式授权入口——只接受携带可信 flowToken 的卡片动作（普通文本
      // 无可靠制品定位，不能授权）。第一步创建草稿，二次确认后才 active。
      const flowToken = typeof action.value.flowToken === 'string'
        ? action.value.flowToken
        : '';
      const authorizations = runtime.codingAuthorizations;
      if (!authorizations) {
        return { toast: { type: 'error', content: '编码授权服务不可用，本次操作没有创建任何授权。' } };
      }
      const allowedPaths = Array.isArray(action.value.allowedPaths)
        && action.value.allowedPaths.every((path) => typeof path === 'string')
        ? action.value.allowedPaths as string[]
        : undefined;
      try {
        const draft = await createCodingAuthorizationDraft({
          store: authorizations,
          flows: runtime.productSpecFlows,
          operator: { ...action, operatorBotId: config.id },
          input: {
            flowToken,
            ...(allowedPaths ? { allowedPaths } : {}),
          },
          resolveWorkspaceDir: (sessionId) => runtime.sessions.get(sessionId)?.workspaceDir,
        });
        return {
          toast: { type: 'success', content: '授权草稿已创建，请在卡片上核对后进行第二次确认。' },
          card: { type: 'raw', data: buildCodingAuthorizationDraftCard(draft) },
        };
      } catch (error) {
        return { toast: { type: 'error', content: (error as Error).message } };
      }
    }

    if (action.value.action === 'confirm_coding_authorization') {
      const authorizationId = typeof action.value.authorizationId === 'string'
        ? action.value.authorizationId
        : '';
      const authorizations = runtime.codingAuthorizations;
      if (!authorizations) {
        return { toast: { type: 'error', content: '编码授权服务不可用。' } };
      }
      try {
        const confirmed = await confirmCodingAuthorization({
          store: authorizations,
          flows: runtime.productSpecFlows,
          operator: { ...action, operatorBotId: config.id },
          authorizationId,
          resolveWorkspaceDir: (sessionId) => runtime.sessions.get(sessionId)?.workspaceDir,
        });
        return {
          toast: { type: 'success', content: '授权记录已确认（执行层隔离未接线前编码保持阻断）。' },
          card: { type: 'raw', data: buildCodingAuthorizationActiveCard(confirmed) },
        };
      } catch (error) {
        const record = authorizations.get(authorizationId);
        return {
          toast: { type: 'error', content: (error as Error).message },
          ...(record && effectiveStatus(record) !== 'draft'
            ? { card: { type: 'raw', data: buildCodingAuthorizationInactiveCard(record) } }
            : {}),
        };
      }
    }

    if (action.value.action === 'revoke_coding_authorization') {
      const authorizationId = typeof action.value.authorizationId === 'string'
        ? action.value.authorizationId
        : '';
      const authorizations = runtime.codingAuthorizations;
      if (!authorizations) {
        return { toast: { type: 'error', content: '编码授权服务不可用。' } };
      }
      try {
        const revoked = revokeCodingAuthorization({
          store: authorizations,
          operator: { ...action, operatorBotId: config.id },
          authorizationId,
        });
        return {
          toast: { type: 'success', content: '编码授权已撤销。' },
          card: { type: 'raw', data: buildCodingAuthorizationInactiveCard(revoked) },
        };
      } catch (error) {
        return { toast: { type: 'error', content: (error as Error).message } };
      }
    }

    if (action.value.action === 'answer_clarification') {
      const flowToken = typeof action.value.flowToken === 'string'
        ? action.value.flowToken
        : '';
      const questionId = typeof action.value.questionId === 'string'
        ? action.value.questionId
        : '';
      const flow = runtime.clarificationFlows.get(flowToken);
      if (!flow || flow.botId !== config.id || !action.messageId) {
        return { toast: { type: 'error', content: '这组澄清问题已经失效。' } };
      }
      if (!isClarificationOwner(flow, { ...action, operatorBotId: config.id })) {
        return { toast: { type: 'warning', content: '只有任务发起人可以回答。' } };
      }

      const currentSession = runtime.sessions.get(flow.sessionId);
      if (!currentSession || !flowMatchesSession(flow, currentSession)) {
        return { toast: { type: 'error', content: '对应的 CLI 会话已经失效。' } };
      }
      if (currentSession.status === 'active') {
        return { toast: { type: 'warning', content: '当前会话仍在执行，请稍后重试。' } };
      }
      const complete = flow.currentIndex >= flow.request.questions.length;
      const question = flow.request.questions[complete ? flow.request.questions.length - 1 : flow.currentIndex];
      if (!question || question.id !== questionId) {
        return { toast: { type: 'warning', content: '问题已经更新，请按当前卡片作答。' } };
      }

      const decisionMode = action.value.decisionMode === 'current'
        || action.value.decisionMode === 'remaining'
        ? action.value.decisionMode
        : undefined;
      let answered;
      if (complete) {
        answered = { flow, complete: true };
      } else if (decisionMode) {
        answered = runtime.clarificationFlows.answerWithRecommendation(
          flowToken,
          decisionMode === 'remaining',
        );
      } else {
        const custom = action.value.custom === true;
        const optionId = typeof action.value.optionId === 'string'
          ? action.value.optionId
          : '';
        const selectedOption = question.options.find(
          (option) => option.id === optionId,
        );
        const customAnswer = typeof action.formValue.custom_answer === 'string'
          ? action.formValue.custom_answer.trim()
          : '';
        const answer = custom ? customAnswer : selectedOption?.label ?? '';
        if (!answer) {
          return {
            toast: {
              type: 'warning',
              content: custom ? '请先输入你的答案。' : '这个选项已经失效。',
            },
          };
        }
        answered = runtime.clarificationFlows.answer(
          flowToken,
          questionId,
          answer,
        );
      }
      if (!answered) {
        return { toast: { type: 'warning', content: '答案没有保存，请重试。' } };
      }
      if (!answered.complete) {
        return {
          toast: { type: 'success', content: '已记录，继续下一题。' },
          card: {
            type: 'raw',
            data: buildClarificationCard({ flow: answered.flow }),
          },
        };
      }

      const session = runtime.sessions.get(answered.flow.sessionId);
      const botRuntime = runtime.botRuntimes.get(config.id);
      if (!session || !botRuntime || session.status === 'closed') {
        return { toast: { type: 'error', content: '对应的 CLI 会话已经失效。' } };
      }
      if (session.status === 'active') {
        return { toast: { type: 'warning', content: '当前会话仍在执行，请稍后重试。' } };
      }

      try {
        const run = await beginTask(runtime, session.id, answered.flow, answered.flow.sessionVersion ?? 0);
        // Keep the answered flow durable until its continuation succeeds.
        queueMicrotask(() => {
          void (options.continueFlow ?? continueClarificationFlow)({
            runtime,
            bot: botRuntime.bot,
            config,
            flow: answered.flow,
            run,
            defaultDeliveryMode: defaultProductDeliveryMode,
          }).catch(async (error) => {
            console.error('[澄清] 继续执行失败:', (error as Error).message);
            if (runtime.clarificationFlows.get(flowToken)) {
              await botRuntime.bot.updateCard(action.messageId, buildClarificationRetryCard(answered.flow)).catch(console.error);
            }
            await botRuntime.bot.reply(answered.flow.originalMessageId, '继续整理失败，答案已保留。请点击重新整理，或在话题中发送补充信息重试。', answered.flow.replyInThread).catch(console.error);
          }).catch(console.error);
        });
        return {
          toast: { type: 'success', content: '答案已收到。' },
          card: {
            type: 'raw',
            data: buildClarificationContinuingCard(answered.flow),
          },
        };
      } catch (error) {
        return { toast: { type: 'error', content: (error as Error).message } };
      }
    }

    if (action.value.action === 'resume_cli_session') {
      const agentSessionId = typeof action.value.agentSessionId === 'string'
        ? action.value.agentSessionId
        : '';
      const cliSessionId = typeof action.value.cliSessionId === 'string'
        ? action.value.cliSessionId
        : '';
      const session = runtime.sessions.get(agentSessionId);
      if (!session || session.botId !== config.id || !cliSessionId) {
        return { toast: { type: 'error', content: '这条会话记录已经失效。' } };
      }
      if (!canManageSession(runtime, session.id, { ...action, operatorBotId: config.id })) {
        return { toast: { type: 'warning', content: '只有任务发起人可以切换会话。' } };
      }
      if (session.status === 'active') {
        return { toast: { type: 'warning', content: '当前任务结束后才能切换会话。' } };
      }
      if (session.status === 'closed') {
        return { toast: { type: 'warning', content: '当前话题的会话已经关闭。' } };
      }
      const cliAdapter = getCliAdapter(session.cliId);
      if (cliAdapter.id === 'cursor' || cliAdapter.id === 'zcode') {
        return { toast: { type: 'error', content: `${cliAdapter.displayName} 暂不支持此操作` } };
      }
      try {
        const nativeSessions = await listNativeCliSessions({
          adapter: cliAdapter,
          cwd: session.workspaceDir,
          isolation: runtime.isolationPreparer ?? createProductionIsolationPreparer(),
        });
        if (!nativeSessions.some((item) => item.id === cliSessionId)) {
          return {
            toast: { type: 'error', content: '这个 CLI 会话已经不在当前工作目录中。' },
          };
        }
        const current = runtime.sessions.get(session.id);
        if (!current || (current.version ?? 0) !== (session.version ?? 0)
          || !canManageSession(runtime, session.id, { ...action, operatorBotId: config.id })) {
          throw new Error('会话已变化，请重新选择');
        }
        const updated = await runtime.sessions.selectCliSessionId(
          session.id,
          cliSessionId,
        );
        return {
          toast: { type: 'success', content: '已切换到选中的历史会话。' },
          card: {
            type: 'raw',
            data: buildResumeCard({
              agentSessionId: updated.id,
              cliName: cliAdapter.displayName,
              currentCliSessionId: updated.cliSessionId,
              sessions: nativeSessions,
            }),
          },
        };
      } catch (error) {
        return { toast: { type: 'error', content: (error as Error).message } };
      }
    }

    if (action.value.action !== 'abort_task') return undefined;
    const sessionId = typeof action.value.sessionId === 'string'
      ? action.value.sessionId
      : '';
    const outcome = requestTaskAbort(
      runtime.activeRuns,
      sessionId,
      action.operatorOpenId,
      action.operatorUnionId,
      config.id,
    );
    if (outcome === 'not_found') {
      return { toast: { type: 'info', content: '任务已经结束，无需再次停止。' } };
    }
    if (outcome === 'forbidden') {
      return { toast: { type: 'warning', content: '无法识别操作者，无法停止任务。' } };
    }
    if (outcome === 'already_stopping') {
      return { toast: { type: 'info', content: '正在停止任务，请稍候。' } };
    }
    return { toast: { type: 'success', content: '已发送停止指令。' } };
  };
}
