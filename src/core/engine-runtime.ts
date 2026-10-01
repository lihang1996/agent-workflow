import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliId } from '../cli/types.js';
import { ENGINE_MODEL_CAPABILITIES } from './engine-capabilities.js';
import type { ModelSelection, ModelSelectionCapabilities } from './model-selection.js';
import { createProductionIsolationPreparer, isProcessGroupAlive, launchIsolated, terminateIsolatedChild } from './isolation.js';

/**
 * 引擎运行时核验（Codex 审查点 5）：静态矩阵的证据来自某一时刻的 PATH 解析，
 * 运行环境可能解析到不同版本/不同可执行文件。带模型/强度声明的执行必须在
 * spawn 前用「运行时将启动的同一命令」实测版本与参数面，不支持就拒绝；
 * 只允许运行时核验降级静态能力，不允许升级。
 */
export interface EngineRuntimeCheck {
  cliId: CliId;
  command: string;
  version: string | null;
  checkedAt: string;
  /** 命令可运行且参数面实测通过（与静态矩阵求交后的最终能力）。 */
  capabilities: ModelSelectionCapabilities;
  reasoningEffortValues?: readonly string[];
  /** 运行时实测中发现的降级/不可用原因（审计与报错用）。 */
  notes: string[];
}

export type CliProbe = (
  command: string,
  args: readonly string[],
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

const PROBE_TIMEOUT_MS = 15_000;

/**
 * 默认探测（T-022 修订后 / 138·149 号 P1-3）：真实 CLI 可执行文件不可信，
 * `--version/--help` **不再豁免隔离**。error/close/timeout 全部经**单一异步
 * 收尾门**：整组终止（SIGTERM→SIGKILL）并核验退出后才 settle；close 分支
 * 发现存活进程组先终止再核验（不只 settle）。核验失败（无法核验/幸存者）
 * ⇒ ok=false 附原因，且**不删除仍可能被后代使用的目录**（探测工作区与
 * ephemeral scratch 保留诊断，不盲删）；从未启动子进程的失败路径安全清理。
 */
function defaultProbe(command: string, args: readonly string[]): Promise<{
  ok: boolean; stdout: string; stderr: string;
}> {
  return runIsolatedProbe(command, args);
}

/**
 * 149 号 P1-3/P2-2：参数化探测入口。生产（defaultProbe）恒用生产 preparer
 *（能力库空 ⇒ blocked）；测试用 fixture preparer 驱动同一收尾门代码路径——
 * 不放行生产，只让收尾行为可验证。
 */
export function runIsolatedProbe(
  command: string,
  args: readonly string[],
  preparer: ReturnType<typeof createProductionIsolationPreparer> = createProductionIsolationPreparer(),
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return (async () => {
    let probeWorkspace: string | undefined;
    let prepared: Awaited<ReturnType<typeof preparer>> | undefined;
    let launched = false;
    try {
      probeWorkspace = mkdtempSync(join(tmpdir(), 'agent-os-iso-probe-ws-'));
      prepared = await preparer({
        taskId: `probe-${command}`,
        purpose: 'probe',
        cliMode: 'probe',
        command,
        cwd: probeWorkspace,
      });
      return await new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
        let stdout = '';
        let stderr = '';
        let settling = false;
        const child = launchIsolated(prepared!, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        launched = true;
        const settle = (result: { ok: boolean; stdout: string; stderr: string }): void => {
          if (settling) return;
          settling = true;
          clearTimeout(timer);
          resolve(result);
        };
        // 组已核实退出后的清理：只删本探测自建目录（幂等）。
        const cleanupVerified = (): void => {
          prepared!.dispose();
          if (probeWorkspace) rmSync(probeWorkspace, { recursive: true, force: true });
        };
        // 单一异步收尾门：整组终止（不只杀 wrapper）→ 存活核验 → 清理 → 才 settle。
        const shutdown = (label: string, exitOk: boolean): void => {
          if (settling) return;
          settling = true;
          clearTimeout(timer);
          void terminateIsolatedChild(child)
            .catch((terminateError: Error): { outcome: 'unverifiable'; reason: string } => ({
              outcome: 'unverifiable',
              reason: terminateError.message,
            }))
            .then((outcome) => {
              settling = false;
              if (outcome.outcome === 'unverifiable') {
                settle({ ok: false, stdout, stderr: `${label}且无法核验后代终止（${outcome.reason}），探测目录保留诊断` });
                return;
              }
              if (outcome.groupAliveAfter) {
                settle({ ok: false, stdout, stderr: `${label}后进程组仍有存活后代，失败关闭；探测目录保留诊断` });
                return;
              }
              cleanupVerified();
              if (exitOk) {
                settle({ ok: true, stdout, stderr });
                return;
              }
              settle({ ok: false, stdout, stderr: stderr || label });
            });
        };
        const timer = setTimeout(() => {
          // 超时：走同一收尾门（整组终止+核验+清理后才 settle）。
          shutdown('探测超时', false);
        }, PROBE_TIMEOUT_MS);
        child.stdout.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
        child.once('error', (error: Error) => {
          shutdown(`启动失败（${error.message}）`, false);
        });
        child.once('close', (code) => {
          // close ≠ 后代退出：组仍有成员 ⇒ 先经收尾门终止+核验+清理再 settle。
          const liveness = isProcessGroupAlive(child.pid ?? 0);
          if (liveness.ok && liveness.alive) {
            shutdown(`探测进程退出（状态码 ${code}）但进程组仍有成员`, false);
            return;
          }
          if (!liveness.ok) {
            settle({ ok: false, stdout, stderr: `探测进程退出（状态码 ${code}）但无法核验进程组（${liveness.error}），探测目录保留诊断` });
            return;
          }
          // 组已空：清理自建目录后按退出码 settle。
          cleanupVerified();
          if (code === 0) {
            settle({ ok: true, stdout, stderr });
            return;
          }
          settle({ ok: false, stdout, stderr: stderr || `探测进程退出，状态码 ${code}` });
        });
      });
    } catch (error) {
      return { ok: false, stdout: '', stderr: (error as Error).message };
    } finally {
      // 从未启动子进程（prepare/launch 抛错）：无后代可占用目录，安全清理
      // 本探测自建的工作区与 ephemeral scratch；已启动的清理由收尾门在核验
      // 退出后执行，核验失败则保留诊断（不盲删）。
      if (!launched) {
        if (probeWorkspace) rmSync(probeWorkspace, { recursive: true, force: true });
        prepared?.dispose();
      }
    }
  })();
}

const runtimeCache = new Map<string, EngineRuntimeCheck>();

export function resetEngineRuntimeCacheForTests(): void {
  runtimeCache.clear();
}

/** 每引擎的 help 子命令：参数面证据所在位置。 */
function helpArgs(cliId: CliId): readonly string[] {
  if (cliId === 'codex') return ['exec', '--help'];
  return ['--help'];
}

function firstLine(text: string): string | null {
  const line = text.split('\n').map((value) => value.trim()).find(Boolean);
  return line ?? null;
}

/**
 * 从 help 文本解析 --effort 枚举（Codex 二轮 P1-1）。
 * 真实 claude help 的枚举不在旗标紧后，而是隔着说明文字、常见折行，例如：
 *   --effort <level>                      Effort level for the current session
 *                                         (low, medium, high, xhigh, max)
 * 解析窗口为该选项的整个说明块（到下一个缩进选项为止）；窗口内找第一个
 * 「纯小写词的逗号清单」括号组。识别不了真实格式时返回 undefined，
 * 调用方必须失败关闭，不得回退到含未核验选项的静态枚举。
 */
function parseEffortValues(help: string): string[] | undefined {
  const flagIndex = help.indexOf('--effort');
  if (flagIndex < 0) return undefined;
  const windowStart = flagIndex + '--effort'.length;
  // 说明块边界：下一个换行后的缩进选项（"--xxx"），或窗口上限 500 字符。
  const nextOption = /\n\s+--[\w-]+/.exec(help.slice(windowStart));
  const block = help.slice(
    windowStart,
    nextOption ? windowStart + nextOption.index : Math.min(help.length, windowStart + 500),
  );
  for (const group of block.matchAll(/\(([^()]{3,200})\)/g)) {
    const content = group[1]!;
    if (!content.includes(',')) continue;
    const tokens = content.split(',').map((token) => token.trim());
    if (
      tokens.every((token) => /^[a-z0-9][a-z0-9-]*$/.test(token))
      && tokens.every(Boolean)
    ) {
      return tokens;
    }
  }
  return undefined;
}

function hasFlag(help: string, ...needles: string[]): boolean {
  return needles.every((needle) => help.includes(needle));
}

async function runCheck(
  cliId: CliId,
  command: string,
  probe: CliProbe,
): Promise<EngineRuntimeCheck> {
  const staticCaps = ENGINE_MODEL_CAPABILITIES[cliId];
  const notes: string[] = [];
  const base = {
    cliId,
    command,
    checkedAt: new Date().toISOString(),
    notes,
  };

  const versionRun = await probe(command, ['--version']);
  if (!versionRun.ok) {
    notes.push(
      `无法运行 ${command} --version（命令缺失或退出非零）`
      + (versionRun.stderr.trim() ? `：${versionRun.stderr.trim().slice(0, 160)}` : ''),
    );
    return {
      ...base,
      version: null,
      capabilities: {
        supportsModelSelection: false,
        supportsReasoningEffort: false,
        supportsInPlaceModelSwitch: false,
      },
    };
  }
  const version = firstLine(versionRun.stdout) ?? firstLine(versionRun.stderr);
  if (version && staticCaps.evidence && !version.includes(staticCaps.evidence.cliVersion)) {
    notes.push(
      `运行时版本 ${version} 与矩阵核验版本 ${staticCaps.evidence.cliVersion} 不一致，以运行时参数面实测为准`,
    );
  }

  const helpRun = await probe(command, helpArgs(cliId));
  if (!helpRun.ok) {
    notes.push(`无法读取 ${command} ${helpArgs(cliId).join(' ')}，参数面不可核验`);
    return {
      ...base,
      version,
      capabilities: {
        supportsModelSelection: false,
        supportsReasoningEffort: false,
        supportsInPlaceModelSwitch: false,
      },
    };
  }
  const help = `${helpRun.stdout}\n${helpRun.stderr}`;

  let supportsModelSelection = staticCaps.supportsModelSelection;
  let supportsReasoningEffort = staticCaps.supportsReasoningEffort;
  // 强度取值只认运行时实测；静态枚举不得赋予未核验的值（C5）。
  let reasoningEffortValues: readonly string[] | undefined;

  if (staticCaps.supportsModelSelection) {
    const flag = cliId === 'codex' ? hasFlag(help, '-m, --model') : hasFlag(help, '--model');
    if (!flag) {
      supportsModelSelection = false;
      notes.push(`运行时 ${command} 的 help 未提供模型选择参数，模型声明降级为不支持`);
    }
  }
  if (staticCaps.supportsReasoningEffort) {
    if (cliId === 'claude') {
      // claude 的强度是 --effort 旗标：help 可直接核验。枚举解析不出时
      // 失败关闭（空清单 = 拒绝一切强度声明），绝不回退静态枚举——运行时
      // 版本可能与矩阵样本不同（如 2.1.109 无 xhigh）。
      if (!help.includes('--effort')) {
        supportsReasoningEffort = false;
        notes.push(`运行时 ${command} 的 help 未提供 --effort，推理强度降级为不支持`);
      } else {
        const runtimeValues = parseEffortValues(help);
        if (runtimeValues) {
          reasoningEffortValues = runtimeValues;
        } else {
          reasoningEffortValues = [];
          notes.push(
            `运行时 ${command} 的 --effort 枚举无法按实际 help 格式解析，失败关闭：所有推理强度声明被拒绝`,
          );
        }
      }
    } else {
      // codex 的强度经 -c model_reasoning_effort 传递（机制证据来自二进制源码），
      // help 无从核验：机制能力沿用静态矩阵，但取值清单不授予（运行时无法
      // 核验的值不加白名单，非法值由服务端拒绝、任务显式失败）。
      notes.push(`${cliId} 的推理强度机制无法经 help 核验，机制沿用矩阵静态证据，取值不加运行时白名单`);
    }
  }

  return {
    ...base,
    version,
    capabilities: {
      supportsModelSelection,
      supportsReasoningEffort,
      // 原地切换从未核验，运行时检查也不补这个面。
      supportsInPlaceModelSwitch: false,
    },
    ...(reasoningEffortValues ? { reasoningEffortValues } : {}),
  };
}

export async function ensureEngineRuntimeVerified(
  cliId: CliId,
  command: string,
  options: { probe?: CliProbe; noCache?: boolean } = {},
): Promise<EngineRuntimeCheck> {
  const key = `${cliId}::${command}`;
  const cached = runtimeCache.get(key);
  if (cached && !options.noCache) return cached;
  const check = await runCheck(cliId, command, options.probe ?? defaultProbe);
  runtimeCache.set(key, check);
  return check;
}

/**
 * 用运行时核验结果（而非静态矩阵）拒绝矩阵外组合：CLI 不可用/参数缺失时，
 * 带模型或强度声明的执行在 spawn 前失败；native-default 声明不涉及参数面，
 * 不在此拦截（CLI 缺失会在 spawn 时显式失败）。
 */
export function assertSelectionAgainstRuntime(
  check: EngineRuntimeCheck,
  selection: Pick<ModelSelection, 'model' | 'reasoningEffort'>,
): void {
  if (selection.model && !check.capabilities.supportsModelSelection) {
    throw new Error(
      `运行时核验未通过：${check.command}（${check.version ?? '版本未知'}）不能按执行指定模型`
      + `${selection.model}。${check.notes.join('；') || '参数面实测不支持模型选择。'}`
      + '请修正模型声明或改用支持模型选择的引擎。',
    );
  }
  if (selection.reasoningEffort && !check.capabilities.supportsReasoningEffort) {
    throw new Error(
      `运行时核验未通过：${check.command}（${check.version ?? '版本未知'}）不支持独立设置推理强度`
      + `${selection.reasoningEffort}。${check.notes.join('；') || '参数面实测不支持 --effort。'}`,
    );
  }
  if (
    selection.reasoningEffort
    && check.reasoningEffortValues
    && !check.reasoningEffortValues.includes(selection.reasoningEffort)
  ) {
    throw new Error(
      `运行时核验未通过：${check.command} 支持的推理强度为 ${check.reasoningEffortValues.join('、')}，`
      + `收到的是 ${selection.reasoningEffort}。`,
    );
  }
}
