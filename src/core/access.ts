import {
  normalizeIdentity,
  type IdentityInput,
  type IdentityRegistry,
  type UserIdentity,
} from './identity-registry.js';

/**
 * 个人 Agent OS 的入站访问控制。
 *
 * open_id 是飞书应用级 ID，不能跨多个 Bot 直接比较；权限判断优先使用
 * user_id / union_id，并通过 IdentityRegistry 兼容历史上只保存 open_id 的数据。
 */

function splitIds(value: string | undefined): string[] {
  return (value?.split(/[\s,]+/) ?? []).map((item) => item.trim()).filter(Boolean);
}

export function configuredOwnerIdentity(): UserIdentity | undefined {
  const identity = normalizeIdentity({
    openId: process.env.OWNER_OPEN_ID,
    userId: process.env.OWNER_USER_ID,
    unionId: process.env.OWNER_UNION_ID,
  });
  return identity.openId || identity.userId || identity.unionId ? identity : undefined;
}

export function configuredOperatorIdentities(): UserIdentity[] {
  const identities: UserIdentity[] = [];
  const owner = configuredOwnerIdentity();
  if (owner) identities.push(owner);
  identities.push(
    ...splitIds(process.env.AGENT_OS_ALLOWED_OPEN_IDS).map((openId) => ({ openId })),
    ...splitIds(process.env.AGENT_OS_ALLOWED_USER_IDS).map((userId) => ({ userId })),
    ...splitIds(process.env.AGENT_OS_ALLOWED_UNION_IDS).map((unionId) => ({ unionId })),
  );
  return identities;
}

/** 兼容既有调用：返回显式配置的 open_id 白名单。 */
export function configuredOperatorIds(): ReadonlySet<string> {
  return new Set(configuredOperatorIdentities().flatMap((identity) =>
    identity.openId ? [identity.openId] : []));
}

function samePerson(
  left: IdentityInput,
  right: IdentityInput,
  identities?: IdentityRegistry,
): boolean {
  if (identities) return identities.samePerson(left, right);
  const a = normalizeIdentity(left);
  const b = normalizeIdentity(right);
  return !!(
    (a.userId && b.userId && a.userId === b.userId)
    || (a.unionId && b.unionId && a.unionId === b.unionId)
    || (a.openId && b.openId && a.openId === b.openId)
  );
}

export function isAuthorizedOperator(input: {
  senderOpenId: string;
  senderUserId?: string;
  senderUnionId?: string;
  chatType: string;
}, identities?: IdentityRegistry): boolean {
  const operator = {
    openId: input.senderOpenId,
    userId: input.senderUserId,
    unionId: input.senderUnionId,
  };
  if (!normalizeIdentity(operator).openId && !normalizeIdentity(operator).userId && !normalizeIdentity(operator).unionId) {
    return false;
  }
  const allowed = configuredOperatorIdentities();
  if (allowed.length > 0) return allowed.some((candidate) => samePerson(candidate, operator, identities));
  return input.chatType === 'p2p';
}

/**
 * 高风险审批归属校验。
 * 配置了任一 OWNER_* 身份时只认当前负责人；未配置时认任务归属人。
 */
export function assertOwnedBy(
  owner: IdentityInput,
  operator: IdentityInput,
  identities?: IdentityRegistry,
): void {
  const expected = configuredOwnerIdentity() ?? owner;
  if (!samePerson(expected, operator, identities)) {
    throw new Error('只有指定负责人可以执行此高风险操作。');
  }
}

/** 任务发起人，或白名单内任一授权用户（OWNER ∪ ALLOWED）。 */
export function canControlOwnedResource(
  owner: IdentityInput,
  operator: IdentityInput,
  identities?: IdentityRegistry,
): boolean {
  const normalized = normalizeIdentity(operator);
  if (!normalized.openId && !normalized.userId && !normalized.unionId) return false;
  if (samePerson(owner, operator, identities)) return true;
  return configuredOperatorIdentities().some((candidate) => samePerson(candidate, operator, identities));
}

/** Spec / 问卷 / 停止任务 / 定时任务管理：发起人与授权用户均可。 */
export function assertCanControlOwnedResource(
  owner: IdentityInput,
  operator: IdentityInput,
  identities?: IdentityRegistry,
): void {
  if (!canControlOwnedResource(owner, operator, identities)) {
    throw new Error('只有任务发起人或授权用户可以执行此操作。');
  }
}
