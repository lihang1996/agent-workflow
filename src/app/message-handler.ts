import type { CliAttachment } from '../cli/types.js';
import { prefetchSourceContext, sourceSubmission, sourceBinding } from './source-context.js';
import { resolve } from 'node:path';
import { type Bot } from '../im/lark.js';
import { answerContinuation, answerNeedsContinuation, buildArchitectureApprovalCard, buildClarificationCard, buildProductSpecApprovalCard, buildClarificationSupersededCard, buildSessionNoticeCard, buildTaskCard, splitLongText } from '../im/card.js';
import { resolveMentions, extractResourceKeys } from '../im/message-parser.js';
import { parseCliRequest, parseCommand } from '../core/command-parser.js';
import { TaskProgressTracker } from '../core/task-progress.js';
import { isClarificationOwner, findClarificationRequest, formatClarificationMessage } from '../core/clarification.js';
import { topicTaskId } from '../core/topic-task.js';
import { buildCollaborationPrompt, collaborationOrigin, collaborationTurnKey, findDispatchTaskRequest, type CollaborationMessage } from '../core/collaboration.js';
import { ensureWorkspaceDirectory } from '../core/workspace.js';
import { buildBotPrompt, type BotConfig } from '../core/bot-registry.js';
import { getCliAdapter } from '../cli/registry.js';
import { compactCliSession } from '../cli/native-compact.js';
import { createProductionIsolationPreparer } from '../core/isolation.js';
import { createSessionIsolationSupplier, requireScratchRootForSubmission } from './cli-execution.js';
import { createBoundProductSpecFlow } from './product-spec-creation.js';
import { createBoundArchitectureFlow } from './architecture-flow.js';
import { findArchitectureRequest } from '../core/product-spec.js';
import { attachmentPromptSection, executeCli } from './cli-execution.js';
import {
  applyModelDecision,
  assertRecreateWithoutHistoryDependency,
  planExecutionModel,
} from './execution-model.js';
import { handleSessionCommand } from './command-handler.js';
import { sendResultNotification } from './notification-service.js';
import { normalizeProductDocument } from './product-document-url.js';
import { ensureProductSpecSubmission } from './product-spec-submission.js';
import { CODING_AUTHORIZATION_TEXT_HINT, looksLikeCodingAuthorizationText } from './authorization-text.js';
import { CollaborationService } from './collaboration-service.js';
import type { AppRuntime, BotRuntime } from './runtime.js';
import type { IncomingMessage } from '../im/lark.js';
import { beginTask, releaseTask, executeTask, executionStore } from './task-lifecycle.js';
import { createTaskCardUpdater, deliveryOutbox } from './result-delivery.js';
import { canManageSession, flowMatchesSession } from './session-guard.js';

export function createMessageHandler(options: {
  runtime: AppRuntime; config: BotConfig; defaultProductDeliveryMode: 'local' | 'lark-doc';
  collaborationService: CollaborationService; execute?: typeof executeCli;
  planModel?: typeof planExecutionModel;
}): (msg: IncomingMessage, bot: Bot) => Promise<void> {
  const { runtime, config, defaultProductDeliveryMode, collaborationService } = options;
  const { sessions, teamRegistry, activeRuns, contextWindows, botRuntimes,
    processedCollaborationTurns, collaborationInbox, clarificationFlows, productSpecFlows } = runtime;
  return async (msg, bot) => {
    const resolved = resolveMentions(msg.text, msg.mentions);
    const taskId = topicTaskId(msg);
    let senderRuntime: BotRuntime | undefined;
    let collaboration: CollaborationMessage | undefined;
    if (msg.senderType === 'app' || msg.senderType === 'bot') {
      const currentRuntime = botRuntimes.get(config.id);
      const mentionedCurrentBot = currentRuntime
        ? msg.mentions.some(
            (mention) => mention.openId === currentRuntime.identity.openId,
          )
        : false;
      const dispatchId = msg.text.match(/任务编号：([a-f0-9]{12})/)?.[1];
      const pending = msg.messageType === 'post'
        && mentionedCurrentBot
        && dispatchId
        ? collaborationInbox.peek(dispatchId, config.id)
        : undefined;
      if (!pending) {
        console.log(
          `[协作] 忽略非目标 bot 消息 sender=${msg.senderOpenId} target=${config.id}`,
        );
        return;
      }
      senderRuntime = botRuntimes.get(pending.fromBotId);
      if (!senderRuntime) {
        console.log(`[协作] 找不到来源 bot: ${pending.fromBotId}`);
        return;
      }
      if (senderRuntime.identity.openId !== msg.senderOpenId) return;
      const turnKey = collaborationTurnKey(pending);
      if (processedCollaborationTurns.has(turnKey)) {
        console.log(`[协作] 忽略重复消息 ${turnKey}`);
        return;
      }

      collaboration = pending;
    }
    const hasThread = !!msg.threadId || !!msg.rootId;
    const command = parseCommand(resolved);
    const cliRequest = parseCliRequest(resolved);
    if (cliRequest && !cliRequest.prompt) {
      await bot.reply(
        msg.messageId,
        `请在 /${cliRequest.cliId} 后面写下任务，例如：/${cliRequest.cliId} 检查项目状态`,
        hasThread,
      );
      return;
    }
    let pendingClarification =
      msg.senderType !== 'app'
      && msg.senderType !== 'bot'
      && !command
        ? clarificationFlows.findForTask(taskId, config.id)
        : undefined;
    const resolvedSession = await sessions.resolve(
      msg,
      cliRequest?.cliId ?? config.defaultCliId,
      config.id,
      collaboration?.workspaceDir ?? config.workspaceDir,
    );
    let { session } = resolvedSession;
    if (pendingClarification && !flowMatchesSession(pendingClarification, session)) {
      clarificationFlows.delete(pendingClarification.token);
      pendingClarification = undefined;
    }
    if (pendingClarification && !isClarificationOwner(pendingClarification, {
      operatorOpenId: msg.senderOpenId, operatorUnionId: msg.senderUnionId, operatorBotId: config.id,
    })) {
      await bot.reply(msg.messageId, '只有原任务发起人可以补充这组澄清问题。', hasThread);
      return;
    }
    if (!collaboration && !command && !canManageSession(runtime, session.id, {
      operatorOpenId: msg.senderOpenId, operatorUnionId: msg.senderUnionId, operatorBotId: config.id,
    })) {
      await bot.reply(msg.messageId, '只有原任务发起人可以继续当前会话。请新建话题。', hasThread);
      return;
    }
    const { isNew } = resolvedSession;
    if (command && isNew && session.status === 'creating') {
      session = await sessions.transition(session.id, 'idle');
    }
    const cliAdapter = getCliAdapter(session.cliId, teamRegistry.appToolsFor(config.id));
    const isCompacting = command?.name === 'compact';
    const taskText = pendingClarification
      ? formatClarificationMessage(
          pendingClarification,
          cliRequest?.prompt ?? resolved,
        )
      : collaboration
        ? buildCollaborationPrompt(collaboration)
        : cliRequest?.prompt ?? resolved;
    const collaborationContext = collaboration
      ? collaborationOrigin(collaboration)
      : pendingClarification?.collaboration;
    const taskCardTitle = isCompacting
      ? '整理上下文'
      : cliAdapter.displayName;
    console.log(
      `[收到] chat=${msg.chatId} threadId=${msg.threadId} rootId=${msg.rootId} sender=${msg.senderOpenId}`,
    );
    console.log(`  原文: ${msg.text}`);
    console.log(`  还原: ${resolved}`);
    console.log(
      `  mentions: ${msg.mentions.map((m) => `${m.key}=${m.name}(${m.openId})`).join(', ') || '(无)'}`,
    );
    console.log(
      `  [会话] ${isNew ? '新建' : '复用'} id=${session.id} status=${session.status}`,
    );

    const commandOutcome = await handleSessionCommand({
      runtime,
      config,
      msg,
      bot,
      session,
      cliAdapter,
      command,
      cliRequest,
      isNew,
      hasThread,
    });
    if (commandOutcome === 'handled') return;

    if (session.status === 'closed') {
      await bot.reply(
        msg.messageId,
        '这个话题的会话已经关闭，请新开一个话题继续。',
        hasThread,
      );
      return;
    }
    if (!isNew && session.status === 'creating') {
      await bot.reply(
        msg.messageId,
        '当前会话正在准备，请稍后再追问。',
        hasThread,
      );
      return;
    }
    if (session.status === 'active') {
      await bot.reply(
        msg.messageId,
        '当前会话还在执行，请等任务结束后再追问。',
        hasThread,
      );
      return;
    }

    // T-021：普通文本授权口令没有可靠的制品定位（IncomingMessage 不含被回复
    // 卡片 ID），不能猜测制品或自动授权——只提示走显式卡片入口，且不执行任务。
    if (
      !collaboration
      && !pendingClarification
      && !command
      && msg.senderType !== 'app'
      && msg.senderType !== 'bot'
      && (config.specStages ?? []).includes('architecture')
      && looksLikeCodingAuthorizationText(resolved)
    ) {
      await bot.reply(msg.messageId, CODING_AUTHORIZATION_TEXT_HINT, hasThread);
      return;
    }

    if (
      collaboration &&
      session.workspaceDir !== collaboration.workspaceDir
    ) {
      await ensureWorkspaceDirectory(collaboration.workspaceDir);
      session = await sessions.setWorkspaceDir(
        session.id,
        collaboration.workspaceDir,
      );
    }

    const owner = {
      ownerUnionId: collaboration?.ownerUnionId ?? pendingClarification?.ownerUnionId ?? msg.senderUnionId,
      ownerOpenId: collaboration?.ownerOpenId ?? pendingClarification?.ownerOpenId ?? msg.senderOpenId,
      ownerBotId: collaboration?.ownerBotId ?? (collaboration ? collaboration.fromBotId : pendingClarification?.ownerBotId ?? config.id),
    };
    const run = await beginTask(runtime, session.id, owner, session.version ?? 0);
    const activeRun = activeRuns.get(session.id)!;
    try {
      if (collaboration && !collaborationInbox.acquire(collaboration.dispatchId, config.id, session.id)) {
        await releaseTask(runtime, session.id, run);
        return;
      }
      if (pendingClarification) {
        clarificationFlows.delete(pendingClarification.token);
        if (pendingClarification.cardMessageId) {
          try {
            await bot.updateCard(
              pendingClarification.cardMessageId,
              buildClarificationSupersededCard(pendingClarification),
            );
          } catch (error) {
            console.warn(
              '[澄清] 旧卡片更新失败，继续处理用户的新消息:',
              (error as Error).message,
            );
          }
        }
      }

      // 图片/文件先落盘，再把绝对路径写进 prompt，CLI 才知道有附件可读。
      const attachments: CliAttachment[] = [];
      for (const res of extractResourceKeys(msg.messageType, msg.rawContent)) {
        try {
          const savePath = await bot.downloadResource(
            msg.messageId,
            res.key,
            res.type,
            resolve('data', 'downloads'),
            res.fileName,
          );
          attachments.push({ path: savePath, type: res.type, fileName: res.fileName });
          console.log(`  [下载] ${res.type} → ${savePath}`);
        } catch (e) {
          console.error(`  [下载失败] ${res.key}:`, (e as Error).message);
        }
      }
      let prompt = buildBotPrompt(
        config,
        taskText + attachmentPromptSection(attachments),
        teamRegistry.contextFor(config.id),
        defaultProductDeliveryMode,
      );
      const sourceIdentity = sourceBinding(config, { taskId, sessionId: session.id, sessionVersion: session.version ?? 0, ...owner }, session.workspaceDir);
      if (!isCompacting) prompt += await prefetchSourceContext(runtime, config, sourceIdentity, taskText);

      // 先回复一张卡片，让用户知道任务已经进入执行队列。
      const cardId = await bot.replyCard(
          msg.messageId,
          buildTaskCard({
            title: taskCardTitle,
            status: 'running',
            detail: isCompacting
              ? cliAdapter.id === 'codex' && command?.instructions
                ? 'Codex 正在使用原生默认策略整理上下文'
                : `正在调用 ${cliAdapter.displayName} 原生上下文整理`
              : '正在理解任务',
            abortSessionId: session.id,
          }),
          hasThread,
        );
      if (!cardId) throw new Error('飞书没有返回任务卡片 message_id');
      console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`);

      const progress = new TaskProgressTracker(
        Date.now,
        contextWindows.get(session.id),
        !session.cliSessionId,
      );
      const cardUpdater = createTaskCardUpdater({ runtime, bot, botId: config.id, sessionId: session.id,
        cardId, replyToMessageId: msg.messageId, replyInThread: hasThread });
      const renderProgress = () => {
        const snapshot = progress.snapshot();
        cardUpdater.push(
          buildTaskCard({
            title: taskCardTitle,
            status: 'running',
            detail: isCompacting
              ? `正在调用 ${cliAdapter.displayName} 原生上下文整理`
              : snapshot.current,
            ...(!isCompacting ? { progress: snapshot } : {}),
            abortSessionId: session.id,
          }),
        );
      };
      const progressHeartbeat = setInterval(renderProgress, 1_000);
      progressHeartbeat.unref();

      // 让事件回调尽快返回，CLI 在后台继续执行。
      const executionId = collaboration ? `dispatch:${collaboration.dispatchId}` : `${config.id}:${msg.messageId}`;
      // executeTask 持久化时才读取（getter）：模型决策在执行闭包内完成，
      // blocked/recreate 都表现为本次任务的结果，而不是悬空卡片。
      let plannedModelSelection: import('../core/model-selection.js').ModelSelection | null | undefined;
      let plannedFreshNativeSession = false;
      const execution = executeTask({ runtime, id: executionId, sessionId: session.id, botId: config.id,
        get modelSelection() { return plannedModelSelection; },
        get freshNativeSession() { return plannedFreshNativeSession; },
        execute: async () => {
        if (collaboration) {
          collaborationInbox.beginExecution(collaboration.dispatchId);
          processedCollaborationTurns.add(collaborationTurnKey(collaboration));
          if (processedCollaborationTurns.size > 1000) processedCollaborationTurns.delete(processedCollaborationTurns.values().next().value!);
        }
        if (isCompacting) {
          return compactCliSession({
            adapter: cliAdapter,
            sessionId: session.cliSessionId!,
            cwd: session.workspaceDir,
            instructions: command.instructions,
            signal: run.signal,
            isolation: createSessionIsolationSupplier(
              runtime,
              session.id,
              runtime.isolationPreparer ?? createProductionIsolationPreparer(),
            ),
          }).then((result) => ({
            answer: result.message ?? '',
            sessionId: result.sessionId,
            stats: undefined,
            toolCalls: undefined,
          }));
        }
        const modelPlan = await (options.planModel ?? planExecutionModel)(
          config.modelOverrides,
          session,
          { command: cliAdapter.command },
        );
        // native-default 也显式记录为 null：下次续接才能区分「已核验一致」与「不可核验」。
        plannedModelSelection = modelPlan.modelSelection;
        // 返修 3（二轮 P1-3）：依赖历史上下文的 recreate 一律阻断——历史 CLI
        // 回答可能转述项目文件/网页/工具输出中的第三方指令，注入新会话构成
        // 指令洗白；请新话题提供明确上下文，或恢复原模型配置。
        if (modelPlan.decision.action === 'recreate') {
          assertRecreateWithoutHistoryDependency({ hadNativeSession: !!session.cliSessionId });
        }
        const resumeCliSessionId = applyModelDecision(modelPlan);
        plannedFreshNativeSession = resumeCliSessionId === undefined;
        // 138 号 P0-1：不再从授权列表按 owner+workspace 猜测编码授权——当前
        // 没有任何生产入口能创建「一次性编码交接」，因此普通任务一律零代码写
        //（隔离 profile 只放行 scratch）。未来显式编码入口须经
        // resolveCodingAuthorizationById（唯一 authorizationId + 交接绑定 + await G3）。
        return (options.execute ?? executeCli)(
          cliAdapter,
          prompt,
          session.workspaceDir,
          resumeCliSessionId,
          run.signal,
          (event) => {
            if (
              event.type !== 'tool_start' &&
              event.type !== 'tool_end' &&
              event.type !== 'context'
            )
              return;
            progress.accept(event);
            renderProgress();
          },
          attachments,
          modelPlan.modelSelection,
          createSessionIsolationSupplier(
            runtime,
            session.id,
            runtime.isolationPreparer ?? createProductionIsolationPreparer(),
          ),
          taskId,
        );
      } });

      void execution
        .then(async (result) => {
          clearInterval(progressHeartbeat);
          const clarificationRequest = !isCompacting
            && cliAdapter.appTools.includes('request_clarification')
            ? findClarificationRequest(result.toolCalls)
            : undefined;
          if (clarificationRequest) {
            const flow = clarificationFlows.create({
              taskId,
              botId: config.id,
              sessionId: session.id,
              sessionVersion: session.version ?? 0,
              ownerOpenId: collaboration?.ownerOpenId ?? pendingClarification?.ownerOpenId ?? msg.senderOpenId,
              ownerBotId: collaboration?.ownerBotId ?? (collaboration ? collaboration.fromBotId : pendingClarification?.ownerBotId ?? config.id),
              ownerUnionId: collaboration?.ownerUnionId ?? pendingClarification?.ownerUnionId ?? msg.senderUnionId,
              collaboration: collaborationContext,
              originalMessageId: msg.messageId,
              cardMessageId: cardId,
              replyInThread: hasThread,
              request: clarificationRequest,
            });
            await cardUpdater.finish(buildClarificationCard({ flow }), { kind: 'clarification', token: flow.token });
            await sendResultNotification({
              runtime, botId: config.id, sessionId: session.id, afterCardId: cardId,
              bot,
              replyToMessageId: msg.messageId,
              target: { openId: flow.ownerOpenId, name: '' },
              text: `需要你确认 ${clarificationRequest.questions.length} 个问题，请在上方卡片中选择。`,
              replyInThread: hasThread,
            });
            console.log(
              `[澄清] 已发送交互卡片 questions=${clarificationRequest.questions.length}`,
            );
            // 澄清卡也是一次完整交付（用户作答后走澄清续跑的新执行）：
            // 协作终态在此收口，其余失败路径由 catch 统一记 failed。
            if (collaboration) collaborationInbox.finish(collaboration.dispatchId, true);
            return;
          }
          const finalResult = result;
          let productSpecRequest = !isCompacting && cliAdapter.appTools.includes('request_spec_approval')
            ? (await ensureProductSpecSubmission({ result })).request
            : undefined;
          // T-020：架构提交是独立工具与独立阶段；上游交接码由服务端核验，
          // CLI 自报的 artifact kind / 上游 token 不进入任何输入。
          let architectureSubmission = !isCompacting && cliAdapter.appTools.includes('request_architecture_review')
            ? findArchitectureRequest(finalResult.toolCalls)
            : undefined;
          const dispatchRequest = !isCompacting
            ? findDispatchTaskRequest(finalResult.toolCalls)
            : undefined;
          if (dispatchRequest) {
            if (config.id !== teamRegistry.leaderBotId) {
              throw new Error('只有 CEO 助理可以调用 dispatch_task 派发团队任务');
            }
            const dispatchTarget = teamRegistry.get(dispatchRequest.targetBotId);
            if (!dispatchTarget) {
              throw new Error(
                `团队成员未注册或未启用: ${dispatchRequest.targetBotId}`,
              );
            }
            if (dispatchRequest.targetBotId === config.id) {
              throw new Error(
                `不能把团队任务派发给当前 bot: ${config.id}`,
              );
            }
            if (
              collaboration
              && collaboration.round >= collaboration.maxRounds
            ) {
              throw new Error(
                `协作任务已达到轮次上限 ${collaboration.maxRounds}，不能继续派发`,
              );
            }
          }
          if (productSpecRequest && dispatchRequest) {
            throw new Error('不能同时提交产品方案和派发团队任务');
          }
          if (architectureSubmission && (dispatchRequest || productSpecRequest)) {
            throw new Error('不能同时提交架构设计和派发团队任务或产品方案');
          }
          if (architectureSubmission && !runtime.architectureHandoffs) {
            throw new Error('架构交接服务不可用：本次架构提交失败关闭，未创建任何确认卡。');
          }
          if (productSpecRequest) {
            productSpecRequest = await normalizeProductDocument(bot, productSpecRequest);
            // T-018：flow 创建即绑定完整制品摘要与来源清单（与澄清后提交共用同一
            // 服务端路径）。本地模式摘要计算失败（缺失/符号链接/读取失败）直接
            // 失败关闭，不进入审批；飞书模式完整回读能力未核验（U-3），
            // content_digest 保持 null，G1 拒绝确认。
            const flow = await createBoundProductSpecFlow({
              store: productSpecFlows,
              workspaceDir: session.workspaceDir,
              // 119 号 P1-4：本地交付必须持有当前任务的 scratch 绑定（缺/跨任务/过期失败关闭）。
              ...(productSpecRequest.deliveryMode === 'local'
                ? { scratchRoot: requireScratchRootForSubmission(runtime, session.id, taskId, session.workspaceDir) }
                : {}),
              identity: {
                taskId,
                botId: config.id,
                sessionId: session.id,
                sessionVersion: session.version ?? 0,
                ownerOpenId: collaboration?.ownerOpenId ?? pendingClarification?.ownerOpenId ?? msg.senderOpenId,
                ownerBotId: collaboration?.ownerBotId ?? (collaboration ? collaboration.fromBotId : pendingClarification?.ownerBotId ?? config.id),
                ownerUnionId: collaboration?.ownerUnionId ?? pendingClarification?.ownerUnionId ?? msg.senderUnionId,
                collaboration: collaborationContext,
              },
              request: productSpecRequest,
              ...sourceSubmission(runtime, sourceIdentity),
            });
            await cardUpdater.finish(buildProductSpecApprovalCard(flow), { kind: 'product', token: flow.token });
            await sendResultNotification({
              runtime, botId: config.id, sessionId: session.id, afterCardId: cardId,
              bot,
              replyToMessageId: msg.messageId,
              target: {
                openId: collaboration?.ownerOpenId ?? pendingClarification?.ownerOpenId ?? msg.senderOpenId,
                name: '',
              },
              text: '产品方案已生成，请查看上方卡片了解确认状态。',
              replyInThread: hasThread,
            });
            console.log('[产品文档] 已展示待确认产物');
            if (collaboration) collaborationInbox.finish(collaboration.dispatchId, true);
            return;
          }
          if (architectureSubmission) {
            const { request: architectureRequest, handoffToken } = architectureSubmission;
            const normalizedRequest = await normalizeProductDocument(bot, architectureRequest);
            // 服务端交接核验 + 上游漂移检查 + 架构摘要绑定；任何失败都不生成
            // 确认卡（失败关闭），且不消费交接码。
            const archFlow = await createBoundArchitectureFlow({
              flows: productSpecFlows,
              handoffs: runtime.architectureHandoffs!,
              workspaceDir: session.workspaceDir,
              ...(normalizedRequest.deliveryMode === 'local'
                ? { scratchRoot: requireScratchRootForSubmission(runtime, session.id, taskId, session.workspaceDir) }
                : {}),
              resolvePrdWorkspaceDir: ({ prdSessionId }) => sessions.get(prdSessionId)?.workspaceDir,
              identity: {
                taskId,
                botId: config.id,
                sessionId: session.id,
                sessionVersion: session.version ?? 0,
                ownerOpenId: collaboration?.ownerOpenId ?? pendingClarification?.ownerOpenId ?? msg.senderOpenId,
                ownerBotId: collaboration?.ownerBotId ?? (collaboration ? collaboration.fromBotId : pendingClarification?.ownerBotId ?? config.id),
                ownerUnionId: collaboration?.ownerUnionId ?? pendingClarification?.ownerUnionId ?? msg.senderUnionId,
                collaboration: collaborationContext,
              },
              request: normalizedRequest,
              handoffToken,
            });
            await cardUpdater.finish(buildArchitectureApprovalCard(archFlow), { kind: 'product', token: archFlow.token });
            await sendResultNotification({
              runtime, botId: config.id, sessionId: session.id, afterCardId: cardId,
              bot,
              replyToMessageId: msg.messageId,
              target: {
                openId: collaboration?.ownerOpenId ?? pendingClarification?.ownerOpenId ?? msg.senderOpenId,
                name: '',
              },
              text: '架构设计已生成，请查看上方卡片了解确认状态。',
              replyInThread: hasThread,
            });
            console.log('[架构文档] 已展示待确认架构设计');
            if (collaboration) collaborationInbox.finish(collaboration.dispatchId, true);
            return;
          }
          const snapshot = progress.snapshot();
          await cardUpdater.finish(isCompacting
            ? buildSessionNoticeCard({
              title: finalResult.answer ? '暂时无需整理' : '上下文已整理',
              template: finalResult.answer ? 'grey' : 'green',
              detail: finalResult.answer || [
                `${cliAdapter.displayName} 已在当前 CLI 会话内完成原生压缩。`,
                'CLI 会话 ID 保持不变，下一条任务会继续使用整理后的上下文。',
              ].join('\n\n'),
            })
            : buildTaskCard({
              title: taskCardTitle,
              status: 'success',
              detail: '执行完成',
              progress: snapshot,
              answer: finalResult.answer,
              stats: finalResult.stats,
            }));
          if (!isCompacting && answerNeedsContinuation(finalResult.answer)) {
            await deliveryOutbox(runtime, config.id, bot).submit({
              id: `text:${executionId}`, botId: config.id, sessionId: session.id,
              operations: splitLongText(answerContinuation(finalResult.answer)).map((text) => ({
                type: 'text', messageId: msg.messageId, text, replyInThread: hasThread,
              })),
            });
          }
          console.log(
            `[CLI] ${cliAdapter.id} 完成 session_id=${result.sessionId ?? '(无)'}`,
          );
          if (!collaboration) {
            await sendResultNotification({
              runtime, botId: config.id, sessionId: session.id, afterCardId: cardId,
              bot,
              replyToMessageId: msg.messageId,
              target: { openId: msg.senderOpenId, name: '' },
              text: isCompacting
                ? '上下文整理已完成，请查看上方结果。'
                : '任务已完成，请查看上方结果。',
              replyInThread: hasThread,
            });
          }
          if (!isCompacting) {
            try {
              if (dispatchRequest) {
                await collaborationService.dispatch({
                  senderConfig: config,
                  senderBot: bot,
                  replyToMessageId: msg.messageId,
                  targetBotId: dispatchRequest.targetBotId,
                  taskId,
                  ownerOpenId: collaboration?.ownerOpenId ?? pendingClarification?.ownerOpenId ?? msg.senderOpenId,
                  ownerBotId: collaboration?.ownerBotId ?? (collaboration ? collaboration.fromBotId : pendingClarification?.ownerBotId ?? config.id),
                  ownerUnionId: collaboration?.ownerUnionId ?? pendingClarification?.ownerUnionId ?? msg.senderUnionId,
                  reportToBotId: collaboration?.reportToBotId ?? config.id,
                  objective: dispatchRequest.objective,
                  instruction: dispatchRequest.instruction,
                  expectedOutput: dispatchRequest.expectedOutput,
                  round: collaboration ? collaboration.round + 1 : 1,
                  maxRounds: collaboration?.maxRounds
                    ?? config.collaborationMaxRounds,
                  workspaceDir: session.workspaceDir,
                });
                if (!collaboration) {
                  const targetName = botRuntimes.get(dispatchRequest.targetBotId)
                    ?.identity.name ?? dispatchRequest.targetBotId;
                  await sendResultNotification({
                    runtime, botId: config.id, sessionId: session.id, afterCardId: cardId,
                    bot,
                    replyToMessageId: msg.messageId,
                    target: { openId: msg.senderOpenId, name: '' },
                    text: `任务已交给 ${targetName}，请查看上方协作消息。`,
                    replyInThread: hasThread,
                  });
                }
              } else if (collaboration) {
                // 协作结果直接交给用户，不再回传给派发方转述。
                await sendResultNotification({
                  runtime, botId: config.id, sessionId: session.id, afterCardId: cardId,
                  bot,
                  replyToMessageId: msg.messageId,
                  target: { openId: collaboration.ownerOpenId, name: '' },
                  text: `协作任务“${collaboration.objective}”已经完成，请查看上方结果。`,
                  replyInThread: hasThread,
                });
              }
            } catch (error) {
              const message = (error as Error).message;
              console.error('[协作] 派发失败:', message);
              await bot.reply(msg.messageId, `协作派发失败：${message}`, hasThread);
            }
          }
          // 协作终态在全部制品后处理（产品/架构确认卡、派发、通知）成功之后
          // 才落为 completed：中途任何失败走 catch 分支记 failed，不会出现
          // 「协作已成功、制品创建失败」的状态错位（work/30）。
          if (collaboration) collaborationInbox.finish(collaboration.dispatchId, true);
        })
        .catch(async (error) => {
          clearInterval(progressHeartbeat);
          if (collaboration) collaborationInbox.finish(collaboration.dispatchId, false);
          if (executionStore(runtime).get(executionId)?.status === 'completed') {
            await cardUpdater.cancel();
            await bot.reply(msg.messageId, 'CLI 已完成，结果处理或通知暂时失败，执行结果已保存。请检查产物，勿重复执行任务。', hasThread).catch(console.error);
            console.error('[结果处理]', error);
            return;
          }
          if (run.signal.aborted) {
            console.log('[CLI] 任务已取消');
            await cardUpdater.finish(
              buildTaskCard({
                title: taskCardTitle,
                status: 'cancelled',
                detail:
                  activeRun.cancelMode === 'close'
                    ? '本次任务已停止，当前会话已经关闭。'
                    : isCompacting
                      ? '整理已停止，当前 CLI 会话没有改变。'
                      : '本次任务已停止。你可以继续在当前话题里提问。',
                progress: progress.snapshot(),
              }),
            );
            await sendResultNotification({
              runtime, botId: config.id, sessionId: session.id, afterCardId: cardId,
              bot,
              replyToMessageId: msg.messageId,
              target: senderRuntime?.identity
                ?? { openId: msg.senderOpenId, name: '' },
              text: '任务已停止，请查看上方状态。',
              replyInThread: hasThread,
            });
            return;
          }
          const message = (error as Error).message;
          console.error('[CLI] 执行失败:', message);
          await cardUpdater.finish(
            buildTaskCard({
              title: taskCardTitle,
              status: 'failed',
              detail: isCompacting
                ? '上下文整理失败，当前 CLI 会话没有改变。'
                : '执行没有完成。你可以调整指令后，在当前话题里重试。',
              technicalDetail: message,
              progress: progress.snapshot(),
            }),
          );
          await sendResultNotification({
            runtime, botId: config.id, sessionId: session.id, afterCardId: cardId,
            bot,
            replyToMessageId: msg.messageId,
            target: senderRuntime?.identity
              ?? { openId: msg.senderOpenId, name: '' },
            text: '任务执行失败，请查看上方错误信息。',
            replyInThread: hasThread,
          });
        })
        .finally(async () => {
          clearInterval(progressHeartbeat);
          if (collaboration) collaborationInbox.release(collaboration.dispatchId);
          await releaseTask(runtime, session.id, run);

        })
        .catch((error) => {
          console.error('[任务] 回传或收尾失败:', (error as Error).message);
        });
    } catch (error) {
      if (collaboration) collaborationInbox.release(collaboration.dispatchId);
      await releaseTask(runtime, session.id, run);
      throw error;
    }
  };
}
