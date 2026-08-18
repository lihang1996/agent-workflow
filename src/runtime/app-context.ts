/**
 * 运行时上下文容器。
 *
 * AppContext 是整个运行时最核心的依赖容器（dependency container）。
 * 几乎所有运行时模块（message-handler, cli-task, pipeline-runner 等）
 * 都接收 AppContext 作为第一个参数，从中获取各种 Store 和配置。
 *
 * 这个文件定义了：
 * 1. AppConfig —— 从 index.ts 传入的配置常量
 * 2. AppContext —— AppConfig + 所有 Store + 运行时可变状态
 * 3. CreateAppDeps —— createApp 的入参类型
 * 4. createAppContext() —— 工厂函数，组装 AppContext
 */

// ─── 类型导入 ───

import type { CliId } from '../cli/types.js';                    // 'claude' | 'codex' | 'cursor'
import type { JsonActiveRunStore } from '../core/active-run-store.js';     // 进行中任务快照
import type { JsonCollabStore } from '../core/collab-store.js';           // 协作轮次
import type { JsonQuestionnaireStore } from '../core/questionnaire-store.js'; // 问卷
import type { JsonSpecStore } from '../core/spec-store.js';               // 产品 Spec
import type { JsonScheduleStore } from '../core/schedule-store.js';       // 定时任务
import type { JsonApprovalStore } from '../core/approval-store.js';       // 审批
import type { JsonWorkflowStore } from '../core/workflow-store.js';       // 交付工作流
import { IdentityRegistry } from '../core/identity-registry.js';         // 跨 Bot 用户身份
import type { PipelineStep } from '../core/pipeline.js';                  // 流水线步骤定义
import {
  processRuntimeSourceGuard,
  type RuntimeSourceGuardLike,
} from '../core/runtime-source-guard.js';  // 运行时源码变更检测
import type { SessionManager } from '../core/session-manager.js';         // 会话管理器
import type { JsonTopicStore } from '../core/topic-store.js';             // 话题存储
import type { Bot } from '../im/lark.js';                                 // 飞书 Bot 实例
import type { ActiveRun } from './types.js';                              // 进行中任务

/**
 * 应用级配置（不可变，从 index.ts 传入）。
 * 这些值在启动时确定，运行期间不变。
 */
export interface AppConfig {
  /** 默认 CLI 引擎：新会话首次执行时使用 */
  defaultCliId: CliId;

  /** 评审↔开发协作最大轮次（默认 2，超过后评审结果不再回传开发） */
  collabMaxRounds: number;

  /** 固定 8 步流水线步骤定义 */
  pipelineSteps: PipelineStep[];

  /** 停机宽限期（毫秒）：停机时最多等这么久让 CLI 收尾 */
  shutdownGraceMs: number;

  /** 活跃任务快照防抖落盘间隔（毫秒） */
  activeRunPersistDebounceMs: number;

  /** 进度心跳间隔（毫秒）：每多久推送一次进度卡片 */
  progressHeartbeatMs: number;
}

/**
 * 运行时上下文：AppConfig + 所有 Store + 运行时可变状态。
 *
 * 这是整个系统的"大脑"，所有模块通过它访问：
 * - 持久化数据（sessions, workflows, specs, ...）
 * - 运行时状态（activeRuns, contextWindows, botsById, ...）
 * - 定时器（persistTimer, schedulerTimer, specReviewTimer, ...）
 * - 安全守护（runtimeSourceGuard, identities, ...）
 */
export interface AppContext extends AppConfig {
  // ─── 运行时标记 ───

  /** 是否正在停机（停机时拒绝新任务） */
  shuttingDown: boolean;

  // ─── 运行时可变状态 ───

  /**
   * 当前活跃的 CLI 任务：Map<sessionId, ActiveRun>。
   * startCliTask 时 set，任务结束时 delete。
   * 停机收尾时遍历所有 ActiveRun 做 SIGTERM + 刷中断卡。
   */
  activeRuns: Map<string, ActiveRun>;

  /**
   * 各会话的上下文窗口 token 数：Map<sessionId, number>。
   * CLI 返回 stats 时更新，新任务传入 tracker 用于显示进度。
   */
  contextWindows: Map<string, number>;

  // ─── 持久化 Store ───

  /** 会话管理器：管理 CLI 会话的创建、状态转换、上下文恢复 */
  sessions: SessionManager;

  /** 话题存储：每个飞书话题的工作目录和引擎绑定 */
  topics: JsonTopicStore;

  /** 协作轮次存储：记录评审↔开发协作的当前轮次 */
  collabStore: JsonCollabStore;

  /** 活跃任务快照存储：data/active-runs.json */
  activeRunStore: JsonActiveRunStore;

  /** 问卷存储：PM 通过 MCP 创建的需求问卷 */
  questionnaires: JsonQuestionnaireStore;

  /** 产品 Spec 存储 */
  specs: JsonSpecStore;

  /** 定时任务存储 */
  schedules: JsonScheduleStore;

  /** 高风险审批存储 */
  approvals: JsonApprovalStore;

  /** 交付工作流存储（流水线状态机） */
  workflows: JsonWorkflowStore;

  /** 跨 Bot 用户身份注册表：open_id → user_id/union_id 映射 */
  identities: IdentityRegistry;

  // ─── 安全守护 ───

  /**
   * 运行时源码变更检测器。
   * 流水线执行期间如果 src/ 或 skills/ 被改过，
   * 下一个门禁步骤会暂停并提示"请重启服务"。
   * 防止用旧代码跑新门禁逻辑。
   */
  runtimeSourceGuard: RuntimeSourceGuardLike;

  // ─── 飞书 Bot 注册表 ───

  /** 已连接的飞书 Bot：Map<botId, Bot>。由 index.ts 的 startBot 填充 */
  botsById: Map<string, Bot>;

  // ─── 定时器引用（运行时动态创建/清除） ───

  /** 活跃任务防抖落盘定时器 */
  persistTimer?: ReturnType<typeof setTimeout>;

  /** 定时任务轮询定时器 */
  schedulerTimer?: ReturnType<typeof setInterval>;

  /** 定时任务是否在运行 */
  schedulerRunning: boolean;

  /** 云文档评论同步定时器 */
  specReviewTimer?: ReturnType<typeof setInterval>;

  /** 云文档评论同步是否在运行 */
  specReviewRunning: boolean;
}

/**
 * createApp 的入参类型。
 * 从 index.ts 构造，包含所有必须的 Store 和配置。
 */
export interface CreateAppDeps {
  sessions: SessionManager;
  topics: JsonTopicStore;
  collabStore: JsonCollabStore;
  activeRunStore: JsonActiveRunStore;
  questionnaires: JsonQuestionnaireStore;
  specs: JsonSpecStore;
  schedules: JsonScheduleStore;
  approvals: JsonApprovalStore;
  workflows: JsonWorkflowStore;
  /** 可选；未传入时创建空注册表 */
  identities?: IdentityRegistry;
  /** 可选；未传入时使用 processRuntimeSourceGuard（检测 src/ 文件变更） */
  runtimeSourceGuard?: RuntimeSourceGuardLike;
  config: AppConfig;
}

/**
 * 组装运行时上下文。
 *
 * 被 createApp()（create-app.ts）调用。
 * 做的事情很简单：把 deps 里的所有字段平铺到一个对象，
 * 加上运行时可变状态的初始值（空 Map、false 等）。
 *
 * 这里的设计思路是"显式依赖注入"：
 * 所有 Store 都从外部传入，不在此处 new，
 * 方便测试时替换为 mock。
 */
export function createAppContext(deps: CreateAppDeps): AppContext {
  return {
    // 展开 config 里的所有字段
    ...deps.config,

    // 运行时标记
    shuttingDown: false,

    // 运行时可变状态初始值
    activeRuns: new Map(),
    contextWindows: new Map(),

    // 持久化 Store
    sessions: deps.sessions,
    topics: deps.topics,
    collabStore: deps.collabStore,
    activeRunStore: deps.activeRunStore,
    questionnaires: deps.questionnaires,
    specs: deps.specs,
    schedules: deps.schedules,
    approvals: deps.approvals,
    workflows: deps.workflows,

    // 身份注册表：未传入时创建空的
    identities: deps.identities ?? new IdentityRegistry(),

    // 源码守护：未传入时使用默认实现（检测 src/ 变更）
    runtimeSourceGuard: deps.runtimeSourceGuard ?? processRuntimeSourceGuard,

    // Bot 注册表：初始为空，由 index.ts 的 startBot 逐个填充
    botsById: new Map(),

    // 定时器初始状态
    schedulerRunning: false,
    specReviewRunning: false,
  };
}
