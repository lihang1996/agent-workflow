import { assertGroupFullyExited, terminateIsolatedChild } from '../core/isolation.js';
import { createInterface } from 'node:readline';
import type { CliAdapter, CliCompactPlan } from './types.js';
import {
  assertTaskDiffClean,
  launchIsolated,
  type IsolationSupplier,
  type PreparedIsolation,
} from '../core/isolation.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface CompactCliSessionOptions {
  adapter: CliAdapter;
  sessionId: string;
  cwd: string;
  instructions?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** T-022 强制入口契约：compact 承载会话上下文，必须经统一隔离边界。 */
  isolation: IsolationSupplier;
}

export interface CompactCliSessionResult {
  sessionId: string;
  compacted: boolean;
  message?: string;
}

interface JsonMessage {
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: unknown;
  params?: unknown;
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJson(line: string): JsonMessage | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function protocolError(message: JsonMessage): string | undefined {
  if (!isRecord(message.error)) return undefined;
  return typeof message.error.message === 'string'
    ? message.error.message
    : '原生上下文整理失败';
}

function runClaudeCompact(
  plan: Extract<CliCompactPlan, { protocol: 'claude-stream-json' }>,
  options: CompactCliSessionOptions,
  prepared: PreparedIsolation,
): Promise<CompactCliSessionResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`${options.adapter.displayName} 上下文整理已取消`));
      return;
    }
    const child = launchIsolated(prepared, plan.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // stdin 模式时把 /compact 指令写入子进程后收口，否则 Claude 会空等 stdin。
    if (child.stdin) {
      child.stdin.write(`${plan.prompt}\n`, 'utf8');
      child.stdin.end();
    }
    const lines = createInterface({ input: child.stdout });
    let stderr = '';
    let completed = false;
    let resultMessage: string | undefined;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    // 138 号 P1-3：唯一 settle 门——错误路径先 await 整组终止+核验再 reject
    //（错误保留核验原因），不再 fire-and-forget。
    const fail = (error: Error): Promise<void> => {
      if (settled) return Promise.resolve();
      settled = true;
      cleanup();
      return terminateIsolatedChild(child)
        .catch((terminateError: Error): { outcome: 'unverifiable'; reason: string } => ({
          outcome: 'unverifiable',
          reason: terminateError.message,
        }))
        .then((outcome) => {
          if (outcome.outcome === 'unverifiable') {
            reject(new Error(`${error.message}；且无法核验后代终止（${outcome.reason}），失败关闭`));
            return;
          }
          if (outcome.groupAliveAfter) {
            reject(new Error(`${error.message}；进程组仍有存活后代，失败关闭`));
            return;
          }
          reject(error);
        });
    };
    const abort = () => void fail(
      new Error(`${options.adapter.displayName} 上下文整理已取消`),
    );
    const timer = setTimeout(
      () => void fail(new Error(`${options.adapter.displayName} 上下文整理超时`)),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    options.signal?.addEventListener('abort', abort, { once: true });

    lines.on('line', (line) => {
      const message = parseJson(line);
      if (!message) return;
      if (message.type === 'system' && message.subtype === 'compact_boundary') {
        completed = true;
      }
      if (message.type === 'result' && message.is_error === true) {
        const result = typeof message.result === 'string'
          ? message.result
          : 'Claude Code 原生上下文整理失败';
        void fail(new Error(result));
        return;
      }
      if (message.type === 'result' && typeof message.result === 'string') {
        resultMessage = message.result.trim() || undefined;
      }
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => void fail(error));
    child.once('close', (code) => {
      if (settled) return;
      // 129 号：取消路径先 await 整组终止并核验，幸存者/不确定 ⇒ 失败关闭。
      void (async () => {
        if (options.signal?.aborted) {
          const outcome = await terminateIsolatedChild(child).catch(
            (error: Error): { outcome: 'unverifiable'; reason: string } => ({ outcome: 'unverifiable', reason: error.message }),
          );
          if (outcome.outcome === 'unverifiable' || outcome.groupAliveAfter) {
            const detail = outcome.outcome === 'unverifiable'
              ? `无法核验后代终止（${outcome.reason}）`
              : '进程组仍有存活后代';
            void fail(new Error(`上下文整理已取消，且${detail}，失败关闭`));
            return;
          }
          void fail(new Error(`${options.adapter.displayName} 上下文整理已取消`));
          return;
        }
        try {
          assertGroupFullyExited(child.pid);
        } catch (groupError) {
          void fail(groupError as Error);
          return;
        }
        if (code !== 0) {
          fail(new Error(
            stderr.trim() || `Claude Code 退出，状态码 ${code}`,
          ));
          return;
        }
        if (!completed) {
          if (resultMessage === 'Not enough messages to compact.') {
            settled = true;
            cleanup();
            resolve({
              sessionId: options.sessionId,
              compacted: false,
              message: '当前上下文还不需要整理。继续使用一段时间后再试。',
            });
            return;
          }
          void fail(new Error('Claude Code 没有返回上下文整理完成事件'));
          return;
        }
        settled = true;
        cleanup();
        resolve({ sessionId: options.sessionId, compacted: true });
      })();
    });
  });
}

function runCodexCompact(
  plan: Extract<CliCompactPlan, { protocol: 'codex-app-server' }>,
  options: CompactCliSessionOptions,
  prepared: PreparedIsolation,
): Promise<CompactCliSessionResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`${options.adapter.displayName} 上下文整理已取消`));
      return;
    }
    const child = launchIsolated(prepared, plan.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout });
    let stderr = '';
    let settled = false;

    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    // 138 号 P1-3：fail 先 await 整组终止+核验再 reject；succeed 同样先 await
    // 终止核验（app-server 常驻形态必须真实退出）后 resolve——不 fire-and-forget。
    const fail = (error: Error): Promise<void> => {
      if (settled) return Promise.resolve();
      settled = true;
      cleanup();
      return terminateIsolatedChild(child)
        .catch((terminateError: Error): { outcome: 'unverifiable'; reason: string } => ({
          outcome: 'unverifiable',
          reason: terminateError.message,
        }))
        .then((outcome) => {
          if (outcome.outcome === 'unverifiable') {
            reject(new Error(`${error.message}；且无法核验后代终止（${outcome.reason}），失败关闭`));
            return;
          }
          if (outcome.groupAliveAfter) {
            reject(new Error(`${error.message}；进程组仍有存活后代，失败关闭`));
            return;
          }
          reject(error);
        });
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void (async () => {
        const outcome = await terminateIsolatedChild(child).catch(
          (terminateError: Error): { outcome: 'unverifiable'; reason: string } => ({
            outcome: 'unverifiable',
            reason: terminateError.message,
          }),
        );
        if (outcome.outcome === 'unverifiable') {
          reject(new Error(`Codex 上下文整理完成但无法核验后代终止（${outcome.reason}），失败关闭`));
          return;
        }
        if (outcome.groupAliveAfter) {
          reject(new Error('Codex 上下文整理完成但进程组仍有存活后代，失败关闭'));
          return;
        }
        resolve({ sessionId: options.sessionId, compacted: true });
      })();
    };
    const abort = () => void fail(
      new Error(`${options.adapter.displayName} 上下文整理已取消`),
    );
    const timer = setTimeout(
      () => fail(new Error(`${options.adapter.displayName} 上下文整理超时`)),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    options.signal?.addEventListener('abort', abort, { once: true });

    lines.on('line', (line) => {
      const message = parseJson(line);
      if (!message) return;
      const error = protocolError(message);
      if (error) {
        void fail(new Error(error));
        return;
      }
      if (message.id === 1) {
        send({ method: 'initialized', params: {} });
        send({
          id: 2,
          method: 'thread/resume',
          params: { threadId: plan.sessionId },
        });
        return;
      }
      if (message.id === 2) {
        send({
          id: 3,
          method: 'thread/compact/start',
          params: { threadId: plan.sessionId },
        });
        return;
      }
      if (message.method !== 'item/completed' || !isRecord(message.params)) {
        return;
      }
      const item = message.params.item;
      if (isRecord(item) && item.type === 'contextCompaction') succeed();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => void fail(error));
    child.once('close', (code) => {
      if (settled) return;
      // 129 号：取消路径先 await 整组终止并核验，幸存者/不确定 ⇒ 失败关闭。
      void (async () => {
        if (options.signal?.aborted) {
          const outcome = await terminateIsolatedChild(child).catch(
            (error: Error): { outcome: 'unverifiable'; reason: string } => ({ outcome: 'unverifiable', reason: error.message }),
          );
          if (outcome.outcome === 'unverifiable' || outcome.groupAliveAfter) {
            const detail = outcome.outcome === 'unverifiable'
              ? `无法核验后代终止（${outcome.reason}）`
              : '进程组仍有存活后代';
            void fail(new Error(`上下文整理已取消，且${detail}，失败关闭`));
            return;
          }
          void fail(new Error(`${options.adapter.displayName} 上下文整理已取消`));
          return;
        }
        try {
          assertGroupFullyExited(child.pid);
        } catch (groupError) {
          void fail(groupError as Error);
          return;
        }
        fail(new Error(
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

export async function compactCliSession(
  options: CompactCliSessionOptions,
): Promise<CompactCliSessionResult> {
  if (!options.adapter.buildCompactPlan) {
    throw new Error(`${options.adapter.displayName} 暂不支持此操作`);
  }
  if (!options.isolation) {
    throw new Error('compact 必须提供 isolation supplier（IsolationContext 强制入口契约，无 bypass）。');
  }
  const plan = options.adapter.buildCompactPlan(
    options.sessionId,
    options.instructions,
  );
  const prepared = await options.isolation({
    taskId: `compact-${options.sessionId}`,
    purpose: 'task',
    command: plan.command,
    cwd: options.cwd,
  });
  try {
    const result = plan.protocol === 'claude-stream-json'
      ? await runClaudeCompact(plan, options, prepared)
      : await runCodexCompact(plan, options, prepared);
    assertTaskDiffClean(await prepared.finalize());
    return result;
  } catch (error) {
    try {
      assertTaskDiffClean(await prepared.finalize());
    } catch (violation) {
      throw new Error(`${(error as Error).message}\n${(violation as Error).message}`);
    }
    throw error;
  }
}
