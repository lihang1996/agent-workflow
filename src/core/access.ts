/**
 * 个人 Agent OS 的入站访问控制。
 *
 * - 配置 OWNER_OPEN_ID / AGENT_OS_ALLOWED_OPEN_IDS 时，只接受白名单用户。
 * - 未配置白名单时仅允许私聊，避免机器人进群后被任意成员驱动本机 CLI。
 *
 * 权限分层：
 * - 入站发消息：isAuthorizedOperator（白名单 / 私聊）
 * - 业务控制（停任务、Spec、问卷、定时任务）：发起人 ∪ 白名单
 * - 高风险审批：仅当前 OWNER_OPEN_ID（未配置时认审批归属人）
 */
export function configuredOperatorIds(): ReadonlySet<string> {
  const ids = [
    process.env.OWNER_OPEN_ID,
    ...(process.env.AGENT_OS_ALLOWED_OPEN_IDS?.split(/[\s,]+/) ?? []),
  ]
    .map((value) => value?.trim() ?? '')
    .filter(Boolean);
  return new Set(ids);
}

export function isAuthorizedOperator(input: {
  senderOpenId: string;
  chatType: string;
}): boolean {
  if (!input.senderOpenId) return false;
  const allowed = configuredOperatorIds();
  if (allowed.size > 0) return allowed.has(input.senderOpenId);
  return input.chatType === 'p2p';
}

/**
 * 高风险审批归属校验。
 * 配置了 OWNER_OPEN_ID 时只认「当前」负责人（负责人变更后旧卡失效）；未配置时认任务归属人。
 */
export function assertOwnedBy(ownerOpenId: string, operatorOpenId: string): void {
  const configuredOwner = process.env.OWNER_OPEN_ID?.trim();
  if (operatorOpenId !== (configuredOwner || ownerOpenId)) {
    throw new Error('只有指定负责人可以执行此高风险操作。');
  }
}

/** 任务发起人，或白名单内任一授权用户（OWNER ∪ ALLOWED）。 */
export function canControlOwnedResource(ownerOpenId: string, operatorOpenId: string): boolean {
  if (!operatorOpenId) return false;
  if (operatorOpenId === ownerOpenId?.trim()) return true;
  return configuredOperatorIds().has(operatorOpenId);
}

/**
 * Spec / 问卷 / 停止任务 / 定时任务管理：发起人与授权用户均可。
 */
export function assertCanControlOwnedResource(ownerOpenId: string, operatorOpenId: string): void {
  if (!canControlOwnedResource(ownerOpenId, operatorOpenId)) {
    throw new Error('只有任务发起人或授权用户可以执行此操作。');
  }
}
