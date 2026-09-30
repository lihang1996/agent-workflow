import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { ChildProcess, ChildProcessByStdio, SpawnOptions, StdioOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnCli } from '../cli/spawn-cli.js';
import { z } from 'zod';
import { readJsonState, writeJsonState } from './json-state.js';
import {
  assertCapabilityAllowsLaunch,
  computeBinaryFingerprint,
  computeIsolationCapabilityIdentity,
  type IsolationCapabilityReader,
} from './isolation-capability.js';
import {
  baselineDiffClean,
  diffWorkspaceBaseline,
  persistWorkspaceBaseline,
  takeWorkspaceBaseline,
  type WorkspaceBaseline,
  type WorkspaceBaselineDiff,
} from './workspace-baseline.js';

/**
 * T-022 统一隔离启动边界（G-W6b-FIX，100 号修订版 §2）：
 *
 * **强制入口契约**：任何真实 CLI 启动（任务 fresh/resume/recreate、native
 * compact、引擎版本/参数面探测、会话列表）都必须经由 `launchIsolated`，且
 * 携带不可省略的 `IsolationContext`；`spawnCli` 仅作为本模块内部 choke point
 * 的底层实现，业务层禁止裸用（tests/isolation-wiring.test.ts 做静态断言）。
 *
 * 失败关闭（无 bypass）：
 * - Windows 一律 blocked；
 * - 受保护根清单缺失/空/不可核验 ⇒ blocked（清单只能由受信服务端维护）；
 * - 能力库无当前环境键的「读+写双 passed」canary 证据 ⇒ blocked
 *   （G-W6b-CANARY 未执行，生产库为空 ⇒ **当前一切真实 CLI 启动均 blocked**）；
 * - 允许路径窄化：拒绝 `'.'`、工作区根及等价别名、任何待复核/不存在的路径；
 * - fixture 写探针只在**唯一临时 fixture** 内运行（不触碰真实工作区/授权路径）。
 *
 * 本模块放 `src/core/`（而非架构稿的 `src/cli/sandbox.ts`）：engine-runtime
 * 等 core 模块也要经此边界启动，避免 core→cli 反向依赖；差异在报告中登记。
 */

export type IsolationPurpose = 'task' | 'probe' | 'session-list';

/** 受信服务端维护的版本化受保护根清单（realpath 绝对路径）。 */
export interface IsolationProtectedRoots {
  version: string;
  roots: string[];
}

export interface IsolationNarrowPath {
  /** 工作区相对 POSIX 路径（窄子路径，不得为 '.'）。 */
  relative: string;
  realpath: string;
}

export interface IsolationContext {
  taskId: string;
  purpose: IsolationPurpose;
  /** 引擎可执行命令（capability 键组成部分）。 */
  command: string;
  cwd: string;
  /** 服务端独占创建的任务 scratch（realpath）；profile 中唯一默认可写子树。 */
  scratchDir: string;
  /** 仅编码任务：已核验的窄允许路径（不含 scratch）。 */
  allowedPaths: IsolationNarrowPath[];
  protectedRoots: IsolationProtectedRoots;
  /** purpose='task' 必填。 */
  baselineId?: string;
}

export interface IsolationHarness {
  capabilityStore: IsolationCapabilityReader;
  /** 默认 'sandbox-exec'。 */
  sandboxExecCommand?: string;
  /** fixture 写探针（可注入；默认真实实现只在临时 fixture 内运行）。 */
  probeFixture?: (profile: string) => Promise<{ ok: boolean; reason?: string }>;
  /** spawn 实现（可注入；默认 spawnCli）。 */
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** 白名单环境来源（默认 process.env；测试注入受控环境）。 */
  envBase?: NodeJS.ProcessEnv;
  /**
   * A03：引擎二进制真实路径（realpath 后）与 `--version` 输出。两者**必须同时
   * 提供**（只给其一属调用方错误，失败关闭）；齐备时 prepare 计算指纹并纳入
   * 能力身份——二进制被替换/升级后旧证据查不到，须重新 canary。
   */
  binaryRealPath?: string;
  binaryVersion?: string;
  /**
   * 受信服务端的额外环境注入（如未来 V-5 验证后的 CLAUDE_CONFIG_DIR 重定向）。
   * 以 scratch 为入参的函数（值常依赖随机 scratch 路径）；仅受信代码可设置，
   * 不得用于传递凭据/KB 配置。
   */
  extraEnv?: (scratchDir: string) => Record<string, string>;
  /** 平台判定（默认 process.platform）。 */
  platform?: NodeJS.Platform;
}

export type PreparedIsolation = {
  harness: IsolationHarness;
  context: IsolationContext;
  profile: string;
  env: NodeJS.ProcessEnv;
  capabilityKey: string;
  /** 任务 scratch 相对工作区 realpath 的 POSIX 路径（制品约束/基线例外用）。 */
  scratchRelative?: string;
  /** 任务收尾差异判读（purpose='task'）；其余 purpose 为 no-op。 */
  finalize: () => Promise<WorkspaceBaselineDiff | undefined>;
  /**
   * 149 号 P2-1：ephemeral scratch（probe/session-list）的明确所有者清理。
   * 只能在**进程及后代已核实退出后**由启动方调用；只删本 prepare 自建目录。
   */
  dispose: () => { disposed: boolean; kept?: string };
  /** 诊断视图：尚未清理的 ephemeral scratch（task 恒 undefined）。 */
  pendingEphemeralScratch?: string;
};

export interface IsolationPrepareInput {
  taskId: string;
  purpose: IsolationPurpose;
  command: string;
  cwd: string;
  /**
   * T-021 已核验的编码授权（119 号 P1-3）：id 与**精确**相对允许路径一起传入，
   * 绑定进能力身份与 profile；未授权任务（设计/产品/探测/compact）两者皆空
   * ⇒ 零代码写权限（profile 只放行 scratch）。
   */
  authorizationId?: string;
  allowedRelatives?: readonly string[];
}

export type IsolationSupplier = (input: IsolationPrepareInput) => Promise<PreparedIsolation>;

// ---- 受保护根清单 --------------------------------------------------------------

const ProtectedRootsSchema = z.object({
  version: z.string().min(1).max(64),
  roots: z.array(z.string().min(1)).min(1),
}).strict();

/** 清单只能由受信服务端维护；缺失/空/不可核验即 blocked（修订版 §2.3）。 */
export function loadProtectedRoots(filePath = join('data', 'isolation-protected-roots.json')): IsolationProtectedRoots {
  const state = readJsonState(filePath);
  if (state === undefined) {
    throw new Error(`隔离失败关闭：受保护根清单缺失（${filePath}）；由受信服务端创建并核验前，一切真实 CLI 启动保持 blocked。`);
  }
  const parsed = ProtectedRootsSchema.parse(state);
  const realRoots: string[] = [];
  for (const root of parsed.roots) {
    const real = realpathSync(root);
    realRoots.push(real);
  }
  return { version: parsed.version, roots: realRoots };
}

// ---- 任务 scratch ---------------------------------------------------------------

/**
 * 服务端独占创建的任务 scratch：workspaceDir 下 `.aos-scratch-<taskId>-<rand>`
 * 唯一子目录（0700，独占创建；realpath 必须仍在工作区 realpath 内——父链被
 * 换成指向外部的符号链接即失败关闭）。返回 { dir（绝对词面）, realpath,
 * relative（相对工作区 realpath 的 POSIX 路径，用于基线例外） }。
 */
export function createTaskScratch(workspaceDir: string, taskId: string): {
  dir: string; realpath: string; relative: string;
} {
  const workspaceReal = realpathSync(workspaceDir);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = randomBytes(8).toString('hex');
    const safeTask = taskId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48) || 'task';
    const dir = join(workspaceReal, `.aos-scratch-${safeTask}-${suffix}`);
    let created = false;
    try {
      mkdirSync(dir, { recursive: false, mode: 0o700 });
      created = true;
      const real = realpathSync(dir);
      const rel = relative(workspaceReal, real);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error('隔离失败关闭：任务 scratch 解析后越出工作区（父链被替换？）');
      }
      return { dir: real, realpath: real, relative: rel.split(sep).join('/') };
    } catch (error) {
      // 138 号 P2-6：创建函数对自建目录负责——mkdir 之后的任何校验失败，
      // 只清理本次独占创建的这个目录（绝不触碰未知目录）。
      if (created) rmSync(dir, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('隔离失败关闭：无法创建唯一任务 scratch（连续冲突）');
}

/** 服务端自有的临时 scratch（probe / session-list 用，不落在用户工作区）。 */
export function createEphemeralScratch(purpose: string): string {
  return mkdtempSync(join(tmpdir(), `agent-os-iso-${purpose}-`));
}

// ---- 允许路径窄化 ----------------------------------------------------------------

/**
 * W6b 使用门（修订版 §2.3）：只接受**明确、现存、真实路径仍在工作区内**的窄
 * 子路径。拒绝 `'.'`、工作区根及等价别名（realpath 相同）、任何不存在/待复核
 * 叶子（含历史 active 记录里的 pendingPathRecheck 路径——由调用方传入前自查，
 * 这里再以「必须存在」兜底）。绝不把现存祖先当作窄路径的替身。
 */
export function assertNarrowAllowedPaths(options: {
  workspaceDir: string;
  allowedRelatives: readonly string[];
}): IsolationNarrowPath[] {
  const workspaceReal = realpathSync(options.workspaceDir);
  if (options.allowedRelatives.length === 0) return [];
  const result: IsolationNarrowPath[] = [];
  for (const raw of options.allowedRelatives) {
    const value = raw.trim();
    if (!value) throw new Error('允许路径窄化失败：空路径');
    if (value === '.' || isAbsolute(value) || value.includes('\\') || value.includes('\0')
      || value.split('/').some((segment) => segment === '..' || segment === '')) {
      throw new Error(`允许路径窄化失败：拒绝工作区根/绝对路径/越界段: ${raw}`);
    }
    const absolute = join(workspaceReal, value);
    const real = realpathSync(absolute);
    const rel = relative(workspaceReal, real);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`允许路径窄化失败：${raw} 解析为工作区根本身或越出工作区`);
    }
    if (real === workspaceReal) {
      throw new Error('允许路径窄化失败：拒绝工作区根等价路径');
    }
    result.push({ relative: rel.split(sep).join('/'), realpath: real });
  }
  return result;
}

/**
 * 制品路径约束（修订版 §5 / 138 号 P1-4 / 149 号 P1-6）：本地制品
 * （spec/tickets/design）必须真实位于本任务 scratch 子树——先做**词面规范
 * 化**（拒绝 `.`/`..`/绝对路径/反斜杠/NUL/空段，杜绝 `scratch/../outside`
 * 前缀绕过），再做 resolve 包含检查，最后做 **realpath 身份复核**（symlink
 * 逃逸拒绝）。**workspaceDir 必填**：realpath 分支是本 guard 的组成部分，
 * 不得以「后续 snapshot 也会拒绝」为由省略。
 */
export function assertArtifactRequestWithinScratch(
  request: { deliveryMode: string; specPath?: string; ticketsPath?: string; designPath?: string },
  scratchRoot: string,
  workspaceDir: string,
): void {
  if (request.deliveryMode !== 'local') return;
  const normalizedScratch = normalizeScratchRelative(scratchRoot);
  const workspaceReal = realpathSync(workspaceDir);
  const scratchReal = resolve(workspaceReal, normalizedScratch);
  const within = (raw: string | undefined, label: string): void => {
    if (raw === undefined) return;
    const value = raw.trim();
    if (!value) throw new Error(`本地制品 ${label} 路径为空，拒绝。`);
    if (isAbsolute(value) || value.includes('\\') || value.includes('\0')
      || value.split('/').some((segment) => segment === '..' || segment === '')) {
      throw new Error(`本地制品 ${label} 含绝对路径/越界段/反斜杠，拒绝: ${raw}`);
    }
    // 词面包含：规范化后必须位于 scratch 前缀内（段感知，拒绝 `scratch/../x`）。
    const normalized = value.split('/').filter((segment) => segment !== '.').join('/');
    if (normalized !== normalizedScratch && !normalized.startsWith(`${normalizedScratch}/`)) {
      throw new Error(`本地制品 ${label} 必须位于任务 scratch（${normalizedScratch}/）内，拒绝: ${raw}`);
    }
    // realpath 身份复核：路径已存在时，symlink 指向 scratch 外 ⇒ 本 guard
    // 直接拒绝（不依赖后续 snapshot）；不存在则由词面/resolve 检查兜底。
    const resolved = resolve(workspaceReal, normalized);
    if (existsSync(resolved)) {
      const real = realpathSync(resolved);
      const relFromScratch = relative(scratchReal, real);
      if (relFromScratch === '..' || relFromScratch.startsWith(`..${sep}`) || isAbsolute(relFromScratch)) {
        throw new Error(`本地制品 ${label} 解析后越出任务 scratch（symlink 逃逸），拒绝: ${raw}`);
      }
    }
  };
  within(request.specPath, 'specPath');
  within(request.ticketsPath, 'ticketsPath');
  within(request.designPath, 'designPath');
}

function normalizeScratchRelative(scratchRoot: string): string {
  const value = scratchRoot.trim();
  if (!value || isAbsolute(value) || value.includes('\\')
    || value.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new Error(`任务 scratch 根不合法: ${scratchRoot}`);
  }
  return value.split('/').filter((segment) => segment !== '.').join('/');
}

// ---- profile（纯函数） -----------------------------------------------------------

export interface IsolationProfileInput {
  scratchRealpath: string;
  allowedPathRealpaths: readonly string[];
  protectedRootRealpaths: readonly string[];
}

/** seatbelt 字面量转义：subpath 只接受字面绝对路径（禁止正则 `^`，13 号 C3）。 */
function seatbeltLiteral(path: string): string {
  if (path.includes('\0') || path.includes('\n')) {
    throw new Error(`profile 路径含非法字符（NUL/换行），失败关闭: ${JSON.stringify(path)}`);
  }
  return path.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export function buildIsolationProfile(input: IsolationProfileInput): string {
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (subpath "${seatbeltLiteral(input.scratchRealpath)}"))`,
  ];
  for (const allowed of input.allowedPathRealpaths) {
    lines.push(`(allow file-write* (subpath "${seatbeltLiteral(allowed)}"))`);
  }
  for (const root of input.protectedRootRealpaths) {
    lines.push(`(deny file-read-data (subpath "${seatbeltLiteral(root)}"))`);
  }
  return lines.join('\n');
}

// ---- 任务环境（空白构建 + 白名单） -------------------------------------------------

const TASK_ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM'] as const;
/** adapter.buildEnv 的逐键白名单（现仅工具授权标签）。 */
export const ADAPTER_ENV_ALLOWLIST = ['AGENT_OS_ALLOWED_TOOLS'] as const;

export function buildTaskEnv(options: {
  scratchDir: string;
  envBase?: NodeJS.ProcessEnv;
  adapterEnv?: Record<string, string | undefined>;
  extra?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const base = options.envBase ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const key of TASK_ENV_ALLOWLIST) {
    const value = base[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  // HOME/TMPDIR/XDG 从不从 envBase 继承（不在白名单），一律重定向到任务 scratch：
  // 模型工具可读的环境里不得出现用户全局状态目录。
  env.HOME = join(options.scratchDir, 'home');
  env.TMPDIR = join(options.scratchDir, 'tmp');
  env.XDG_CONFIG_HOME = join(options.scratchDir, 'xdg', 'config');
  env.XDG_CACHE_HOME = join(options.scratchDir, 'xdg', 'cache');
  env.XDG_DATA_HOME = join(options.scratchDir, 'xdg', 'data');
  for (const dir of [env.HOME, env.TMPDIR, env.XDG_CONFIG_HOME!, env.XDG_CACHE_HOME!, env.XDG_DATA_HOME!]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // adapter env 逐键白名单；敏感/未知键拒绝（不从 process.env 合并任何东西回来）。
  for (const [key, value] of Object.entries(options.adapterEnv ?? {})) {
    if (!(ADAPTER_ENV_ALLOWLIST as readonly string[]).includes(key)) {
      throw new Error(`adapter 环境变量不在白名单，拒绝注入: ${key}`);
    }
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    env[key] = value;
  }
  return env;
}

/** 启动前把 adapter.buildEnv 合入任务环境（同样的逐键白名单校验）。 */
export function applyAdapterEnv(
  env: NodeJS.ProcessEnv,
  adapterEnv: Record<string, string | undefined> | undefined,
): NodeJS.ProcessEnv {
  for (const [key, value] of Object.entries(adapterEnv ?? {})) {
    if (!(ADAPTER_ENV_ALLOWLIST as readonly string[]).includes(key)) {
      throw new Error(`adapter 环境变量不在白名单，拒绝注入: ${key}`);
    }
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// ---- fixture 写探针（只在唯一临时 fixture 内） -----------------------------------

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  fixtureRoot?: string;
}

/**
 * profile 语义预检（修订版 §2.2/§8）：在**本轮唯一 mkdtemp fixture** 内构造
 * **等价策略**（与真实 profile 同形：scratch/protected 指向 fixture 副本），
 * 驱动 `sandbox-exec /bin/sh` 三类尝试：scratch 写必须成功、protected 写与读
 * 必须被拒（退出码 + 实际落盘双重判读）。**不触碰真实工作区、授权路径或
 * 项目根**；sandbox-exec 不可用（spawn ENOENT）⇒ {ok:false} ⇒ 启动 blocked。
 */
export async function preflightFixtureProbe(options: {
  sandboxExecCommand?: string;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
} = {}): Promise<PreflightResult> {
  const spawn = options.spawn ?? spawnCli;
  const sandboxExec = options.sandboxExecCommand ?? 'sandbox-exec';
  // macOS TMPDIR（/var/folders/...）是指向 /private/var/... 的符号链接：seatbelt
  // subpath 匹配的是进程实际访问的解析路径——未经 realpath 的词面路径会让
  // scratch 允许区永不命中，预检在任何默认环境 macOS 上必然失败关闭。
  const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agent-os-iso-preflight-')));
  try {
    const scratch = join(fixtureRoot, 'scratch');
    const protectedRoot = join(fixtureRoot, 'protected');
    mkdirSync(scratch, { recursive: true });
    mkdirSync(protectedRoot, { recursive: true });
    mkdirSync(join(protectedRoot, 'kb'), { recursive: true });
    const { writeFileSync: writeFixtureFile } = await import('node:fs');
    writeFixtureFile(join(protectedRoot, 'kb', 'sentinel.txt'), 'preflight-sentinel');
    const profile = buildIsolationProfile({
      scratchRealpath: scratch,
      allowedPathRealpaths: [],
      protectedRootRealpaths: [protectedRoot],
    });
    const runSh = (script: string): Promise<{ code: number | null; stdout: string; error?: string }> =>
      new Promise((resolve) => {
        let child: import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, import('node:stream').Readable>;
        try {
          child = spawn(sandboxExec, ['-p', profile, '--', '/bin/sh', '-c', script], {
            stdio: ['ignore', 'pipe', 'pipe'],
          }) as typeof child;
        } catch (error) {
          resolve({ code: null, stdout: '', error: (error as Error).message });
          return;
        }
        let stdout = '';
        let spawnError = '';
        child.stdout.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
        child.once('error', (error: Error) => { spawnError = error.message; });
        child.once('close', (code) => {
          resolve({ code, stdout, error: spawnError || undefined });
        });
      });
    const scratchWrite = await runSh(`echo ok > ${shellQuote(join(scratch, 'w.txt'))}`);
    const protectedWrite = await runSh(`echo bad > ${shellQuote(join(protectedRoot, 'w.txt'))} 2>/dev/null; echo code=$?`);
    const protectedRead = await runSh(`cat ${shellQuote(join(protectedRoot, 'kb', 'sentinel.txt'))} >/dev/null 2>&1; echo code=$?`);
    if (scratchWrite.code !== 0) {
      return { ok: false, reason: `fixture scratch 写失败（${scratchWrite.error ?? `code=${scratchWrite.code}`}）`, fixtureRoot };
    }
    if (!/code=[^0]/.test(protectedWrite.stdout) || existsSync(join(protectedRoot, 'w.txt'))) {
      return { ok: false, reason: `fixture protected 写未被拒绝（stdout=${protectedWrite.stdout.trim()}）`, fixtureRoot };
    }
    if (!/code=[^0]/.test(protectedRead.stdout)) {
      return { ok: false, reason: `fixture protected 读未被拒绝（stdout=${protectedRead.stdout.trim()}）`, fixtureRoot };
    }
    return { ok: true, fixtureRoot };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// ---- 隔离启动 ---------------------------------------------------------------------

export interface LaunchIsolatedOptions {
  stdio?: StdioOptions;
}

export function launchIsolated(
  prepared: PreparedIsolation,
  args: readonly string[],
  options: LaunchIsolatedOptions & { stdio: ['ignore', 'pipe', 'pipe'] },
): ChildProcessByStdio<null, Readable, Readable>;
export function launchIsolated(
  prepared: PreparedIsolation,
  args: readonly string[],
  options: LaunchIsolatedOptions & { stdio: ['pipe', 'pipe', 'pipe'] },
): ChildProcessByStdio<Writable, Readable, Readable>;
export function launchIsolated(
  prepared: PreparedIsolation,
  args: readonly string[],
  options?: LaunchIsolatedOptions,
): ChildProcess;
/**
 * 统一隔离启动：Windows blocked → 同步能力复核（读+写双 passed；probe 与
 * 基线已在 prepareIsolation 按序完成）→ `sandbox-exec -p <profile> --
 * <command> <args...>`（经 spawnCli choke point）。返回子进程句柄，行为与
 * 直接 spawn 等价（调用方复用既有 stdio/kill 逻辑）。
 */
export function launchIsolated(
  prepared: PreparedIsolation,
  args: readonly string[],
  options: LaunchIsolatedOptions = {},
): ChildProcess {
  const platform = prepared.harness.platform ?? process.platform;
  if (platform === 'win32') {
    throw new Error('Windows 平台无 sandbox-exec 隔离，默认 blocked（不提供跳过开关）。');
  }
  assertCapabilityAllowsLaunch(prepared.harness.capabilityStore, prepared.capabilityKey);
  // 注入 spawn 与 spawnCli 重载并集在此收窄为单一通用签名（stdio 恒显式传入）。
  const spawn = (prepared.harness.spawn ?? spawnCli) as (
    command: string,
    args: string[],
    options: SpawnOptions & { stdio: StdioOptions },
  ) => ChildProcess;
  const sandboxExec = prepared.harness.sandboxExecCommand ?? 'sandbox-exec';
  // detached ⇒ 子进程自成进程组（pgid = wrapper pid）：取消/超时/异常时对整组
  // SIGTERM/SIGKILL（terminateIsolatedChild），**不向 spawn 传 AbortSignal**——
  // Node 的 signal 只杀直接子进程（wrapper），会让 CLI/后端变孤儿逃逸收尾。
  return spawn(
    sandboxExec,
    ['-p', prepared.profile, '--', prepared.context.command, ...args],
    {
      cwd: prepared.context.cwd,
      env: prepared.env,
      stdio: options.stdio ?? 'pipe',
      detached: true,
    },
  );
}

// ---- 隔离进程组收尾（119 号 P1-2） ------------------------------------------------

export interface ProcessGroupSnapshot {
  ok: boolean;
  pids: number[];
  error?: string;
}

export type ProcessGroupLiveness =
  | { ok: true; alive: boolean }
  | { ok: false; error: string };

/**
 * 进程组存活核验（129 号）：`kill(-pgid, 0)` 纯 syscall——组内任一进程存活
 * ⇒ alive=true；ESRCH ⇒ 全组已退；EPERM ⇒ 目标存在但无权发信号 ⇒ 存活。
 * 不依赖 ps（宿主沙箱可能对 ps 枚举 EPERM，会误把「无法枚举」当结论）。
 */
export function isProcessGroupAlive(pgid: number): ProcessGroupLiveness {
  if (!pgid || process.platform === 'win32') {
    return { ok: false, error: `无法核验进程组（pgid=${pgid}）` };
  }
  try {
    process.kill(-pgid, 0);
    return { ok: true, alive: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { ok: true, alive: false };
    if (code === 'EPERM') return { ok: true, alive: true };
    return { ok: false, error: `kill(-pgid,0) 失败: ${(error as Error).message}` };
  }
}

/**
 * 枚举进程组成员（`ps -eo pid=,pgid=`，仅诊断补充）。ps 不可用 ⇒ {ok:false}。
 */
export function listProcessGroup(pgid: number): ProcessGroupSnapshot {
  if (!pgid || process.platform === 'win32') {
    return { ok: false, pids: [], error: `无法核验进程组（pgid=${pgid}）` };
  }
  try {
    const result = spawnSync('ps', ['-eo', 'pid=,pgid='], { encoding: 'utf8', timeout: 10_000 });
    if (result.error || result.status !== 0) {
      return { ok: false, pids: [], error: `ps 枚举失败: ${result.error?.message ?? `status=${result.status}`}` };
    }
    const pids: number[] = [];
    for (const line of (result.stdout ?? '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [pidText, pgidText] = trimmed.split(/\s+/);
      if (Number(pgidText) === pgid && Number.isFinite(Number(pidText))) {
        pids.push(Number(pidText));
      }
    }
    return { ok: true, pids };
  } catch (error) {
    return { ok: false, pids: [], error: (error as Error).message };
  }
}

async function waitFor(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export type TerminateIsolatedChildOutcome =
  | { outcome: 'terminated'; groupAliveAfter: boolean }
  | { outcome: 'unverifiable'; reason: string };

/**
 * 终止隔离进程组并核验后代全部退出（SIGTERM → 宽限 → SIGKILL → 复核）。
 * wrapper（sandbox-exec）退出不代表 CLI/后端退出——以**进程组存活 syscall**
 * 为准；无法核验返回 unverifiable，调用方失败关闭。
 */
export async function terminateIsolatedChild(
  child: Pick<ChildProcess, 'pid'>,
  options: { termGraceMs?: number; killGraceMs?: number } = {},
): Promise<TerminateIsolatedChildOutcome> {
  const pgid = child.pid;
  if (!pgid) return { outcome: 'unverifiable', reason: '子进程无 pid' };
  if (process.platform === 'win32') {
    return { outcome: 'unverifiable', reason: 'Windows 无进程组核验（本就 blocked）' };
  }
  const termGraceMs = options.termGraceMs ?? 2_000;
  const killGraceMs = options.killGraceMs ?? 1_500;
  const groupGone = (): boolean | string => {
    const liveness = isProcessGroupAlive(pgid);
    if (!liveness.ok) return liveness.error;
    return !liveness.alive;
  };
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch { /* ESRCH：组已不存在 */ }
  const deadline = Date.now() + termGraceMs;
  while (Date.now() < deadline) {
    const gone = groupGone();
    if (typeof gone === 'string') return { outcome: 'unverifiable', reason: gone };
    if (gone) return { outcome: 'terminated', groupAliveAfter: false };
    await waitFor(100);
  }
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch { /* ESRCH */ }
  const killDeadline = Date.now() + killGraceMs;
  while (Date.now() < killDeadline) {
    const gone = groupGone();
    if (typeof gone === 'string') return { outcome: 'unverifiable', reason: gone };
    if (gone) return { outcome: 'terminated', groupAliveAfter: false };
    await waitFor(100);
  }
  const final = groupGone();
  if (typeof final === 'string') return { outcome: 'unverifiable', reason: final };
  return { outcome: 'terminated', groupAliveAfter: !final };
}

/**
 * 子进程已退出后的核验：进程组内不得再有存活成员（后端/CLI 不得比 wrapper
 * 活得长）。无法核验或存在幸存者 ⇒ 抛错（失败关闭），尽力附幸存 pid 供诊断。
 */
export function assertGroupFullyExited(pgid: number | undefined): void {
  if (!pgid) throw new Error('隔离子进程无 pid，无法核验进程组，失败关闭。');
  const liveness = isProcessGroupAlive(pgid);
  if (!liveness.ok) {
    throw new Error(`无法核验隔离进程组（${liveness.error}），失败关闭。`);
  }
  if (liveness.alive) {
    const snapshot = listProcessGroup(pgid);
    const detail = snapshot.ok && snapshot.pids.length > 0
      ? `pids=${snapshot.pids.join(',')}`
      : '组内仍有存活进程（无法枚举 pid）';
    throw new Error(`隔离进程组仍有存活后代（${detail}），wrapper 退出不代表 CLI/后端退出，任务判失败。`);
  }
}

// ---- prepare（组装 IsolationContext；顺序按修订版 §6） -----------------------------

export async function prepareIsolation(options: {
  input: IsolationPrepareInput;
  harness: IsolationHarness;
  protectedRoots: IsolationProtectedRoots;
  baselineStoreDir?: string;
  gitStatus?: (cwd: string) => Promise<string[] | undefined>;
  probeFixture?: IsolationHarness['probeFixture'];
}): Promise<PreparedIsolation> {
  const { input, harness } = options;
  if ((harness.platform ?? process.platform) === 'win32') {
    throw new Error('Windows 平台无 sandbox-exec 隔离，默认 blocked。');
  }
  // 受保护根必须规范化（realpath）后才能进 seatbelt deny 规则：未经解析的
  // 词面路径（如 macOS /var → /private/var 符号链接）与进程实际访问的解析路径
  // 不匹配，deny file-read-data 会静默失效（fail-open）。loadProtectedRoots
  // 已做解析；直接传 roots 的调用路径（fixture/未来服务端）在此兜底。
  // 不存在的根保留词面（契约允许——测试以不存在路径构造失败/成功路径；生产
  // 加载器在 load 时即要求存在并解析）。
  const protectedRoots: IsolationProtectedRoots = {
    version: options.protectedRoots.version,
    roots: options.protectedRoots.roots.map((root) => {
      try {
        return realpathSync(root);
      } catch {
        return root;
      }
    }),
  };
  const cwdReal = realpathSync(input.cwd);
  // 1) 能力核验（119 号 P1-1：**先失败关闭，后创建任何目录**）。能力身份不含
  //    随机 scratch——同一写策略（none 或同一授权记录的精确范围）跨任务可
  //    命中同一证据；不同授权/宽窄互不匹配。无证据 ⇒ 此处抛错，用户工作区
  //    不留任何痕迹。
  //    A03：harness 提供引擎二进制真实路径 + --version 输出时，指纹纳入身份
  //    （只给其一属调用方错误，失败关闭；都不给 = 沿用无指纹身份，证据文件
  //    中一旦存在带指纹的键，无指纹身份自然查不到，不会 fail-open）。
  let binaryFingerprint: string | undefined;
  if (harness.binaryRealPath !== undefined || harness.binaryVersion !== undefined) {
    if (!harness.binaryRealPath || !harness.binaryVersion) {
      throw new Error('隔离失败关闭：binaryRealPath 与 binaryVersion 必须同时提供（A03 能力身份校验）。');
    }
    binaryFingerprint = computeBinaryFingerprint({
      binaryRealPath: harness.binaryRealPath,
      versionOutput: harness.binaryVersion,
    });
  }
  const capabilityKey = computeIsolationCapabilityIdentity({
    command: input.command,
    purpose: input.purpose,
    protectedRootsVersion: protectedRoots.version,
    writePolicy: describeWritePolicy(input),
    platform: harness.platform ?? process.platform,
    ...(binaryFingerprint !== undefined ? { binaryFingerprint } : {}),
  });
  assertCapabilityAllowsLaunch(harness.capabilityStore, capabilityKey);
  // 2) scratch 创建；此后任何失败只清理**本次独占创建**的目录（此时尚无任何
  //    子进程，不存在后代使用；绝不触碰未知目录）。
  let scratchCreated: string | undefined;
  try {
    let scratchRealpath: string;
    let scratchRelative: string | undefined;
    if (input.purpose === 'task') {
      const scratch = createTaskScratch(input.cwd, input.taskId);
      scratchRealpath = scratch.realpath;
      scratchRelative = scratch.relative;
      scratchCreated = scratch.realpath;
    } else {
      const ephemeral = createEphemeralScratch(input.purpose);
      scratchRealpath = realpathSync(ephemeral);
      scratchCreated = scratchRealpath;
    }
    // 3) 窄允许路径（真实 FS 核验：拒绝 '.'/根别名/缺失叶子/越界）。
    const allowedPaths = input.allowedRelatives && input.allowedRelatives.length > 0
      ? assertNarrowAllowedPaths({ workspaceDir: input.cwd, allowedRelatives: input.allowedRelatives })
      : [];
    // 4) 绑定 profile / env（单次运行的完整 profile 仍逐字面生成与核验）。
    const profile = buildIsolationProfile({
      scratchRealpath,
      allowedPathRealpaths: allowedPaths.map((path) => path.realpath),
      protectedRootRealpaths: protectedRoots.roots,
    });
    const env = buildTaskEnv({
      scratchDir: scratchRealpath,
      envBase: harness.envBase,
      extra: harness.extraEnv?.(scratchRealpath),
    });
    // 5) fixture 写探针（等价策略，只在唯一临时 fixture 内；可用 harness 注入）。
    const probe = options.probeFixture ?? harness.probeFixture ?? (() => preflightFixtureProbe({
      sandboxExecCommand: harness.sandboxExecCommand,
      spawn: harness.spawn,
    }));
    const probeResult = await probe(profile);
    if (!probeResult.ok) {
      throw new Error(`隔离预检失败（fixture 写探针）：${probeResult.reason ?? '未知原因'}；本次启动 blocked。`);
    }
    // 6) 任务基线（完整扫描 + scratch/授权路径精确例外；incomplete/持久化失败 ⇒ 失败关闭）。
    let baseline: WorkspaceBaseline | undefined;
    let baselineId: string | undefined;
    if (input.purpose === 'task') {
      baseline = await takeWorkspaceBaseline({
        workspaceDir: input.cwd,
        scratchExceptions: [scratchRelative!],
        allowedExceptions: allowedPaths.map((path) => path.relative),
        ...(options.gitStatus ? { gitStatus: options.gitStatus } : {}),
      });
      if (baseline.incomplete) {
        throw new Error(`任务基线不完整（${baseline.incompleteReason ?? '未知'}），启动失败关闭。`);
      }
      baselineId = `bl-${input.taskId}-${randomBytes(6).toString('hex')}`;
      if (options.baselineStoreDir) {
        try {
          persistWorkspaceBaseline(join(options.baselineStoreDir, `${baselineId}.json`), baseline);
        } catch (error) {
          throw new Error(`任务基线持久化失败（${(error as Error).message}），失败关闭，不冒充已建立可审计基线。`);
        }
      }
    }
    const context: IsolationContext = {
      taskId: input.taskId,
      purpose: input.purpose,
      command: input.command,
      cwd: cwdReal,
      scratchDir: scratchRealpath,
      allowedPaths,
      protectedRoots,
      ...(baselineId ? { baselineId } : {}),
    };
    let finalized = false;
    let disposed = false;
    return {
      harness,
      context,
      profile,
      env,
      capabilityKey,
      ...(scratchRelative ? { scratchRelative } : {}),
      finalize: async () => {
        if (finalized || input.purpose !== 'task' || !baseline) return undefined;
        finalized = true;
        return diffWorkspaceBaseline({
          baseline,
          workspaceDir: input.cwd,
          ...(options.gitStatus ? { gitStatus: options.gitStatus } : {}),
        });
      },
      /**
       * P2-1（149 号）：非 task（probe/session-list）的 ephemeral scratch
       * 由**明确所有者**（启动方）在**进程及后代已核实退出后**调用本方法清理；
       * 只删除本 prepare 独占创建的目录，幂等。调用方无法核验后代退出时**不得
       * 调用**（保留诊断，不盲删）。task scratch 不归本方法管（任务基线生命周期）。
       */
      dispose: (): { disposed: boolean; kept?: string } => {
        if (disposed) return { disposed: false };
        disposed = true;
        if (input.purpose === 'task' || !scratchCreated) return { disposed: false };
        rmSync(scratchCreated, { recursive: true, force: true });
        return { disposed: true };
      },
      /** 诊断视图：尚未清理的 ephemeral scratch 路径（task 恒 undefined）。 */
      pendingEphemeralScratch: input.purpose === 'task' ? undefined : scratchCreated,
    };
  } catch (error) {
    if (scratchCreated) {
      rmSync(scratchCreated, { recursive: true, force: true });
    }
    throw error;
  }
}

/**
 * 写策略描述（进入能力身份）：无授权 ⇒ 'none'（设计/产品/探测/compact 等
 * 零代码写）；授权 ⇒ 绑定授权记录 id + 其精确相对允许路径摘要。带路径却缺
 * 授权 id 属调用方错误，失败关闭。
 */
function describeWritePolicy(input: IsolationPrepareInput): string {
  if (!input.authorizationId) {
    if (input.allowedRelatives && input.allowedRelatives.length > 0) {
      throw new Error('隔离失败关闭：携带允许路径却缺少授权记录 id（allowedRelatives 必须来自已核验的编码授权）。');
    }
    return 'none';
  }
  const digest = createHash('sha256')
    .update([...new Set(input.allowedRelatives ?? [])].sort().join('\n'))
    .digest('hex');
  return `auth:${input.authorizationId}:${digest}`;
}

/** 任务收尾判定：任务外 added/modified/removed 必须为空（scratch 内除外）。 */
export function assertTaskDiffClean(diff: WorkspaceBaselineDiff | undefined): void {
  if (!diff) return;
  if (!baselineDiffClean(diff)) {
    const summary = [
      diff.added.length ? `新增 ${diff.added.length}` : '',
      diff.modified.length ? `修改 ${diff.modified.length}` : '',
      diff.removed.length ? `删除 ${diff.removed.length}` : '',
    ].filter(Boolean).join('、');
    throw new Error(`任务外变更检出（${summary}；样例 added=${diff.added[0] ?? '-'} modified=${diff.modified[0] ?? '-'} removed=${diff.removed[0] ?? '-'}），违反写隔离判据，任务判失败。`);
  }
}

// ---- 生产 preparer（默认 = 全部 blocked 的失败关闭实现） ---------------------------

/**
 * 生产隔离 preparer：受保护根清单 + 只读能力库（G-W6b-CANARY 未执行 ⇒ 库为空
 * ⇒ 一切真实 CLI 启动在能力核验处失败关闭）。任何生产入口不得绕过它提供
 * 「宽松」实现；测试 fixture 自行构造 harness（见 tests/isolation-*.test.ts）。
 */
export function createProductionIsolationPreparer(overrides: {
  capabilityFilePath?: string;
  protectedRootsFilePath?: string;
  baselineStoreDir?: string;
} = {}): IsolationSupplier {
  // 惰性加载：坏文件在首次真实启动时失败关闭，而非 import 时崩溃。
  let capabilityStore: IsolationCapabilityReader | undefined;
  let protectedRoots: IsolationProtectedRoots | undefined;
  return async (input) => {
    if (!protectedRoots) protectedRoots = loadProtectedRoots(overrides.protectedRootsFilePath);
    if (!capabilityStore) {
      const { JsonIsolationCapabilityStore } = await import('./isolation-capability.js');
      capabilityStore = new JsonIsolationCapabilityStore(
        overrides.capabilityFilePath ?? join('data', 'isolation-capability.json'),
      );
    }
    return prepareIsolation({
      input,
      harness: { capabilityStore },
      protectedRoots,
      // 生产默认持久化基线（119 号 P2）；持久化失败在 prepare 内失败关闭。
      baselineStoreDir: overrides.baselineStoreDir ?? join('data', 'task-baselines'),
    });
  };
}

// ---- 会话 scratch 绑定（119 号 P1-4） ----------------------------------------------

export interface SessionScratchBinding {
  /** 任务 scratch 相对工作区 realpath 的 POSIX 路径。 */
  relative: string;
  /** 建立绑定的任务键（topic taskId）；跨任务引用即失效。 */
  taskKey: string;
  at: number;
}

export const SESSION_SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 制品提交门（本地 PRD/架构/工单）：必须存在**当前任务**的 scratch 绑定——
 * 缺绑定（生产未初始化/重启丢失/注入执行未经过隔离）、跨任务/跨会话引用、
 * 过期绑定一律失败关闭。返回 scratch 相对根供制品路径约束。
 */
export function requireSessionScratchBinding(options: {
  scratches: ReadonlyMap<string, SessionScratchBinding>;
  sessionId: string;
  taskKey: string;
  now?: () => number;
  maxAgeMs?: number;
}): string {
  const now = (options.now ?? Date.now)();
  const entry = options.scratches.get(options.sessionId);
  if (!entry) {
    throw new Error('本地制品提交失败关闭：当前会话没有经隔离建立的任务 scratch 绑定（重启后须重新执行隔离任务）。');
  }
  if (entry.taskKey !== options.taskKey) {
    throw new Error(`本地制品提交失败关闭：scratch 绑定属于任务 ${entry.taskKey}，当前任务为 ${options.taskKey}（跨任务引用被拒）。`);
  }
  if (now - entry.at > (options.maxAgeMs ?? SESSION_SCRATCH_MAX_AGE_MS)) {
    throw new Error('本地制品提交失败关闭：scratch 绑定已过期，须重新执行隔离任务后提交。');
  }
  return entry.relative;
}

// ---- 会话 scratch 绑定持久化（A07） -----------------------------------------------

const SessionScratchBindingSchema = z.object({
  relative: z.string().min(1),
  taskKey: z.string().min(1),
  at: z.number().int().nonnegative(),
}).strict();

/**
 * A07：可持久化的会话 scratch 绑定表（Map 子类，runtime 的
 * `Map<string, SessionScratchBinding>` 类型不变；cli-execution 的 set 路径
 * 自动落盘）。set/delete/clear 后 tmp+rename 原子写（writeJsonState）；
 * 持久化失败抛错——静默丢持久化会让「重启后绑定仍在」变成谎言，宁可让本次
 * 任务失败（制品提交门本就失败关闭）。
 */
export class SessionScratchBindingStore extends Map<string, SessionScratchBinding> {
  constructor(
    private readonly filePath: string | undefined,
    initial?: ReadonlyMap<string, SessionScratchBinding>,
  ) {
    super(initial ? [...initial] : []);
    // A07：构造即以当前内容落盘（恢复路径用核验后的集合覆盖旧文件，被丢弃
    // 的死条目不再每次启动重复核验）。无 filePath（纯内存）不写盘。
    if (this.filePath) this.persist();
  }

  override set(key: string, value: SessionScratchBinding): this {
    super.set(key, value);
    this.persist();
    return this;
  }

  override delete(key: string): boolean {
    const removed = super.delete(key);
    if (removed) this.persist();
    return removed;
  }

  override clear(): void {
    super.clear();
    this.persist();
  }

  private persist(): void {
    if (!this.filePath) return;
    const entries: Record<string, SessionScratchBinding> = {};
    for (const [key, value] of this) entries[key] = value;
    writeJsonState(this.filePath, { _v: 1, entries });
  }
}

/**
 * A07：重启恢复绑定，**逐条重新核对**后只装回仍然成立的绑定（安全拒绝，
 * 不冒充可用）：
 * - relative 形如工作区相对 POSIX 路径（拒绝绝对路径/`..` 段）；
 * - 会话的工作区 realpath 仍存在；
 * - scratch 目录真实存在且 realpath 解析后仍落在工作区内、相对路径一致
 *   （目录被删/被挪/父链符号链接逃逸 ⇒ 丢弃）；
 * - taskKey 非空（schema 保证），提供 taskKeyOf 时还须与该会话最近任务一致
 *   （重启后绑定必须属于会话当前任务，跨任务残留 ⇒ 丢弃）；
 * - 未过期（SESSION_SCRATCH_MAX_AGE_MS；时间戳异常超前亦丢弃）。
 * 文件缺失 ⇒ 空表；坏文件 ⇒ 抛错失败关闭（对齐既有 store）。
 */
export function loadSessionScratchBindings(options: {
  filePath?: string;
  resolveWorkspaceDir: (sessionId: string) => string | undefined;
  /** 提供时校验绑定 taskKey 与会话最近任务一致（index.ts 用任务台账）。 */
  taskKeyOf?: (sessionId: string) => string | undefined;
  now?: number;
  maxAgeMs?: number;
}): SessionScratchBindingStore {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? SESSION_SCRATCH_MAX_AGE_MS;
  const restored = new Map<string, SessionScratchBinding>();
  const state = readJsonState(options.filePath);
  if (state !== undefined) {
    const parsed = z.object({
      _v: z.literal(1),
      entries: z.record(z.string().min(1), SessionScratchBindingSchema),
    }).parse(state);
    for (const [sessionId, entry] of Object.entries(parsed.entries)) {
      // 形状核对：拒绝绝对路径/`..`/反斜杠等（normalizeScratchRelative 抛错即丢弃）。
      try {
        normalizeScratchRelative(entry.relative);
      } catch {
        continue;
      }
      const workspaceDir = options.resolveWorkspaceDir(sessionId);
      if (!workspaceDir) continue;
      let workspaceReal: string;
      try {
        workspaceReal = realpathSync(workspaceDir);
      } catch {
        continue;
      }
      // 存在性 + 解析一致性：目录被删/被挪/符号链接逃逸都解析不回同一相对路径。
      const scratchAbsolute = join(workspaceReal, entry.relative);
      if (!existsSync(scratchAbsolute)) continue;
      let scratchReal: string;
      try {
        scratchReal = realpathSync(scratchAbsolute);
      } catch {
        continue;
      }
      const resolvedRelative = relative(workspaceReal, scratchReal).split(sep).join('/');
      if (resolvedRelative !== entry.relative) continue;
      // taskKey 一致性：最近任务已变化（或记录被清理后显式不匹配）⇒ 丢弃。
      const currentTaskKey = options.taskKeyOf?.(sessionId);
      if (currentTaskKey !== undefined && currentTaskKey !== entry.taskKey) continue;
      // 有效期：过期与异常超前的时间戳都不可信。
      if (entry.at > now + 60_000) continue;
      if (now - entry.at > maxAgeMs) continue;
      restored.set(sessionId, { relative: entry.relative, taskKey: entry.taskKey, at: entry.at });
    }
  }
  // 用核验后的集合建库并把「丢弃」落盘（下次启动不再重复核验死条目）。
  return new SessionScratchBindingStore(options.filePath, restored);
}
// ---- 证据判读（纯函数；canary 与 fixture 共用） ------------------------------------

export type IsolationEvidenceVerdict = 'blocked' | 'allowed' | 'inconclusive';

export interface IsolationAttemptEvidence {
  direction: 'read' | 'write';
  /** 工具/命令的 OS 报错文本（EPERM/EACCES 等）。 */
  toolError?: string;
  /** 目标位置是否实际发生变化（写方向落盘；读方向为哨兵内容是否出现在输出）。 */
  landedOrEchoed: boolean;
}

export function adjudicateAttempt(evidence: IsolationAttemptEvidence): IsolationEvidenceVerdict {
  const osDenied = /EPERM|EACCES|Operation not permitted|Permission denied/i.test(evidence.toolError ?? '');
  if (evidence.landedOrEchoed) return 'allowed';
  if (osDenied) return 'blocked';
  // 无落盘/复述也无 OS 拒绝证据 ⇒ 不确定 ⇒ 按 blocked 处理（失败关闭）。
  return 'inconclusive';
}
