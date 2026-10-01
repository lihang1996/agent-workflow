import type { Bot, BotIdentity } from '../im/lark.js';
import type { ActiveRun } from '../core/task-abort.js';
import type { BotConfig } from '../core/bot-registry.js';
import type { IsolationSupplier, SessionScratchBinding } from '../core/isolation.js';
import type { CollaborationInbox } from '../core/collaboration.js';
import type { ClarificationFlowStore } from '../core/clarification.js';
import type { ProductSpecFlowStore } from '../core/product-spec.js';
import type { ArchitectureHandoffStore } from '../core/architecture-handoff.js';
import type { CodingAuthorizationStore } from '../core/coding-authorization.js';
import type { KnowledgePrefetchLedger } from '../core/kb-prefetch.js';
import type { SessionManager } from '../core/session-manager.js';
import type { TeamRegistry } from '../core/team-registry.js';
import type { TaskExecutionStore } from '../core/task-execution.js';
import type { DeliveryOutbox } from './delivery-outbox.js';
import type { SourceContextGrantStore } from '../core/source-context-grant.js';
import type { CodingIntentHandoffStore } from '../core/coding-handoff.js';

export interface BotRuntime {
  config: BotConfig;
  bot: Bot;
  identity: BotIdentity;
}

export interface AppRuntime {
  sourceContexts?: SourceContextGrantStore;
  codingHandoffs?: CodingIntentHandoffStore;
  authorizeCodingOperator?: (principalId: string, botId: string) => boolean;
  validateCodingKnowledge?: (authorizationId: string) => Promise<void>;
  taskExecutions?: TaskExecutionStore;
  deliveries?: DeliveryOutbox;
  sessions: SessionManager;
  teamRegistry: TeamRegistry;
  activeRuns: Map<string, ActiveRun>;
  sessionMutations?: Map<string, string>;
  contextWindows: Map<string, number>;
  botRuntimes: Map<string, BotRuntime>;
  processedCollaborationTurns: Set<string>;
  collaborationInbox: CollaborationInbox;
  clarificationFlows: ClarificationFlowStore;
  productSpecFlows: ProductSpecFlowStore;
  /**
   * 旧部署事实预取台账（T-016）。正式部署证明未配置时不注入；
   * source/dev 消费由 sourceContexts 提供，并在 G1 重新校验。
   */
  knowledgePrefetch?: KnowledgePrefetchLedger;
  /**
   * 架构交接台账（T-020）：服务端签发的 PRD→架构 capability。
   * 正式入口使用 JsonArchitectureHandoffStore，支持保留及重启恢复。
   */
  architectureHandoffs?: ArchitectureHandoffStore;
  /**
   * 编码授权台账：开始开发卡片通过 codingHandoffs 可恢复地启动任务。
   * active 授权仍须通过 G3、当前身份和对应 CLI 的隔离能力证明。
   */
  codingAuthorizations?: CodingAuthorizationStore;
  /**
   * T-022 隔离 preparer（G-W6b-FIX）。缺省 = 生产失败关闭实现：受保护根清单
   * 缺失或能力库无 canary 证据 ⇒ 一切真实 CLI 启动 blocked。测试注入专用
   * fixture harness，不得在生产线放宽。
   */
  isolationPreparer?: IsolationSupplier;
  /**
   * 会话 → 最近一次隔离任务的 scratch 绑定（119 号 P1-4：**必填**，生产在
   * index.ts 初始化；本地制品提交缺绑定/跨任务/过期一律失败关闭）。
   */
  sessionScratches: Map<string, SessionScratchBinding>;
}
