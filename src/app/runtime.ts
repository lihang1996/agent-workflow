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

export interface BotRuntime {
  config: BotConfig;
  bot: Bot;
  identity: BotIdentity;
}

export interface AppRuntime {
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
   * 服务端知识预取台账（T-016）。生产运行态多系统 KB 消费保持 blocked
   * （见 kb-prefetch.ts 的 KNOWLEDGE_RUNTIME_GATE），生产不注入；仅当 flow
   * 声明了 knowledge_refs 时 G1 才要求它在场做服务端引用核验。
   */
  knowledgePrefetch?: KnowledgePrefetchLedger;
  /**
   * 架构交接台账（T-020）：服务端签发的 PRD→架构 capability。内存态；
   * 交接是单次使用的短生命周期引用，生产持久化策略随 W6 一并评审。
   */
  architectureHandoffs?: ArchitectureHandoffStore;
  /**
   * 编码授权台账（T-021 首批）：本地数据模型与显式授权入口。active 授权
   * 不接入任何真实开发派发（T-022 写隔离 canary 未通过前仅作为可校验状态）。
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
