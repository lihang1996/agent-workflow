import type { CliId } from '../cli/types.js';
import type { ModelSelection, ModelSelectionCapabilities } from './model-selection.js';

/**
 * 引擎模型能力矩阵（AO-REQ-602）。
 *
 * 这里的取值只允许来自已核验证据（本机 CLI help、二进制源码字符串或真实探测），
 * 与 docs/engine-support-matrix.md 一一对应；未核验的能力一律为 false，禁止
 * 用引擎自述或历史成功日志替代。capabilities 不来自用户配置，避免自报。
 */
export interface EngineModelCapabilities extends ModelSelectionCapabilities {
  /** 已核验的 CLI 版本与证据来源；null 表示本机尚未核验。 */
  evidence: {
    cliVersion: string;
    verifiedAt: string;
    source: string;
  } | null;
  /** CLI 接受模型/推理强度的实际参数（文档用途，构造 args 的逻辑在各 adapter）。 */
  modelSelectionArgs: string;
  /** 已核验的推理强度取值；未核验枚举时不设，非法值交由引擎侧显式失败。 */
  reasoningEffortValues?: readonly string[];
  /** 未核验/不支持的已知限制，写进矩阵与报错提示。 */
  notes: string;
}

const CLAUDE_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const ENGINE_MODEL_CAPABILITIES: Record<CliId, EngineModelCapabilities> = {
  claude: {
    supportsModelSelection: true,
    supportsReasoningEffort: true,
    // 原地切换未实测：模型变化时按 recreate 重建原生会话，而不是冒充可切换。
    supportsInPlaceModelSwitch: false,
    evidence: {
      cliVersion: '2.1.261',
      verifiedAt: '2026-09-28',
      source: 'claude --help：--model <model>；--effort <level> (low, medium, high, xhigh, max)',
    },
    modelSelectionArgs: '--model <model> --effort <level>',
    reasoningEffortValues: CLAUDE_EFFORT_VALUES,
    notes: '续接（--resume）叠加模型参数未端到端实测；原地切换按未核验处理。',
  },
  codex: {
    supportsModelSelection: true,
    supportsReasoningEffort: true,
    supportsInPlaceModelSwitch: false,
    evidence: {
      cliVersion: '0.150.1',
      verifiedAt: '2026-09-28',
      source: 'codex exec --help：-m/--model <MODEL>；-c model_reasoning_effort（键名见二进制源码字符串）',
    },
    modelSelectionArgs: '-m <model>；-c model_reasoning_effort="<level>"',
    notes: [
      '推理强度取值枚举本地不校验，非法值由服务端拒绝（任务显式失败）。',
      '本机用户默认模型与账号不兼容时端到端不可用（见矩阵文档）。',
    ].join(''),
  },
  cursor: {
    supportsModelSelection: true,
    // 无独立推理强度参数：仅个别模型支持 model[effort=...] 括号参数化，
    // 不能当作通用能力，显式配置 effort 时直接拒绝。
    supportsReasoningEffort: false,
    supportsInPlaceModelSwitch: false,
    evidence: {
      cliVersion: '2026.08.11-e8db854',
      verifiedAt: '2026-09-28',
      source: 'agent --help：--model <model>；agent --list-models 列出可选模型',
    },
    modelSelectionArgs: '--model <model>（无推理强度参数）',
    notes: '未显式指定模型时沿用 CURSOR_CLI_MODEL 环境变量（历史行为）。',
  },
  zcode: {
    // 官方 CLI 0.16.9 headless（--prompt）没有模型参数；/model 仅 TUI。
    // 新会话模型来自 provider 配置 defaultModelSelection（源码核对），不受
    // 单次执行控制，显式声明模型只能 blocked，不允许静默用原生默认。
    supportsModelSelection: false,
    supportsReasoningEffort: false,
    supportsInPlaceModelSwitch: false,
    evidence: {
      cliVersion: '0.16.9',
      verifiedAt: '2026-09-28',
      source: 'zcode --help 无模型参数；zcode.cjs 源码仅 provider 配置 defaultModelSelection 路径',
    },
    modelSelectionArgs: '（无）',
    notes: '默认模型需在官方 TUI/provider 配置中预先选定；agent-os 无法逐执行声明。',
  },
};

export function engineModelCapabilities(cliId: CliId): ModelSelectionCapabilities {
  const capabilities = ENGINE_MODEL_CAPABILITIES[cliId];
  return {
    supportsModelSelection: capabilities.supportsModelSelection,
    supportsReasoningEffort: capabilities.supportsReasoningEffort,
    supportsInPlaceModelSwitch: capabilities.supportsInPlaceModelSwitch,
  };
}

function describeCapabilities(cliId: CliId): string {
  const capabilities = ENGINE_MODEL_CAPABILITIES[cliId];
  return capabilities.evidence
    ? `${cliId}（${capabilities.evidence.cliVersion}，${capabilities.evidence.source}）`
    : `${cliId}`;
}

/**
 * 矩阵外组合显式拒绝（R-MDL-1：不支持静默 native-default）。
 * 在组装引擎参数前调用；命中即抛错，任务失败并给出原因。
 */
export function assertModelSelectionSupported(
  cliId: CliId,
  selection: Pick<ModelSelection, 'model' | 'reasoningEffort'>,
): void {
  const capabilities = ENGINE_MODEL_CAPABILITIES[cliId];
  if (selection.model && !capabilities.supportsModelSelection) {
    throw new Error(
      `${describeCapabilities(cliId)} 的 headless 模式没有模型选择参数，无法保证使用指定模型 ${selection.model}。`
      + `请移除该角色对 ${cliId} 的模型声明，或改用支持模型选择的引擎。`,
    );
  }
  if (selection.reasoningEffort && !capabilities.supportsReasoningEffort) {
    throw new Error(
      `${describeCapabilities(cliId)} 不支持独立设置推理强度（${capabilities.modelSelectionArgs}）。`
      + `请移除该角色对 ${cliId} 的 reasoningEffort 声明。`,
    );
  }
  if (
    selection.reasoningEffort
    && capabilities.reasoningEffortValues
    && !capabilities.reasoningEffortValues.includes(selection.reasoningEffort)
  ) {
    throw new Error(
      `${describeCapabilities(cliId)} 支持的推理强度为 ${capabilities.reasoningEffortValues.join('、')}，`
      + `收到的是 ${selection.reasoningEffort}。`,
    );
  }
}
