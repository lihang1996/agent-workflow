import { FingerprintDriftError } from './quality-gates.js';
import { RuntimeSourceChangedError } from './runtime-source-guard.js';

const DEFAULT_FORMAT_REPAIR_ATTEMPTS = 1;
const MAX_FORMAT_REPAIR_ATTEMPTS = 2;

/**
 * 语义/质量结论：必须停或退回开发，不能靠同一会话「再交一次卷」蒙混。
 * 含真实 P0/P1、测试失败、fingerprint 漂移、CLI 根本没启动。
 */
const SEMANTIC_FAILURE_RE = /仍有未闭环 P0\/P1|仍有开放 P0\/P1|仍有未处理 P0\/P1|质量门禁 [^\n]+ 未通过|必需检查未通过|实现门禁必须闭环|不得静默降低|尝试上限|无限返工|与审查 artifact 不一致|findings 集合不一致|当前变更快照|fingerprint|FingerprintDrift|spawn \S+ ENOENT|产品代码缺陷|测试真实失败|命令已真实运行且因产品代码/i;

/**
 * 协议/结构：探索已经做完，只是交卷标记、JSON、artifact 路径/hash 不合格。
 * Claude / Codex / Cursor 都会在 CLI 退出后才碰到这些错误。
 */
const PROTOCOL_FORMAT_RE = /不是可确认的产品 Spec|未创建结构化问卷|RISK_WAIVER|稳定需求 ID|缺少显式 \[RESULT:|终态标记|缺少可解析的 \[GATE_RESULT\]|无法解析 GATE_RESULT|Gate 结果格式错误|不是有效 JSON|JSON 未闭合|格式错误|hash 不匹配|缺少规范主 artifact|artifact 不可读取|artifact 不是普通文件|必须位于本工作流证据目录|必须声明 canonical requirementIds|必须包含已落盘|命令缺少 cwd|finishedAt 位于未来|检查来自当前步骤启动前|必须包含真实校验命令|必须包含 command-report artifact|必须包含 review-report artifact|必须包含 runtime-report artifact|不得声明控制器拥有的 artifact|不得声明其他步骤主 artifact|主 artifact 类型错误|validate-spec-markdown|validate-change-plan|validate-implementation-manifest|validate-review-report|validate-verification-report|validate-runtime-matrix|validate-final-review/i;

/** 控制器在同一 CLI 会话内最多纠偏几次交卷格式；0 关闭。默认 1，上限 2。 */
export function resolveFormatRepairAttempts(
  envValue = process.env.CLI_FORMAT_REPAIR_ATTEMPTS,
): number {
  const raw = envValue?.trim();
  if (!raw) return DEFAULT_FORMAT_REPAIR_ATTEMPTS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[配置] CLI_FORMAT_REPAIR_ATTEMPTS=${raw} 非法，回退到 ${DEFAULT_FORMAT_REPAIR_ATTEMPTS}`,
    );
    return DEFAULT_FORMAT_REPAIR_ATTEMPTS;
  }
  return Math.min(MAX_FORMAT_REPAIR_ATTEMPTS, Math.floor(parsed));
}

export function isProtocolFormatError(error: unknown): boolean {
  if (error instanceof FingerprintDriftError) return false;
  if (error instanceof RuntimeSourceChangedError) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (!message.trim()) return false;
  if (SEMANTIC_FAILURE_RE.test(message)) return false;
  return PROTOCOL_FORMAT_RE.test(message);
}

export function shouldRepairProtocolFormat(options: {
  error: unknown;
  repairsUsed: number;
  maxRepairs?: number;
  resumeSessionId?: string;
  aborted?: boolean;
}): boolean {
  if (options.aborted) return false;
  if (!options.resumeSessionId) return false;
  const max = options.maxRepairs ?? resolveFormatRepairAttempts();
  if (max <= 0 || options.repairsUsed >= max) return false;
  return isProtocolFormatError(options.error);
}

/** 同一会话续写：禁止重新探索，只修协议/结构。三引擎 resume 都能吃这段。 */
export function buildProtocolFormatRepairPrompt(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    '【控制器格式纠偏 · 同一会话续写，禁止重新探索】',
    '上一轮交卷被控制器拒绝。原因是协议/结构格式，不是要你重做需求分析、扩大审查或重跑全量测试。',
    `具体原因：${message}`,
    '',
    '要求：',
    '1. 不要重新读取整个仓库，不要重做项目发现或全量审查。',
    '2. 只修正 Spec 结构、行首 [RESULT:done|blocked|failed]、可选的 [DECISION]/[HANDOFF]/[BLOCK_KIND]、[GATE_RESULT] JSON、主 artifact 路径与真实 sha256。',
    '3. 没有用户已明确接受的风险时，Spec 正文不要出现 RISK_WAIVER 标记。',
    '4. 先运行本步骤 Skill 的 validate-*.mjs（产品经理用 validate-spec-markdown.mjs），通过后再输出完整终态。',
    '5. 产品结论、开放 P0/P1、是否 [APPROVED] 保持上一轮判断，除非格式修正必然改到这些字段。',
  ].join('\n');
}
