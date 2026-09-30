import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { readJsonState } from './json-state.js';
import { z } from 'zod';

/**
 * T-022 隔离能力证据（G-W6b-FIX 批；A03 扩展）：
 *
 * 真实 CLI 的任何启动（任务/resume/recreate/compact/版本探测/会话列表）都必须
 * 先查到**当前能力身份**下的「读隔离 + 写隔离双双 passed」证据，否则 blocked
 *（100 号修订版 §2.2「强制入口契约」/ §6「无 bypass」）。
 *
 * 能力身份（119 号 P1-1 修订）：引擎命令 + 受保护根版本 + 用途 + **写策略**
 * （none 或 auth:<id>:<授权精确范围摘要>）+ 平台。随机任务 scratch 不进入身份
 * ——同一授权下不同任务可复用证据；不同授权（宽窄不同）互不匹配。**V 项待补
 * 维度**：引擎二进制 realpath/内容哈希/版本、OS 与 sandbox-exec 版本、认证
 * 方式、CLI 模式、MCP 配置哈希（canary 批扩展并做失效断言）；任一字段加入后
 * 旧身份自然查不到 ⇒ blocked。
 *
 * A03（Codex 深度审查）：① 身份补 **binaryFingerprint** 维度——二进制真实
 * 路径 + `--version` 输出的 sha256 前 16 位（调用方传入；harness 同时提供
 * binaryRealPath/binaryVersion 时 prepare 纳入身份，旧证据自然失效）；② 能力
 * 条目必须有 **expiresAt**（ISO 时间）与 **evidenceRef**（证据文件路径）——
 * 无限期证据等于无审计的永久通行证；③ store 每次 lookup 前核对文件 mtime，
 * 被撤销/重写即时生效；④ 过期条目按无证据处理（失败关闭）。
 *
 * 本模块只提供**只读** store：条目只能由未来的 G-W6b-CANARY 写入；空库/缺文件
 * ⇒ lookup 返回 undefined ⇒ 一切真实启动失败关闭。
 *
 * V-10（阻断登记）：官方 ZCode CLI 0.16.9 启动期沿 `--cwd` 读取 `.env`——
 * 在无私有 `.env` 的引导方式经 fresh/resume/compact 实测验证前，zcode 引擎
 * 保持 blocked，且任何 `.env` 内容不得进入任务进程环境。
 */
export type IsolationCapabilityVerdict = 'passed' | 'failed' | 'unverified';

export interface IsolationCapabilityVerdicts {
  read: IsolationCapabilityVerdict;
  write: IsolationCapabilityVerdict;
  /** canary 证据引用（ndjson 路径/矩阵行），人工复核用。A03 起必填。 */
  evidenceRef: string;
  /** 证据有效期（ISO 8601）。过期条目按无证据处理；A03 起必填。 */
  expiresAt: string;
}

export type IsolationCapabilityIdentityInput = {
  command: string;
  purpose: string;
  protectedRootsVersion: string;
  /**
   * 写策略描述（119 号 P1-1）：`none` = 设计/产品/探测/compact 等零代码写任务；
   * 编码任务 = `auth:<授权记录id>:<sha256(该授权的精确相对允许路径排序)>`——
   * 绑定**具体授权记录与其精确范围**（不同授权/不同宽窄互不匹配，不过度归一化）。
   * 随机 scratch 路径**不进入身份**：同一授权下的不同任务（不同 scratch）命中
   * 同一能力证据，可跨任务复用 canary 结果。
   */
  writePolicy: string;
  platform: NodeJS.Platform;
  /**
   * A03：引擎二进制指纹（computeBinaryFingerprint 的返回值，16 位 hex）。
   * 缺省 = 空串（旧调用路径；一旦某环境写入带指纹的证据，同环境无指纹的
   * 身份查不到它，保持失败关闭）。
   */
  binaryFingerprint?: string;
};

/** 能力身份（可跨任务 scratch 复用；单次运行的完整 profile 仍由预检/启动核验）。 */
export function computeIsolationCapabilityIdentity(input: IsolationCapabilityIdentityInput): string {
  const canonical = JSON.stringify([
    input.command,
    input.protectedRootsVersion,
    input.purpose,
    input.writePolicy,
    input.platform,
    input.binaryFingerprint ?? '',
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * A03：引擎二进制指纹 = sha256(二进制真实路径 + `--version` 输出) 前 16 位。
 * 由调用方（canary 写入侧/装配侧）传入；版本升级或二进制被替换 ⇒ 指纹变化
 * ⇒ 旧能力证据查不到 ⇒ blocked（重新 canary）。
 */
export function computeBinaryFingerprint(input: {
  /** 二进制真实路径（realpath 解析后；符号链接换绑即指纹变化）。 */
  binaryRealPath: string;
  /** `--version` 的完整 stdout（trim 后参与哈希）。 */
  versionOutput: string;
}): string {
  const canonical = JSON.stringify([input.binaryRealPath, input.versionOutput.trim()]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export type IsolationCapabilityReader = {
  lookup(key: string): IsolationCapabilityVerdicts | undefined;
};

const VerdictsSchema = z.object({
  read: z.enum(['passed', 'failed', 'unverified']),
  write: z.enum(['passed', 'failed', 'unverified']),
  evidenceRef: z.string().min(1),
  expiresAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'expiresAt 必须是可解析的 ISO 时间',
  }),
}).strict();

/** 只读 JSON 能力库：`{ _v: 2, entries: { [key]: verdicts } }`。坏文件失败关闭。 */
export class JsonIsolationCapabilityStore implements IsolationCapabilityReader {
  private readonly entries = new Map<string, IsolationCapabilityVerdicts>();
  /** 上次加载时的文件 mtime（毫秒）；文件未变则不重复解析。 */
  private loadedMtimeMs: number | undefined;
  private readonly now: () => number;

  constructor(private readonly filePath: string, options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.loadedMtimeMs = this.statMtimeMs();
    this.reload();
  }

  lookup(key: string): IsolationCapabilityVerdicts | undefined {
    // A03：每次 lookup 前核对 mtime——外部撤销（重写/删除证据文件）不必等
    // 进程重启即生效。stat 失败（含文件被删）⇒ 清空内存条目，失败关闭。
    const mtimeMs = this.statMtimeMs();
    if (mtimeMs !== this.loadedMtimeMs) {
      this.loadedMtimeMs = mtimeMs;
      if (mtimeMs === undefined) {
        this.entries.clear();
      } else {
        this.reload();
      }
    }
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // 过期按无证据处理（A03）：Date.parse 失败的条目在 schema 已拒绝，
    // 这里再兜底一次（防御手写文件绕过 strict schema 的路径）。
    const expiresAtMs = Date.parse(entry.expiresAt);
    if (Number.isNaN(expiresAtMs) || expiresAtMs <= this.now()) return undefined;
    return entry;
  }

  private statMtimeMs(): number | undefined {
    try {
      return statSync(this.filePath).mtimeMs;
    } catch {
      return undefined;
    }
  }

  private reload(): void {
    this.entries.clear();
    const state = readJsonState(this.filePath);
    if (state === undefined) return;
    // 坏文件在构造与刷新处都失败关闭（抛错），不带着旧条目继续放行。
    const parsed = z.object({
      _v: z.literal(2),
      entries: z.record(z.string().min(1), VerdictsSchema),
    }).parse(state);
    for (const [key, verdicts] of Object.entries(parsed.entries)) {
      this.entries.set(key, verdicts);
    }
  }
}

/**
 * 判定当前键是否允许启动：读、写两个方向都必须是 passed，且证据未过期。
 * store 已过滤过期条目；这里再核对一次（自定义 reader 不经 JsonIsolation-
 * CapabilityStore 时同样失败关闭，A03）。
 */
export function assertCapabilityAllowsLaunch(
  reader: IsolationCapabilityReader,
  key: string,
): IsolationCapabilityVerdicts {
  const verdicts = reader.lookup(key);
  if (
    !verdicts
    || verdicts.read !== 'passed'
    || verdicts.write !== 'passed'
    || Number.isNaN(Date.parse(verdicts.expiresAt ?? ''))
    || Date.parse(verdicts.expiresAt) <= Date.now()
  ) {
    const detail = verdicts
      ? (Number.isNaN(Date.parse(verdicts.expiresAt ?? '')) || Date.parse(verdicts.expiresAt) <= Date.now()
        ? 'canary 证据已过期（A03：过期按无证据处理）'
        : `读=${verdicts.read} 写=${verdicts.write}`)
      : '无该环境键下的 canary 证据（G-W6b-CANARY 未执行）';
    throw new Error(`引擎读写隔离未验证（blocked）：${detail}；key=${key.slice(0, 16)}…`);
  }
  return verdicts;
}
