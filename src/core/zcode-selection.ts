/**
 * 纯模块：ZCode provider 的模型选择规范化与非秘密运行证据核验。
 * 不启动 CLI、不读取 SDK/个人配置、不 import SDK；只接受受信 providerId、
 * 只读模型目录与已有 ModelSelection。绝不生成 Entitlement/账号身份/服务端档位证据。
 *
 * 本模块不内置"当前真实目录"（没有 SDK 实时来源），目录由调用方传入并逐次核验；
 * 运行时白名单独立于目录：目录只能进一步收窄，不能放行目录外的新模型/档位。
 */
import type { ModelSelection } from './model-selection.js';

export const ZCODE_PROVIDER_ID = 'account:bigmodel-individual-coding-plan';

export type ZcodeProviderId = 'account:bigmodel-individual-coding-plan';
export type ZcodeModelId = 'GLM-5.3' | 'GLM-5.3-Flash';
export type ZcodeReasoningLevel = 'low' | 'high' | 'max';

/** 运行时白名单：独立于任何传入目录，目录只允许收窄、不允许放宽。 */
const RUNTIME_PROVIDERS: ReadonlySet<string> = new Set([ZCODE_PROVIDER_ID]);
const RUNTIME_MODELS: ReadonlySet<string> = new Set(['GLM-5.3', 'GLM-5.3-Flash']);
const RUNTIME_LEVELS: ReadonlySet<string> = new Set(['low', 'high', 'max']);

export interface ZcodeCatalogModel {
  readonly modelId: string;
  readonly reasoningLevels: readonly ZcodeReasoningLevel[];
}

export interface ZcodeCatalogProvider {
  readonly providerId: string;
  readonly models: readonly ZcodeCatalogModel[];
}

/** 供后续 SDK facade 映射的只读模型目录类型；本模块不 import SDK、不内置当前目录。 */
export interface ZcodeModelCatalog {
  readonly providers: readonly ZcodeCatalogProvider[];
}

export const ZCODE_SELECTION_LIMITS = deepFreeze({
  maxCatalogProviders: 256,
  maxCatalogModels: 256,
  maxReasoningLevels: 16,
  maxNetworkEntries: 10000,
  maxStringLength: 256,
}) as {
  readonly maxCatalogProviders: 256;
  readonly maxCatalogModels: 256;
  readonly maxReasoningLevels: 16;
  readonly maxNetworkEntries: 10000;
  readonly maxStringLength: 256;
};

export type ZcodeSelectionErrorCode =
  | 'E_STRING_TOO_LONG'
  | 'E_MISSING_MODEL'
  | 'E_MISSING_EFFORT'
  | 'E_UNSUPPORTED_PROVIDER'
  | 'E_UNSUPPORTED_MODEL'
  | 'E_NONCANONICAL_MODEL'
  | 'E_UNSUPPORTED_EFFORT'
  | 'E_CATALOG_INVALID'
  | 'E_CATALOG_BUDGET'
  | 'E_SNAPSHOT_INVALID'
  | 'E_SNAPSHOT_CONFLICT'
  | 'E_CALLBACK_INVALID'
  | 'E_CALLBACK_CONFLICT'
  | 'E_SELECTION_INVALID'
  | 'E_CONFIRMED_INVALID'
  | 'E_DEBUG_INVALID'
  | 'E_NETWORK_BUDGET'
  | 'E_NO_COMPLETED'
  | 'E_COMPLETED_MISMATCH'
  | 'E_STATUS_INVALID';

/** 固定错误码与固定消息；不回显任意未知输入，也不携带 secret。 */
export class ZcodeSelectionError extends Error {
  readonly code: ZcodeSelectionErrorCode;
  constructor(code: ZcodeSelectionErrorCode, message: string) {
    super(message);
    this.name = 'ZcodeSelectionError';
    this.code = code;
  }
}

function fail(code: ZcodeSelectionErrorCode, message: string): never {
  throw new ZcodeSelectionError(code, message);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkString(value: unknown, code: ZcodeSelectionErrorCode, message: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(code, message);
  if (value.length > ZCODE_SELECTION_LIMITS.maxStringLength) fail('E_STRING_TOO_LONG', '输入字符串超出长度预算');
  return value;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= ZCODE_SELECTION_LIMITS.maxStringLength;
}

/** 目录逐次核验：形态、provider 数与累计模型数预算、字符串预算、levels 预算、重复与畸形项。 */
function validateCatalog(catalog: ZcodeModelCatalog): void {
  if (!isPlainObject(catalog) || !Array.isArray(catalog.providers)) {
    fail('E_CATALOG_INVALID', '模型目录形态非法');
  }
  if (catalog.providers.length > ZCODE_SELECTION_LIMITS.maxCatalogProviders) {
    fail('E_CATALOG_BUDGET', '模型目录 provider 数超出预算，拒绝处理');
  }
  const seenProviders = new Set<string>();
  let totalModels = 0;
  for (const rawProvider of catalog.providers) {
    if (!isPlainObject(rawProvider) || !Array.isArray(rawProvider.models)) {
      fail('E_CATALOG_INVALID', '模型目录 provider 项形态非法');
    }
    if (typeof rawProvider.providerId !== 'string' || rawProvider.providerId.length === 0) {
      fail('E_CATALOG_INVALID', '模型目录 providerId 形态非法');
    }
    if (rawProvider.providerId.length > ZCODE_SELECTION_LIMITS.maxStringLength) {
      fail('E_STRING_TOO_LONG', '输入字符串超出长度预算');
    }
    if (seenProviders.has(rawProvider.providerId)) {
      fail('E_CATALOG_INVALID', '模型目录存在重复 provider，拒绝处理');
    }
    seenProviders.add(rawProvider.providerId);
    const seenModels = new Set<string>();
    for (const rawModel of rawProvider.models) {
      if (!isPlainObject(rawModel) || !Array.isArray(rawModel.reasoningLevels)) {
        fail('E_CATALOG_INVALID', '模型目录模型项形态非法');
      }
      if (typeof rawModel.modelId !== 'string' || rawModel.modelId.length === 0) {
        fail('E_CATALOG_INVALID', '模型目录 modelId 形态非法');
      }
      if (rawModel.modelId.length > ZCODE_SELECTION_LIMITS.maxStringLength) {
        fail('E_STRING_TOO_LONG', '输入字符串超出长度预算');
      }
      if (seenModels.has(rawModel.modelId)) {
        fail('E_CATALOG_INVALID', '模型目录存在重复模型，拒绝处理');
      }
      seenModels.add(rawModel.modelId);
      if (rawModel.reasoningLevels.length > ZCODE_SELECTION_LIMITS.maxReasoningLevels) {
        fail('E_CATALOG_BUDGET', 'reasoningLevels 数组超出预算，拒绝处理');
      }
      for (const level of rawModel.reasoningLevels) {
        if (typeof level !== 'string' || !RUNTIME_LEVELS.has(level)) {
          fail('E_CATALOG_INVALID', '模型目录 reasoningLevels 项形态非法');
        }
      }
      totalModels += 1;
      if (totalModels > ZCODE_SELECTION_LIMITS.maxCatalogModels) {
        fail('E_CATALOG_BUDGET', '模型目录超出预算，拒绝处理');
      }
    }
  }
}

export interface CanonicalZcodeSelection {
  readonly providerId: ZcodeProviderId;
  readonly modelId: ZcodeModelId;
  readonly options: { readonly reasoningLevel: ZcodeReasoningLevel };
  readonly thoughtLevel: ZcodeReasoningLevel;
}

/**
 * 规范化为 canonical 形态；model 与 effort 不可缺，不默认补 high、不静默回退。
 * 运行时白名单独立于目录；目录核验通过后才做查找，且目录只能收窄白名单。
 * 输出为冻结的独立副本，不受调用方目录后续变更影响。
 */
export function normalizeZcodeSelection(
  selection: ModelSelection,
  providerId: string,
  catalog: ZcodeModelCatalog,
): CanonicalZcodeSelection {
  if (selection.model === null || selection.model === undefined) {
    fail('E_MISSING_MODEL', '必须显式指定 model，不能使用默认模型');
  }
  if (selection.reasoningEffort === null || selection.reasoningEffort === undefined) {
    fail('E_MISSING_EFFORT', '必须显式指定 reasoning effort，不能默认补 high');
  }
  if (typeof providerId !== 'string' || providerId.length === 0) {
    fail('E_UNSUPPORTED_PROVIDER', 'providerId 标识非法');
  }
  if (providerId.length > ZCODE_SELECTION_LIMITS.maxStringLength) {
    fail('E_STRING_TOO_LONG', '输入字符串超出长度预算');
  }
  if (!RUNTIME_PROVIDERS.has(providerId)) {
    fail('E_UNSUPPORTED_PROVIDER', 'provider 不在运行时白名单中');
  }
  const modelId = checkString(selection.model, 'E_UNSUPPORTED_MODEL', 'model 标识非法');
  const effortRaw = checkString(selection.reasoningEffort, 'E_UNSUPPORTED_EFFORT', 'reasoning effort 标识非法');

  // 目录预算/形态核验先于任何目录查找，避免畸形或超预算目录驱动无界查找。
  validateCatalog(catalog);

  if (!RUNTIME_MODELS.has(modelId)) {
    if ([...RUNTIME_MODELS].some((candidate) => candidate.toLowerCase() === modelId.toLowerCase())) {
      // 旧 glm-5.3 等大小写别名不自动猜测；错误消息固定，不回显输入。
      fail('E_NONCANONICAL_MODEL', 'model 别名不获自动映射；请使用目录中的 canonical 名称');
    }
    fail('E_UNSUPPORTED_MODEL', 'model 不在运行时白名单中');
  }
  if (!RUNTIME_LEVELS.has(effortRaw)) {
    fail('E_UNSUPPORTED_EFFORT', 'reasoning effort 不在运行时白名单中');
  }

  const provider = catalog.providers.find((entry) => entry.providerId === providerId);
  if (!provider) fail('E_UNSUPPORTED_PROVIDER', 'provider 不在受信目录中');
  if (provider.models.length === 0) fail('E_UNSUPPORTED_MODEL', 'provider 目录为空，模型已被撤出目录');
  const exact = provider.models.find((model) => model.modelId === modelId);
  if (!exact) fail('E_UNSUPPORTED_MODEL', 'model 不在当前目录中（可能已被撤出目录）');
  const level = effortRaw as ZcodeReasoningLevel;
  if (!exact.reasoningLevels.includes(level)) {
    fail('E_UNSUPPORTED_EFFORT', '该模型当前目录不支持指定的 reasoning effort');
  }

  return deepFreeze({
    providerId: providerId as ZcodeProviderId,
    modelId: exact.modelId as ZcodeModelId,
    options: { reasoningLevel: level },
    thoughtLevel: level,
  });
}

export interface VerifiedZcodeSettings {
  readonly kind: 'snapshot-verified';
  readonly sessionId: string;
  readonly providerId: ZcodeProviderId;
  readonly modelId: ZcodeModelId;
  readonly reasoningLevel: ZcodeReasoningLevel;
}

/** 模块私有登记：只有本模块真实核验过的对象才进入集合，结构伪造值不在其中。 */
const verifiedReadbacks = new WeakSet<VerifiedZcodeSettings>();
const verifiedCallbacks = new WeakMap<ZcodeCallbackEvidence, CanonicalZcodeSelection>();
const confirmedSessions = new WeakSet<ZcodeSessionConfirmed>();

function readField(source: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

/**
 * 统一的 canonical 运行时核验/复制：verifyZcodeSettingsSnapshot 与 verifyZcodeAuthCallback
 * 入口都必须先经过本 helper，typed readonly 不能代替运行时一致性。
 * 核验 provider 固定 Individual、model 在白名单、thoughtLevel 与 options.reasoningLevel
 * 均为合法档位且相等、options 为对象、字符串有界；畸形或不一致时抛固定 E_SELECTION_INVALID，
 * 不回显原输入。返回全新深度冻结副本，核验与后续绑定只用副本，不保存或改写调用者对象，
 * 因此调用者之后修改其 expected 不能污染已产生的证据。
 */
function validateCanonicalSelection(expected: unknown): CanonicalZcodeSelection {
  if (!isPlainObject(expected)) {
    fail('E_SELECTION_INVALID', 'expected canonical 选择形态非法');
  }
  const providerId = readField(expected, 'providerId');
  const modelId = readField(expected, 'modelId');
  const options = readField(expected, 'options');
  const thoughtLevel = readField(expected, 'thoughtLevel');
  if (!isBoundedString(providerId) || !isBoundedString(modelId)
    || !isBoundedString(thoughtLevel)) {
    fail('E_SELECTION_INVALID', 'expected canonical 选择字段形态非法');
  }
  if (providerId !== ZCODE_PROVIDER_ID || !RUNTIME_MODELS.has(modelId)
    || !RUNTIME_LEVELS.has(thoughtLevel)) {
    fail('E_SELECTION_INVALID', 'expected canonical 选择含不支持的 provider/model/档位');
  }
  if (!isPlainObject(options)) {
    fail('E_SELECTION_INVALID', 'expected canonical 缺少 options 对象');
  }
  const level = readField(options, 'reasoningLevel');
  if (!isBoundedString(level) || !RUNTIME_LEVELS.has(level) || level !== thoughtLevel) {
    fail('E_SELECTION_INVALID', 'expected canonical 的双档位不一致或不合法');
  }
  return deepFreeze({
    providerId: providerId as ZcodeProviderId,
    modelId: modelId as ZcodeModelId,
    options: { reasoningLevel: level as ZcodeReasoningLevel },
    thoughtLevel: thoughtLevel as ZcodeReasoningLevel,
  });
}

/**
 * 回读官方 settings snapshot（unknown）；不允许用 ?? 遮住冲突。
 * 官方 session/create 返回 snapshot.session.sessionId（canonical 字段）。
 * 核验其非空有界与 settings 双档位，返回带 sessionId 的已验证结果；
 * 不接受仅有旧 session.id 的伪官方 snapshot；若同时存在旧 id 且与 canonical
 * sessionId 不一致则明确拒绝，同值额外 id 仅作为附加字段容忍。
 * 结果登记在私有 WeakSet，普通结构对象或 normalizer 返回值不能冒充已验证回读。
 */
export function verifyZcodeSettingsSnapshot(
  snapshot: unknown,
  rawExpected: CanonicalZcodeSelection,
): VerifiedZcodeSettings {
  const expected = validateCanonicalSelection(rawExpected);
  if (!isPlainObject(snapshot) || !isPlainObject(snapshot.settings)) {
    fail('E_SNAPSHOT_INVALID', 'snapshot 缺少 settings，无法核验模型绑定');
  }
  if (!isPlainObject(snapshot.session)) {
    fail('E_SNAPSHOT_INVALID', 'snapshot 缺少 session 对象，无法核验会话');
  }
  if (!isBoundedString(snapshot.session.sessionId)) {
    fail('E_SNAPSHOT_INVALID', 'snapshot 缺少非空有界的 session.sessionId，无法核验会话');
  }
  const legacyId = readField(snapshot.session, 'id');
  if (legacyId !== undefined && legacyId !== snapshot.session.sessionId) {
    fail('E_SNAPSHOT_CONFLICT', 'session.id 与 canonical session.sessionId 不一致，拒绝歧义快照');
  }
  const settings = snapshot.settings;
  if (!isPlainObject(settings.model) || !isPlainObject(settings.model.current)) {
    fail('E_SNAPSHOT_INVALID', 'snapshot 缺少 settings.model.current，无法核验模型绑定');
  }
  const current = settings.model.current;
  const providerId = readField(current, 'providerId');
  const modelId = readField(current, 'modelId');
  if (providerId !== expected.providerId || modelId !== expected.modelId) {
    fail('E_SNAPSHOT_CONFLICT', 'snapshot 的 provider/model 与期望不符');
  }
  if (!isPlainObject(settings.thoughtLevel)) {
    fail('E_SNAPSHOT_INVALID', 'snapshot 缺少 settings.thoughtLevel，无法核验推理档位');
  }
  const thought = readField(settings.thoughtLevel, 'current');
  if (thought !== expected.thoughtLevel) {
    fail('E_SNAPSHOT_CONFLICT', 'snapshot 的 thoughtLevel 与期望不符');
  }
  const options = readField(current, 'options');
  if (options !== undefined) {
    if (!isPlainObject(options)) fail('E_SNAPSHOT_INVALID', 'settings.model.current.options 形态非法');
    const level = readField(options, 'reasoningLevel');
    if (level !== undefined && level !== expected.options.reasoningLevel) {
      fail('E_SNAPSHOT_CONFLICT', 'snapshot 的 options.reasoningLevel 与期望不符');
    }
  }
  const verified: VerifiedZcodeSettings = deepFreeze({
    kind: 'snapshot-verified',
    sessionId: snapshot.session.sessionId,
    providerId: expected.providerId,
    modelId: expected.modelId,
    reasoningLevel: expected.options.reasoningLevel,
  });
  verifiedReadbacks.add(verified);
  return verified;
}

export interface ZcodeCallbackEvidence {
  readonly kind: 'callback-verified';
  readonly providerId: ZcodeProviderId;
  readonly modelId: ZcodeModelId;
  /** 仅在回调真实携带并匹配时出现；缺省时不伪造 observed effort。 */
  readonly reasoningLevel?: ZcodeReasoningLevel;
}

/**
 * auth 回调核验：只验证 ModelSelection 子对象的 provider/model/options（深层 workspace
 * 等由后续 AuthHost 负责）；options 缺省合法，缺 effort 时不声称回调观测到了请求努力。
 * 证据登记在私有 WeakMap 并绑定 expected，供 confirm 做一致性比较。
 */
export function verifyZcodeAuthCallback(
  callback: unknown,
  rawExpected: CanonicalZcodeSelection,
): ZcodeCallbackEvidence {
  const expected = validateCanonicalSelection(rawExpected);
  if (!isPlainObject(callback)) fail('E_CALLBACK_INVALID', 'auth 回调数据形态非法');
  const providerId = readField(callback, 'providerId');
  const modelId = readField(callback, 'modelId');
  if (typeof providerId !== 'string' || typeof modelId !== 'string') {
    fail('E_CALLBACK_INVALID', 'auth 回调缺少 provider/model，无法核验');
  }
  if (providerId !== expected.providerId || modelId !== expected.modelId) {
    fail('E_CALLBACK_CONFLICT', 'auth 回调的 provider/model 与期望不符');
  }
  let observedLevel: ZcodeReasoningLevel | undefined;
  const options = readField(callback, 'options');
  if (options !== undefined) {
    if (!isPlainObject(options)) fail('E_CALLBACK_INVALID', 'auth 回调 options 形态非法');
    const level = readField(options, 'reasoningLevel');
    if (level !== undefined) {
      if (level !== expected.options.reasoningLevel) {
        fail('E_CALLBACK_CONFLICT', 'auth 回调的 effort 与期望冲突');
      }
      observedLevel = expected.options.reasoningLevel;
    }
  }
  const evidence: ZcodeCallbackEvidence = observedLevel === undefined
    ? deepFreeze({ kind: 'callback-verified', providerId: expected.providerId, modelId: expected.modelId })
    : deepFreeze({
      kind: 'callback-verified',
      providerId: expected.providerId,
      modelId: expected.modelId,
      reasoningLevel: observedLevel,
    });
  verifiedCallbacks.set(evidence, expected);
  return evidence;
}

export interface ZcodeSessionConfirmed {
  readonly kind: 'session-confirmed';
  readonly sessionId: string;
  readonly providerId: ZcodeProviderId;
  readonly modelId: ZcodeModelId;
  readonly reasoningLevel: ZcodeReasoningLevel;
}

/**
 * 只有本模块真实核验的回调证据 + 独立 session 回读同时成立才构造 session-confirmed；
 * 结构伪造值、normalizer 返回值都不被接受。这是纯库内防误用，不声称阻止恶意宿主。
 */
export function confirmZcodeSession(
  callback: ZcodeCallbackEvidence,
  sessionReadback: VerifiedZcodeSettings,
): ZcodeSessionConfirmed {
  const bound = verifiedCallbacks.get(callback);
  if (bound === undefined || !verifiedReadbacks.has(sessionReadback)) {
    fail('E_CONFIRMED_INVALID', '回调或回读不是本模块核验过的证据，不能构造 session-confirmed');
  }
  if (callback.providerId !== sessionReadback.providerId
    || callback.modelId !== sessionReadback.modelId) {
    fail('E_CALLBACK_CONFLICT', '回调与 session 回读不一致，不能构造 session-confirmed');
  }
  if (callback.reasoningLevel !== undefined && callback.reasoningLevel !== sessionReadback.reasoningLevel) {
    fail('E_CALLBACK_CONFLICT', '回调与 session 回读的推理档位不一致，不能构造 session-confirmed');
  }
  if (bound.options.reasoningLevel !== sessionReadback.reasoningLevel) {
    fail('E_CALLBACK_CONFLICT', '回调绑定的期望档位与 session 回读不一致，不能构造 session-confirmed');
  }
  const confirmed: ZcodeSessionConfirmed = deepFreeze({
    kind: 'session-confirmed',
    sessionId: sessionReadback.sessionId,
    providerId: sessionReadback.providerId,
    modelId: sessionReadback.modelId,
    reasoningLevel: sessionReadback.reasoningLevel,
  });
  confirmedSessions.add(confirmed);
  return confirmed;
}

export interface ZcodeCompletedRequest {
  readonly providerId: string;
  readonly modelId: string;
  readonly requestId: string;
  readonly statusCode?: number;
}

export interface ZcodeCompletionEvidence {
  readonly kind: 'model-request-completed';
  readonly sessionId: string;
  readonly queryId: string;
  readonly reasoningLevel: ZcodeReasoningLevel;
  /** effort 为 session-confirmed 的会话档位，不代表服务端内部实际推理档位。 */
  readonly reasoningLevelSource: 'session-confirmed';
  readonly requests: readonly ZcodeCompletedRequest[];
}

function isSafeIntegerStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 200 && value <= 299;
}

/**
 * 从 unknown debug 的 networkEntries 取得本次 query 的 completed 证据。
 * 官方 debug 真实返回 {sessionId, rounds, networkEntries, cache}，没有 queryInfo。
 * 只接受 confirmZcodeSession 返回的 confirmed；sessionId 必须等于 confirmed 与
 * debug.sessionId。匹配本次 main_turn + queryId 的每条 completed 记录都必须校验，
 * 不能只校验第一条；其他 query/source 不进证据。无匹配 completed 拒绝。
 * 输出只含白名单字段并深度冻结，不含 headers/error/debug 正文。
 */
export function verifyZcodeCompletion(
  debug: unknown,
  context: {
    sessionId: string;
    queryId: string;
    confirmed: ZcodeSessionConfirmed;
  },
): ZcodeCompletionEvidence {
  if (!isPlainObject(context.confirmed) || !confirmedSessions.has(context.confirmed)) {
    fail('E_CONFIRMED_INVALID', 'confirmed 不是本模块 confirmZcodeSession 的结果，不能证明完成');
  }
  const queryId = checkString(context.queryId, 'E_DEBUG_INVALID', 'queryId 非法');
  const sessionId = checkString(context.sessionId, 'E_DEBUG_INVALID', 'sessionId 非法');
  if (sessionId !== context.confirmed.sessionId) {
    fail('E_DEBUG_INVALID', 'context.sessionId 与 session-confirmed 的 sessionId 不符');
  }
  if (!isPlainObject(debug) || !Array.isArray(debug.networkEntries)) {
    fail('E_DEBUG_INVALID', 'debug 缺少 networkEntries，无法核验 completed 证据');
  }
  const entries = debug.networkEntries as unknown[];
  if (entries.length > ZCODE_SELECTION_LIMITS.maxNetworkEntries) {
    fail('E_NETWORK_BUDGET', 'networkEntries 超出预算，拒绝处理');
  }
  if (!isBoundedString(debug.sessionId) || debug.sessionId !== sessionId) {
    fail('E_DEBUG_INVALID', 'debug.sessionId 与本次会话不符，无法确认证据归属');
  }

  const requests: ZcodeCompletedRequest[] = [];
  for (const raw of entries) {
    if (!isPlainObject(raw)) continue;
    const entryQueryId = readField(raw, 'queryId');
    const querySource = readField(raw, 'querySource');
    const statusType = readField(raw, 'statusType');
    if (entryQueryId !== queryId || querySource !== 'main_turn') continue;
    if (statusType !== 'model_request_completed') continue;
    const providerId = readField(raw, 'providerId');
    const modelId = readField(raw, 'modelId');
    if (typeof providerId !== 'string' || typeof modelId !== 'string'
      || providerId !== context.confirmed.providerId || modelId !== context.confirmed.modelId) {
      // 同目标 query 里出现错 provider/model 的 completed 必须拒绝，绝不混用。
      fail('E_COMPLETED_MISMATCH', '同 query 存在 provider/model 不符的 completed 记录');
    }
    const requestId = readField(raw, 'requestId');
    if (typeof requestId !== 'string' || requestId.length === 0) {
      fail('E_DEBUG_INVALID', 'completed 记录缺少 requestId');
    }
    if (requestId.length > ZCODE_SELECTION_LIMITS.maxStringLength) {
      fail('E_STRING_TOO_LONG', '输入字符串超出长度预算');
    }
    const statusCode = readField(raw, 'statusCode');
    let request: { providerId: string; modelId: string; requestId: string; statusCode?: number };
    if (statusCode !== undefined) {
      if (!isSafeIntegerStatus(statusCode)) {
        fail('E_STATUS_INVALID', 'statusCode 非 2xx safe integer，拒绝该 completed 记录');
      }
      request = { providerId, modelId, requestId, statusCode };
    } else {
      request = { providerId, modelId, requestId };
    }
    requests.push(request);
  }
  if (requests.length === 0) {
    fail('E_NO_COMPLETED', '本次 query 缺少 model_request_completed 记录，不能通过');
  }
  return deepFreeze({
    kind: 'model-request-completed',
    sessionId,
    queryId,
    reasoningLevel: context.confirmed.reasoningLevel,
    reasoningLevelSource: 'session-confirmed',
    requests: deepFreeze(requests),
  });
}
