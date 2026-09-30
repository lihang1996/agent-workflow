import { runCli } from "../cli/runner.js";
import type { CliAdapter, CliAttachment } from "../cli/types.js";
import type { ModelSelection } from "../core/model-selection.js";
import { realpathSync } from "node:fs";
import {
  createProductionIsolationPreparer,
  requireSessionScratchBinding,
  type IsolationSupplier,
  type PreparedIsolation,
  type SessionScratchBinding,
} from "../core/isolation.js";
import { assertAuthorizationUsable } from "../core/coding-authorization.js";
import type { AppRuntime } from "./runtime.js";

export interface ExecuteCliTaskBinding {
  /** agent-os 会话 ID（注意：不是原生 CLI session ID）。 */
  sessionId: string;
  /** 当前 agent-os 会话版本（防跨任务/跨版本串用）。 */
  sessionVersion: number;
  botId: string;
  taskId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
}

export function executeCli(
  adapter: CliAdapter,
  prompt: string,
  workspaceDir: string,
  sessionId: string | undefined,
  signal: AbortSignal,
  onEvent: Parameters<typeof runCli>[0]["onEvent"],
  attachments?: readonly CliAttachment[],
  modelSelection?: ModelSelection | null,
  isolation: IsolationSupplier = createProductionIsolationPreparer(),
  taskId?: string,
  authorization?: { id: string; allowedRelatives: readonly string[] },
) {
  return runCli({
    adapter,
    prompt,
    cwd: workspaceDir,
    sessionId,
    taskId,
    ...(authorization ? { authorization } : {}),
    signal,
    onEvent,
    attachments,
    ...(modelSelection !== undefined && modelSelection !== null
      ? { modelSelection }
      : {}),
    isolation,
  });
}

/**
 * 会话级隔离 supplier 包装：真实隔离 prepare 成功后，把任务 scratch 的相对
 * 路径记录到 runtime.sessionScratches，供制品创建（PRD/tickets/architecture）
 * 的 scratch 子树约束使用。生产默认 supplier（能力库为空）在 prepare 处失败
 * 关闭，不会记录任何东西。
 */
export function createSessionIsolationSupplier(
  runtime: AppRuntime,
  sessionId: string | undefined,
  base: IsolationSupplier = createProductionIsolationPreparer(),
): IsolationSupplier {
  return async (input) => {
    const prepared: PreparedIsolation = await base(input);
    // 119 号 P1-4：绑定非可选——只有**成功 prepare** 的任务才写绑定（taskKey
    // + 时间戳）；失败路径在 prepare 内已被清理，不会到达这里。
    if (sessionId && prepared.scratchRelative) {
      runtime.sessionScratches.set(sessionId, {
        relative: prepared.scratchRelative,
        taskKey: input.taskId,
        at: Date.now(),
      });
    }
    return prepared;
  };
}

/**
 * 制品提交门（119 号 P1-4）：本地 PRD/架构提交必须持有当前任务的 scratch
 * 绑定；缺绑定/跨任务/过期 ⇒ 失败关闭（不静默跳过）。
 */
export function requireScratchRootForSubmission(
  runtime: AppRuntime,
  sessionId: string,
  taskKey: string,
): string {
  return requireSessionScratchBinding({
    scratches: runtime.sessionScratches,
    sessionId,
    taskKey,
  });
}

/**
 * 一次性编码交接记录（138 号 P0-1）：把某个授权**单次**绑定到唯一一次执行
 * （taskId + agent-os session.id/version + botId + 发起人身份）。任何生产
 * 入口当前都**不会创建**该记录——跨 bot 交接的受信签发通道尚未设计，因此
 * 编码路径整体保持 blocked；本结构仅供未来显式入口与服务端核验使用。
 */
export interface CodingIntentHandoff {
  authorizationId: string;
  taskId: string;
  sessionId: string;
  sessionVersion: number;
  botId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  consumedAt?: string;
}

export class CodingIntentHandoffStore {
  private readonly handoffs = new Map<string, CodingIntentHandoff>();

  /** 受信入口显式签发（生产未接线：编码路径 blocked）。 */
  issue(handoff: CodingIntentHandoff): void {
    if (this.handoffs.has(handoff.authorizationId) && !this.handoffs.get(handoff.authorizationId)!.consumedAt) {
      throw new Error(`授权 ${handoff.authorizationId} 已有未消费的一次性交接，拒绝重复签发。`);
    }
    this.handoffs.set(handoff.authorizationId, { ...handoff });
  }

  get(authorizationId: string): CodingIntentHandoff | undefined {
    const found = this.handoffs.get(authorizationId);
    return found ? { ...found } : undefined;
  }

  consume(authorizationId: string, at: string): CodingIntentHandoff | undefined {
    const found = this.handoffs.get(authorizationId);
    if (!found || found.consumedAt) return undefined;
    const consumed = { ...found, consumedAt: at };
    this.handoffs.set(authorizationId, consumed);
    return consumed;
  }
}

/**
 * 显式按 ID 解析编码授权（138 号 P0-1 替代旧 resolveActiveCodingAuthorization）：
 * - **不从 store.list() 猜**：必须给出唯一 authorizationId，且其一次性交接
 *   记录与本次执行的 taskId/agent-os session.id+version/botId/发起人身份
 *   （同应用 Open ID 或 Union ID）逐一匹配、未消费；
 * - **完整 await G3**（assertAuthorizationUsable 为 async——撤销/过期/上游
 *   漂移/pendingPathRecheck 的异步拒绝在此真实生效）；
 * - workspace realpath 与授权绑定一致；返回**精确**允许路径并消费交接。
 * 任何一步失败抛错（不返回 undefined 让调用方降级）。交接记录不存在 ⇒ 失败
 * 关闭——即当前生产没有任何入口能创建交接 ⇒ 编码路径整体 blocked。
 */
export async function resolveCodingAuthorizationById(options: {
  runtime: AppRuntime;
  handoffs: Pick<CodingIntentHandoffStore, 'get' | 'consume'>;
  authorizationId: string;
  binding: ExecuteCliTaskBinding;
  workspaceDir: string;
  now?: () => Date;
  /** 149 号 P1-2 测试钩子：透传到 G3 的 pauseBeforeFinalRecheck。 */
  pauseBeforeFinalRecheck?: () => Promise<void>;
}): Promise<{ id: string; allowedRelatives: string[] }> {
  const { runtime, handoffs, authorizationId, binding } = options;
  const store = runtime.codingAuthorizations;
  if (!store) {
    throw new Error('编码授权台账不可用，编码路径失败关闭。');
  }
  const handoff = handoffs.get(authorizationId);
  if (!handoff) {
    throw new Error(`授权 ${authorizationId} 没有一次性交接记录：服务端未把该授权绑定到本次执行，编码路径失败关闭（不能从授权列表猜测）。`);
  }
  if (handoff.consumedAt) {
    throw new Error(`授权 ${authorizationId} 的一次性交接已被消费（${handoff.consumedAt}），不能复用。`);
  }
  // 绑定逐一核对：taskId / agent-os session.id+version / botId / 发起人身份。
  if (handoff.taskId !== binding.taskId
    || handoff.sessionId !== binding.sessionId
    || handoff.sessionVersion !== binding.sessionVersion
    || handoff.botId !== binding.botId) {
    throw new Error(`授权 ${authorizationId} 的一次性交接与本次执行（task/session/version/bot）不一致，编码路径失败关闭。`);
  }
  const sameApp = handoff.ownerOpenId === binding.ownerOpenId;
  const sameUnion = !!handoff.ownerUnionId && !!binding.ownerUnionId
    && handoff.ownerUnionId === binding.ownerUnionId;
  if (!sameApp && !sameUnion) {
    throw new Error(`授权 ${authorizationId} 的交接发起人与本次执行发起人不一致（跨 bot 身份无法证明同人），编码路径失败关闭。`);
  }
  const record = store.get(authorizationId);
  if (!record) {
    throw new Error(`编码授权 ${authorizationId} 不存在。`);
  }
  // 149 号 P1-1：三方一致——**授权记录本人 ↔ 交接发起人 ↔ 本次执行发起人**
  // 必须是同一人（记录侧按同应用 Open ID 或 Union ID 判定）。受信签发入口
  // 若误把他人的 authorizationId 放进交接，在此失败关闭。
  const recordMatchesHandoffApp = record.requesterOpenId === handoff.ownerOpenId;
  const recordMatchesHandoffUnion = !!record.requesterUnionId && !!handoff.ownerUnionId
    && record.requesterUnionId === handoff.ownerUnionId;
  if (!recordMatchesHandoffApp && !recordMatchesHandoffUnion) {
    throw new Error(`授权 ${authorizationId} 的记录发起人与一次性交接发起人不是同一人，编码路径失败关闭（A 授权不能进 B 交接）。`);
  }
  const workspaceRealpath = realpathSync(options.workspaceDir);
  if (record.workspaceRealpath !== workspaceRealpath) {
    throw new Error(`授权 ${authorizationId} 绑定的工作区与本次执行不一致，编码路径失败关闭。`);
  }
  const allowedSnapshot = [...record.allowedPaths].sort().join('\0');
  // 完整 await G3（含末次 CAS 复检）：异步拒绝（撤销/过期/制品漂移/
  // pendingPathRecheck/核验期间改记录）在此生效；返回的是最终核定的 fresh 记录。
  const finalRecord = await assertAuthorizationUsable({
    store,
    flows: runtime.productSpecFlows,
    authorizationId,
    resolveWorkspaceDir: (sessionId) => runtime.sessions.get(sessionId)?.workspaceDir,
    ...(options.now ? { now: options.now } : {}),
    ...(options.pauseBeforeFinalRecheck ? { pauseBeforeFinalRecheck: options.pauseBeforeFinalRecheck } : {}),
  });
  // G3 后的交接消费与路径下放在同一同步块内完成（事件循环原子窗口），且
  // 必须来自同一份最终核定的最新记录：任何维度漂移 ⇒ 失败关闭。
  if (finalRecord.requesterOpenId !== record.requesterOpenId
    || finalRecord.workspaceRealpath !== workspaceRealpath
    || [...finalRecord.allowedPaths].sort().join('\0') !== allowedSnapshot) {
    throw new Error(`授权 ${authorizationId} 在 G3 核验后与交接绑定的记录不一致，编码路径失败关闭。`);
  }
  const consumed = handoffs.consume(authorizationId, (options.now ?? (() => new Date()))().toISOString());
  if (!consumed) {
    throw new Error(`授权 ${authorizationId} 的一次性交接消费失败（并发使用），编码路径失败关闭。`);
  }
  return { id: authorizationId, allowedRelatives: [...finalRecord.allowedPaths] };
}

/**
 * 附件说明段落。写进 prompt 后，任何能读本地文件的 CLI 都知道去哪里找，
 * 不依赖某个 CLI 是否有专门的附件参数。
 */
export function attachmentPromptSection(attachments: readonly CliAttachment[]): string {
  if (attachments.length === 0) return "";
  const lines = attachments.map((attachment) => {
    const kind = attachment.type === "image" ? "图片" : "文件";
    const originalName = attachment.fileName ? `（原文件名：${attachment.fileName}）` : "";
    return `- ${kind}：${attachment.path}${originalName}`;
  });
  return [
    "",
    "",
    "用户随这条消息附带了以下内容，已保存到本机。请先读取这些文件，再结合上面的任务处理：",
    ...lines,
  ].join("\n");
}
