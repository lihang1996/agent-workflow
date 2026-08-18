/**
 * Agent OS 入口文件（组合根）。
 *
 * 职责：
 * 1. 加载 .env 环境变量
 * 2. 解析全局配置（默认引擎、协作轮次、流水线步骤、Bot 凭证）
 * 3. 获取单实例锁（防止两个 pnpm start 同时运行丢更新）
 * 4. 初始化所有持久化 Store（从 data/*.json 恢复）
 * 5. 调用 createApp() 组装运行时上下文
 * 6. 注册进程信号收尾（SIGINT/SIGTERM/SIGHUP/异常）
 * 7. 逐个启动飞书 Bot WS 长连接
 * 8. 收尾上次遗留的孤儿卡片、恢复中断的流水线
 * 9. markReady() 后开始接收新事件
 *
 * 多 Bot 入群 + 话题项目目录 + 任务交接 + CEO 团队流水线 + Claude/Codex/Cursor 三引擎。
 */

// ─── 导入：环境变量 ───
// dotenv/config 副作用导入：加载 .env 文件到 process.env
import 'dotenv/config';

// ─── 导入：Node 内置 ───
import { join } from 'node:path';

// ─── 导入：飞书接入层 ───
// startBot() 创建飞书 WS 长连接 + REST 客户端
import { startBot } from './im/lark.js';

// ─── 导入：单实例锁 ───
// acquireInstanceLock 用文件锁保证只有一个 Agent OS 实例在跑
// InstanceLockError 是锁冲突时的自定义错误
import { acquireInstanceLock, DEFAULT_LOCK_FILE, InstanceLockError } from './core/instance-lock.js';

// ─── 导入：引擎迁移 ───
// 启动时把旧版本持久化的引擎配置（如 per-session cliId）对齐到新的默认引擎
import { migratePersistedEngineToDefault } from './core/engine-migration.js';

// ─── 导入：协作配置 ───
// parseMaxRounds 解析 COLLAB_MAX_ROUNDS 环境变量（1-10，非法回退 2）
import { parseMaxRounds } from './core/collab.js';

// ─── 导入：持久化 Store ───
// 每个 Store 对应 data/ 下一个 JSON 文件，负责序列化/反序列化和并发安全
import { JsonActiveRunStore } from './core/active-run-store.js';     // 进行中任务快照
import { JsonCollabStore } from './core/collab-store.js';           // 协作轮次记录
import { loadBotConfigs } from './core/bot-config.js';               // 从 .env 加载 Bot 角色
import { parsePipelineSteps } from './core/pipeline.js';            // 解析 PIPELINE_STEPS
import { SessionManager } from './core/session-manager.js';         // 会话状态机
import { JsonSessionStore } from './core/session-store.js';         // 会话持久化
import { JsonTopicStore } from './core/topic-store.js';             // 话题（工作目录/引擎）
import { JsonQuestionnaireStore } from './core/questionnaire-store.js'; // 结构化问卷
import { JsonSpecStore } from './core/spec-store.js';               // 产品 Spec
import { JsonScheduleStore } from './core/schedule-store.js';       // 定时任务
import { JsonApprovalStore } from './core/approval-store.js';       // 高风险审批
import { JsonWorkflowStore } from './core/workflow-store.js';       // 交付工作流
import { IdentityRegistry } from './core/identity-registry.js';     // 跨 Bot 用户身份映射

// ─── 导入：工具函数 ───
import { resolveWorkdir } from './core/workdir.js';                 // 解析工作目录回退链
import { sanitizeForLog } from './core/log-inspection.js';          // 日志脱敏（防泄露 token 等）

// ─── 导入：CLI 引擎 ───
import { listEngines } from './cli/registry.js';                    // 列出 claude/codex/cursor
import { isCliId, type CliId } from './cli/types.js';              // 类型守卫 + CliId 类型

// ─── 导入：MCP ───
import { logMcpStatus } from './mcp/config.js';                    // 打印 MCP 配置状态
import { cleanupStaleOverlays } from './mcp/cleanup.js';            // 清理过期 Cursor overlay 目录

// ─── 导入：运行时组装 ───
import { createApp } from './runtime/create-app.js';               // 工厂函数：组装 App 对象

// ═══════════════════════════════════════════════════════════════
// 常量配置
// ═══════════════════════════════════════════════════════════════

/** 停机宽限期：最多等 15 秒让进行中任务收尾，然后强制退出 */
const SHUTDOWN_GRACE_MS = 15_000;

/** 活跃任务快照防抖落盘间隔：避免每个工具事件都写磁盘，800ms 内合并 */
const ACTIVE_RUN_PERSIST_DEBOUNCE_MS = 800;

/** 进度心跳间隔：每 15 秒推送一次卡片进度更新（即使没有新工具事件） */
const PROGRESS_HEARTBEAT_MS = 15_000;

// ═══════════════════════════════════════════════════════════════
// 第一步：解析全局配置
// ═══════════════════════════════════════════════════════════════

/**
 * 解析 DEFAULT_CLI 环境变量为合法的 CliId。
 * 支持 'claude' | 'codex' | 'cursor'，不区分大小写。
 * 空值或非法值回退到 'cursor'（项目默认引擎）。
 */
function parseDefaultCliId(value: string | undefined): CliId {
  if (!value) return 'cursor';                          // 未设置 → 默认 cursor
  const normalized = value.trim().toLowerCase();       // 统一小写
  if (isCliId(normalized)) return normalized;           // 合法值直接用
  console.warn(`[配置] 未知 DEFAULT_CLI=${value}，回退到 cursor`); // 非法值警告
  return 'cursor';                                      // 回退
}

// 解析四个全局配置项
const defaultCliId = parseDefaultCliId(process.env.DEFAULT_CLI);       // 默认 CLI 引擎
const collabMaxRounds = parseMaxRounds(process.env.COLLAB_MAX_ROUNDS); // 评审↔开发最大协作轮次
const pipelineSteps = parsePipelineSteps(process.env.PIPELINE_STEPS); // 固定 8 步流水线
const botConfigs = loadBotConfigs();                                   // 从 .env 加载所有角色 Bot

// 没有任何 Bot 凭证时直接退出（至少需要一个飞书应用）
if (botConfigs.length === 0) {
  console.error('未找到任何 Bot 凭证，请在 .env 配置 BOT_DEV_* / BOT_A_* 等');
  process.exit(1);
}

console.log('Agent OS 启动，正在建立飞书长连接…');

// ═══════════════════════════════════════════════════════════════
// 第二步：单实例锁
// ═══════════════════════════════════════════════════════════════

// P0 修复：单实例锁，防止两个 pnpm start 跨进程 last-writer-wins 丢更新。
// 锁文件是 data/.agent-os.lock，用 PID 写入；启动时检查 + 回收死 PID。
try {
  acquireInstanceLock(DEFAULT_LOCK_FILE);
} catch (error) {
  if (error instanceof InstanceLockError) {
    // 另一个实例正在运行，打印提示后退出
    console.error(`[启动] 检测到另一个 Agent OS 实例正在运行（${error.lockFile} 已存在）。`);
    console.error('[启动] 同时运行两个实例会导致跨进程丢更新、重复调度和数据损坏。');
    console.error('[启动] 如确认没有其他实例，请删除该锁文件后重试。');
    process.exit(1);
  }
  throw error; // 其他异常直接抛出
}

// ═══════════════════════════════════════════════════════════════
// 第三步：打印引擎/协作/流水线信息
// ═══════════════════════════════════════════════════════════════

// 打印每个引擎的命令名和回退工作目录
for (const engine of listEngines()) {
  console.log(`[CLI] ${engine.id}=${engine.command} fallbackCwd=${resolveWorkdir({ cliId: engine.id })}`);
}

console.log(`[CLI] 默认引擎=${defaultCliId}`);

// Cursor 引擎特殊警告：--force 是 YOLO 模式，没有 PreToolUse hook 拦截高风险
if (defaultCliId === 'cursor') {
  console.warn('[CLI] Cursor 无头使用 --force，没有 Claude PreToolUse 高风险闸门；高风险动作只靠提示词与飞书 /approval。');
}

console.log(`[协作] 最大轮次=${collabMaxRounds}`);
console.log(`[流水线] 步骤=${pipelineSteps.map((s) => s.id).join(' → ')}`); // pm → architect → dev → ...

// 打印 MCP（结构化提问）配置状态
logMcpStatus();

// 清理上次运行残留的 Cursor MCP overlay 目录（隔离的 mcp.json + 环境变量）
cleanupStaleOverlays();

// 打印即将启动的 Bot 列表
console.log(`[Bot] 将启动 ${botConfigs.length} 个角色: ${botConfigs.map((b) => b.id).join(', ')}`);
for (const config of botConfigs) {
  if (config.workdir) console.log(`[Bot] ${config.id} 默认工作目录=${config.workdir}`);
}

// ═══════════════════════════════════════════════════════════════
// 第四步：初始化所有持久化 Store（从 data/*.json 恢复）
// ═══════════════════════════════════════════════════════════════

// 会话管理器：管理每个话题下每个 Bot 角色的 CLI 会话
const sessions = await SessionManager.open({
  store: new JsonSessionStore(join('data', 'sessions.json')),
  defaultCliId, // 新会话默认使用此引擎
});

// 话题存储：记录每个飞书话题的工作目录和引擎选择
const topics = await JsonTopicStore.open(join('data', 'topics.json'));

// 协作轮次存储：记录评审↔开发协作的当前轮次
const collabStore = await JsonCollabStore.open(join('data', 'collab-rounds.json'));

// 活跃任务快照：记录进行中任务的卡片 ID 和进度，用于重启后收尾
const activeRunStore = new JsonActiveRunStore(join('data', 'active-runs.json'));

// 问卷存储：PM 通过 MCP 创建的结构化需求问卷
const questionnaires = await JsonQuestionnaireStore.open();

// 产品 Spec 存储：PM 产出的需求规格文档
const specs = await JsonSpecStore.open(join('data', 'specs.json'));

// 定时任务存储：/schedule 创建的周期性任务
const schedules = await JsonScheduleStore.open(join('data', 'schedules.json'));

// 审批存储：高风险操作审批卡
const approvals = await JsonApprovalStore.open(join('data', 'approvals.json'));

// 工作流存储：交付流水线的完整状态（步骤、门禁、证据链）
const workflows = await JsonWorkflowStore.open(join('data', 'workflows.json'));

// 用户身份注册表：跨 Bot 识别同一真实用户（open_id → user_id/union_id 映射）
const identities = await IdentityRegistry.open(join('data', 'user-identities.json'));

// 启动迁移：把旧版本每个 session 各自的引擎配置对齐到新的全局默认引擎
await migratePersistedEngineToDefault({ sessions, topics, defaultCliId });

// 打印恢复情况
console.log(
  `[会话] 已恢复 ${sessions.size} 个会话，${topics.size} 个话题设置，${collabStore.size} 个协作轮次，${identities.size} 个用户身份别名`,
);

// ═══════════════════════════════════════════════════════════════
// 第五步：组装运行时上下文（createApp 是工厂函数）
// ═══════════════════════════════════════════════════════════════

const app = createApp({
  // 注入所有 Store
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
  // 注入配置
  config: {
    defaultCliId,
    collabMaxRounds,
    pipelineSteps,
    shutdownGraceMs: SHUTDOWN_GRACE_MS,
    activeRunPersistDebounceMs: ACTIVE_RUN_PERSIST_DEBOUNCE_MS,
    progressHeartbeatMs: PROGRESS_HEARTBEAT_MS,
  },
});

// ═══════════════════════════════════════════════════════════════
// 第六步：注册进程信号收尾
// ═══════════════════════════════════════════════════════════════

// 复用标记：多次信号只执行一轮收尾
let shutdownPromise: Promise<void> | undefined;

/**
 * 停止接收新事件 → 断开飞书长连接 → 停定时器 → 收尾进行中任务 → 退出。
 *
 * 收尾逻辑：
 * - app.pauseEventHandling() 把状态切到 stopping，拒收新消息/卡片回调
 * - app.disconnectBots() 断开所有飞书 WS 长连接
 * - app.stopScheduler() 停止定时任务轮询
 * - app.stopSpecReviewSync() 停止云文档评论同步
 * - app.shutdownActiveRuns() 中断所有 CLI 子进程，刷卡为中断态，等 grace period
 * - process.exit() 退出
 */
function shutdownAndExit(reason: string, exitCode = 0): Promise<void> {
  if (shutdownPromise) return shutdownPromise; // 幂等：重复信号复用同一轮收尾

  app.pauseEventHandling();  // 状态 → stopping，拒收新事件
  app.disconnectBots();      // 断开飞书 WS 长连接

  shutdownPromise = (async () => {
    console.log(`[进程] ${reason}，开始收尾进行中任务…`);
    app.stopScheduler();        // 停定时任务
    app.stopSpecReviewSync();   // 停云文档评论同步
    try {
      await app.shutdownActiveRuns(reason); // 中断 CLI + 刷卡 + 等 grace
    } catch (error) {
      console.error('[进程] 收尾失败:', safeProcessError(error));
    } finally {
      process.exit(exitCode);
    }
  })();
  return shutdownPromise;
}

/**
 * 注册单个进程信号监听。
 * 用 try-catch 包裹是因为 Windows 可能没有 SIGHUP 等信号。
 */
function listenForShutdown(signal: NodeJS.Signals, reason: string): void {
  try {
    process.once(signal, () => {
      void shutdownAndExit(reason);
    });
  } catch {
    // Windows 等环境可能没有该信号，忽略
  }
}

// Ctrl+C
listenForShutdown('SIGINT', '服务已停止（SIGINT），任务中断');
// kill 命令 / docker stop
listenForShutdown('SIGTERM', '服务已停止（SIGTERM），任务中断');
// 关闭终端
listenForShutdown('SIGHUP', '终端已关闭（SIGHUP），任务中断');

// 未捕获异常：打印后退出码 1
process.once('uncaughtException', (error) => {
  console.error('[进程] uncaughtException:', safeProcessError(error));
  void shutdownAndExit('服务异常退出（uncaughtException），任务中断', 1);
});

// 未处理的 Promise 拒绝：打印后退出码 1
process.once('unhandledRejection', (reason) => {
  console.error('[进程] unhandledRejection:', safeProcessError(reason));
  void shutdownAndExit('服务异常退出（unhandledRejection），任务中断', 1);
});

// ═══════════════════════════════════════════════════════════════
// 第七步：逐个启动飞书 Bot WS 长连接
// ═══════════════════════════════════════════════════════════════

for (const config of botConfigs) {
  try {
    // startBot 做了三件事：
    // 1. 创建飞书 SDK Client（用 appId/appSecret）
    // 2. 调 /bot/v3/info 拉取自己的 open_id（用于群聊 @ 匹配）
    // 3. 创建 WSClient 建立长连接，注册事件 dispatcher
    const bot = await startBot({
      config,
      onMessage: app.handleMessage,          // 消息回调
      onCardAction: app.handleCardAction,     // 卡片按钮回调
      onDocumentComment: app.handleDocumentComment, // 云文档评论回调
    });
    app.botsById.set(bot.id, bot); // 存入 botsById 供后续路由使用
    console.log(
      `[Bot] 已连接 id=${bot.id} name=${bot.name} open_id=${bot.openId || '(未知，将按名称匹配 @)'}`,
    );
  } catch (error) {
    // 单个 Bot 启动失败不阻断其他 Bot
    console.error(`[Bot] 启动失败 id=${config.id}:`, safeProcessError(error));
  }
}

// 所有 Bot 都启动失败 → 无法接收消息 → 退出
if (app.botsById.size === 0) {
  console.error('所有 Bot 均启动失败，Agent OS 无法接收飞书消息。请先运行 pnpm probe 检查凭证。');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════
// 第八步：恢复上次中断的状态
// ═══════════════════════════════════════════════════════════════

// 收尾上次遗留的任务卡片（tsx watch 热重启 / crash 会留下"运行中"卡）
await app.reconcileOrphanedCards();

// 恢复中断的审批执行（审批通过但 CLI 还没跑完就 crash 了）
await app.reconcileApprovalExecutions();

// 恢复可重试的交付流水线（executing 状态的 workflow 继续跑）
await app.resumeRecoverableWorkflows();

// ═══════════════════════════════════════════════════════════════
// 第九步：标记就绪，开始接收新事件
// ═══════════════════════════════════════════════════════════════

app.markReady(); // 状态：recovering → ready

if (app.isReady()) {
  console.log('[启动] 会话、审批和工作流恢复完成，开始接收新事件');
  app.startScheduler();        // 启动定时任务轮询
  app.startSpecReviewSync();   // 启动云文档评论定时同步
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 把错误对象安全格式化为字符串，用于日志输出。
 * - Error：优先取 stack（含调用链），其次 message
 * - 非 Error：String(value)
 * - 最后经过 sanitizeForLog 脱敏（移除 token/密码等敏感信息），截断到 4000 字符
 */
function safeProcessError(error: unknown): string {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return sanitizeForLog(detail, 4_000);
}
