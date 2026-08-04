import type { CliId } from '../cli/types.js';
import type { JsonActiveRunStore } from '../core/active-run-store.js';
import type { JsonCollabStore } from '../core/collab-store.js';
import type { JsonQuestionnaireStore } from '../core/questionnaire-store.js';
import type { JsonSpecStore } from '../core/spec-store.js';
import type { JsonScheduleStore } from '../core/schedule-store.js';
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
  specs: JsonSpecStore;
  schedules: JsonScheduleStore;
  botsById: Map<string, Bot>;
  persistTimer?: ReturnType<typeof setTimeout>;
  schedulerTimer?: ReturnType<typeof setInterval>;
  schedulerRunning: boolean;
}

export interface CreateAppDeps {
  sessions: SessionManager;
  topics: JsonTopicStore;
  collabStore: JsonCollabStore;
  activeRunStore: JsonActiveRunStore;
  questionnaires: JsonQuestionnaireStore;
  specs: JsonSpecStore;
  schedules: JsonScheduleStore;
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
    specs: deps.specs,
    schedules: deps.schedules,
    botsById: new Map(),
    schedulerRunning: false,
  };
}
