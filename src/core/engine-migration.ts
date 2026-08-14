/**
 * DEFAULT_CLI 变更时，把已持久化的话题/空闲会话对齐到新默认引擎。
 * 同一默认值再次启动不会覆盖用户后来用 /engine 选定的话题引擎。
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isCliId, type CliId } from '../cli/types.js';
import type { SessionManager } from './session-manager.js';
import type { JsonTopicStore } from './topic-store.js';

export const DEFAULT_ENGINE_MIGRATION_MARKER = join('data', '.default-cli-migration.json');

export interface EngineMigrationResult {
  skipped: boolean;
  previousCliId?: CliId;
  topicsUpdated: number;
  sessionsUpdated: number;
  deferred: number;
}

interface EngineMigrationMarker {
  cliId: CliId;
  migratedAt: string;
}

export async function migratePersistedEngineToDefault(options: {
  sessions: SessionManager;
  topics: JsonTopicStore;
  defaultCliId: CliId;
  markerPath?: string;
}): Promise<EngineMigrationResult> {
  const markerPath = options.markerPath ?? DEFAULT_ENGINE_MIGRATION_MARKER;
  const previous = readMarker(markerPath);
  if (previous?.cliId === options.defaultCliId) {
    return { skipped: true, previousCliId: previous.cliId, topicsUpdated: 0, sessionsUpdated: 0, deferred: 0 };
  }

  const seen = new Map<string, { chatId: string; threadId: string }>();
  let topicsUpdated = 0;
  for (const topic of options.topics.list()) {
    seen.set(topicKey(topic.chatId, topic.threadId), { chatId: topic.chatId, threadId: topic.threadId });
    if (topic.cliId === options.defaultCliId) continue;
    await options.topics.setCliId(topic.chatId, topic.threadId, options.defaultCliId);
    topicsUpdated += 1;
  }
  for (const session of options.sessions.list()) {
    const key = topicKey(session.chatId, session.threadId);
    if (seen.has(key)) continue;
    seen.set(key, { chatId: session.chatId, threadId: session.threadId });
    await options.topics.setCliId(session.chatId, session.threadId, options.defaultCliId);
    topicsUpdated += 1;
  }

  let sessionsUpdated = 0;
  let deferred = 0;
  for (const topic of seen.values()) {
    const update = await options.sessions.setCliIdForTopic(topic.chatId, topic.threadId, options.defaultCliId);
    sessionsUpdated += update.updated;
    deferred += update.deferredBotIds.length;
    if (update.deferredBotIds.length > 0) {
      console.warn(
        `[引擎] 话题 ${topic.chatId}/${topic.threadId} 仍有在途角色（${update.deferredBotIds.join('、')}），结束后会再对齐到 ${options.defaultCliId}`,
      );
    }
  }

  writeMarker(markerPath, {
    cliId: options.defaultCliId,
    migratedAt: new Date().toISOString(),
  });
  console.log(
    `[引擎] 已将持久化话题/会话对齐到默认引擎 ${options.defaultCliId}`
    + `${previous?.cliId ? `（此前 ${previous.cliId}）` : '（首次）'}`
    + ` topics=${topicsUpdated} sessions=${sessionsUpdated} deferred=${deferred}`,
  );
  return {
    skipped: false,
    ...(previous?.cliId ? { previousCliId: previous.cliId } : {}),
    topicsUpdated,
    sessionsUpdated,
    deferred,
  };
}

function topicKey(chatId: string, threadId: string): string {
  return `${chatId}\0${threadId}`;
}

function readMarker(path: string): EngineMigrationMarker | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { cliId?: unknown; migratedAt?: unknown };
    if (!isCliId(String(parsed.cliId ?? '')) || typeof parsed.migratedAt !== 'string') return undefined;
    return { cliId: parsed.cliId as CliId, migratedAt: parsed.migratedAt };
  } catch {
    return undefined;
  }
}

function writeMarker(path: string, marker: EngineMigrationMarker): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  try {
    renameSync(tempPath, path);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* ignore */ }
    throw error;
  }
}
