/**
 * Agent OS 入口。
 * 当前阶段：飞书消息驱动 Claude Code / Codex / Cursor / ZCode 完成任务。
 */
import 'dotenv/config';
import { createMessageHandler } from './app/message-handler.js';
import { TaskExecutionStore } from './core/task-execution.js';
import { resolveResultCard } from './app/result-delivery.js';
import { DeliveryOutbox } from './app/delivery-outbox.js';
import { subscribeDocumentComments } from './app/document-subscription.js';
import { join, resolve } from 'node:path';
import { startBot } from './im/lark.js';
import { SessionManager } from './core/session-manager.js';
import { JsonSessionStore } from './core/session-store.js';
import type { ActiveRun } from './core/task-abort.js';
import { ClarificationFlowStore } from './core/clarification.js';
import { JsonProductSpecFlowStore } from './core/product-spec-store.js';
import { CollaborationInbox } from './core/collaboration.js';
import { ensureWorkspaceDirectory } from './core/workspace.js';
import { loadAgentOsConfig, type BotConfig } from './core/bot-registry.js';
import { TeamRegistry } from './core/team-registry.js';
import { listCliAdapters } from './cli/registry.js';
import { createCardActionHandler } from './app/card-action-handler.js';
import { ProductCommentScheduler } from './app/product-comment-scheduler.js';
import { CollaborationService } from './app/collaboration-service.js';
import type { AppRuntime, BotRuntime } from './app/runtime.js';

const botConfigPath = resolve(
  process.env.BOTS_CONFIG ?? join('config', 'bots.json'),
);
const agentOsConfig = await loadAgentOsConfig(botConfigPath);
const botConfigs = agentOsConfig.bots;
const teamRegistry = new TeamRegistry(agentOsConfig.teamLeaderId, botConfigs);
await Promise.all(
  botConfigs.map((config) => ensureWorkspaceDirectory(config.workspaceDir)),
);
for (const missing of await teamRegistry.findMissingSkills()) {
  console.warn(
    `[Skill] bot=${missing.botId} 找不到 ${missing.skill}，请安装到工作区或用户级 Skills 目录`,
  );
}
const defaultWorkspaces = Object.fromEntries(
  botConfigs.map((config) => [config.id, config.workspaceDir]),
);
const sessions = await SessionManager.open({
  store: new JsonSessionStore(
    join('data', 'sessions.json'),
    botConfigs[0]?.id,
    defaultWorkspaces,
  ),
});
const activeRuns = new Map<string, ActiveRun>();
const contextWindows = new Map<string, number>();
const botRuntimes = new Map<string, BotRuntime>();
const processedCollaborationTurns = new Set<string>();
const collaborationInbox = new CollaborationInbox(join('data', 'collaboration-inbox.json'));
const clarificationFlows = new ClarificationFlowStore(join('data', 'clarification-flows.json'));
const productSpecFlows = new JsonProductSpecFlowStore(
  join('data', 'product-spec-flows.json'),
);
const runtime: AppRuntime = {
  taskExecutions: new TaskExecutionStore(join('data', 'task-executions.json')),
  deliveries: new DeliveryOutbox((id) => botRuntimes.get(id)?.bot, join('data', 'result-deliveries.json'), 100, (operation) => resolveResultCard(runtime, operation)),
  sessions,
  teamRegistry,
  activeRuns,
  contextWindows,
  botRuntimes,
  processedCollaborationTurns,
  collaborationInbox,
  clarificationFlows,
  productSpecFlows,
};
const collaborationService = new CollaborationService(runtime);
const productComments = new ProductCommentScheduler(runtime);

console.log('Agent OS 启动，正在建立飞书长连接…');
console.log(
  `[配置] 已注册 ${botConfigs.length} 个 bot，Team Leader=${teamRegistry.leaderBotId}，已恢复 ${sessions.size} 个会话`,
);
for (const adapter of listCliAdapters()) {
  console.log(`[CLI] id=${adapter.id} command=${adapter.command}`);
}
for (const config of botConfigs) {
  console.log(
    `[Bot ${config.id.toUpperCase()}] default_cli=${config.defaultCliId} workspace=${config.workspaceDir}`,
  );
}

async function startConfiguredBot(
  config: BotConfig,
  collaborationService: CollaborationService,
): Promise<void> {
  const startedBot = startBot({
    appId: config.appId,
    appSecret: config.appSecret,
    onCardAction: createCardActionHandler({
      runtime,
      config,
      defaultProductDeliveryMode: agentOsConfig.defaultProductDeliveryMode,
    }),
    onDocumentComment: config.skills.includes('lark-drive')
      ? async (comment, bot) => productComments.schedule(
          config,
          bot,
          comment,
        )
      : undefined,
    onMessage: createMessageHandler({ runtime, config,
      defaultProductDeliveryMode: agentOsConfig.defaultProductDeliveryMode, collaborationService }),
  });
  const identity = await startedBot.getIdentity();
  const botRuntime = { config, bot: startedBot, identity };
  botRuntimes.set(config.id, botRuntime);
  if (config.skills.includes('lark-drive')) {
    await subscribeDocumentComments(startedBot, config.id);
  }
  console.log(
    `[Bot ${config.id.toUpperCase()}] 已连接 name=${identity.name} open_id=${identity.openId}`,
  );
}

await Promise.all(
  botConfigs.map((config) => startConfiguredBot(config, collaborationService)),
);

// 尚未送达的协作派发（例如目标 Bot 当时离线）在启动后及每分钟补发一次。
let recoveringDispatches = false;
async function recoverDispatches(): Promise<void> {
  if (recoveringDispatches) return;
  recoveringDispatches = true;
  try { await collaborationService.recover(); await runtime.deliveries!.recover(); }
  finally { recoveringDispatches = false; }
}
void recoverDispatches().catch(console.error);
const dispatchRecoveryTimer = setInterval(() => { void recoverDispatches().catch(console.error); }, 60_000);
dispatchRecoveryTimer.unref();
