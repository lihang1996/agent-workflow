import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
  type SpawnOptions,
} from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';

/** 在 Windows 上把子进程连同进程树一起杀掉，避免 cmd 被杀后 claude.exe/codex.exe 变孤儿继续跑。 */
export function killCli(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child.pid) {
    child.kill(signal);
    return;
  }
  if (process.platform !== 'win32') {
    child.kill(signal);
    return;
  }
  spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
    windowsHide: true,
    stdio: 'ignore',
  });
}

export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: ['ignore', 'pipe', 'pipe'] },
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] },
): ChildProcessByStdio<Writable, Readable, Readable>;
export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions & { stdio: SpawnOptions['stdio'] },
): ChildProcessByStdio<any, any, any> {
  if (process.platform !== 'win32') {
    return spawn(command, args, options);
  }
  const invocation = resolveWindowsInvocation(command, args);
  return spawn(invocation.command, invocation.args, {
    ...options,
    shell: false,
    windowsHide: true,
  });
}

/** Resolve standard npm .cmd shims without sending JSON or paths through cmd.exe. */
export function resolveWindowsInvocation(command: string, args: string[], searchPath = process.env.PATH ?? ''): { command: string; args: string[] } {
  const bases = isAbsolute(command) || command.includes('/') || command.includes('\\')
    ? [command]
    : searchPath.split(delimiter).map((dir) => join(dir.replace(/^"|"$/g, ''), command));
  const executable = bases.flatMap((base) => /\.(exe|com|cmd|bat)$/i.test(base)
    ? [base]
    : [`${base}.exe`, `${base}.cmd`, `${base}.bat`, base])
    .find((candidate) => existsSync(candidate));
  if (!executable) throw new Error(`找不到 CLI: ${command}`);
  if (!/\.(cmd|bat)$/i.test(executable)) return { command: executable, args };
  const shim = readFileSync(executable, 'utf8');
  const entry = /"%(?:dp0|~dp0)%?[\\/]([^"\r\n]+\.(?:cjs|mjs|js))"/i.exec(shim)?.[1];
  if (!entry) throw new Error(`不支持此 CLI 批处理启动器：${executable}。请安装官方 npm 版本或配置原生可执行文件。`);
  const script = resolve(dirname(executable), ...entry.split(/[\\/]/));
  if (!existsSync(script)) throw new Error(`CLI 入口不存在：${script}`);
  return { command: process.execPath, args: [script, ...args] };
}
