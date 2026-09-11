export interface TaskOwner {
  ownerOpenId: string;
  ownerUnionId?: string;
  ownerBotId?: string;
}
export interface OperatorIdentity {
  operatorOpenId: string;
  operatorUnionId?: string;
  operatorBotId?: string;
}

export function isTaskOwner(owner: TaskOwner, operator: OperatorIdentity): boolean {
  if (owner.ownerUnionId && operator.operatorUnionId) {
    return owner.ownerUnionId === operator.operatorUnionId;
  }
  // An Open ID may only be compared within its issuing application.
  if (owner.ownerBotId && owner.ownerBotId !== operator.operatorBotId) return false;
  return !!owner.ownerOpenId && owner.ownerOpenId === operator.operatorOpenId;
}
