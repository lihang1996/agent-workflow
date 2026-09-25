import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CLI_IDS, type CliId } from '../cli/types.js';

export interface ModelSelection {
  model: string | null;
  reasoningEffort: string | null;
}

export type ModelSelectionSource = 'topic' | 'role' | 'native-default';

export interface ResolvedModel {
  cliId: CliId;
  selection: ModelSelection;
  source: ModelSelectionSource;
  roleDefaultFingerprint: string;
}

export type FrozenExecutionModel =
  | { kind: 'known'; value: ResolvedModel }
  | { kind: 'legacy-native' };

export interface NativeModelBinding {
  cliSessionId?: string;
  selection?: ResolvedModel;
  hasImageInput?: boolean;
}

export interface ModelSelectionCapabilities {
  supportsModelSelection: boolean;
  supportsReasoningEffort: boolean;
  supportsInPlaceModelSwitch: boolean;
}

export type ModelSwitchDecision =
  | { action: 'keep' }
  | { action: 'recreate'; reason: string }
  | { action: 'blocked'; reason: string };

export type ModelCommandIntent =
  | { kind: 'set'; model: string; reasoningEffort?: string | null }
  | { kind: 'effort'; reasoningEffort: string | null }
  | { kind: 'reset' };

const ModelStringSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !value.includes('\u0000'), '模型标识不能包含空字符');

export const ModelSelectionSchema = z.object({
  model: ModelStringSchema.nullable().default(null),
  reasoningEffort: ModelStringSchema.nullable().default(null),
}).strict();

export const ModelOverridesSchema = z.partialRecord(
  z.enum(CLI_IDS),
  ModelSelectionSchema,
).default({});

export type ModelOverrides = z.infer<typeof ModelOverridesSchema>;

const UNKNOWN_NATIVE_VALUE = 'native-default';

export function normalizeModelSelection(
  value: ModelSelection | undefined | null,
): ModelSelection {
  return {
    model: value?.model ?? null,
    reasoningEffort: value?.reasoningEffort ?? null,
  };
}

export function parseModelSelection(value: unknown): ModelSelection {
  return ModelSelectionSchema.parse(value);
}

export function modelSelectionFingerprint(selection: ModelSelection): string {
  return createHash('sha256')
    .update(JSON.stringify({
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
    }))
    .digest('hex');
}

export function roleModelOverridesFingerprint(overrides: ModelOverrides): string {
  const normalized = Object.fromEntries(
    CLI_IDS
      .filter((cliId): cliId is CliId => Object.hasOwn(overrides, cliId))
      .map((cliId) => [cliId, normalizeModelSelection(overrides[cliId])]),
  );
  return createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
}

export function sameSelection(
  left: ModelSelection | undefined | null,
  right: ModelSelection | undefined | null,
): boolean {
  const normalizedLeft = normalizeModelSelection(left);
  const normalizedRight = normalizeModelSelection(right);
  return normalizedLeft.model === normalizedRight.model
    && normalizedLeft.reasoningEffort === normalizedRight.reasoningEffort;
}

export function samePreference(
  left: { selection?: ModelSelection | null; source?: ModelSelectionSource } | undefined | null,
  right: { selection?: ModelSelection | null; source?: ModelSelectionSource } | undefined | null,
): boolean {
  const leftExists = Boolean(left?.selection);
  const rightExists = Boolean(right?.selection);
  if (leftExists !== rightExists) return false;
  if (!leftExists && !rightExists) return left?.source === right?.source;
  return sameSelection(left?.selection, right?.selection)
    && left?.source === right?.source;
}

export function resolveModel(
  botModelOverrides: ModelOverrides | undefined,
  cliId: CliId,
  topicOverride: ModelSelection | null | undefined,
): ResolvedModel {
  const roleDefaultFingerprint = roleModelOverridesFingerprint(botModelOverrides ?? {});
  if (topicOverride) {
    return {
      cliId,
      selection: normalizeModelSelection(topicOverride),
      source: 'topic',
      roleDefaultFingerprint,
    };
  }

  const roleOverride = botModelOverrides?.[cliId];
  if (roleOverride) {
    return {
      cliId,
      selection: normalizeModelSelection(roleOverride),
      source: 'role',
      roleDefaultFingerprint,
    };
  }

  return {
    cliId,
    selection: { model: null, reasoningEffort: null },
    source: 'native-default',
    roleDefaultFingerprint,
  };
}

export function selectionForCommand(
  intent: ModelCommandIntent,
  current: ResolvedModel,
): ModelSelection | null {
  if (intent.kind === 'reset') return null;
  if (intent.kind === 'set') {
    return {
      model: intent.model,
      reasoningEffort: intent.reasoningEffort ?? null,
    };
  }
  return {
    model: current.selection.model,
    reasoningEffort: intent.reasoningEffort,
  };
}

export function describeResolvedModel(resolved: ResolvedModel): string {
  const model = resolved.selection.model ?? UNKNOWN_NATIVE_VALUE;
  const effort = resolved.selection.reasoningEffort ?? UNKNOWN_NATIVE_VALUE;
  return `${resolved.cliId}:${model}:${effort}:${resolved.source}`;
}

export function compareExecutionSelection(
  binding: NativeModelBinding | undefined,
  desired: ResolvedModel,
  capabilities: ModelSelectionCapabilities,
): ModelSwitchDecision {
  if (!binding?.cliSessionId) return { action: 'keep' };

  const current = binding.selection;
  if (!current) {
    return {
      action: 'recreate',
      reason: '现有原生会话没有可核验的模型绑定，不能确认它正在使用目标模型。',
    };
  }

  if (sameSelection(current.selection, desired.selection)) {
    return { action: 'keep' };
  }

  if (desired.selection.model === null) {
    return {
      action: 'blocked',
      reason: '目标模型是 CLI 原生默认，当前无法核验它是否与现有原生会话相同。',
    };
  }
  if (!capabilities.supportsModelSelection) {
    return {
      action: 'blocked',
      reason: `${desired.cliId} 尚未验证可按执行指定模型，不能静默继续使用旧模型。`,
    };
  }
  if (desired.selection.reasoningEffort !== null && !capabilities.supportsReasoningEffort) {
    return {
      action: 'blocked',
      reason: `${desired.cliId} 尚未验证支持推理强度 ${desired.selection.reasoningEffort}。`,
    };
  }
  if (capabilities.supportsInPlaceModelSwitch) {
    return { action: 'keep' };
  }
  return {
    action: 'recreate',
    reason: '目标模型与现有原生会话不同，当前 CLI 只能在新原生会话中应用该模型。',
  };
}

export function frozenKnownModel(value: ResolvedModel): FrozenExecutionModel {
  return { kind: 'known', value };
}

export function frozenLegacyModel(): FrozenExecutionModel {
  return { kind: 'legacy-native' };
}
