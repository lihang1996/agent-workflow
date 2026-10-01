import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZCODE_PROVIDER_ID,
  ZcodeSelectionError,
  normalizeZcodeSelection,
  verifyZcodeSettingsSnapshot,
  verifyZcodeAuthCallback,
  confirmZcodeSession,
  verifyZcodeCompletion,
  ZCODE_SELECTION_LIMITS,
  type ZcodeModelCatalog,
  type ZcodeReasoningLevel,
  type CanonicalZcodeSelection,
  type ZcodeSessionConfirmed,
  type VerifiedZcodeSettings,
  type ZcodeCallbackEvidence,
} from '../src/core/zcode-selection.js';

/**
 * 测试专用目录 fixture：仅用于驱动白名单收窄逻辑，不代表当前真实目录
 * （生产模块已不再内置 CURRENT_ZCODE_CATALOG，真实目录须由 SDK facade 提供）。
 */
const TEST_CATALOG: ZcodeModelCatalog = Object.freeze({
  providers: Object.freeze([Object.freeze({
    providerId: ZCODE_PROVIDER_ID,
    models: Object.freeze([
      Object.freeze({ modelId: 'GLM-5.3', reasoningLevels: Object.freeze(['low', 'high', 'max'] as const) }),
      Object.freeze({ modelId: 'GLM-5.3-Flash', reasoningLevels: Object.freeze(['low', 'high'] as const) }),
    ]),
  })]),
});

/** 目录里故意放了白名单外的 Start/GLM-5.5：目录不能放宽运行时模型白名单。 */
const WIDENED_CATALOG: ZcodeModelCatalog = {
  providers: [{
    providerId: ZCODE_PROVIDER_ID,
    models: [
      { modelId: 'GLM-5.3', reasoningLevels: ['low', 'high', 'max'] },
      { modelId: 'GLM-5.5', reasoningLevels: ['low', 'high', 'max'] },
      { modelId: 'Start', reasoningLevels: ['low', 'high'] },
    ],
  }],
};

function norm(model: string | null, effort: string | null, catalog: ZcodeModelCatalog = TEST_CATALOG) {
  return normalizeZcodeSelection({ model, reasoningEffort: effort }, ZCODE_PROVIDER_ID, catalog);
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ZcodeSelectionError, `expected ZcodeSelectionError, got ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected error ${code}`);
}

const EXPECTED = norm('GLM-5.3', 'high');

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    // 官方 session/create 真实形态：canonical 字段为 session.sessionId。
    session: { sessionId: 'sess-1' },
    settings: {
      model: { current: { providerId: ZCODE_PROVIDER_ID, modelId: 'GLM-5.3', options: { reasoningLevel: 'high' } } },
      thoughtLevel: { current: 'high' },
      ...overrides,
    },
    extraOfficialField: { anything: true },
  };
}

/** 官方 debug 形态：{sessionId, rounds, networkEntries, cache}，没有 queryInfo。 */
function debug(entries: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-1',
    rounds: [] as unknown[],
    networkEntries: entries,
    cache: null,
    ...overrides,
  };
}

const OK_ENTRY = {
  queryId: 'q1', querySource: 'main_turn', statusType: 'model_request_completed',
  providerId: ZCODE_PROVIDER_ID, modelId: 'GLM-5.3', requestId: 'req-1', statusCode: 200,
  headers: { authorization: 'Bearer SECRET' }, body: 'raw-debug-payload',
};

function confirm(): ZcodeSessionConfirmed {
  const callback = verifyZcodeAuthCallback(
    { providerId: ZCODE_PROVIDER_ID, modelId: 'GLM-5.3' },
    EXPECTED,
  );
  const readback = verifyZcodeSettingsSnapshot(snapshot(), EXPECTED);
  return confirmZcodeSession(callback, readback);
}

// ---------- normalize ----------

test('normalize: canonical 结果两个 effort 字段一致且不可变', () => {
  const result = norm('GLM-5.3', 'low');
  assert.equal(result.options.reasoningLevel, 'low');
  assert.equal(result.thoughtLevel, 'low');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.options), true);
});

test('normalize: 大小写别名 glm-5.3 不自动猜，固定错误消息不回显输入', () => {
  expectCode(() => norm('glm-5.3', 'high'), 'E_NONCANONICAL_MODEL');
  try {
    norm('GLM-5.3'.toLowerCase(), 'high');
    assert.fail('expected error');
  } catch (error) {
    assert.ok(error instanceof ZcodeSelectionError);
    assert.equal((error.message as string).includes('glm'), false);
  }
});

test('normalize: missing model 拒绝', () => {
  expectCode(() => norm(null, 'high'), 'E_MISSING_MODEL');
});

test('normalize: missing effort 拒绝，不默认补 high', () => {
  expectCode(() => norm('GLM-5.3', null), 'E_MISSING_EFFORT');
});

test('normalize: unsupported provider 拒绝（目录外与目录内伪造 Start 均拒绝）', () => {
  expectCode(() => normalizeZcodeSelection(
    { model: 'GLM-5.3', reasoningEffort: 'high' },
    'account:other-provider',
    TEST_CATALOG,
  ), 'E_UNSUPPORTED_PROVIDER');
  const forgedProviderCatalog: ZcodeModelCatalog = {
    providers: [{ providerId: 'account:start-plan', models: [{ modelId: 'GLM-5.3', reasoningLevels: ['low'] }] }],
  };
  expectCode(() => normalizeZcodeSelection(
    { model: 'GLM-5.3', reasoningEffort: 'low' },
    'account:start-plan',
    forgedProviderCatalog,
  ), 'E_UNSUPPORTED_PROVIDER');
});

test('normalize: 运行时白名单独立于目录：目录内放 GLM-5.5/Start、请求 medium 仍拒绝', () => {
  expectCode(() => norm('GLM-5.5', 'high', WIDENED_CATALOG), 'E_UNSUPPORTED_MODEL');
  expectCode(() => norm('Start', 'high', WIDENED_CATALOG), 'E_UNSUPPORTED_MODEL');
  expectCode(() => norm('GLM-5.3-Flash', 'medium', TEST_CATALOG), 'E_UNSUPPORTED_EFFORT');
  expectCode(() => norm('GLM-5.3', 'medium', WIDENED_CATALOG), 'E_UNSUPPORTED_EFFORT');
});

test('normalize: 模型被撤出目录后拒绝（目录收窄）', () => {
  const withdrawn: ZcodeModelCatalog = {
    providers: [{ providerId: ZCODE_PROVIDER_ID, models: [{ modelId: 'GLM-5.3-Flash', reasoningLevels: ['low', 'high'] }] }],
  };
  expectCode(() => norm('GLM-5.3', 'high', withdrawn), 'E_UNSUPPORTED_MODEL');
});

test('normalize: unsupported effort 拒绝（fixture 目录将 Flash 收窄到无 max）', () => {
  expectCode(() => norm('GLM-5.3-Flash', 'max'), 'E_UNSUPPORTED_EFFORT');
});

test('normalize: 合法模型每档 effort 均支持', () => {
  for (const level of ['low', 'high', 'max'] as const) {
    assert.equal(norm('GLM-5.3', level).thoughtLevel, level);
  }
  for (const level of ['low', 'high'] as const) {
    assert.equal(norm('GLM-5.3-Flash', level).thoughtLevel, level);
  }
});

test('normalize: 输出不受调用方目录后续变更污染', () => {
  const mutableCatalog: ZcodeModelCatalog = {
    providers: [{ providerId: ZCODE_PROVIDER_ID, models: [{ modelId: 'GLM-5.3', reasoningLevels: ['low', 'high', 'max'] }] }],
  };
  const result = norm('GLM-5.3', 'high', mutableCatalog);
  (mutableCatalog.providers[0].models[0] as { modelId: string }).modelId = 'TAMPERED';
  (mutableCatalog.providers[0].models[0].reasoningLevels as string[]).length = 0;
  assert.equal(result.modelId, 'GLM-5.3');
  assert.equal(result.options.reasoningLevel, 'high');
});

// ---------- catalog 校验 ----------

test('catalog: 空模型 provider 的多 provider 目录在预算内可服务', () => {
  const sparse: ZcodeModelCatalog = {
    providers: [
      { providerId: 'account:other', models: [] },
      { providerId: ZCODE_PROVIDER_ID, models: [{ modelId: 'GLM-5.3', reasoningLevels: ['low'] }] },
      ...Array.from({ length: 254 }, (_, i) => ({ providerId: `p${i}`, models: [] as never[] })),
    ],
  };
  assert.equal(norm('GLM-5.3', 'low', sparse).modelId, 'GLM-5.3');
});

test('catalog: provider 数超 256 拒绝', () => {
  const big: ZcodeModelCatalog = {
    providers: Array.from({ length: ZCODE_SELECTION_LIMITS.maxCatalogProviders + 1 }, (_, i) => ({
      providerId: `p${i}`, models: [] as never[],
    })),
  };
  expectCode(() => norm('GLM-5.3', 'low', big), 'E_CATALOG_BUDGET');
});

test('catalog: 累计模型超 256 拒绝', () => {
  const bigCatalog: ZcodeModelCatalog = {
    providers: [{
      providerId: ZCODE_PROVIDER_ID,
      models: Array.from({ length: ZCODE_SELECTION_LIMITS.maxCatalogModels + 1 }, (_, i) => ({
        modelId: `M${i}`, reasoningLevels: ['low'] as const,
      })),
    }],
  };
  expectCode(() => norm('M1', 'low', bigCatalog), 'E_CATALOG_BUDGET');
});

test('catalog: 恰好 256 模型在预算内可服务', () => {
  const edge: ZcodeModelCatalog = {
    providers: [{
      providerId: ZCODE_PROVIDER_ID,
      models: Array.from({ length: ZCODE_SELECTION_LIMITS.maxCatalogModels }, (_, i) => ({
        modelId: i === 0 ? 'GLM-5.3' : `M${i}`, reasoningLevels: ['low', 'high', 'max'] as const,
      })),
    }],
  };
  assert.equal(norm('GLM-5.3', 'max', edge).thoughtLevel, 'max');
});

test('catalog: 字符串超长、重复、畸形均拒绝', () => {
  const longId = 'x'.repeat(ZCODE_SELECTION_LIMITS.maxStringLength + 1);
  expectCode(() => norm('GLM-5.3', 'low', {
    providers: [{ providerId: longId, models: [] }],
  }), 'E_STRING_TOO_LONG');
  expectCode(() => norm('GLM-5.3', 'low', {
    providers: [{ providerId: ZCODE_PROVIDER_ID, models: [{ modelId: longId, reasoningLevels: ['low'] }] }],
  }), 'E_STRING_TOO_LONG');
  expectCode(() => norm('GLM-5.3', 'low', {
    providers: [
      { providerId: ZCODE_PROVIDER_ID, models: [] },
      { providerId: ZCODE_PROVIDER_ID, models: [{ modelId: 'GLM-5.3', reasoningLevels: ['low'] }] },
    ],
  }), 'E_CATALOG_INVALID');
  expectCode(() => norm('GLM-5.3', 'low', {
    providers: [{
      providerId: ZCODE_PROVIDER_ID,
      models: [
        { modelId: 'GLM-5.3', reasoningLevels: ['low'] },
        { modelId: 'GLM-5.3', reasoningLevels: ['high'] },
      ],
    }],
  }), 'E_CATALOG_INVALID');
  // 刻意畸形的负例 fixture：经 unknown 显式转换为目录类型，仅限本测试边界使用。
  const missingLevels = {
    providers: [{ providerId: ZCODE_PROVIDER_ID, models: [{ modelId: 'GLM-5.3' }] }],
  } as unknown as ZcodeModelCatalog;
  expectCode(() => norm('GLM-5.3', 'low', missingLevels), 'E_CATALOG_INVALID');
  expectCode(() => norm('GLM-5.3', 'low', {
    providers: [null as never],
  }), 'E_CATALOG_INVALID');
  expectCode(() => norm('GLM-5.3', 'low', {
    providers: [{ providerId: ZCODE_PROVIDER_ID, models: [{ modelId: 'GLM-5.3', reasoningLevels: [] as never[] }] }],
  }), 'E_UNSUPPORTED_EFFORT');
  expectCode(() => norm('GLM-5.3', 'low', {
    providers: [{ providerId: ZCODE_PROVIDER_ID, models: [{ modelId: 'GLM-5.3', reasoningLevels: ['medium'] as never[] }] }],
  }), 'E_CATALOG_INVALID');
  const manyLevels: ZcodeReasoningLevel[] = Array.from(
    { length: ZCODE_SELECTION_LIMITS.maxReasoningLevels + 1 },
    () => 'low',
  );
  expectCode(() => norm('GLM-5.3', 'low', {
    providers: [{ providerId: ZCODE_PROVIDER_ID, models: [{ modelId: 'GLM-5.3', reasoningLevels: manyLevels }] }],
  }), 'E_CATALOG_BUDGET');
});

// ---------- snapshot / session ----------

test('snapshot: session.sessionId + 双档位匹配时通过，并容忍官方额外字段', () => {
  const verified = verifyZcodeSettingsSnapshot(snapshot(), EXPECTED);
  assert.equal(verified.kind, 'snapshot-verified');
  assert.equal(verified.sessionId, 'sess-1');
  assert.equal(verified.providerId, ZCODE_PROVIDER_ID);
  assert.equal(verified.modelId, 'GLM-5.3');
  assert.equal(Object.isFrozen(verified), true);
});

test('snapshot: session.sessionId 缺失、空或超长时拒绝', () => {
  expectCode(() => verifyZcodeSettingsSnapshot({ settings: snapshot().settings }, EXPECTED), 'E_SNAPSHOT_INVALID');
  expectCode(() => verifyZcodeSettingsSnapshot({
    ...snapshot(),
    session: { sessionId: '' },
  }, EXPECTED), 'E_SNAPSHOT_INVALID');
  expectCode(() => verifyZcodeSettingsSnapshot({
    ...snapshot(),
    session: { sessionId: 'x'.repeat(ZCODE_SELECTION_LIMITS.maxStringLength + 1) },
  }, EXPECTED), 'E_SNAPSHOT_INVALID');
});

test('snapshot 回归: 仅有旧 session.id 的对象拒绝，不用 id ?? sessionId 兜底', () => {
  expectCode(() => verifyZcodeSettingsSnapshot({
    ...snapshot(),
    session: { id: 'sess-1' },
  }, EXPECTED), 'E_SNAPSHOT_INVALID');
});

test('snapshot 回归: sessionId 与额外旧 id 冲突时拒绝，同值额外 id 保持 canonical 结果', () => {
  expectCode(() => verifyZcodeSettingsSnapshot({
    ...snapshot(),
    session: { sessionId: 'sess-1', id: 'sess-other' },
  }, EXPECTED), 'E_SNAPSHOT_CONFLICT');
  const verified = verifyZcodeSettingsSnapshot({
    ...snapshot(),
    session: { sessionId: 'sess-1', id: 'sess-1' },
  }, EXPECTED);
  assert.equal(verified.sessionId, 'sess-1');
});

test('snapshot: thoughtLevel 与 options.reasoningLevel 冲突时拒绝，不用 ?? 遮住', () => {
  const clash = snapshot();
  clash.settings.model.current.options = { reasoningLevel: 'low' };
  clash.settings.thoughtLevel.current = 'low';
  expectCode(() => verifyZcodeSettingsSnapshot(clash, EXPECTED), 'E_SNAPSHOT_CONFLICT');
  const onlyThought = snapshot();
  onlyThought.settings.thoughtLevel.current = 'max';
  expectCode(() => verifyZcodeSettingsSnapshot(onlyThought, EXPECTED), 'E_SNAPSHOT_CONFLICT');
});

test('auth 回调: options 缺 effort 合法且不伪造 observed effort', () => {
  const callback = verifyZcodeAuthCallback({ providerId: ZCODE_PROVIDER_ID, modelId: 'GLM-5.3' }, EXPECTED);
  assert.equal(callback.kind, 'callback-verified');
  assert.equal('reasoningLevel' in callback, false);
  const withWorkspace = verifyZcodeAuthCallback(
    { providerId: ZCODE_PROVIDER_ID, modelId: 'GLM-5.3', workspace: { deep: { secret: 'SECRET' } } },
    EXPECTED,
  );
  assert.equal('reasoningLevel' in withWorkspace, false);
});

test('auth 回调: callback effort 存在且冲突时拒绝', () => {
  expectCode(() => verifyZcodeAuthCallback(
    { providerId: ZCODE_PROVIDER_ID, modelId: 'GLM-5.3', options: { reasoningLevel: 'max' } },
    EXPECTED,
  ), 'E_CALLBACK_CONFLICT');
});

test('session-confirmed: 回调 + 独立回读一致时确认，包含 sessionId', () => {
  const confirmed = confirm();
  assert.equal(confirmed.kind, 'session-confirmed');
  assert.equal(confirmed.sessionId, 'sess-1');
  assert.equal(confirmed.reasoningLevel, 'high');
  assert.equal(Object.isFrozen(confirmed), true);
});

test('session-confirmed: 伪造回读 / 伪造回调 / normalizer 返回值不能确认', () => {
  const callback = verifyZcodeAuthCallback({ providerId: ZCODE_PROVIDER_ID, modelId: 'GLM-5.3' }, EXPECTED);
  const readback = verifyZcodeSettingsSnapshot(snapshot(), EXPECTED);
  const fakeReadback: VerifiedZcodeSettings = { ...readback };
  expectCode(() => confirmZcodeSession(callback, fakeReadback), 'E_CONFIRMED_INVALID');
  const fakeCallback: ZcodeCallbackEvidence = { ...callback };
  expectCode(() => confirmZcodeSession(fakeCallback, readback), 'E_CONFIRMED_INVALID');
  const normalizedAsReadback = EXPECTED as unknown as VerifiedZcodeSettings;
  expectCode(() => confirmZcodeSession(callback, normalizedAsReadback), 'E_CONFIRMED_INVALID');
  const copied = JSON.parse(JSON.stringify(readback)) as VerifiedZcodeSettings;
  expectCode(() => confirmZcodeSession(JSON.parse(JSON.stringify(callback)) as ZcodeCallbackEvidence, copied), 'E_CONFIRMED_INVALID');
});

test('session-confirmed: 回调与回读 provider/model 不一致时拒绝', () => {
  const callback = verifyZcodeAuthCallback({ providerId: ZCODE_PROVIDER_ID, modelId: 'GLM-5.3' }, EXPECTED);
  const flashExpected = norm('GLM-5.3-Flash', 'high');
  const otherReadback = verifyZcodeSettingsSnapshot({
    session: { sessionId: 'sess-2' },
    settings: {
      model: { current: { providerId: ZCODE_PROVIDER_ID, modelId: 'GLM-5.3-Flash' } },
      thoughtLevel: { current: 'high' },
    },
  }, flashExpected);
  expectCode(() => confirmZcodeSession(callback, otherReadback), 'E_CALLBACK_CONFLICT');
});

// ---------- canonical 运行时一致性 ----------

/** 结构合法（与 normalizer 输出同构）但可被测试任意改写的 expected。 */
function shape(modelId: string, thought: string, optionLevel: string) {
  return {
    providerId: ZCODE_PROVIDER_ID,
    modelId,
    options: { reasoningLevel: optionLevel },
    thoughtLevel: thought,
  } as CanonicalZcodeSelection;
}

function snapshotWithoutOptions(thought: string) {
  return {
    session: { sessionId: 'sess-1' },
    settings: {
      model: { current: { providerId: ZCODE_PROVIDER_ID, modelId: 'GLM-5.3' } },
      thoughtLevel: { current: thought },
    },
  };
}

test('canonical: thought=options 不一致且 snapshot options 缺省时拒绝，不能确认 low 为 high', () => {
  const tampered = shape('GLM-5.3', 'low', 'high');
  expectCode(() => verifyZcodeSettingsSnapshot(snapshotWithoutOptions('low'), tampered), 'E_SELECTION_INVALID');
  expectCode(() => verifyZcodeAuthCallback({ providerId: ZCODE_PROVIDER_ID, modelId: 'GLM-5.3' }, tampered), 'E_SELECTION_INVALID');
});

test('canonical: verifyAuth 后修改 expected.options 不能重绑定，原 high 证据仍成立', () => {
  const callerOwned = shape('GLM-5.3', 'high', 'high');
  const callback = verifyZcodeAuthCallback(
    { providerId: ZCODE_PROVIDER_ID, modelId: 'GLM-5.3', options: { reasoningLevel: 'high' } },
    callerOwned,
  );
  // 调用者事后把自己的 expected 改成 low。
  (callerOwned.options as { reasoningLevel: string }).reasoningLevel = 'low';
  (callerOwned as { thoughtLevel: string }).thoughtLevel = 'low';
  // 与 low 的真实回读确认必须拒绝：证据仍绑定 high。
  const lowReadback = verifyZcodeSettingsSnapshot(snapshotWithoutOptions('low'), norm('GLM-5.3', 'low'));
  expectCode(() => confirmZcodeSession(callback, lowReadback), 'E_CALLBACK_CONFLICT');
  // 与原 high 回读仍可确认。
  const highReadback = verifyZcodeSettingsSnapshot(snapshot(), norm('GLM-5.3', 'high'));
  const confirmed = confirmZcodeSession(callback, highReadback);
  assert.equal(confirmed.reasoningLevel, 'high');
});

test('canonical: 不合法 provider/model/effort/缺 options 的结构 canonical 拿不到 settings 证明', () => {
  const bads: CanonicalZcodeSelection[] = [
    shape('account:other-provider', 'high', 'high'),
    shape('GLM-5.5', 'high', 'high'),
    shape('GLM-5.3', 'medium', 'medium'),
    { providerId: ZCODE_PROVIDER_ID, modelId: 'GLM-5.3', thoughtLevel: 'high' } as never,
  ];
  for (const bad of bads) {
    expectCode(() => verifyZcodeSettingsSnapshot(snapshot(), bad), 'E_SELECTION_INVALID');
  }
});

test('canonical: 不合法 provider/model/effort/缺 options 的结构 canonical 拿不到 callback 证明', () => {
  const bads: CanonicalZcodeSelection[] = [
    shape('account:other-provider', 'high', 'high'),
    shape('GLM-5.5', 'high', 'high'),
    shape('GLM-5.3', 'medium', 'medium'),
    { providerId: ZCODE_PROVIDER_ID, modelId: 'GLM-5.3', thoughtLevel: 'high' } as never,
  ];
  for (const bad of bads) {
    expectCode(() => verifyZcodeAuthCallback(
      { providerId: ZCODE_PROVIDER_ID, modelId: 'GLM-5.3', options: { reasoningLevel: 'high' } },
      bad,
    ), 'E_SELECTION_INVALID');
  }
});

test('canonical: 一致的结构合法 expected 可通过；source 对象未被 freeze 或改写', () => {
  const source = { ...shape('GLM-5.3', 'high', 'high') };
  const before = JSON.stringify(source);
  const verified = verifyZcodeSettingsSnapshot(snapshot(), source);
  const callback = verifyZcodeAuthCallback(
    { providerId: ZCODE_PROVIDER_ID, modelId: 'GLM-5.3', options: { reasoningLevel: 'high' } },
    source,
  );
  assert.equal(verified.reasoningLevel, 'high');
  assert.equal(callback.reasoningLevel, 'high');
  assert.equal(Object.isFrozen(source), false);
  assert.equal(Object.isFrozen(source.options), false);
  assert.equal(JSON.stringify(source), before);
  const confirmed = confirmZcodeSession(callback, verified);
  assert.equal(confirmed.reasoningLevel, 'high');
});

// ---------- completion ----------

test('completed: 官方 debug（无 queryInfo）正常路径输出白名单字段', () => {
  const evidence = verifyZcodeCompletion(debug([OK_ENTRY]), {
    sessionId: 'sess-1', queryId: 'q1', confirmed: confirm(),
  });
  assert.equal(evidence.kind, 'model-request-completed');
  assert.equal(evidence.requests.length, 1);
  assert.equal(evidence.requests[0].requestId, 'req-1');
  assert.equal(evidence.requests[0].statusCode, 200);
  assert.equal(evidence.reasoningLevelSource, 'session-confirmed');
  assert.deepEqual(Object.keys(evidence).sort(),
    ['kind', 'queryId', 'reasoningLevel', 'reasoningLevelSource', 'requests', 'sessionId']);
  assert.deepEqual(Object.keys(evidence.requests[0]).sort(),
    ['modelId', 'providerId', 'requestId', 'statusCode']);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.requests), true);
  assert.equal(Object.isFrozen(evidence.requests[0]), true);
});

test('completed: sessionId 与 confirmed 或 debug.sessionId 不符时拒绝', () => {
  expectCode(() => verifyZcodeCompletion(debug([OK_ENTRY]), {
    sessionId: 'sess-other', queryId: 'q1', confirmed: confirm(),
  }), 'E_DEBUG_INVALID');
  expectCode(() => verifyZcodeCompletion(debug([OK_ENTRY], { sessionId: 'sess-other' }), {
    sessionId: 'sess-1', queryId: 'q1', confirmed: confirm(),
  }), 'E_DEBUG_INVALID');
});

test('completed: 第二条 completed 的 401/500/非数值拒绝，不能只校验第一条', () => {
  for (const bad of [401, 500, 302, '200', 200.5, NaN]) {
    const second = { ...OK_ENTRY, requestId: 'req-2', statusCode: bad };
    expectCode(() => verifyZcodeCompletion(debug([OK_ENTRY, second]), {
      sessionId: 'sess-1', queryId: 'q1', confirmed: confirm(),
    }), 'E_STATUS_INVALID');
  }
});

test('completed: 超长或缺失 requestId 拒绝', () => {
  const long = 'r'.repeat(ZCODE_SELECTION_LIMITS.maxStringLength + 1);
  expectCode(() => verifyZcodeCompletion(debug([{ ...OK_ENTRY, requestId: long }]), {
    sessionId: 'sess-1', queryId: 'q1', confirmed: confirm(),
  }), 'E_STRING_TOO_LONG');
  expectCode(() => verifyZcodeCompletion(debug([{ ...OK_ENTRY, requestId: '' }]), {
    sessionId: 'sess-1', queryId: 'q1', confirmed: confirm(),
  }), 'E_DEBUG_INVALID');
});

test('completed: 同 query 出现错 provider/model 的记录时不混用，整体拒绝', () => {
  const wrong = { ...OK_ENTRY, providerId: 'account:other', requestId: 'req-2' };
  expectCode(() => verifyZcodeCompletion(debug([OK_ENTRY, wrong]), {
    sessionId: 'sess-1', queryId: 'q1', confirmed: confirm(),
  }), 'E_COMPLETED_MISMATCH');
});

test('completed: 其他 query/source 不进证据', () => {
  const noise = [
    { ...OK_ENTRY, queryId: 'other-query', requestId: 'req-n1' },
    { ...OK_ENTRY, querySource: 'sub_agent', requestId: 'req-n2' },
    { ...OK_ENTRY, statusType: 'model_request_failed', requestId: 'req-n3', statusCode: 500 },
    'not-an-object',
  ];
  const evidence = verifyZcodeCompletion(debug([OK_ENTRY, ...noise]), {
    sessionId: 'sess-1', queryId: 'q1', confirmed: confirm(),
  });
  assert.deepEqual(evidence.requests.map((r) => r.requestId), ['req-1']);
});

test('completed: 缺少 completed 记录不通过', () => {
  const none = { ...OK_ENTRY, statusType: 'model_request_failed' };
  expectCode(() => verifyZcodeCompletion(debug([none]), {
    sessionId: 'sess-1', queryId: 'q1', confirmed: confirm(),
  }), 'E_NO_COMPLETED');
  expectCode(() => verifyZcodeCompletion(debug([]), {
    sessionId: 'sess-1', queryId: 'q1', confirmed: confirm(),
  }), 'E_NO_COMPLETED');
});

test('completed: statusCode 缺省时保持缺省，不补 200', () => {
  const { statusCode: _omit, ...noStatus } = OK_ENTRY;
  const evidence = verifyZcodeCompletion(debug([noStatus]), {
    sessionId: 'sess-1', queryId: 'q1', confirmed: confirm(),
  });
  assert.equal('statusCode' in evidence.requests[0], false);
});

test('completed: 仅 normalizer 结果或伪造复制的 confirmed 不能证明完成', () => {
  const confirmed = confirm();
  expectCode(() => verifyZcodeCompletion(debug([OK_ENTRY]), {
    sessionId: 'sess-1', queryId: 'q1', confirmed: EXPECTED as unknown as ZcodeSessionConfirmed,
  }), 'E_CONFIRMED_INVALID');
  const copied = JSON.parse(JSON.stringify(confirmed)) as ZcodeSessionConfirmed;
  expectCode(() => verifyZcodeCompletion(debug([OK_ENTRY]), {
    sessionId: 'sess-1', queryId: 'q1', confirmed: copied,
  }), 'E_CONFIRMED_INVALID');
  const fabricated: ZcodeSessionConfirmed = {
    kind: 'session-confirmed', sessionId: 'sess-1',
    providerId: ZCODE_PROVIDER_ID, modelId: 'GLM-5.3', reasoningLevel: 'high',
  };
  expectCode(() => verifyZcodeCompletion(debug([OK_ENTRY]), {
    sessionId: 'sess-1', queryId: 'q1', confirmed: fabricated,
  }), 'E_CONFIRMED_INVALID');
});

test('completed: 未知 headers/正文字段绝不进入输出，secret 不出现在错误消息', () => {
  const evidence = verifyZcodeCompletion(debug([OK_ENTRY]), {
    sessionId: 'sess-1', queryId: 'q1', confirmed: confirm(),
  });
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes('SECRET'), false);
  assert.equal(serialized.includes('raw-debug-payload'), false);
  const secretQuery = 'SECRET-token-' + 'x'.repeat(ZCODE_SELECTION_LIMITS.maxStringLength);
  try {
    verifyZcodeCompletion(debug([OK_ENTRY]), {
      sessionId: 'sess-1', queryId: secretQuery, confirmed: confirm(),
    });
    assert.fail('expected error');
  } catch (error) {
    assert.ok(error instanceof ZcodeSelectionError);
    assert.equal(error.message.includes('SECRET'), false);
  }
});

test('预算: entries 超 10000、字符串超 256 均拒绝不截断', () => {
  const filler = Array.from({ length: ZCODE_SELECTION_LIMITS.maxNetworkEntries + 1 }, () => ({ ...OK_ENTRY, requestId: 'x' }));
  expectCode(() => verifyZcodeCompletion(debug(filler), {
    sessionId: 'sess-1', queryId: 'q1', confirmed: confirm(),
  }), 'E_NETWORK_BUDGET');

  expectCode(() => norm('GLM-5.3', 'x'.repeat(ZCODE_SELECTION_LIMITS.maxStringLength + 1)), 'E_STRING_TOO_LONG');
});
