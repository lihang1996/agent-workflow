import type { CliId } from '../cli/types.js';
import type { JsonActiveRunStore } from '../core/active-run-store.js';
import type { JsonCollabStore } from '../core/collab-store.js';
import type { JsonQuestionnaireStore } from '../core/questionnaire-store.js';
import type { PipelineStep } from '../core/pipeline.js';
import type { SessionManager } from '../core/session-manager.js';
import type { JsonTopicStore } from '../core/topic-store.js';
import type { Bot } from '../im/lark.js';
import type { ActiveRun } from './types.js';

export interface AppConfig {
  defaultCliId: CliId;
  collabMaxRounds: number;
  pipelineSteps: PipelineStep[];
  shutdownGraceMs: number;
  activeRunPersistDebounceMs: number;
  progressHeartbeatMs: number;
}

export interface AppContext extends AppConfig {
  shuttingDown: boolean;
  activeRuns: Map<string, ActiveRun>;
  contextWindows: Map<string, number>;
  sessions: SessionManager;
  topics: JsonTopicStore;
  collabStore: JsonCollabStore;
  activeRunStore: JsonActiveRunStore;
  questionnaires: JsonQuestionnaireStore;
  botsById: Map<string, Bot>;
  persistTimer?: ReturnType<typeof setTimeout>;
}

export interface CreateAppDeps {
  sessions: SessionManager;
  topics: JsonTopicStore;
  collabStore: JsonCollabStore;
  activeRunStore: JsonActiveRunStore;
  questionnaires: JsonQuestionnaireStore;
  config: AppConfig;
}

/** 由 createApp 组装运行时上下文。 */
export function createAppContext(deps: CreateAppDeps): AppContext {
  return {
    ...deps.config,
    shuttingDown: false,
    activeRuns: new Map(),
    contextWindows: new Map(),
    sessions: deps.sessions,
    topics: deps.topics,
    collabStore: deps.collabStore,
    activeRunStore: deps.activeRunStore,
    questionnaires: deps.questionnaires,
    botsById: new Map(),
  };
}
