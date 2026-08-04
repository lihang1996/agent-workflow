/**
 * 高风险操作需经 OWNER_OPEN_ID（未设置时由发起者）确认。
 * 规则刻意保守：命中后只会多一道审批，不会放行危险动作。
 */
const HIGH_RISK = /(?:\b(?:deploy|release|publish|push\s+--force|reset\s+--hard|drop\s+database|truncate)\b|生产(?:环境|库)?|线上(?:环境|服务)?|删除(?:全部|数据|目录)|清空(?:数据|数据库)|高权限|权限(?:提升|变更)|密钥|secret|token)/i;

export function isHighRiskTask(prompt: string): boolean {
  return HIGH_RISK.test(prompt);
}

export function highRiskReason(prompt: string): string {
  if (/生产|线上|deploy|release|publish/i.test(prompt)) return '可能影响生产/线上环境';
  if (/删除|清空|drop\s+database|truncate|reset\s+--hard/i.test(prompt)) return '可能造成数据或工作区不可逆变更';
  if (/权限|密钥|secret|token/i.test(prompt)) return '涉及权限或敏感凭证';
  return '命中高风险操作规则';
}
