/**
 * 个人 Agent OS 的入站访问控制。
 *
 * - 配置 OWNER_OPEN_ID / AGENT_OS_ALLOWED_OPEN_IDS 时，只接受白名单用户。
 * - 未配置白名单时仅允许私聊，避免机器人进群后被任意成员驱动本机 CLI。
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

export function assertOwnedBy(ownerOpenId: string, operatorOpenId: string): void {
  const configuredOwner = process.env.OWNER_OPEN_ID?.trim();
  if (operatorOpenId !== (configuredOwner || ownerOpenId)) {
    throw new Error('只有任务发起人或指定负责人可以执行此操作。');
  }
}
