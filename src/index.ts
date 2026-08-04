/**
 * Agent OS 入口。
 * 多 Bot 入群 + 话题项目目录 + 任务交接 + CEO 团队流水线 + Claude/Codex 双引擎。
 */
import 'dotenv/config';
import { join } from 'node:path';
import { startBot } from './im/lark.js';
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
import { resolveWorkdir } from './core/workdir.js';
import { listEngines } from './cli/registry.js';
import { isCliId, type CliId } from './cli/types.js';
import { logMcpStatus } from './mcp/config.js';
import { createApp } from './runtime/create-app.js';

const SHUTDOWN_GRACE_MS = 15_000;
const ACTIVE_RUN_PERSIST_DEBOUNCE_MS = 800;
const PROGRESS_HEARTBEAT_MS = 15_000;

/** 解析 DEFAULT_CLI，非法值回退 claude。 */
function parseDefaultCliId(value: string | undefined): CliId {
  if (!value) return 'claude';
  const normalized = value.trim().toLowerCase();
  if (isCliId(normalized)) return normalized;
  console.warn(`[配置] 未知 DEFAULT_CLI=${value}，回退到 claude`);
  return 'claude';
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
for (const engine of listEngines()) {
  console.log(`[CLI] ${engine.id}=${engine.command} fallbackCwd=${resolveWorkdir({ cliId: engine.id })}`);
}
console.log(`[CLI] 默认引擎=${defaultCliId}`);
console.log(`[协作] 最大轮次=${collabMaxRounds}`);
console.log(`[流水线] 步骤=${pipelineSteps.map((s) => s.id).join(' → ')}`);
logMcpStatus();
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
const questionnaires = new JsonQuestionnaireStore();
const specs = await JsonSpecStore.open(join('data', 'specs.json'));
const schedules = await JsonScheduleStore.open(join('data', 'schedules.json'));
const approvals = await JsonApprovalStore.open(join('data', 'approvals.json'));
console.log(
  `[会话] 已恢复 ${sessions.size} 个会话，${topics.size} 个话题项目目录，${collabStore.size} 个协作轮次`,
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
  config: {
    defaultCliId,
    collabMaxRounds,
    pipelineSteps,
    shutdownGraceMs: SHUTDOWN_GRACE_MS,
    activeRunPersistDebounceMs: ACTIVE_RUN_PERSIST_DEBOUNCE_MS,
    progressHeartbeatMs: PROGRESS_HEARTBEAT_MS,
  },
});

for (const config of botConfigs) {
  try {
    const bot = await startBot({
      config,
      onMessage: app.handleMessage,
      onCardAction: app.handleCardAction,
    });
    app.botsById.set(bot.id, bot);
    console.log(
      `[Bot] 已连接 id=${bot.id} name=${bot.name} open_id=${bot.openId || '(未知，将按名称匹配 @)'}`,
    );
  } catch (error) {
    console.error(`[Bot] 启动失败 id=${config.id}:`, (error as Error).message);
  }
}

await app.reconcileOrphanedCards();
app.startScheduler();

/** 收尾进行中任务后退出进程。 */
async function shutdownAndExit(reason: string, exitCode = 0): Promise<void> {
  console.log(`[进程] ${reason}，开始收尾进行中任务…`);
  app.stopScheduler();
  try {
    await app.shutdownActiveRuns(reason);
  } catch (error) {
    console.error('[进程] 收尾失败:', (error as Error).message);
  } finally {
    process.exit(exitCode);
  }
}

process.once('SIGINT', () => {
  void shutdownAndExit('服务已停止（SIGINT），任务中断');
});
process.once('SIGTERM', () => {
  void shutdownAndExit('服务已停止（SIGTERM），任务中断');
});
process.once('uncaughtException', (error) => {
  console.error('[进程] uncaughtException:', error);
  void shutdownAndExit('服务异常退出（uncaughtException），任务中断', 1);
});
process.once('unhandledRejection', (reason) => {
  console.error('[进程] unhandledRejection:', reason);
  void shutdownAndExit('服务异常退出（unhandledRejection），任务中断', 1);
});
