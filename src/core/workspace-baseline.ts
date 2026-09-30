import { createHash } from 'node:crypto';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, relative } from 'node:path';
import { readJsonState, writeJsonState } from './json-state.js';
import { z } from 'zod';
import { spawnCli } from '../cli/spawn-cli.js';

/**
 * T-022 workspace 基线指纹（100 号修订版 §4）：
 *
 * - **完整扫描保护范围**：不默认跳过 `.git`/`node_modules`/ignored——目录、
 *   空目录、符号链接（target+身份）、特殊文件（类型+dev:ino 身份）都记录；
 *   普通文件逐个 sha256。超限（条目/字节/深度）或任何 stat/read/枚举竞态
 *   ⇒ `incomplete: true` ⇒ 差异判读失败关闭，**不退化为单次 git status**。
 * - 已有脏文件以内容快照入基线；任务后变化计入 modified（mtime 仅展示，
 *   绝不作为豁免）；`git status --porcelain` 前后对照只产出「用户未操作」
 *   旁证字段。
 * - 任务 scratch 子树以**精确相对路径**登记为 `scratchExceptions`；差异中
 *   落在其内的变更单列为 `scratchChanges`，不算违规。
 */
export interface BaselineLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxDepth: number;
}

export const DEFAULT_BASELINE_LIMITS: BaselineLimits = {
  maxEntries: 50_000,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxDepth: 64,
};

export type BaselineEntryKind = 'file' | 'dir' | 'symlink' | 'special';

export interface BaselineEntry {
  kind: BaselineEntryKind;
  /** 权限位（八进制字符串，如 '100644'）：chmod / 同内容替换均可检出（119 号 P2）。 */
  mode: string;
  /** 普通文件的内容摘要；目录/特殊项缺省。 */
  sha256?: string;
  /** 符号链接 target（不跟随）。 */
  target?: string;
  /** 身份指纹（dev:ino）：所有类型都记录，同形（含同内容）替换必检。 */
  identity?: string;
  /** 展示字段（不参与比较）。 */
  mtimeMs?: number;
  size?: number;
}

export interface WorkspaceBaseline {
  takenAt: string;
  incomplete: boolean;
  incompleteReason?: string;
  workspaceRealpath: string;
  /** 任务 scratch 精确例外（相对工作区 realpath 的 POSIX 路径）。 */
  scratchExceptions: string[];
  /** 同一批准授权的精确允许路径（相对 POSIX；119 号 P1-3）：其中变化单列，不与 scratch 混同。 */
  allowedExceptions: string[];
  /** git status --porcelain 旁证（非 Git 工作区缺省）。 */
  gitPorcelain?: string[];
  entries: Record<string, BaselineEntry>;
}

export interface WorkspaceBaselineDiff {
  added: string[];
  modified: string[];
  removed: string[];
  /** 全部落在 scratch 例外内的变更（本任务允许写的精确子树）。 */
  scratchChanges: string[];
  /** 全部落在同一批准允许路径内的变更（编码任务的合法改动，单列供审阅）。 */
  allowedChanges: string[];
  incomplete: boolean;
  incompleteReason?: string;
  /** 旁证：git porcelain 前后对照（null=无 git/不可比；true=期间有用户侧变更迹象）。 */
  userActivityHint: boolean | null;
}

const MAX_FILE_BYTES_FOR_SHA = 256 * 1024 * 1024;

export async function takeWorkspaceBaseline(options: {
  workspaceDir: string;
  scratchExceptions?: readonly string[];
  allowedExceptions?: readonly string[];
  limits?: Partial<BaselineLimits>;
  gitStatus?: (cwd: string) => Promise<string[] | undefined>;
  now?: () => Date;
}): Promise<WorkspaceBaseline> {
  const limits = { ...DEFAULT_BASELINE_LIMITS, ...options.limits };
  const now = (options.now ?? (() => new Date()))();
  const workspaceRealpath = await realpath(options.workspaceDir).catch(() => {
    throw new Error(`基线失败关闭：工作区无法解析 realpath: ${options.workspaceDir}`);
  });
  const baseline: WorkspaceBaseline = {
    takenAt: now.toISOString(),
    incomplete: false,
    workspaceRealpath,
    scratchExceptions: [...(options.scratchExceptions ?? [])],
    allowedExceptions: [...(options.allowedExceptions ?? [])],
    entries: {},
  };
  let entryCount = 0;
  let totalBytes = 0;

  const fail = (reason: string): void => {
    baseline.incomplete = true;
    baseline.incompleteReason = reason;
  };

  const walk = async (dirReal: string, depth: number): Promise<void> => {
    if (baseline.incomplete) return;
    if (depth > limits.maxDepth) return fail(`目录深度超过上限 ${limits.maxDepth}`);
    let names: string[];
    try {
      names = await readdir(dirReal);
    } catch (error) {
      return fail(`目录枚举失败 ${dirReal}: ${(error as Error).message}`);
    }
    for (const name of names) {
      if (baseline.incomplete) return;
      const absolute = join(dirReal, name);
      const rel = relative(workspaceRealpath, absolute).split('\\').join('/');
      let info;
      try {
        info = await lstat(absolute);
      } catch (error) {
        return fail(`lstat 失败 ${rel}: ${(error as Error).message}`);
      }
      entryCount += 1;
      if (entryCount > limits.maxEntries) return fail(`条目数超过上限 ${limits.maxEntries}`);
      const identity = `${info.dev}:${info.ino}`;
      const mode = (info.mode & 0o7777).toString(8);
      let entry: BaselineEntry;
      if (info.isDirectory()) {
        entry = { kind: 'dir', identity, mode };
      } else if (info.isSymbolicLink()) {
        let target: string;
        try {
          target = await readlink(absolute);
        } catch (error) {
          return fail(`读取符号链接失败 ${rel}: ${(error as Error).message}`);
        }
        entry = { kind: 'symlink', target, identity, mode, mtimeMs: info.mtimeMs };
      } else if (info.isFile()) {
        if (info.size > MAX_FILE_BYTES_FOR_SHA) return fail(`单文件过大 ${rel}: ${info.size}`);
        totalBytes += info.size;
        if (totalBytes > limits.maxTotalBytes) return fail(`总字节数超过上限 ${limits.maxTotalBytes}`);
        let sha256: string;
        try {
          // 先独占打开再读：读窗口内被替换/删除 ⇒ 错误 ⇒ incomplete（不产出半截摘要）。
          const handle = await open(absolute, 'r');
          try {
            const buffer = await handle.readFile();
            sha256 = createHash('sha256').update(buffer).digest('hex');
          } finally {
            await handle.close();
          }
        } catch (error) {
          return fail(`文件读取失败 ${rel}: ${(error as Error).message}`);
        }
        entry = { kind: 'file', sha256, size: info.size, identity, mode, mtimeMs: info.mtimeMs };
      } else {
        entry = { kind: 'special', identity, mode, mtimeMs: info.mtimeMs };
      }
      baseline.entries[rel] = entry;
      if (info.isDirectory()) await walk(absolute, depth + 1);
    }
  };

  await walk(workspaceRealpath, 0);
  if (baseline.incomplete) return baseline;

  const gitStatus = options.gitStatus ?? defaultGitStatus;
  const gitPorcelain = await gitStatus(workspaceRealpath);
  if (gitPorcelain !== undefined) baseline.gitPorcelain = gitPorcelain;
  return baseline;
}

export async function diffWorkspaceBaseline(options: {
  baseline: WorkspaceBaseline;
  workspaceDir: string;
  gitStatus?: (cwd: string) => Promise<string[] | undefined>;
}): Promise<WorkspaceBaselineDiff> {
  if (options.baseline.incomplete) {
    throw new Error(`基线不完整（${options.baseline.incompleteReason ?? '未知'}），差异判读失败关闭`);
  }
  const after = await takeWorkspaceBaseline({
    workspaceDir: options.workspaceDir,
    scratchExceptions: options.baseline.scratchExceptions,
    allowedExceptions: options.baseline.allowedExceptions,
    gitStatus: options.gitStatus,
  });
  if (after.incomplete) {
    throw new Error(`任务后扫描不完整（${after.incompleteReason ?? '未知'}），差异判读失败关闭`);
  }
  const before = options.baseline.entries;
  const afterEntries = after.entries;
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  const allPaths = new Set([...Object.keys(before), ...Object.keys(afterEntries)]);
  const inScratch = (rel: string): boolean =>
    options.baseline.scratchExceptions.some((exception) =>
      rel === exception || rel.startsWith(`${exception}/`));
  const inAllowed = (rel: string): boolean =>
    options.baseline.allowedExceptions.some((exception) =>
      rel === exception || rel.startsWith(`${exception}/`));
  for (const rel of allPaths) {
    const a = before[rel];
    const b = afterEntries[rel];
    if (a && !b) removed.push(rel);
    else if (!a && b) added.push(rel);
    else if (a && b && !sameEntry(a, b)) modified.push(rel);
  }
  const scratchChanges = [...added, ...modified, ...removed].filter(inScratch);
  // 授权路径内的合法变化单独列出（供审阅），与 scratch 分开；范围外才是违规。
  const allowedChanges = [...added, ...modified, ...removed].filter((rel) => !inScratch(rel) && inAllowed(rel));
  const filterExempt = (list: string[]) => list.filter((rel) => !inScratch(rel) && !inAllowed(rel));
  return {
    added: filterExempt(added),
    modified: filterExempt(modified),
    removed: filterExempt(removed),
    scratchChanges,
    allowedChanges,
    incomplete: false,
    userActivityHint: comparePorcelain(options.baseline.gitPorcelain, after.gitPorcelain),
  };
}

/** 任务合格判据：无授权任务 = 任务外 added/modified/removed 全空。 */
export function baselineDiffClean(diff: WorkspaceBaselineDiff): boolean {
  return !diff.incomplete
    && diff.added.length === 0 && diff.modified.length === 0 && diff.removed.length === 0;
}

function sameEntry(a: BaselineEntry, b: BaselineEntry): boolean {
  if (a.kind !== b.kind) return false;
  if (a.mode !== b.mode) return false; // chmod 检出（119 号 P2）
  if (a.kind === 'file') {
    // sha（内容）+ identity（dev:ino）：同内容原子替换（新 inode）也检出。
    return a.sha256 === b.sha256 && a.identity === b.identity;
  }
  if (a.kind === 'symlink') return a.target === b.target && a.identity === b.identity;
  return a.identity === b.identity;
}

function comparePorcelain(before: string[] | undefined, after: string[] | undefined): boolean | null {
  if (before === undefined || after === undefined) return null;
  if (before.length !== after.length) return true;
  return before.some((line, index) => line !== after[index]);
}

async function defaultGitStatus(cwd: string): Promise<string[] | undefined> {
  // git 是受信系统工具（非模型可达路径），经 spawnCli 统一入口；非 Git 目录或
  // git 不可用 ⇒ undefined（仅旁证缺失，不影响失败关闭主判据）。
  try {
    const child = spawnCli('git', ['status', '--porcelain'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => { stdout += `${line}\n`; });
    child.stderr.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve(exitCode ?? -1));
    });
    if (code !== 0) return undefined;
    return stdout.split('\n').filter(Boolean);
  } catch {
    return undefined;
  }
}

// ---- 持久化（data/task-baselines/<id>.json） -----------------------------------

const BaselineFileSchema = z.object({
  takenAt: z.iso.datetime(),
  incomplete: z.boolean(),
  incompleteReason: z.string().min(1).optional(),
  workspaceRealpath: z.string().min(1),
  scratchExceptions: z.array(z.string().min(1)),
  allowedExceptions: z.array(z.string().min(1)).default([]),
  gitPorcelain: z.array(z.string()).optional(),
  entries: z.record(z.string(), z.object({
    kind: z.enum(['file', 'dir', 'symlink', 'special']),
    mode: z.string().regex(/^[0-7]{1,4}$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    target: z.string().optional(),
    identity: z.string().optional(),
    mtimeMs: z.number().optional(),
    size: z.number().optional(),
  })),
});

export function persistWorkspaceBaseline(filePath: string, baseline: WorkspaceBaseline): void {
  writeJsonState(filePath, { _v: 1, baseline });
}

export function loadWorkspaceBaseline(filePath: string): WorkspaceBaseline {
  const state = readJsonState(filePath);
  if (state === undefined) {
    throw new Error(`基线缺失，失败关闭（不得退化为单次 git status）: ${filePath}`);
  }
  const parsed = z.object({ _v: z.literal(1), baseline: BaselineFileSchema }).parse(state);
  return parsed.baseline as WorkspaceBaseline;
}
