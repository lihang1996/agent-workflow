import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CliAdapter, CliEvent, CliRunResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const useProcessGroup = process.platform !== 'win32';

export interface RunCliOptions {
  adapter: CliAdapter;
  prompt: string;
  cwd: string;
  sessionId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: (event: CliEvent) => void;
}

/** 杀掉 CLI 进程组（含孙子进程）。 */
function killProcessTree(child: ChildProcess, sig: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (useProcessGroup) {
      process.kill(-pid, sig);
      return;
    }
  } catch {
    // 进程组不存在时回退杀自身
  }
  try {
    child.kill(sig);
  } catch {
    // 已退出
  }
}

/** 启动 CLI 子进程，解析 stream-json，支持取消/超时。 */
export function runCli(options: RunCliOptions): Promise<CliRunResult> {
  const {
    adapter,
    prompt,
    cwd,
    sessionId,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onEvent,
  } = options;
  const args = sessionId
    ? adapter.buildResumeArgs(prompt, sessionId)
    : adapter.buildArgs(prompt);

  return new Promise((resolve, reject) => {
    // detached 让子进程成为新进程组组长，便于连带杀掉孙子进程。
    const child = spawn(adapter.command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: useProcessGroup,
    });
    const lines = createInterface({ input: child.stdout });
    let observedSessionId = sessionId;
    let finalResult: CliRunResult | undefined;
    let resultError: Error | undefined;
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const onAbort = () => {
      killProcessTree(child, 'SIGTERM');
      // 仍存活则升级 SIGKILL
      setTimeout(() => {
        if (!settled) killProcessTree(child, 'SIGKILL');
      }, 2_000).unref();
    };

    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, 'SIGTERM');
      setTimeout(() => {
        if (!settled) killProcessTree(child, 'SIGKILL');
      }, 2_000).unref();
    }, timeoutMs);

    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      finish();
      reject(error);
    };

    lines.on('line', (line) => {
      const events = adapter.parseEvents(line);
      for (const event of events) {
        if (event.sessionId) observedSessionId = event.sessionId;
        onEvent?.(event);
        if (event.type === 'error') {
          resultError = new Error(event.message);
          continue;
        }
        if (event.type === 'result') {
          finalResult = {
            answer: event.answer,
            sessionId: event.sessionId ?? observedSessionId,
          };
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      if (timedOut) {
        fail(new Error(`${adapter.displayName} 执行超时`));
        return;
      }
      if (signal?.aborted) {
        fail(new Error(`${adapter.displayName} 执行已取消`));
        return;
      }
      fail(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      if (timedOut) {
        return fail(new Error(`${adapter.displayName} 执行超时`));
      }
      if (signal?.aborted) {
        return fail(new Error(`${adapter.displayName} 执行已取消`));
      }
      if (code !== 0) {
        return fail(new Error(
          resultError?.message
          || stderr.trim()
          || `${adapter.displayName} 退出，状态码 ${code}`,
        ));
      }
      if (finalResult) {
        settled = true;
        finish();
        resolve(finalResult);
        return;
      }
      if (resultError) return fail(resultError);
      return fail(new Error(`${adapter.displayName} 没有返回最终结果`));
    });
  });
}
