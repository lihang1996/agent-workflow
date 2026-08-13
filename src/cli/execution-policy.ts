import type { CliCapabilityExpectation, CliExecutionPolicy } from './types.js';

export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

const STANDARD_POLICY = [
  '[Agent OS 执行边界：普通任务]',
  '本任务没有获得高风险操作审批。只允许在当前工作区内完成常规读取、编辑、构建和测试。',
  'migration/TRUNCATE/DROP 仍须通过隔离测试资源预检与显式 sentinel。',
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

const WORKSPACE_PROFILE = 'agent-os-workspace';

let warnedStandardSandbox = false;
let warnedApprovedSandbox = false;

export function instructionsForExecutionPolicy(
  policy: CliExecutionPolicy,
  approvedScope?: string,
  localNetwork?: CliCapabilityExpectation,
): string {
  let boundary: string;
  if (policy === 'standard') boundary = STANDARD_POLICY;
  else if (policy === 'read-only') boundary = READ_ONLY_POLICY;
  else if (policy === 'input-only') boundary = INPUT_ONLY_POLICY;
  else {
    const scope = (approvedScope?.trim() || '未提供审批范围').slice(0, 4_000);
    boundary = [
      '[Agent OS 执行边界：本次已审批]',
      '负责人只批准了下面“批准范围”内的任务。可以完成它明确需要的高权限步骤，但不得扩大目标、对象或影响范围。',
      '遇到批准范围之外的新高风险操作，必须停止并要求重新审批。',
      `[批准范围]\n${scope}`,
    ].join('\n');
  }
  return localNetwork ? `${boundary}\n${localNetworkInstruction(localNetwork)}` : boundary;
}

export function promptForExecutionPolicy(
  prompt: string,
  policy: CliExecutionPolicy,
  approvedScope?: string,
  localNetwork?: CliCapabilityExpectation,
): string {
  const boundary = instructionsForExecutionPolicy(policy, approvedScope, localNetwork);
  return `${boundary}\n\n[本次任务]\n${prompt.trim()}`;
}

/**
 * Claude 普通任务（dontAsk + 预授权 Write/Bash）没有 OS 沙箱，本机 listen / Postgres / 浏览器都能跑。
 * Codex 默认对齐为 danger-full-access；显式 CODEX_SANDBOX=workspace-write|read-only 才收紧。
 */
export function codexSandboxFor(policy: CliExecutionPolicy): CodexSandbox {
  if (policy === 'read-only' || policy === 'input-only') return 'read-only';
  if (policy === 'approved') {
    const configured = process.env.CODEX_APPROVED_SANDBOX?.trim();
    if (!configured) return 'danger-full-access';
    if (isCodexSandbox(configured)) return configured;
    if (!warnedApprovedSandbox) {
      warnedApprovedSandbox = true;
      console.warn(`[配置] CODEX_APPROVED_SANDBOX=${configured} 非法，回退到 danger-full-access`);
    }
    return 'danger-full-access';
  }

  // P0 安全修复：standard 策略默认 fail-closed 到 workspace-write，而不是 fail-open 到 danger-full-access。
  // 只有显式配置 CODEX_SANDBOX=danger-full-access 才放行全权限。
  const configured = process.env.CODEX_SANDBOX?.trim();
  if (!configured) return 'workspace-write';
  if (isCodexSandbox(configured)) return configured;
  if (!warnedStandardSandbox) {
    warnedStandardSandbox = true;
    console.warn(
      `[配置] CODEX_SANDBOX=${configured} 非法，已回退到 workspace-write（fail-closed）。`,
    );
  }
  return 'workspace-write';
}

export type CodexLocalNetworkReason =
  | 'not-requested'
  | 'policy-forbids-network'
  | 'sandbox-read-only'
  | 'sandbox-provides-network'
  | 'disabled-by-env'
  | 'invalid-env'
  | 'loopback-config-applied';

export interface CodexRuntimePlan {
  /** 只读策略才传 `--sandbox`；写权限走 permission profile，避免旧沙箱丢掉本机绑定。 */
  sandboxFlag?: CodexSandbox;
  prefixArgs: string[];
  expectation: CliCapabilityExpectation & { reason: CodexLocalNetworkReason };
}

/**
 * 为本次 Codex 调用生成 argv 前缀与能力预期。
 * 传 `--sandbox` 会强制走旧沙箱，permission profile 的 allow_local_binding 不会生效。
 */
export function codexRuntimePlan(
  policy: CliExecutionPolicy,
  requested: boolean,
  configuredValue = process.env.CODEX_LOCAL_NETWORK_ACCESS,
): CodexRuntimePlan {
  const sandbox = codexSandboxFor(policy);
  const network = resolveNetworkIntent(policy, sandbox, requested, configuredValue);

  if (sandbox === 'read-only' || policy === 'read-only' || policy === 'input-only') {
    return {
      sandboxFlag: 'read-only',
      prefixArgs: [],
      expectation: capability(requested, false, 'none', network.reason),
    };
  }

  if (sandbox === 'danger-full-access' && network.expected === 'sandbox-provided') {
    return {
      prefixArgs: ['-c', 'default_permissions=":danger-full-access"'],
      expectation: capability(requested, true, 'sandbox-provided', 'sandbox-provides-network'),
    };
  }

  return {
    prefixArgs: workspaceProfileArgs(network.expected === 'loopback'),
    expectation: capability(
      requested,
      network.expected === 'loopback',
      network.expected,
      network.reason,
    ),
  };
}

/** @deprecated 使用 codexRuntimePlan；保留给只需要旧 argv 网络段的调用方。 */
export function codexLocalNetworkPlan(
  policy: CliExecutionPolicy,
  sandbox: CodexSandbox,
  requested: boolean,
  configuredValue = process.env.CODEX_LOCAL_NETWORK_ACCESS,
): { expectation: CliCapabilityExpectation & { reason: CodexLocalNetworkReason }; args: string[] } {
  const plan = codexRuntimePlan(policy, requested, configuredValue);
  if (sandbox === 'read-only' && plan.sandboxFlag === 'read-only') {
    return { expectation: plan.expectation, args: [] };
  }
  return { expectation: plan.expectation, args: plan.prefixArgs };
}

export function codexLocalNetworkConfigArgs(
  policy: CliExecutionPolicy,
  sandbox: CodexSandbox,
  requested: boolean,
): string[] {
  return codexLocalNetworkPlan(policy, sandbox, requested).args;
}

function resolveNetworkIntent(
  policy: CliExecutionPolicy,
  sandbox: CodexSandbox,
  requested: boolean,
  configuredValue: string | undefined,
): { expected: CliCapabilityExpectation['expected']; reason: CodexLocalNetworkReason } {
  if (policy === 'read-only' || policy === 'input-only') {
    return { expected: 'none', reason: 'policy-forbids-network' };
  }
  if (sandbox === 'read-only') return { expected: 'none', reason: 'sandbox-read-only' };

  const configured = configuredValue?.trim().toLowerCase();
  if (configured && ['0', 'false', 'no', 'off'].includes(configured)) {
    return { expected: 'none', reason: 'disabled-by-env' };
  }
  if (configured && !['1', 'true', 'yes', 'on'].includes(configured)) {
    return { expected: 'none', reason: 'invalid-env' };
  }

  // Claude dontAsk 对允许的 Bash(node/pnpm/npx) 没有 OS 网络沙箱。
  // Codex 默认 danger-full-access 对齐这一点，不要求调用方再声明 localNetworkAccess。
  if (sandbox === 'danger-full-access') {
    return { expected: 'sandbox-provided', reason: 'sandbox-provides-network' };
  }
  if (!requested) return { expected: 'none', reason: 'not-requested' };
  return { expected: 'loopback', reason: 'loopback-config-applied' };
}

function workspaceProfileArgs(network: boolean): string[] {
  const args = [
    '-c',
    `default_permissions=${JSON.stringify(WORKSPACE_PROFILE)}`,
    '-c',
    `permissions.${WORKSPACE_PROFILE}.extends=${JSON.stringify(':workspace')}`,
  ];
  if (!network) return args;
  args.push(
    '-c',
    `permissions.${WORKSPACE_PROFILE}.network.enabled=true`,
    '-c',
    `permissions.${WORKSPACE_PROFILE}.network.allow_local_binding=true`,
    '-c',
    `permissions.${WORKSPACE_PROFILE}.network.domains={ "*" = "allow", "localhost" = "allow", "127.0.0.1" = "allow", "::1" = "allow" }`,
  );
  return args;
}

function capability(
  requested: boolean,
  configApplied: boolean,
  expected: CliCapabilityExpectation['expected'],
  reason: CodexLocalNetworkReason,
): CliCapabilityExpectation & { reason: CodexLocalNetworkReason } {
  return {
    capability: 'local-network',
    requested,
    configApplied,
    expected,
    reason,
  };
}

function localNetworkInstruction(expectation: CliCapabilityExpectation): string {
  if (expectation.expected === 'loopback') {
    return [
      `[本机网络能力：已请求；reason=${expectation.reason}]`,
      '本次已向 Codex 请求工作区写入与本机回环网络（permission profile，含 allow_local_binding），用于当前项目的测试服务、浏览器和隔离测试库；不得探测无关本地服务。',
      '“已请求”不等于运行时已授予；若实际执行仍返回受限、EPERM 或连接被拒绝，必须如实报告阻塞，不能伪造验收证据。',
    ].join('\n');
  }
  if (expectation.expected === 'sandbox-provided') {
    return [
      `[本机网络能力：由运行时提供；reason=${expectation.reason}]`,
      '本次 Codex 权限与 Claude dontAsk 对齐：不启用旧 `--sandbox`，使用 `:danger-full-access` permission profile，可完成本机构建、测试服务、浏览器和隔离测试库；仍必须遵守本任务的审批范围和其它执行边界。',
    ].join('\n');
  }
  return [
    `[本机网络能力：未请求；reason=${expectation.reason}]`,
    '本次没有向 Codex 请求本机回环网络；不得声称能够启动或连接本地服务。需要该能力时必须由调用方重新发起带明确网络请求的任务。',
  ].join('\n');
}

function isCodexSandbox(value: string): value is CodexSandbox {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access';
}
