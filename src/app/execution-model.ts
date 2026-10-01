import type { CliId } from '../cli/types.js';
import { inspectProtectedZcodeBinding } from '../core/zcode-model-binding.js';
import {
  compareExecutionSelection,
  normalizeModelSelection,
  resolveModel,
  type ModelOverrides,
  type ModelSelection,
  type ModelSelectionSource,
  type ModelSwitchDecision,
  type ResolvedModel,
} from '../core/model-selection.js';
import {
  assertModelSelectionSupported,
  ENGINE_MODEL_CAPABILITIES,
} from '../core/engine-capabilities.js';
import type { BotConfig } from '../core/bot-registry.js';
import {
  assertSelectionAgainstRuntime,
  ensureEngineRuntimeVerified,
  type CliProbe,
  type EngineRuntimeCheck,
} from '../core/engine-runtime.js';

export interface ExecutionModelPlan {
  desired: ResolvedModel;
  decision: ModelSwitchDecision;
  /** 传给 CLI 的模型选择；有效模型与强度均为空（native-default）时为 null。 */
  modelSelection: ModelSelection | null;
  /** keep/recreate 判定后的原生会话 id；recreate 与全新会话时为 undefined。 */
  resumeCliSessionId: string | undefined;
  /** 运行时核验结果（同一可执行文件的版本/参数面实测，审计留存）。 */
  runtimeCheck: EngineRuntimeCheck;
}

export type ExecutableSession = {
  cliId: CliId;
  cliSessionId?: string;
  cliModelSelection?: ModelSelection | null;
};

export interface PlanExecutionModelOptions {
  /** 环境来源（默认 process.env）；cursor 的生效模型从 CURSOR_CLI_MODEL 读取。 */
  env?: Record<string, string | undefined>;
  /** 运行时将启动的命令（各 adapter 的 command）；用于同可执行文件核验。 */
  command?: string;
  /** 测试注入的 CLI 探测函数。 */
  probe?: CliProbe;
}

function defaultCommand(cliId: CliId): string {
  if (cliId === 'cursor') return process.env.CURSOR_CLI_COMMAND?.trim() || 'agent';
  if (cliId === 'zcode') return process.env.ZCODE_CLI_COMMAND?.trim() || 'zcode';
  return cliId;
}

// ---- 生效选择计算（计划与视图共用；A05 166 号返工） ----------------------------------

/** 生效来源：三级声明之外，cursor 的环境回退是第四种可生效来源。 */
export type EffectiveModelSource = ModelSelectionSource | 'cursor-env';

export interface EffectiveModelComputation {
  cliId: CliId;
  /** 三级来源解析结果（话题 > 角色 > native-default）。 */
  resolved: ResolvedModel;
  /** 实际将生效的选择（含 cursor 环境回退）。 */
  effective: ModelSelection;
  effectiveSource: EffectiveModelSource;
  /** cursor 环境回退命中的 CURSOR_CLI_MODEL 值（未命中为 null）。 */
  cursorEnvModel: string | null;
}

/**
 * A05（166 号返工）：**执行计划与 /status 视图共用同一计算**——过去视图只调
 * resolveModel，不应用 CURSOR_CLI_MODEL 回退，也不区分「引擎确认过的值」与
 * 「待确认默认」；现在两处都从本函数取 effective/effectiveSource，保证展示
 * 与执行计划一致。
 */
export function computeEffectiveModelSelection(options: {
  modelOverrides?: ModelOverrides;
  cliId: CliId;
  env?: Record<string, string | undefined>;
  topicOverride?: ModelSelection | null;
}): EffectiveModelComputation {
  const env = options.env ?? process.env;
  const resolved = resolveModel(options.modelOverrides, options.cliId, options.topicOverride ?? null);
  let effective = normalizeModelSelection(resolved.selection);
  let effectiveSource: EffectiveModelSource = resolved.source;
  let cursorEnvModel: string | null = null;
  // 返修 2：cursor 的隐式回退值进入选择与绑定，绑定比较就能感知环境变化。
  if (options.cliId === 'cursor' && effective.model === null) {
    const envModel = env.CURSOR_CLI_MODEL?.trim();
    if (envModel) {
      effective = { model: envModel, reasoningEffort: null };
      effectiveSource = 'cursor-env';
      cursorEnvModel = envModel;
    }
  }
  return { cliId: options.cliId, resolved, effective, effectiveSource, cursorEnvModel };
}

/**
 * 任务执行前的模型决策（AO-REQ-601 + Codex 返修 2/5）：
 * 1. computeEffectiveModelSelection 得到本轮期望选择（角色覆盖 → cursor 环境
 *    回退 → native-default）——与 /status 视图共用同一计算（A05）；
 * 2. cursor 未显式声明模型时，CURSOR_CLI_MODEL 的环境值就是本次实际生效的
 *    模型——纳入决策与绑定（环境值变化 ⇒ 绑定不一致 ⇒ recreate），不允许
 *    「环境换了模型还照旧 keep」；
 * 3. 静态矩阵外组合显式抛错；随后按运行时同一可执行文件实测参数面，运行时
 *    不支持同样拒绝（只降级不升级）；
 * 4. compareExecutionSelection 判定 keep/recreate/blocked：blocked 由调用方
 *    以任务失败呈现，不静默换模型。
 */
export async function planExecutionModel(
  modelOverrides: ModelOverrides | undefined,
  session: ExecutableSession,
  options: PlanExecutionModelOptions = {},
): Promise<ExecutionModelPlan> {
  const computation = computeEffectiveModelSelection({
    modelOverrides,
    cliId: session.cliId,
    env: options.env,
  });
  const { resolved: desired } = computation;
  const effective = computation.effective;

  if (session.cliId === 'zcode' && effective.model) {
    let detail: string;
    try {
      const receipt = inspectProtectedZcodeBinding(effective, session.cliSessionId);
      detail = `host 元数据 model=${receipt.modelId} / provider=${receipt.providerId}；无项目 .env 的 fresh/resume/recreate 引导链仍未通过实测`;
    } catch (error) { detail = `host 模型绑定未核验：${(error as Error).message}`; }
    throw new Error(`zcode 的 headless 模式没有模型选择参数，无法保证使用指定模型 ${effective.model}。${detail}；保持 blocked，不静默切换模型。`);
  }

  assertModelSelectionSupported(session.cliId, effective);
  // 注入探测函数（测试）时绕过缓存，避免不同用例的假探测结果互相污染。
  const runtimeCheck = await ensureEngineRuntimeVerified(
    session.cliId,
    options.command ?? defaultCommand(session.cliId),
    options.probe ? { probe: options.probe, noCache: true } : {},
  );
  assertSelectionAgainstRuntime(runtimeCheck, effective);

  const decision = compareExecutionSelection(
    session.cliSessionId
      ? {
        cliSessionId: session.cliSessionId,
        selection: session.cliModelSelection === undefined
          ? undefined
          : {
            cliId: session.cliId,
            selection: normalizeModelSelection(session.cliModelSelection),
            source: desired.source,
            roleDefaultFingerprint: '',
          },
      }
      : undefined,
    { ...desired, selection: effective },
    // 带 model/effort 的组合已在上面的运行时断言被拒绝或确认；这里用运行时
    // 能力（只降级不升级）做 keep/recreate/blocked 判定。
    runtimeCheck.capabilities,
  );

  return {
    desired,
    decision,
    modelSelection: effective.model !== null || effective.reasoningEffort !== null
      ? effective
      : null,
    resumeCliSessionId: decision.action === 'keep' ? session.cliSessionId : undefined,
    runtimeCheck,
  };
}

export function assertModelPlanExecutable(plan: ExecutionModelPlan): void {
  if (plan.decision.action === 'blocked') {
    throw new Error(`模型选择被阻断：${plan.decision.reason}`);
  }
}

// ---- 生效模型视图（A05：统一三层可读视图） ------------------------------------------

export interface DescribeEffectiveModelOptions {
  /** 指定引擎（默认 bot.defaultCliId；/status 用会话实际引擎）。 */
  cliId?: CliId;
  /** 话题级声明（三级来源的最高层；调用方取不到会话级信息时不传）。 */
  topicOverride?: ModelSelection | null;
  /** 当前原生会话已绑定的模型选择（上次执行的计划选择；引擎实际值未核验）。 */
  boundSelection?: ModelSelection | null;
  /**
   * 环境来源（默认 process.env）：cursor 的环境回退（CURSOR_CLI_MODEL）与
   * 执行计划取同一来源——视图不再漏掉环境生效值（A05 166 号返工）。
   */
  env?: Record<string, string | undefined>;
}

const EFFECTIVE_SOURCE_LABELS: Record<EffectiveModelSource, string> = {
  topic: '话题声明',
  role: '角色声明',
  'native-default': '引擎原生默认',
  'cursor-env': '环境变量 CURSOR_CLI_MODEL',
};

function describeSelectionLayer(selection: ModelSelection | null | undefined): string {
  const normalized = normalizeModelSelection(selection);
  if (normalized.model === null && normalized.reasoningEffort === null) return '无（原生默认，具体值未核验）';
  return `model=${normalized.model ?? '未声明'}，effort=${normalized.reasoningEffort ?? '未声明'}`;
}

/**
 * A05：把「角色声明 → 环境回退 → 个人默认 → 最终参数」生效模型输出为可读
 * 视图。计算与执行计划共用 computeEffectiveModelSelection（166 号返工：视图
 * 与计划一致）；判读用已核验的引擎能力矩阵——引擎不支持按执行声明模型
 * （zcode）时如实标注「声明无法生效」。**证据标签纪律**：会话绑定来自执行
 * 计划的选择，不是引擎报告的实际值 ⇒ 标注「计划选择；引擎实际值未核验」；
 * 引擎原生默认的具体值 agent-os 拿不到 ⇒ 一律标注「实际值未核验」，绝不把
 * 未知值展示成已核验。视图本身不抛错（它是展示，不是校验）。
 */
export function describeEffectiveModel(
  bot: Pick<BotConfig, 'defaultCliId' | 'modelOverrides'>,
  options: DescribeEffectiveModelOptions = {},
): string {
  const cliId = options.cliId ?? bot.defaultCliId;
  const hasTopicLayer = options.topicOverride !== undefined;
  const computation = computeEffectiveModelSelection({
    modelOverrides: bot.modelOverrides,
    cliId,
    env: options.env,
    topicOverride: options.topicOverride ?? null,
  });
  const { resolved, effective, effectiveSource, cursorEnvModel } = computation;
  const roleOverride = bot.modelOverrides?.[cliId];
  const capabilities = ENGINE_MODEL_CAPABILITIES[cliId];
  const declaredUnsupported = resolved.source === 'role' && !capabilities.supportsModelSelection;

  const lines: string[] = [`生效模型（${cliId}）：`];
  if (hasTopicLayer) {
    lines.push(`- 话题级声明：${describeSelectionLayer(options.topicOverride)}`);
  }
  lines.push(`- 角色声明：${roleOverride ? describeSelectionLayer(roleOverride) : '无'}`);
  if (declaredUnsupported) {
    lines.push('- 个人默认：引擎 provider 配置的默认模型（角色声明不被支持，见下方最终参数；实际值未核验）');
  } else if (effectiveSource === 'cursor-env') {
    lines.push(`- 环境回退：CURSOR_CLI_MODEL=${cursorEnvModel}（cursor 未声明模型时生效，并纳入执行绑定）`);
    lines.push('- 个人默认：未读取，实际值未知（当前显式选择来自上方环境回退）');
  } else if (resolved.source === 'native-default') {
    lines.push(capabilities.supportsModelSelection
      ? '- 个人默认：引擎 CLI 原生默认（角色未声明时由 CLI 自己的配置决定；实际值未核验）'
      : '- 个人默认：引擎 provider 配置的默认模型（官方 headless 无按执行声明模型的参数；实际值未核验）');
  } else {
    lines.push(`- 个人默认：未读取，实际值未知（当前显式选择来自${EFFECTIVE_SOURCE_LABELS[resolved.source]}）`);
  }
  if (declaredUnsupported) {
    lines.push(
      `- 最终参数：引擎原生默认（${cliId} 不支持按执行声明模型，角色声明 model=${roleOverride?.model ?? '未声明'} 无法生效；带该声明的任务将被显式拒绝，不会静默用别的模型）`,
    );
  } else if (effective.model !== null || effective.reasoningEffort !== null) {
    const model = effective.model ?? '引擎原生默认';
    const effort = effective.reasoningEffort ?? '未声明';
    lines.push(`- 最终参数：${cliId} ${model} / effort ${effort}（来源：${EFFECTIVE_SOURCE_LABELS[effectiveSource]}）`);
  } else {
    lines.push(`- 最终参数：${cliId} 引擎原生默认 / effort 未声明（来源：引擎原生默认；实际值未核验）`);
  }
  if (options.boundSelection !== undefined) {
    lines.push(`- 当前会话绑定：${describeSelectionLayer(options.boundSelection)}（上次执行计划选择；引擎实际使用值未核验）`);
  }
  return lines.join('\n');
}

/**
 * 决策落地：blocked 抛错（任务失败并给原因）；recreate 返回 undefined（本次
 * 不续接旧原生会话，开新会话），keep 返回原会话 id。旧绑定不在执行前清除：
 * 执行成功后 executeTask 的 setCliSessionId 会用新会话+实际模型选择覆盖；
 * 执行失败时旧绑定保留，下次仍会按同一决策 recreate（幂等，不破坏现场）。
 */
export function applyModelDecision(plan: ExecutionModelPlan): string | undefined {
  assertModelPlanExecutable(plan);
  return plan.resumeCliSessionId;
}

export interface RecreateContextRecord {
  id: string;
  nativeSessionId?: string;
  model?: ModelSelection | null;
  answer: string;
}

/**
 * 返修 3（Codex 二轮 P1-3 / 13 号 C5）：模型变化 recreate 后，把历史 CLI
 * 回答（可能转述项目文件/网页/工具输出中的第三方指令）注入新会话的当前
 * 任务构成「指令洗白」；仅加「请勿遵从」的提示词或把原文转成摘要都不足
 * 以消除该风险。因此在可信来源分层、授权摘要与工具读写隔离被验证之前，
 * **依赖历史上下文的 recreate 一律阻断**，引导用户在新话题明确提供上下文
 * （新话题 = 新会话、无历史依赖，不受影响）。W2 不宣称已实现自动迁移。
 */
export function assertRecreateWithoutHistoryDependency(input: {
  /** 决策前会话是否已绑定原生会话（recreate 的前提，亦即历史依赖的来源）。 */
  hadNativeSession: boolean;
}): void {
  if (!input.hadNativeSession) return;
  throw new Error(
    '模型配置与当前会话使用的模型不一致，需要新建原生会话；但本话题已有原生会话历史，'
    + '自动迁移历史上下文可能带入来自项目文件、网页或工具输出的第三方指令，在来源分层与隔离'
    + '验证完成前已禁止。请新开一个话题并明确写清必要背景，或把模型配置恢复为先前的取值。',
  );
}
