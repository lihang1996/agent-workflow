import { terminateIsolatedChild } from '../core/isolation.js';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { CliAdapter, CliSessionSummary } from './types.js';
import { launchIsolated, settleGroupAfterExit, type IsolationSupplier } from '../core/isolation.js';

const SESSION_LIMIT = 8;
const REQUEST_TIMEOUT_MS = 15_000;

export interface ListNativeCliSessionsOptions {
  adapter: CliAdapter;
  cwd: string;
  /** T-022 强制入口契约：会话列表也是真实 CLI 调用，必须经统一隔离边界。 */
  isolation: IsolationSupplier;
}

interface JsonMessage {
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function shortText(value: unknown, maxLength = 80): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function userPrompt(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  if (typeof message.content === 'string') return shortText(message.content);
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter(isRecord)
    .filter((block) => block.type === 'text')
    .map((block) => typeof block.text === 'string' ? block.text : '')
    .join(' ');
  return shortText(text);
}

function claudeProjectDirectory(configDir: string, cwd: string): string {
  const key = cwd.replace(/[^A-Za-z0-9]/g, '-');
  return join(configDir, 'projects', key);
}

async function readClaudeSession(
  filePath: string,
  expectedCwd: string,
): Promise<CliSessionSummary | undefined> {
  const lines = createInterface({ input: createReadStream(filePath) });
  let sessionId: string | undefined;
  let observedCwd: string | undefined;
  let firstPrompt: string | undefined;
  let lastPrompt: string | undefined;
  let title: string | undefined;

  for await (const line of lines) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row)) continue;
    if (typeof row.sessionId === 'string') sessionId = row.sessionId;
    if (typeof row.cwd === 'string') observedCwd = row.cwd;
    if (row.type === 'ai-title') title = shortText(row.aiTitle) ?? title;
    if (row.type === 'last-prompt') {
      lastPrompt = shortText(row.lastPrompt) ?? lastPrompt;
    }
    if (row.type === 'user' && !firstPrompt) {
      firstPrompt = userPrompt(row.message);
    }
  }

  if (!sessionId || observedCwd !== expectedCwd) return undefined;
  const metadata = await stat(filePath);
  return {
    id: sessionId,
    title: title ?? lastPrompt ?? firstPrompt ?? '未命名会话',
    updatedAt: metadata.mtime.toISOString(),
  };
}

async function listClaudeSessions(
  options: ListNativeCliSessionsOptions,
): Promise<CliSessionSummary[]> {
  // T-022 修订版 §1.3 S4：Claude 会话历史读取用户全局目录（~/.claude）不得
  // 借「查询」绕开隔离——只有隔离上下文自己重定向的 CLAUDE_CONFIG_DIR（位于
  // 任务 scratch 内）里的会话才可见；未隔离的全局读取一律 blocked。
  if (!options.isolation) {
    throw new Error('Claude 会话列表必须提供 isolation supplier（全局历史读取未隔离，blocked）。');
  }
  const prepared = await options.isolation({
    taskId: `sessions-${options.cwd}`,
    purpose: 'session-list',
    cliMode: 'session-list',
    command: options.adapter.command,
    cwd: options.cwd,
  });
  const isolatedConfigDir = prepared.env.CLAUDE_CONFIG_DIR;
  if (!isolatedConfigDir || !isolatedConfigDir.startsWith(`${prepared.context.scratchDir}/`)) {
    // 149 号 P2-1：读取从未发生的失败路径无进程占用，安全清理 ephemeral scratch。
    prepared.dispose();
    throw new Error('Claude 全局会话历史（~/.claude）未隔离：CLAUDE_CONFIG_DIR 未重定向到任务 scratch，读取保持 blocked（V-5 未验证）。');
  }
  const configDir = isolatedConfigDir;
  const projectDir = claudeProjectDirectory(configDir, options.cwd);
  let names: string[];
  try {
    names = await readdir(projectDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const sessions = await Promise.all(
    names
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => readClaudeSession(join(projectDir, name), options.cwd)),
  );
  return sessions
    .filter((session): session is CliSessionSummary => session !== undefined)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, SESSION_LIMIT);
}

function protocolError(message: JsonMessage): string | undefined {
  if (!isRecord(message.error)) return undefined;
  return typeof message.error.message === 'string'
    ? message.error.message
    : 'Codex 会话列表读取失败';
}

async function listCodexSessions(
  options: ListNativeCliSessionsOptions,
): Promise<CliSessionSummary[]> {
  const prepared = await options.isolation({
    taskId: `sessions-${options.cwd}`,
    purpose: 'session-list',
    cliMode: 'session-list',
    command: options.adapter.command,
    cwd: options.cwd,
  });
  return new Promise((resolve, reject) => {
    const child = launchIsolated(prepared, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout });
    let stderr = '';

    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const cleanup = () => clearTimeout(timer);
    // 138 号 P0-2（续跑修正）：唯一 settle 门——**先 await 整组终止与核验，
    // 再一次性 resolve/reject**。`settling` 在进入异步收尾的瞬间同步占位
    //（挡住 close/error 等并发路径）；`settled` 只在真正 settle 的瞬间置位。
    // 成功路径若收尾核验失败，由自身 settleReject（不经 fail），杜绝「先占位
    // 后失败 ⇒ 永久悬挂」；错误/取消/超时路径的收尾失败并入 reject，不吞。
    // 149 号 P2-1：ephemeral scratch 只在**整组已核实退出**后由 dispose 清理
    //（本入口是明确所有者）；核验失败 ⇒ 保留诊断目录，不盲删。
    let groupVerifiedExited = false;
    let settling = false;
    let settled = false;
    const settleReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const settleResolve = (sessions: CliSessionSummary[]): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(sessions);
    };
    const terminateOutcomeDetail = async (): Promise<string | null> => {
      try {
        const outcome = await terminateIsolatedChild(child);
        if (outcome.outcome === 'unverifiable') return `无法核验后代终止（${outcome.reason}）`;
        if (outcome.groupAliveAfter) return '进程组仍有存活后代';
        groupVerifiedExited = true;
        return null;
      } catch (terminateError) {
        return `终止核验异常（${(terminateError as Error).message}）`;
      }
    };
    const fail = (error: Error): Promise<void> => {
      if (settled || settling) return Promise.resolve();
      settling = true;
      return terminateOutcomeDetail().then((detail) => {
        if (groupVerifiedExited) prepared.dispose();
        settleReject(detail ? new Error(`${error.message}；${detail}，失败关闭`) : error);
      });
    };
    const succeed = (sessions: CliSessionSummary[]): void => {
      if (settled || settling) return;
      settling = true;
      // 先 await 整组终止（成功也要停掉 app-server 及其后端），再核验后 settle。
      void terminateOutcomeDetail().then((detail) => {
        if (groupVerifiedExited) prepared.dispose();
        if (detail) {
          settleReject(new Error(`Codex 会话列表完成但${detail}，失败关闭`));
          return;
        }
        settleResolve(sessions);
      });
    };
    const timer = setTimeout(
      () => void fail(new Error('Codex 会话列表读取超时')),
      REQUEST_TIMEOUT_MS,
    );

    lines.on('line', (line) => {
      let message: JsonMessage;
      try {
        message = JSON.parse(line) as JsonMessage;
      } catch {
        return;
      }
      const error = protocolError(message);
      if (error) {
        fail(new Error(error));
        return;
      }
      if (message.id === 1) {
        send({ method: 'initialized', params: {} });
        send({
          id: 2,
          method: 'thread/list',
          params: {
            cwd: options.cwd,
            limit: SESSION_LIMIT,
            sortKey: 'updated_at',
            sortDirection: 'desc',
            sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
          },
        });
        return;
      }
      if (message.id !== 2 || !isRecord(message.result)) return;
      const data = Array.isArray(message.result.data)
        ? message.result.data.filter(isRecord)
        : [];
      succeed(data.flatMap((thread): CliSessionSummary[] => {
        if (typeof thread.id !== 'string') return [];
        const updatedAt = typeof thread.updatedAt === 'number'
          ? new Date(thread.updatedAt * 1000).toISOString()
          : new Date().toISOString();
        return [{
          id: thread.id,
          title: shortText(thread.name)
            ?? shortText(thread.preview)
            ?? '未命名会话',
          updatedAt,
        }];
      }));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => void fail(error));
    child.once('close', (code) => {
      if (settled || settling) return;
      void (async () => {
        // close 后核验：wrapper 退出 ≠ 后端退出。辅助进程可能滞后有序退出，
        // 给有界宽限再升级终止；幸存者/无法核验 ⇒ 失败关闭。
        const groupOutcome = await settleGroupAfterExit(child.pid).catch(
          (error: Error): { outcome: 'unverifiable'; reason: string } => ({ outcome: 'unverifiable', reason: error.message }),
        );
        if (groupOutcome.outcome === 'unverifiable') {
          await fail(new Error(`无法核验隔离进程组（${groupOutcome.reason}），失败关闭。`));
          return;
        }
        if (groupOutcome.outcome === 'survivors') {
          await fail(new Error(`隔离进程组仍有存活后代（${groupOutcome.detail}），wrapper 退出不代表 CLI/后端退出，任务判失败。`));
          return;
        }
        await fail(new Error(
          stderr.trim() || `Codex app-server 提前退出，状态码 ${code}`,
        ));
      })();
    });

    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'agent_os',
          title: 'Agent OS',
          version: '0.1.0',
        },
      },
    });
  });
}

export function listNativeCliSessions(
  options: ListNativeCliSessionsOptions,
): Promise<CliSessionSummary[]> {
  if (options.adapter.id === 'claude') return listClaudeSessions(options);
  if (options.adapter.id === 'codex') return listCodexSessions(options);
  return Promise.reject(new Error(`${options.adapter.displayName} 暂不支持此操作`));
}
