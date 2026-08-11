import type { CliExecutionPolicy } from './types.js';

type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

const STANDARD_POLICY = [
  '[Agent OS 执行边界：普通任务]',
  '本任务没有获得高风险操作审批。只允许在当前工作区内完成常规读取、编辑、构建和测试。',
  '不得执行生产/线上发布、强制推送、不可逆删除或清库、系统提权、权限/密钥变更。',
  '如果任务确实需要这些操作，立即停止并明确提示用户通过 /approval 重新发起，不能自行绕过。',
].join('\n');

const READ_ONLY_POLICY = [
  '[Agent OS 执行边界：只读任务]',
  '本任务只能分析已有输入与文件，不能修改文件、运行会改变状态的命令，也不能调用有副作用的外部工具。',
].join('\n');

const INPUT_ONLY_POLICY = [
  '[Agent OS 执行边界：仅输入分析]',
  '只能分析本次提示中已经提供的数据。',
  '不得调用任何工具、读取任何文件、访问网络、恢复或引用旧会话，也不能修改任何状态。',
].join('\n');

let warnedStandardSandbox = false;
let warnedApprovedSandbox = false;

export function instructionsForExecutionPolicy(
  policy: CliExecutionPolicy,
  approvedScope?: string,
): string {
  if (policy === 'standard') return STANDARD_POLICY;
  if (policy === 'read-only') return READ_ONLY_POLICY;
  if (policy === 'input-only') return INPUT_ONLY_POLICY;
  const scope = (approvedScope?.trim() || '未提供审批范围').slice(0, 4_000);
  return [
    '[Agent OS 执行边界：本次已审批]',
    '负责人只批准了下面“批准范围”内的任务。可以完成它明确需要的高权限步骤，但不得扩大目标、对象或影响范围。',
    '遇到批准范围之外的新高风险操作，必须停止并要求重新审批。',
    `[批准范围]\n${scope}`,
  ].join('\n');
}

export function promptForExecutionPolicy(
  prompt: string,
  policy: CliExecutionPolicy,
  approvedScope?: string,
): string {
  const boundary = instructionsForExecutionPolicy(policy, approvedScope);
  return `${boundary}\n\n[本次任务]\n${prompt.trim()}`;
}

export function codexSandboxFor(policy: CliExecutionPolicy): CodexSandbox {
  if (policy === 'read-only' || policy === 'input-only') return 'read-only';
  if (policy === 'approved') {
    const configured = process.env.CODEX_APPROVED_SANDBOX?.trim();
    // 人工批准的是一个动作范围，不等于默认授予整个主机权限。
    // 确实需要网络/工作区外写入时，管理员必须显式配置 danger-full-access。
    if (!configured) return 'workspace-write';
    if (isCodexSandbox(configured)) return configured;
    if (!warnedApprovedSandbox) {
      warnedApprovedSandbox = true;
      console.warn(`[配置] CODEX_APPROVED_SANDBOX=${configured} 非法，回退到 workspace-write`);
    }
    return 'workspace-write';
  }

  const configured = process.env.CODEX_SANDBOX?.trim() || 'workspace-write';
  if (configured === 'read-only' || configured === 'workspace-write') return configured;
  if (!warnedStandardSandbox) {
    warnedStandardSandbox = true;
    console.warn(
      `[配置] 普通任务不允许 CODEX_SANDBOX=${configured}，已回退到 workspace-write；高权限沙箱请配置 CODEX_APPROVED_SANDBOX。`,
    );
  }
  return 'workspace-write';
}

function isCodexSandbox(value: string): value is CodexSandbox {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access';
}
