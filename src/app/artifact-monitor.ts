import {
  computeArchitectureArtifactDigest,
  computeLocalArtifactDigest,
  localArtifactInputOf,
} from '../core/artifact-digest.js';
import type { ArchitectureHandoffStore } from '../core/architecture-handoff.js';
import type { ProductSpecFlow, ProductSpecFlowStore } from '../core/product-spec.js';

/**
 * T-019：批准后外部编辑监测（13 号 C2「批准后外部编辑用文档变更事件或轮询
 * 发现」；本批交付**监测接口**与级联原语，生产定时调度不启动）。
 *
 * 语义（失败关闭）：
 * - **内容不一致才失效**：完整回读成功且重算摘要 ≠ 批准时绑定的摘要 ⇒
 *   `invalidated`，记录原因与审计；
 * - **读取失败只记录「无法核验」**：绝不因读不到文件就断定内容已改——
 *   flow 保持 approved，G1/G2/G3 各自回读时仍然失败关闭；
 * - PRD 失效时**级联失效**以它为上游的架构制品，并关闭其 open 架构交接；
 * - **状态先于通知**（61 号 P1）：全部失效迁移与交接关闭先完成（同步、可
 *   持久化），通知/钩子随后逐条隔离执行——单条通知异常都**不影响任何持久
 *   状态**，也不阻断其余对象的通知；
 * - **通知契约（68 号 P1 后修订）**：`notify` 由集成方提供并遵守——
 *   resolve = 已完成外部送达（回调自证）；reject = **未产生任何外部副作用**
 *   （监控据此安全补试）；既不 resolve 也不 reject（悬挂/超时）= 结果不确定。
 *   监控侧据此记录：`sent`（回调自证送达）/ `failed`（回调按契约报告未送
 *   达、未产生副作用，可自动补试）/ `unknown`（超时，结果不确定——**停止一
 *   切自动补试**，避免无接收端幂等保证时的重复外部动作）/ `not_configured`
 *   （未配置回调，不存在送达，不记录 sent）。**不宣称「至多一次送达」**：
 *   只承诺「每 token 至多一次成功确认；自动补试仅限 failed（按契约未产生
 *   副作用）；unknown/not_configured 不自动重试」。迟到完成的发送不会被
 *   观察到（记录保持 unknown，但因不再补试不会产生重复动作）；
 * - **补试范围（68 号 P2）**：随检查的自动补试只覆盖被检查的 token；级联
 *   依赖的通知补试需调用 `retryPendingNotifications()`（遍历全部 failed）。
 *   审计与通知状态只在内存，跨进程持久化（事件/outbox）保持 blocked（W6）；
 * - `onInvalidated` 钩子供 W6 CodingAuthorization 接线（T-021 未落地，
 *   仅定义不接线；每个 token 至多触发一次，异常被记录不外抛）。
 *
 * 真实飞书文档的完整回读（U-3）未核验：lark 交付制品的监测保持 skipped
 * （G1/G2/G3 已对其失败关闭），不得以 Markdown 导出摘要冒充完整版本。
 */
export type ExternalEditOutcome =
  | { outcome: 'consistent'; token: string }
  | { outcome: 'skipped'; token: string; reason: string }
  | { outcome: 'unverifiable'; token: string; reason: string; at: string }
  | { outcome: 'invalidated'; token: string; reason: string; at: string }
  | { outcome: 'already_invalidated'; token: string; reason: string };

export interface MonitorAuditEntry {
  token: string;
  artifact_kind: string;
  outcome: ExternalEditOutcome['outcome'];
  reason?: string;
  at: string;
}

/**
 * 通知尝试的可观察记录：
 * - `sent`：notify 回调 resolve（回调自证送达）；
 * - `failed`：notify reject——**契约要求此时未产生任何外部副作用**，可自动补试；
 * - `unknown`：超时/结果不确定——停止自动补试（无接收端幂等保证，重发可能
 *   造成重复外部动作），待人工/生产对账通道（blocked）；
 * - `not_configured`：未配置 notify 回调——不存在送达，绝不记录 sent。
 */
export type MonitorNotificationStatus = 'sent' | 'failed' | 'unknown' | 'not_configured';

export interface MonitorNotificationRecord {
  token: string;
  attemptAt: string;
  status: MonitorNotificationStatus;
  error?: string;
  /** 同一次尝试中 onInvalidated 钩子的异常（钩子每个 token 至多执行一次）。 */
  hookError?: string;
}

export interface ArtifactInvalidationHookInput {
  flow: ProductSpecFlow;
  reason: string;
  /** cascade_of = 触发级联的上游 PRD token（直接失效时缺省）。 */
  cascadeOfPrdToken?: string;
}

/** W6 CodingAuthorization 的失效钩子形状（T-021 未落地，仅定义不接线）。 */
export interface ArtifactInvalidationHooks {
  onInvalidated?: (input: ArtifactInvalidationHookInput) => void;
}

export class ArtifactMonitor {
  /** 检查审计（内存；跨进程持久化 blocked）。 */
  readonly audit: MonitorAuditEntry[] = [];
  /** 通知尝试记录（内存；跨进程持久化 blocked）。 */
  readonly notifications: MonitorNotificationRecord[] = [];
  private readonly delivered = new Set<string>();
  private readonly hooked = new Set<string>();
  private readonly now: () => Date;
  private readonly notifyTimeoutMs: number;

  constructor(private readonly options: {
    store: ProductSpecFlowStore;
    handoffs?: ArchitectureHandoffStore;
    /**
     * 失效通知回调（契约见类注释）：resolve=已送达；reject=未产生任何外部
     * 副作用（可安全补试）；悬挂=结果不确定（unknown，停止自动补试）。
     */
    notify?: (input: ArtifactInvalidationHookInput) => Promise<void> | void;
    hooks?: ArtifactInvalidationHooks;
    now?: () => Date;
    /** 单次通知的结算上限；超时记 unknown 并继续（默认 5s）。 */
    notifyTimeoutMs?: number;
  }) {
    this.now = options.now ?? (() => new Date());
    this.notifyTimeoutMs = options.notifyTimeoutMs ?? 5_000;
  }

  /**
   * 检查一个已批准制品是否被外部编辑。workspaceDir 缺失按「无法核验」记录
   * （不失效）。只处理本地交付；lark 保持 skipped（U-3）。
   */
  async checkExternalEdit(options: {
    token: string;
    workspaceDir?: string;
  }): Promise<ExternalEditOutcome> {
    const { store, handoffs } = this.options;
    const flow = store.get(options.token);
    if (!flow) {
      return { outcome: 'skipped', token: options.token, reason: 'flow 不存在' };
    }
    if (flow.status === 'pending') {
      return { outcome: 'skipped', token: options.token, reason: '制品仍在待确认（漂移由 G1 在确认时拦截）' };
    }
    if (flow.status === 'expired') {
      return { outcome: 'skipped', token: options.token, reason: '制品已被更新版本取代' };
    }
    if (flow.status === 'invalidated') {
      // 状态已终态；补试本 token 的 failed 通知（unknown/not_configured 不自动重试）。
      await this.emitInvalidated({ flow, reason: flow.invalidation_reason ?? '已失效' });
      return { outcome: 'already_invalidated', token: options.token, reason: flow.invalidation_reason ?? '已失效' };
    }
    if (flow.content_digest == null) {
      return { outcome: 'skipped', token: options.token, reason: '旧记录未绑定摘要（G2/G3 已失败关闭），无漂移基线' };
    }
    if (flow.request.deliveryMode === 'lark-doc') {
      return { outcome: 'skipped', token: options.token, reason: '飞书完整回读能力未核验（U-3），监测保持 blocked；G1/G2/G3 仍失败关闭' };
    }
    if (!options.workspaceDir) {
      const at = this.now().toISOString();
      this.record({ token: options.token, artifact_kind: flow.artifact_kind ?? 'prd', outcome: 'unverifiable', reason: '找不到会话工作区，无法核验', at });
      return { outcome: 'unverifiable', token: options.token, reason: '找不到会话工作区，无法核验', at };
    }
    let recomputed: string;
    try {
      const input = localArtifactInputOf(flow);
      const digest = input.kind === 'architecture'
        ? await computeArchitectureArtifactDigest(options.workspaceDir, input.request)
        : await computeLocalArtifactDigest(options.workspaceDir, input.request);
      recomputed = digest.digest;
    } catch (error) {
      // 读取失败：只记录「无法核验」，不断定内容已改（G1/G2/G3 仍失败关闭）。
      const reason = `无法核验（完整回读失败：${(error as Error).message}）`;
      const at = this.now().toISOString();
      this.record({ token: options.token, artifact_kind: flow.artifact_kind ?? 'prd', outcome: 'unverifiable', reason, at });
      console.warn(`[制品监测] ${options.token} ${reason}`);
      return { outcome: 'unverifiable', token: options.token, reason, at };
    }
    if (recomputed === flow.content_digest) {
      return { outcome: 'consistent', token: options.token };
    }
    const reason = `批准后内容被外部编辑：批准摘要 ${flow.content_digest.slice(0, 12)}… 与当前重算 ${recomputed.slice(0, 12)}… 不一致`;
    const at = this.now().toISOString();

    // ---- 阶段 1：持久状态迁移（同步完成，不依赖任何通知）----
    const invalidated: ArtifactInvalidationHookInput[] = [];
    const transition = store.invalidate(options.token, reason);
    this.record({ token: options.token, artifact_kind: flow.artifact_kind ?? 'prd', outcome: transition ? 'invalidated' : 'already_invalidated', reason, at });
    if (transition) {
      invalidated.push({ flow: transition, reason });
    }
    // PRD 失效 ⇒ 级联失效以其为上游的架构制品，并关闭 open 交接。
    if ((flow.artifact_kind ?? 'prd') === 'prd') {
      for (const dependent of store.listByUpstreamPrd(options.token)) {
        if (dependent.status !== 'pending' && dependent.status !== 'approved') continue;
        const cascadeReason = `上游产品方案已失效（${reason}），架构设计级联失效`;
        const cascaded = store.invalidate(dependent.token, cascadeReason);
        this.record({ token: dependent.token, artifact_kind: dependent.artifact_kind ?? 'architecture', outcome: cascaded ? 'invalidated' : 'already_invalidated', reason: cascadeReason, at });
        if (cascaded) {
          invalidated.push({ flow: cascaded, reason: cascadeReason, cascadeOfPrdToken: options.token });
        }
      }
      if (handoffs) {
        handoffs.closeForPrd(options.token);
      }
    }

    // ---- 阶段 2：通知（逐条隔离：失败/超时/未配置只记录，不阻断其余对象）----
    for (const item of invalidated) {
      await this.emitInvalidated(item);
    }
    return transition
      ? { outcome: 'invalidated', token: options.token, reason, at }
      : { outcome: 'already_invalidated', token: options.token, reason };
  }

  /**
   * 补试**全部** failed 通知（含级联依赖；68 号 P2）：只处理最近一次状态为
   * `failed` 的 token（按契约 reject = 未产生外部副作用，可安全补试）；
   * `unknown`/`not_configured` 不自动重试。返回本次实际补试的 token 列表。
   * 生产调度未接线时由集成方显式调用；跨进程持久化仍 blocked。
   */
  async retryPendingNotifications(): Promise<string[]> {
    const lastByToken = new Map<string, MonitorNotificationRecord>();
    for (const entry of this.notifications) lastByToken.set(entry.token, entry);
    const retryTokens = [...lastByToken.entries()]
      .filter(([, entry]) => entry.status === 'failed')
      .map(([token]) => token);
    const retried: string[] = [];
    for (const token of retryTokens) {
      const flow = this.options.store.get(token);
      if (!flow) continue;
      await this.emitInvalidated({ flow, reason: flow.invalidation_reason ?? '已失效' });
      retried.push(token);
    }
    return retried;
  }

  /** 未成功送达（failed/unknown/not_configured）的通知记录，供人工核对。 */
  listPendingNotifications(): MonitorNotificationRecord[] {
    const deliveredOrStopped = new Set(
      this.notifications
        .filter((entry) => entry.status === 'sent' || entry.status === 'unknown' || entry.status === 'not_configured')
        .map((entry) => entry.token),
    );
    return this.notifications.filter((entry) => !deliveredOrStopped.has(entry.token));
  }

  private lastNotificationOf(token: string): MonitorNotificationRecord | undefined {
    for (let index = this.notifications.length - 1; index >= 0; index -= 1) {
      if (this.notifications[index].token === token) return this.notifications[index];
    }
    return undefined;
  }

  /**
   * 单条失效的通知+钩子（隔离执行）：
   * - 已送达（sent）：不再动作；
   * - unknown / not_configured：**不自动重试**（结果不确定/无接收端）；
   * - failed（契约：未产生外部副作用）或首次尝试：执行一次带超时上限的尝试；
   * - onInvalidated：每个 token 至多执行一次（hooked）；异常记录不外抛。
   */
  private async emitInvalidated(input: ArtifactInvalidationHookInput): Promise<void> {
    const token = input.flow.token;
    if (this.delivered.has(token)) return;
    const last = this.lastNotificationOf(token);
    if (last && last.status !== 'failed') return; // sent/unknown/not_configured 均不再自动尝试
    const entry: MonitorNotificationRecord = {
      token,
      attemptAt: this.now().toISOString(),
      status: 'not_configured',
    };
    this.notifications.push(entry);
    if (!this.options.notify) {
      // 未配置回调：不存在送达，绝不记录 sent（68 号 P1）。
      console.warn(`[制品监测] ${token} 未配置失效通知回调（not_configured），失效状态已生效`);
      this.runHook(input, entry);
      return;
    }
    let timedOut = false;
    // 异步包裹：同步 throw 也走拒绝路径。
    const attempt = Promise.resolve()
      .then(() => this.options.notify!(input))
      .catch((error) => { throw error; });
    // 迟到的拒绝不再变成 unhandledRejection。
    attempt.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        attempt,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => { timedOut = true; resolve(); }, this.notifyTimeoutMs);
        }),
      ]);
    } catch (error) {
      entry.status = 'failed';
      entry.error = (error as Error).message;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (entry.status === 'not_configured' && timedOut) entry.status = 'unknown';
    else if (entry.status === 'not_configured') {
      entry.status = 'sent';
      this.delivered.add(token);
    }
    if (entry.status === 'failed') {
      console.error(`[制品监测] 失效通知未送达（failed，按契约未产生副作用，可补试）: ${token} ${entry.error ?? ''}`);
    } else if (entry.status === 'unknown') {
      console.error(`[制品监测] 失效通知结果不确定（unknown，停止自动补试，待人工/生产对账）: ${token}`);
    }
    this.runHook(input, entry);
  }

  private runHook(input: ArtifactInvalidationHookInput, entry: MonitorNotificationRecord): void {
    if (this.hooked.has(input.flow.token)) return;
    this.hooked.add(input.flow.token);
    try {
      this.options.hooks?.onInvalidated?.(input);
    } catch (error) {
      entry.hookError = (error as Error).message;
      console.error(`[制品监测] onInvalidated 钩子异常（已记录，不影响失效状态）: ${(error as Error).message}`);
    }
  }

  private record(entry: MonitorAuditEntry): void {
    this.audit.push(entry);
    if (this.audit.length > 2000) this.audit.shift();
    if (this.notifications.length > 2000) this.notifications.shift();
  }
}
