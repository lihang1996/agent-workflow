import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentOsConfig } from '../src/core/bot-registry.js';
import {
  ModelSelectionSchema,
  compareExecutionSelection,
  frozenKnownModel,
  frozenLegacyModel,
  modelSelectionFingerprint,
  normalizeModelSelection,
  resolveModel,
  roleModelOverridesFingerprint,
  samePreference,
  sameSelection,
  selectionForCommand,
  type ModelOverrides,
  type ModelSelectionCapabilities,
  type ResolvedModel,
} from '../src/core/model-selection.js';

const env = { TEST_APP_ID: 'placeholder', TEST_APP_SECRET: 'placeholder' };

function parseBot(modelOverrides?: unknown) {
  const config = parseAgentOsConfig({
    teamLeader: 'ceo-assistant',
    bots: [{
      id: 'ceo-assistant',
      appIdEnv: 'TEST_APP_ID',
      appSecretEnv: 'TEST_APP_SECRET',
      defaultCli: 'codex',
      role: 'CEO 助理',
      ...(modelOverrides === undefined ? {} : { modelOverrides }),
    }],
  }, env);
  return config.bots[0]!;
}

const capabilities: ModelSelectionCapabilities = {
  supportsModelSelection: true,
  supportsReasoningEffort: true,
  supportsInPlaceModelSwitch: true,
};

test('configuration accepts sparse model overrides without hardcoding model names', () => {
  const withoutOverrides = parseBot();
  assert.deepEqual(withoutOverrides.modelOverrides, {});

  const withOverrides = parseBot({
    codex: { model: 'gpt-test-a', reasoningEffort: 'high' },
    zcode: { model: 'glm-test-b' },
  });
  assert.deepEqual(withOverrides.modelOverrides.codex, { model: 'gpt-test-a', reasoningEffort: 'high' });
  assert.deepEqual(withOverrides.modelOverrides.zcode, { model: 'glm-test-b', reasoningEffort: null });
});

test('configuration rejects empty explicit values instead of treating them as native defaults', () => {
  assert.throws(() => parseBot({ codex: { model: '' } }), /模型标识|too_small|invalid/i);
  assert.throws(() => parseBot({ codex: { model: 'valid', reasoningEffort: '   ' } }), /模型标识|too_small|invalid/i);
  assert.throws(() => parseBot({ unknownCli: { model: 'valid' } }), /invalid|unrecognized/i);
});

test('topic override wins over role default and role default wins over native default', () => {
  const overrides: ModelOverrides = { codex: { model: 'role-model', reasoningEffort: 'medium' } };

  const topic = resolveModel(overrides, 'codex', { model: 'topic-model', reasoningEffort: null });
  assert.equal(topic.source, 'topic');
  assert.deepEqual(topic.selection, { model: 'topic-model', reasoningEffort: null });

  const role = resolveModel(overrides, 'codex', null);
  assert.equal(role.source, 'role');
  assert.deepEqual(role.selection, { model: 'role-model', reasoningEffort: 'medium' });

  const native = resolveModel(overrides, 'claude', null);
  assert.equal(native.source, 'native-default');
  assert.deepEqual(native.selection, { model: null, reasoningEffort: null });
});

test('set command replaces the whole selection and does not inherit previous effort', () => {
  const current: ResolvedModel = {
    cliId: 'codex',
    selection: { model: 'old-model', reasoningEffort: 'high' },
    source: 'topic',
    roleDefaultFingerprint: roleModelOverridesFingerprint({}),
  };

  assert.deepEqual(
    selectionForCommand({ kind: 'set', model: 'new-model' }, current),
    { model: 'new-model', reasoningEffort: null },
  );
  assert.deepEqual(
    selectionForCommand({ kind: 'set', model: 'new-model', reasoningEffort: 'low' }, current),
    { model: 'new-model', reasoningEffort: 'low' },
  );
});

test('effort command preserves the resolved model and distinguishes native effort from reset', () => {
  const roleOnly: ResolvedModel = {
    cliId: 'zcode',
    selection: { model: null, reasoningEffort: 'role-effort' },
    source: 'role',
    roleDefaultFingerprint: 'fingerprint',
  };

  const effortOverride = selectionForCommand({ kind: 'effort', reasoningEffort: 'high' }, roleOnly);
  assert.deepEqual(effortOverride, { model: null, reasoningEffort: 'high' });

  const nativeEffort = selectionForCommand({ kind: 'effort', reasoningEffort: null }, roleOnly);
  assert.deepEqual(nativeEffort, { model: null, reasoningEffort: null });
  assert.notDeepEqual(nativeEffort, roleOnly.selection);

  assert.equal(selectionForCommand({ kind: 'reset' }, roleOnly), null);
});

test('same selection and same preference are different comparisons', () => {
  const topic: ResolvedModel = {
    cliId: 'codex',
    selection: { model: 'same-model', reasoningEffort: null },
    source: 'topic',
    roleDefaultFingerprint: 'same-fingerprint',
  };
  const role: ResolvedModel = { ...topic, source: 'role' };

  assert.equal(sameSelection(topic.selection, role.selection), true);
  assert.equal(samePreference(topic, role), false);
  assert.equal(samePreference(topic, { ...topic }), true);
  assert.equal(samePreference(null, undefined), true);
  assert.equal(samePreference(topic, null), false);
});

test('fingerprints distinguish source-relevant configuration without hashing credentials', () => {
  const first = roleModelOverridesFingerprint({ codex: { model: 'a', reasoningEffort: null } });
  const second = roleModelOverridesFingerprint({ codex: { model: 'a', reasoningEffort: null } });
  const third = roleModelOverridesFingerprint({ codex: { model: 'b', reasoningEffort: null } });
  assert.equal(first, second);
  assert.notEqual(first, third);
  assert.notEqual(modelSelectionFingerprint({ model: 'a', reasoningEffort: null }), modelSelectionFingerprint({ model: 'a', reasoningEffort: 'high' }));
});

test('native default selections are explicit unknown values rather than fabricated model IDs', () => {
  const resolved = resolveModel({}, 'cursor', null);
  assert.equal(resolved.selection.model, null);
  assert.equal(resolved.source, 'native-default');
  assert.equal(frozenKnownModel(resolved).kind, 'known');
  assert.equal(frozenLegacyModel().kind, 'legacy-native');
});

test('normalizing input preserves explicit null and fills absent fields', () => {
  assert.deepEqual(normalizeModelSelection(undefined), { model: null, reasoningEffort: null });
  assert.deepEqual(normalizeModelSelection({ model: 'a', reasoningEffort: null }), { model: 'a', reasoningEffort: null });
  assert.deepEqual(ModelSelectionSchema.parse({}), { model: null, reasoningEffort: null });
});

test('execution comparison keeps compatible bindings and blocks unverifiable changes', () => {
  const desired = resolveModel({ codex: { model: 'target', reasoningEffort: 'high' } }, 'codex', null);
  assert.deepEqual(compareExecutionSelection(undefined, desired, capabilities), { action: 'keep' });
  assert.deepEqual(
    compareExecutionSelection({ cliSessionId: 'thread', selection: desired }, desired, capabilities),
    { action: 'keep' },
  );

  const legacyRecreate = compareExecutionSelection({ cliSessionId: 'thread' }, desired, capabilities);
  assert.equal(legacyRecreate.action, 'recreate');

  const different = resolveModel({ codex: { model: 'other', reasoningEffort: 'high' } }, 'codex', null);
  assert.equal(
    compareExecutionSelection({ cliSessionId: 'thread', selection: desired }, different, capabilities).action,
    'keep',
  );

  const noInPlaceSwitch = compareExecutionSelection(
    { cliSessionId: 'thread', selection: desired },
    different,
    { supportsModelSelection: true, supportsReasoningEffort: true, supportsInPlaceModelSwitch: false },
  );
  assert.equal(noInPlaceSwitch.action, 'recreate');

  const unsupported = compareExecutionSelection(
    { cliSessionId: 'thread', selection: desired },
    different,
    { supportsModelSelection: false, supportsReasoningEffort: false, supportsInPlaceModelSwitch: false },
  );
  assert.equal(unsupported.action, 'blocked');

  const unknownTarget = resolveModel({}, 'codex', null);
  assert.equal(
    compareExecutionSelection({ cliSessionId: 'thread', selection: desired }, unknownTarget, capabilities).action,
    'blocked',
  );

  const imageHistory = compareExecutionSelection(
    { cliSessionId: 'thread', selection: desired, hasImageInput: true },
    desired,
    capabilities,
  );
  assert.equal(imageHistory.action, 'keep');
});
