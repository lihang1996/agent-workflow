/**
 * ZCode CLI 纯 NDJSON 帧层客户端（无 spawn、无 transport 实现）。
 * 生产 runner 注入 write/读循环边界；本模块只做帧校验、预算、pending/tombstone
 * 与两个受信 reverse 方法的路由。错误消息恒定，不回显对端 method/params/消息体。
 */

/** 出站（客户端 -> CLI）request 方法白名单。 */
export type ZcodeForwardMethod =
  | 'runtime/capabilities'
  | 'provider/updateAccountConfig'
  | 'session/create'
  | 'session/resume'
  | 'session/read'
  | 'session/subscribe'
  | 'session/send'
  | 'session/debug'
  | 'session/stop'
  | 'session/close';

const FORWARD_METHODS: ReadonlySet<string> = new Set<ZcodeForwardMethod>([
  'runtime/capabilities',
  'provider/updateAccountConfig',
  'session/create',
  'session/resume',
  'session/read',
  'session/subscribe',
  'session/send',
  'session/debug',
  'session/stop',
  'session/close',
]);

/** 受信 reverse request（CLI -> 客户端）方法白名单；深层 lease/身份校验在 AuthHost。 */
export type ZcodeReverseMethod =
  | 'interaction/requestProviderRuntimeHeaders'
  | 'session/requestRuntimePreferences';

const REVERSE_METHODS: ReadonlySet<string> = new Set<ZcodeReverseMethod>([
  'interaction/requestProviderRuntimeHeaders',
  'session/requestRuntimePreferences',
]);

const NOTIFICATION_METHODS: ReadonlySet<string> = new Set([
  'session/event',
  'interaction/providerRuntimeHeadersCancelled',
]);

/** 官方 trace 允许的键；验证后忽略，不进 observer。 */
const TRACE_KEYS: ReadonlySet<string> = new Set([
  'traceparent',
  'traceId',
  'parentId',
  'spanId',
]);

const FIXED_MESSAGES = Object.freeze({
  transport: 'zcode protocol transport failure',
  eof: 'zcode protocol stream ended',
  disposed: 'zcode protocol client disposed',
  aborted: 'zcode protocol request aborted',
  timeout: 'zcode protocol request timeout',
  frame: 'zcode protocol frame invalid',
  response: 'zcode protocol error response',
  overflow: 'zcode protocol budget exceeded',
  concurrency: 'zcode protocol concurrency exceeded',
  encode: 'zcode protocol outbound frame invalid',
  observer: 'zcode protocol observer failed',
  limits: 'zcode protocol limits invalid',
  id: 'zcode protocol request id invalid',
  handler: 'zcode protocol reverse handler failure',
} as const);

/** 固定 message 的协议错误；code 为对端 error.code 或内部固定码。 */
export class ZcodeProtocolError extends Error {
  readonly code: number;
  constructor(code: number, kind: keyof typeof FIXED_MESSAGES = 'frame') {
    super(FIXED_MESSAGES[kind]);
    this.name = 'ZcodeProtocolError';
    this.code = code;
  }
}

export interface ZcodeLimits {
  /** 单帧上限（UTF-8 字节），默认 2MiB。 */
  maxFrameBytes?: number;
  /** 累计入站上限（UTF-8 字节），默认 32MiB。 */
  maxTotalBytes?: number;
  /** pending request 上限，默认 128。 */
  maxPending?: number;
  /** 并发 reverse 处理上限，默认 8。 */
  maxReverse?: number;
  /** 响应 tombstone 数量上限，默认 128。 */
  maxTombstones?: number;
  /** tombstone TTL 毫秒，默认 60000。 */
  tombstoneTtlMs?: number;
}

export interface ZcodeFrameMeta {
  direction: 'inbound' | 'outbound';
  category:
    | 'request'
    | 'notification'
    | 'response'
    | 'reverse-request'
    | 'reverse-response'
    | 'ignored'
    | 'unknown';
  method?: string;
  id?: string | number;
  errorCode?: number;
}

export interface ZcodeClientOptions {
  write(frame: string): void | Promise<void>;
  onReverseRequest(
    request: { id: string | number; method: ZcodeReverseMethod; params?: unknown },
    signal: AbortSignal,
  ): Promise<unknown>;
  onNotification?(notification: { method: string; params?: unknown }): void;
  observe?(meta: ZcodeFrameMeta): void;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  limits?: ZcodeLimits;
  /** 受信请求 ID 工厂；产出 invalid 或与 pending/tombstone 冲突的 ID 时失败关闭。 */
  idFactory?(): string | number;
  now?(): number;
}

interface PendingEntry {
  resolve(value: unknown): void;
  reject(error: ZcodeProtocolError): void;
  timer?: ReturnType<typeof setTimeout>;
  cleanup(): void;
}

const DEFAULT_LIMITS = {
  maxFrameBytes: 2 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxPending: 128,
  maxReverse: 8,
  maxTombstones: 128,
  tombstoneTtlMs: 60_000,
};

/** setTimeout 上限；0/NaN/Infinity 一律拒绝，不能借此关掉计时器。 */
const MAX_TIMEOUT_MS = 2_147_483_647;

function isValidTimeout(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS;
}

/** 逐字段 limits 校验：缺省用默认；给定值须为正 safe integer 且不超过原默认上限。 */
function resolveLimits(limits?: ZcodeLimits): Required<ZcodeLimits> {
  const resolved: Required<ZcodeLimits> = { ...DEFAULT_LIMITS };
  if (limits === undefined) return resolved;
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof ZcodeLimits)[]) {
    const value = limits[key];
    if (value === undefined) continue;
    if (
      typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || value <= 0
      || value > DEFAULT_LIMITS[key]
    ) {
      throw new ZcodeProtocolError(-32100, 'limits');
    }
    resolved[key] = value;
  }
  return resolved;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidId(value: unknown): value is string | number {
  if (typeof value === 'string') return value.length > 0 && value.length <= 256;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  return false;
}

function isValidMethod(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isSafeErrorCode(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** reverse handler 因排队期间连接关闭而被跳过时的内部哨兵值。 */
const REVERSE_SKIPPED = Symbol('zcodeReverseSkipped');

export class ZcodeProtocolClient {
  private readonly write: ZcodeClientOptions['write'];
  private readonly onReverseRequest: ZcodeClientOptions['onReverseRequest'];
  private readonly onNotification?: ZcodeClientOptions['onNotification'];
  private readonly observe?: ZcodeClientOptions['observe'];
  private readonly requestTimeoutMs: number;
  private readonly limits: Required<ZcodeLimits>;
  private readonly idFactory: () => string | number;
  private readonly now: () => number;

  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private lineBuffer = '';
  private totalBytes = 0;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<string | number, PendingEntry>();
  private readonly reverseInFlight = new Set<string | number>();
  private readonly reverseControllers = new Set<AbortController>();
  private readonly tombstones = new Map<string | number, number>();
  private readonly constructorSignal?: AbortSignal;
  private readonly constructorAbortListener: () => void;

  constructor(options: ZcodeClientOptions) {
    this.write = options.write;
    this.onReverseRequest = options.onReverseRequest;
    this.onNotification = options.onNotification;
    this.observe = options.observe;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    if (!isValidTimeout(this.requestTimeoutMs)) {
      throw new ZcodeProtocolError(-32100, 'limits');
    }
    this.limits = resolveLimits(options.limits);
    this.idFactory = options.idFactory ?? (() => this.nextId++);
    this.now = options.now ?? (() => Date.now());
    this.constructorSignal = options.signal;
    this.constructorAbortListener = () => this.dispose();
    if (options.signal) {
      options.signal.addEventListener('abort', this.constructorAbortListener, { once: true });
      if (options.signal.aborted) this.dispose();
    }
  }

  /** 发一个白名单 request；返回对端 result 原值。 */
  request(
    method: ZcodeForwardMethod,
    params?: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new ZcodeProtocolError(-32099, 'disposed'));
    }
    if (!FORWARD_METHODS.has(method)) {
      return Promise.reject(new ZcodeProtocolError(-32601, 'frame'));
    }
    // 已 abort 的信号在任何编码/写入之前拒绝并封口，不保留活跃认证。
    if (options?.signal?.aborted) {
      return this.sealRejected(new ZcodeProtocolError(-32000, 'aborted'));
    }
    const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
    if (!isValidTimeout(timeoutMs)) {
      return Promise.reject(new ZcodeProtocolError(-32100, 'limits'));
    }
    if (this.pending.size >= this.limits.maxPending) {
      return Promise.reject(new ZcodeProtocolError(-32098, 'concurrency'));
    }
    let id: string | number;
    try {
      id = this.idFactory();
    } catch {
      return this.failRequestId();
    }
    if (!isValidId(id) || this.idCollides(id)) {
      return this.failRequestId();
    }
    // idFactory 同步回调里可能已触发 abort/dispose，不再登记或发送。
    if (this.closed || options?.signal?.aborted) {
      return this.sealRejected(new ZcodeProtocolError(-32000, 'aborted'));
    }
    let frame: string;
    try {
      const body: Record<string, unknown> = { id, method };
      if (params !== undefined) body.params = params;
      frame = `${JSON.stringify(body)}\n`;
      if (
        !this.frameKeepsShape(frame, body)
        || Buffer.byteLength(frame, 'utf8') > this.limits.maxFrameBytes
      ) {
        return Promise.reject(new ZcodeProtocolError(-32097, 'encode'));
      }
    } catch {
      return Promise.reject(new ZcodeProtocolError(-32097, 'encode'));
    }
    // 序列化钩子（params.toJSON 等）可能同步触发 abort/dispose。
    if (this.closed || options?.signal?.aborted) {
      return this.sealRejected(new ZcodeProtocolError(-32000, 'aborted'));
    }
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      // 单 RPC 超时/中止按合同 failAll：拒绝所有 pending、abort 认证 handler、封口清理。
      const abortListener = () => {
        this.failAll(new ZcodeProtocolError(-32000, 'aborted'));
      };
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        options?.signal?.removeEventListener('abort', abortListener);
        this.pending.delete(id);
      };
      const entry: PendingEntry = {
        resolve,
        reject,
        cleanup,
        timer: undefined,
      };
      timer = setTimeout(() => {
        this.failAll(new ZcodeProtocolError(-32001, 'timeout'));
      }, timeoutMs);
      entry.timer = timer;
      options?.signal?.addEventListener('abort', abortListener, { once: true });
      this.pending.set(id, entry);
      // 注册后立即复查，避免登记与检查之间错过 abort 事件。
      if (options?.signal?.aborted || this.closed) {
        this.failAll(new ZcodeProtocolError(-32000, 'aborted'));
        return;
      }
      this.emit({ direction: 'outbound', category: 'request', method, id });
      this.sendFrame(frame);
    });
  }

  /** ID 工厂产出非法或冲突 ID：失败关闭并返回同一固定错误。 */
  private failRequestId(): Promise<never> {
    const error = new ZcodeProtocolError(-32101, 'id');
    this.failAll(error);
    return Promise.reject(error);
  }

  /** 封口（failAll）后以同一固定错误拒绝本次调用。 */
  private sealRejected(error: ZcodeProtocolError): Promise<never> {
    this.failAll(error);
    return Promise.reject(error);
  }

  /** typed 精确比较：数字 1 与字符串 '1' 是不同协议 ID；过期 tombstone 视为不存在。 */
  private idCollides(id: string | number): boolean {
    if (this.pending.has(id)) return true;
    const expiry = this.tombstones.get(id);
    return expiry !== undefined && expiry > this.now();
  }

  /** 注入一段入站字节（string 按 UTF-8 字节计）。先计字节预算再 decode。 */
  push(chunk: Buffer | string): void {
    if (this.closed) return;
    const byteLength = typeof chunk === 'string'
      ? Buffer.byteLength(chunk, 'utf8')
      : chunk.byteLength;
    this.totalBytes += byteLength;
    if (this.totalBytes > this.limits.maxTotalBytes) {
      this.failAll(new ZcodeProtocolError(-32003, 'overflow'));
      return;
    }
    let text: string;
    try {
      text = this.decoder.decode(
        typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk,
        { stream: true },
      );
    } catch {
      this.failAll(new ZcodeProtocolError(-32002, 'frame'));
      return;
    }
    this.lineBuffer += text;
    let newline = this.lineBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.lineBuffer.slice(0, newline);
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      // 单帧预算按每行计算，而不是整个未切分 buffer。
      if (Buffer.byteLength(line, 'utf8') > this.limits.maxFrameBytes) {
        this.failAll(new ZcodeProtocolError(-32004, 'overflow'));
        return;
      }
      this.handleLine(line);
      if (this.closed) return;
      newline = this.lineBuffer.indexOf('\n');
    }
    if (Buffer.byteLength(this.lineBuffer, 'utf8') > this.limits.maxFrameBytes) {
      this.failAll(new ZcodeProtocolError(-32004, 'overflow'));
    }
  }

  /** 入站 EOF：无换行尾行可解析（响应先交付），随后全部 pending 拒绝。 */
  end(): void {
    if (this.closed) return;
    let tail: string;
    try {
      tail = this.decoder.decode();
    } catch {
      this.failAll(new ZcodeProtocolError(-32005, 'frame'));
      return;
    }
    this.lineBuffer += tail;
    if (this.lineBuffer.trim() !== '') {
      this.handleLine(this.lineBuffer);
      this.lineBuffer = '';
    }
    if (!this.closed) {
      this.failAll(new ZcodeProtocolError(-32006, 'eof'));
    }
  }

  /** transport 侧自报失败：关闭并拒绝全部 pending。 */
  transportFailed(): void {
    if (this.closed) return;
    this.failAll(new ZcodeProtocolError(-32007, 'transport'));
  }

  /** 幂等释放：封口、abort reverse、拒绝 pending、清 timer/listener/buffer。 */
  dispose(): void {
    if (this.closed) return;
    this.failAll(new ZcodeProtocolError(-32008, 'disposed'));
  }

  isClosed(): boolean {
    return this.closed;
  }

  // ---- 内部 ----

  private emit(meta: ZcodeFrameMeta): void {
    if (!this.observe) return;
    try {
      this.observe(meta);
    } catch {
      this.failAll(new ZcodeProtocolError(-32009, 'observer'));
    }
  }

  /** 统一写路径：closed 后禁止新交 write；同步抛错/异步 reject 均转固定 transport 错误并关闭。 */
  private sendFrame(frame: string): void {
    if (this.closed) return;
    let result: unknown;
    try {
      result = this.write(frame);
    } catch {
      this.failAll(new ZcodeProtocolError(-32010, 'transport'));
      return;
    }
    Promise.resolve(result).then(
      () => undefined,
      () => {
        if (!this.closed) this.failAll(new ZcodeProtocolError(-32011, 'transport'));
      },
    );
  }

  /** 所有出站帧统一编码与字节预算；编码失败返回 undefined 由调用方固定失败关闭。 */
  private encodeFrame(body: Record<string, unknown>): string | undefined {
    try {
      const text = `${JSON.stringify(body)}\n`;
      if (Buffer.byteLength(text, 'utf8') > this.limits.maxFrameBytes) return undefined;
      return text;
    } catch {
      return undefined;
    }
  }

  /** 确认编码后的实际 JSON 仍含 body 全部自有键；toJSON/函数值会静默丢字段。 */
  private frameKeepsShape(frameText: string, body: Record<string, unknown>): boolean {
    try {
      const parsed: unknown = JSON.parse(frameText);
      if (!isPlainObject(parsed)) return false;
      return Object.keys(body).every((key) => key in parsed);
    } catch {
      return false;
    }
  }

  private settle(id: string | number, finish: () => void): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    entry.cleanup();
    finish();
    this.recordTombstone(id);
  }

  private recordTombstone(id: string | number): void {
    const now = this.now();
    for (const [key, expiry] of this.tombstones) {
      if (expiry <= now) this.tombstones.delete(key);
    }
    while (this.tombstones.size >= this.limits.maxTombstones) {
      const oldest = this.tombstones.keys().next();
      if (oldest.done) break;
      this.tombstones.delete(oldest.value);
    }
    this.tombstones.set(id, now + this.limits.tombstoneTtlMs);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let frame: unknown;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      this.failAll(new ZcodeProtocolError(-32012, 'frame'));
      return;
    }
    if (!isPlainObject(frame)) {
      this.failAll(new ZcodeProtocolError(-32013, 'frame'));
      return;
    }
    if ('jsonrpc' in frame) {
      this.failAll(new ZcodeProtocolError(-32014, 'frame'));
      return;
    }
    if ('method' in frame) {
      this.handleHasMethod(frame);
      return;
    }
    this.handleResponse(frame);
  }

  private handleHasMethod(frame: Record<string, unknown>): void {
    const { id, method, params, trace } = frame;
    if (!isValidMethod(method)) {
      this.failAll(new ZcodeProtocolError(-32015, 'frame'));
      return;
    }
    if (trace !== undefined && !isValidTrace(trace)) {
      this.failAll(new ZcodeProtocolError(-32016, 'frame'));
      return;
    }
    for (const key of Object.keys(frame)) {
      if (key !== 'id' && key !== 'method' && key !== 'params' && key !== 'trace') {
        this.failAll(new ZcodeProtocolError(-32019, 'frame'));
        return;
      }
    }
    const knownReverse = REVERSE_METHODS.has(method);
    const knownNotification = NOTIFICATION_METHODS.has(method);
    // 已识别 method 要求 params 为 object 且不可缺；未知 method 的 params 是 unknown。
    if ((knownReverse || knownNotification) && !isPlainObject(params)) {
      this.failAll(new ZcodeProtocolError(-32017, 'frame'));
      return;
    }
    if (id === undefined) {
      this.handleNotification(method, params);
      return;
    }
    if (!isValidId(id)) {
      this.failAll(new ZcodeProtocolError(-32018, 'frame'));
      return;
    }
    this.handleReverse(id, method, params);
  }

  private handleNotification(method: string, params: unknown): void {
    if (!NOTIFICATION_METHODS.has(method)) {
      this.emit({ direction: 'inbound', category: 'ignored' });
      return;
    }
    this.emit({ direction: 'inbound', category: 'notification', method });
    if (this.closed) return;
    try {
      this.onNotification?.({ method, params });
    } catch {
      this.failAll(new ZcodeProtocolError(-32020, 'frame'));
    }
  }

  private handleReverse(id: string | number, method: string, params: unknown): void {
    if (!REVERSE_METHODS.has(method)) {
      this.emit({ direction: 'inbound', category: 'unknown', id });
      if (this.closed) return;
      const frameText = this.encodeFrame({
        id,
        error: { code: -32601, message: 'method not found' },
      });
      if (frameText === undefined) {
        this.failAll(new ZcodeProtocolError(-32024, 'encode'));
        return;
      }
      this.sendFrame(frameText);
      return;
    }
    if (this.reverseInFlight.has(id)) {
      this.failAll(new ZcodeProtocolError(-32022, 'frame'));
      return;
    }
    if (this.reverseControllers.size >= this.limits.maxReverse) {
      this.failAll(new ZcodeProtocolError(-32023, 'concurrency'));
      return;
    }
    this.emit({ direction: 'inbound', category: 'reverse-request', method, id });
    if (this.closed) return;
    const controller = new AbortController();
    this.reverseInFlight.add(id);
    this.reverseControllers.add(controller);
    const finishReverse = (build: () => { meta: ZcodeFrameMeta; body: Record<string, unknown> }): void => {
      this.reverseControllers.delete(controller);
      const wasInFlight = this.reverseInFlight.delete(id);
      if (this.closed || !wasInFlight) return;
      const { meta, body } = build();
      this.emit(meta);
      if (this.closed) return;
      const frameText = this.encodeFrame(body);
      if (frameText === undefined || !this.frameKeepsShape(frameText, body)) {
        this.failAll(new ZcodeProtocolError(-32024, 'encode'));
        return;
      }
      this.sendFrame(frameText);
    };
    // 不能await handler：调用方可能在 handler 里 request('session/read')，
    // 路由循环必须继续处理后续响应帧，否则死锁。排队期间可能已 dispose/end/
    // abort 或 id 不再 inflight，此时不得调用 handler。同步 throw / 异步 reject
    // 一律由 reject 分支转固定 -32603。链尾不再静默吞错：链本身异常（如
    // finishReverse 内部抛出）按合同 failAll（封口、abort reverse、拒绝全部
    // pending），错误固定为 -32035，不外泄原始 Error/params/result。
    Promise.resolve()
      .then(() => {
        if (this.closed || controller.signal.aborted || !this.reverseInFlight.has(id)) {
          return REVERSE_SKIPPED;
        }
        return this.onReverseRequest(
          { id, method: method as ZcodeReverseMethod, params },
          controller.signal,
        );
      })
      .then(
        (result) => {
          if (result === REVERSE_SKIPPED) return;
          finishReverse(() => ({
            meta: { direction: 'outbound', category: 'reverse-response', id },
            body: { id, result } as Record<string, unknown>,
          }));
        },
        () => {
          finishReverse(() => ({
            meta: { direction: 'outbound', category: 'reverse-response', id, errorCode: -32603 },
            body: { id, error: { code: -32603, message: 'internal error' } },
          }));
        },
      )
      .catch(() => {
        this.failAll(new ZcodeProtocolError(-32035, 'handler'));
      });
  }

  private handleResponse(frame: Record<string, unknown>): void {
    const { id, result, error } = frame;
    if (!isValidId(id)) {
      this.failAll(new ZcodeProtocolError(-32025, 'frame'));
      return;
    }
    const hasResult = Object.prototype.hasOwnProperty.call(frame, 'result');
    if (hasResult && error !== undefined) {
      this.failAll(new ZcodeProtocolError(-32026, 'frame'));
      return;
    }
    if ('trace' in frame) {
      this.failAll(new ZcodeProtocolError(hasResult ? -32031 : -32028, 'frame'));
      return;
    }
    for (const key of Object.keys(frame)) {
      if (key !== 'id' && key !== 'result' && key !== 'error') {
        this.failAll(new ZcodeProtocolError(-32027, 'frame'));
        return;
      }
    }
    if (error !== undefined && !hasResult) {
      const peerCode = isPlainObject(error) ? error.code : undefined;
      if (
        !isPlainObject(error)
        || !isSafeErrorCode(peerCode)
        || typeof error.message !== 'string'
        || error.message.length === 0
        || error.message.length > 8192
      ) {
        this.failAll(new ZcodeProtocolError(-32029, 'frame'));
        return;
      }
      // error 内部仅允许 code/message/data；未知额外键拒绝。
      for (const key of Object.keys(error)) {
        if (key !== 'code' && key !== 'message' && key !== 'data') {
          this.failAll(new ZcodeProtocolError(-32034, 'frame'));
          return;
        }
      }
      this.deliver(id, (entry) => {
        entry.reject(new ZcodeProtocolError(peerCode, 'response'));
      }, peerCode);
      return;
    }
    if (!hasResult) {
      this.failAll(new ZcodeProtocolError(-32030, 'frame'));
      return;
    }
    if ('trace' in frame) {
      this.failAll(new ZcodeProtocolError(-32031, 'frame'));
      return;
    }
    this.deliver(id, (entry) => entry.resolve(result));
  }

  private deliver(
    id: string | number,
    finish: (entry: PendingEntry) => void,
    errorCode?: number,
  ): void {
    const entry = this.pending.get(id);
    if (entry) {
      this.emit(
        errorCode === undefined
          ? { direction: 'inbound', category: 'response', id }
          : { direction: 'inbound', category: 'response', id, errorCode },
      );
      this.settle(id, () => finish(entry));
      return;
    }
    const expiry = this.tombstones.get(id);
    if (expiry !== undefined) {
      if (expiry <= this.now()) {
        this.tombstones.delete(id);
        this.failAll(new ZcodeProtocolError(-32032, 'frame'));
      } else {
        this.emit({ direction: 'inbound', category: 'ignored', id });
      }
      return;
    }
    this.failAll(new ZcodeProtocolError(-32033, 'frame'));
  }

  private failAll(error: ZcodeProtocolError): void {
    if (this.closed) return;
    this.closed = true;
    this.constructorSignal?.removeEventListener('abort', this.constructorAbortListener);
    for (const controller of this.reverseControllers) controller.abort();
    this.reverseControllers.clear();
    this.reverseInFlight.clear();
    this.lineBuffer = '';
    this.tombstones.clear();
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.cleanup();
      entry.reject(error);
    }
  }
}

function isValidTrace(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (!TRACE_KEYS.has(key)) return false;
    const item = value[key];
    if (typeof item !== 'string' || item.length === 0 || item.length > 256) return false;
  }
  return true;
}
