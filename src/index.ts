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
import { acquireDataDirLock } from './core/data-lock.js';
import { startBot } from './im/lark.js';
import { SessionManager } from './core/session-manager.js';
import { JsonSessionStore } from './core/session-store.js';
import type { ActiveRun } from './core/task-abort.js';
import { ClarificationFlowStore } from './core/clarification.js';
import { JsonProductSpecFlowStore } from './core/product-spec-store.js';
import { ArchitectureHandoffStore } from './core/architecture-handoff.js';
import { JsonCodingAuthorizationStore } from './core/coding-authorization.js';
import { CollaborationInbox } from './core/collaboration.js';
import { ensureWorkspaceDirectory } from './core/workspace.js';
import { loadAgentOsConfig, type BotConfig } from './core/bot-registry.js';
import { loadSessionScratchBindings } from './core/isolation.js';
import { TeamRegistry } from './core/team-registry.js';
import { listCliAdapters } from './cli/registry.js';
import { createCardActionHandler } from './app/card-action-handler.js';
import { ProductCommentScheduler } from './app/product-comment-scheduler.js';
import { CollaborationService } from './app/collaboration-service.js';
import type { AppRuntime, BotRuntime } from './app/runtime.js';

// A08：data 目录单实例锁——多进程共写 data/ 台账会互相覆盖，启动最前面抢锁；
// 已有存活实例即拒绝启动，上次崩溃残留的死锁会被接管。
const dataDirLock = acquireDataDirLock(join('data'));
const releaseDataDirLock = (): void => {
  try {
    dataDirLock.release();
  } catch {
    // 退出路径上锁释放失败不影响关停。
  }
};
process.once('exit', releaseDataDirLock);
process.once('SIGINT', () => {
  releaseDataDirLock();
  process.exit(130);
});
process.once('SIGTERM', () => {
  releaseDataDirLock();
  process.exit(143);
});

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
// 架构交接台账（T-020）：服务端签发的 PRD→架构 capability（单次使用）。
// A07：持久化到 data/architecture-handoffs.json（tmp+rename 原子写），重启后
// 交接码与已消费状态不丢；坏文件在构造处失败关闭。
const architectureHandoffs = new ArchitectureHandoffStore(join('data', 'architecture-handoffs.json'));
// 编码授权台账（T-021 首批）：本地模型与显式入口；active 不接真实开发派发
//（T-022 每引擎读写隔离 canary 未通过前，仅作为可校验的数据状态）。
// 文件名对齐 09 号架构 §3.5 的 data/authorizations.json（新文件无迁移包袱）。
const codingAuthorizations = new JsonCodingAuthorizationStore(
  join('data', 'authorizations.json'),
);
const taskExecutions = new TaskExecutionStore(join('data', 'task-executions.json'));
// A07：会话 scratch 绑定恢复（119 号 P1-4 之前重启即丢失，本地制品提交只能
// 等下一次隔离任务）——恢复时逐条重新核对：realpath 仍存在且解析一致、
// taskKey 与会话最近任务一致、未过期，任一不满足即丢弃（安全拒绝）。
const sessionScratches = loadSessionScratchBindings({
  filePath: join('data', 'session-scratches.json'),
  resolveWorkspaceDir: (sessionId) => sessions.get(sessionId)?.workspaceDir,
  taskKeyOf: (sessionId) => taskExecutions.forSession(sessionId)?.id,
});
const runtime: AppRuntime = {
  taskExecutions,
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
  architectureHandoffs,
  codingAuthorizations,
  // 119 号 P1-4 + A07：会话 scratch 绑定表（SessionScratchBindingStore——
  // Map 子类，cli-execution 的 set 路径自动落盘）。
  sessionScratches,
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
