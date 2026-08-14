/**
 * Agent OS 入口。
 * 多 Bot 入群 + 话题项目目录 + 任务交接 + CEO 团队流水线 + Claude/Codex/Cursor 三引擎。
 */
import 'dotenv/config';
import { join } from 'node:path';
import { startBot } from './im/lark.js';
import { acquireInstanceLock, DEFAULT_LOCK_FILE, InstanceLockError } from './core/instance-lock.js';
import { migratePersistedEngineToDefault } from './core/engine-migration.js';
import { parseMaxRounds } from './core/collab.js';
import { JsonActiveRunStore } from './core/active-run-store.js';
import { JsonCollabStore } from './core/collab-store.js';
import { loadBotConfigs } from './core/bot-config.js';
import { parsePipelineSteps } from './core/pipeline.js';
import { SessionManager } from './core/session-manager.js';
import { JsonSessionStore } from './core/session-store.js';
import { JsonTopicStore } from './core/topic-store.js';
import { JsonQuestionnaireStore } from './core/questionnaire-store.js';
import { JsonSpecStore } from './core/spec-store.js';
import { JsonScheduleStore } from './core/schedule-store.js';
import { JsonApprovalStore } from './core/approval-store.js';
import { JsonWorkflowStore } from './core/workflow-store.js';
import { IdentityRegistry } from './core/identity-registry.js';
import { resolveWorkdir } from './core/workdir.js';
import { sanitizeForLog } from './core/log-inspection.js';
import { listEngines } from './cli/registry.js';
import { isCliId, type CliId } from './cli/types.js';
import { logMcpStatus } from './mcp/config.js';
import { cleanupStaleOverlays } from './mcp/cleanup.js';
import { createApp } from './runtime/create-app.js';

const SHUTDOWN_GRACE_MS = 15_000;
const ACTIVE_RUN_PERSIST_DEBOUNCE_MS = 800;
const PROGRESS_HEARTBEAT_MS = 15_000;

/** 解析 DEFAULT_CLI，非法值回退 cursor。 */
function parseDefaultCliId(value: string | undefined): CliId {
  if (!value) return 'cursor';
  const normalized = value.trim().toLowerCase();
  if (isCliId(normalized)) return normalized;
  console.warn(`[配置] 未知 DEFAULT_CLI=${value}，回退到 cursor`);
  return 'cursor';
}

const defaultCliId = parseDefaultCliId(process.env.DEFAULT_CLI);
const collabMaxRounds = parseMaxRounds(process.env.COLLAB_MAX_ROUNDS);
const pipelineSteps = parsePipelineSteps(process.env.PIPELINE_STEPS);
const botConfigs = loadBotConfigs();

if (botConfigs.length === 0) {
  console.error('未找到任何 Bot 凭证，请在 .env 配置 BOT_DEV_* / BOT_A_* 等');
  process.exit(1);
}

console.log('Agent OS 启动，正在建立飞书长连接…');

// P0 修复：单实例锁，防止两个 pnpm start 跨进程 last-writer-wins 丢更新。
try {
  acquireInstanceLock(DEFAULT_LOCK_FILE);
} catch (error) {
  if (error instanceof InstanceLockError) {
    console.error(`[启动] 检测到另一个 Agent OS 实例正在运行（${error.lockFile} 已存在）。`);
    console.error('[启动] 同时运行两个实例会导致跨进程丢更新、重复调度和数据损坏。');
    console.error('[启动] 如确认没有其他实例，请删除该锁文件后重试。');
    process.exit(1);
  }
  throw error;
}
for (const engine of listEngines()) {
  console.log(`[CLI] ${engine.id}=${engine.command} fallbackCwd=${resolveWorkdir({ cliId: engine.id })}`);
}
console.log(`[CLI] 默认引擎=${defaultCliId}`);
if (defaultCliId === 'cursor') {
  console.warn('[CLI] Cursor 无头使用 --force，没有 Claude PreToolUse 高风险闸门；高风险动作只靠提示词与飞书 /approval。');
}
console.log(`[协作] 最大轮次=${collabMaxRounds}`);
console.log(`[流水线] 步骤=${pipelineSteps.map((s) => s.id).join(' → ')}`);
logMcpStatus();
cleanupStaleOverlays(); // 清理过期 Cursor overlay
console.log(`[Bot] 将启动 ${botConfigs.length} 个角色: ${botConfigs.map((b) => b.id).join(', ')}`);
for (const config of botConfigs) {
  if (config.workdir) console.log(`[Bot] ${config.id} 默认工作目录=${config.workdir}`);
}

const sessions = await SessionManager.open({
  store: new JsonSessionStore(join('data', 'sessions.json')),
  defaultCliId,
});
const topics = await JsonTopicStore.open(join('data', 'topics.json'));
const collabStore = await JsonCollabStore.open(join('data', 'collab-rounds.json'));
const activeRunStore = new JsonActiveRunStore(join('data', 'active-runs.json'));
const questionnaires = await JsonQuestionnaireStore.open();
const specs = await JsonSpecStore.open(join('data', 'specs.json'));
const schedules = await JsonScheduleStore.open(join('data', 'schedules.json'));
const approvals = await JsonApprovalStore.open(join('data', 'approvals.json'));
const workflows = await JsonWorkflowStore.open(join('data', 'workflows.json'));
const identities = await IdentityRegistry.open(join('data', 'user-identities.json'));
await migratePersistedEngineToDefault({ sessions, topics, defaultCliId });
console.log(
  `[会话] 已恢复 ${sessions.size} 个会话，${topics.size} 个话题设置，${collabStore.size} 个协作轮次，${identities.size} 个用户身份别名`,
);

const app = createApp({
  sessions,
  topics,
  collabStore,
  activeRunStore,
  questionnaires,
  specs,
  schedules,
  approvals,
  workflows,
  identities,
  config: {
    defaultCliId,
    collabMaxRounds,
    pipelineSteps,
    shutdownGraceMs: SHUTDOWN_GRACE_MS,
    activeRunPersistDebounceMs: ACTIVE_RUN_PERSIST_DEBOUNCE_MS,
    progressHeartbeatMs: PROGRESS_HEARTBEAT_MS,
  },
});

let shutdownPromise: Promise<void> | undefined;

/** 停止接收新事件，立刻断开飞书长连接，收尾进行中任务后退出；重复信号复用同一轮收尾。 */
function shutdownAndExit(reason: string, exitCode = 0): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  app.pauseEventHandling();
  app.disconnectBots();
  shutdownPromise = (async () => {
    console.log(`[进程] ${reason}，开始收尾进行中任务…`);
    app.stopScheduler();
    app.stopSpecReviewSync();
    try {
      await app.shutdownActiveRuns(reason);
    } catch (error) {
      console.error('[进程] 收尾失败:', safeProcessError(error));
    } finally {
      process.exit(exitCode);
    }
  })();
  return shutdownPromise;
}

function listenForShutdown(signal: NodeJS.Signals, reason: string): void {
  try {
    process.once(signal, () => {
      void shutdownAndExit(reason);
    });
  } catch {
    // Windows 等环境可能没有该信号
  }
}

listenForShutdown('SIGINT', '服务已停止（SIGINT），任务中断');
listenForShutdown('SIGTERM', '服务已停止（SIGTERM），任务中断');
listenForShutdown('SIGHUP', '终端已关闭（SIGHUP），任务中断');
process.once('uncaughtException', (error) => {
  console.error('[进程] uncaughtException:', safeProcessError(error));
  void shutdownAndExit('服务异常退出（uncaughtException），任务中断', 1);
});
process.once('unhandledRejection', (reason) => {
  console.error('[进程] unhandledRejection:', safeProcessError(reason));
  void shutdownAndExit('服务异常退出（unhandledRejection），任务中断', 1);
});

for (const config of botConfigs) {
  try {
    const bot = await startBot({
      config,
      onMessage: app.handleMessage,
      onCardAction: app.handleCardAction,
      onDocumentComment: app.handleDocumentComment,
    });
    app.botsById.set(bot.id, bot);
    console.log(
      `[Bot] 已连接 id=${bot.id} name=${bot.name} open_id=${bot.openId || '(未知，将按名称匹配 @)'}`,
    );
  } catch (error) {
    console.error(`[Bot] 启动失败 id=${config.id}:`, safeProcessError(error));
  }
}

if (app.botsById.size === 0) {
  console.error('所有 Bot 均启动失败，Agent OS 无法接收飞书消息。请先运行 pnpm probe 检查凭证。');
  process.exit(1);
}

await app.reconcileOrphanedCards();
await app.reconcileApprovalExecutions();
await app.resumeRecoverableWorkflows();
app.markReady();
if (app.isReady()) {
  console.log('[启动] 会话、审批和工作流恢复完成，开始接收新事件');
  app.startScheduler();
  app.startSpecReviewSync();
}

function safeProcessError(error: unknown): string {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return sanitizeForLog(detail, 4_000);
}
