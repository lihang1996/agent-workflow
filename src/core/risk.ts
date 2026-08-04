/**
 * 高风险操作需经 OWNER_OPEN_ID（未设置时由发起者）确认。
 * 规则刻意保守：命中后只会多一道审批，不会放行危险动作。
 */
const HIGH_RISK_PATTERNS: RegExp[] = [
  /\b(?:deploy|release|publish)\b/i,
  /\bgit\s+(?:push\b|reset\s+--hard\b|clean\s+-[^\s]*f|branch\s+-D\b)/i,
  /\b(?:rm|rmdir|unlink|shred|wipefs)\b|\bfind\b[^\n]*(?:\s-delete\b|\s-exec\s+rm\b)/i,
  /\b(?:sudo|su|chmod|chown|mkfs|reboot|shutdown)\b|\bdd\s+if=|\bkill\s+-9\b/i,
  /\bdocker\s+(?:system\s+prune|volume\s+rm|push)\b|\bkubectl\s+(?:delete|apply|patch|rollout)\b|\bhelm\s+(?:install|upgrade|uninstall)\b|\bterraform\s+(?:apply|destroy)\b/i,
  /\b(?:npm|pnpm|yarn)\s+publish\b|\bgh\s+release\s+create\b/i,
  /\bdrop\s+(?:database|schema|table)\b|\btruncate\s+table\b|\bdelete\s+from\b(?![^;\n]*\bwhere\b)/i,
  /\b(?:curl|wget)\b[^\n|;]*(?:\||;)\s*(?:ba|z|fi)?sh\b/i,
  /生产(?:环境|库)?|线上(?:环境|服务)?|部署|发布|上线|强推|强制推送|推送(?:代码|分支|仓库)|重启(?:服务|服务器)|提权|删除(?:全部|数据|目录)|清空(?:数据|数据库)|高权限|权限(?:提升|变更)|密钥|secret|token/i,
];

export function isHighRiskTask(prompt: string): boolean {
  const normalized = prompt
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\t\r ]+/g, ' ');
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function highRiskReason(prompt: string): string {
  if (/生产|线上|部署|上线|deploy|release/i.test(prompt)) return '可能影响生产/线上环境';
  if (/删除|清空|\b(?:rm|rmdir|unlink|shred)\b|drop\s+(?:database|schema|table)|truncate|reset\s+--hard|clean\s+-|volume\s+rm|terraform\s+destroy/i.test(prompt)) return '可能造成数据或工作区不可逆变更';
  if (/\bsudo\b|\bsu\b|chmod|chown|权限/i.test(prompt)) return '涉及系统权限变更';
  if (/发布|强推|强制推送|推送(?:代码|分支|仓库)|\bpublish\b|git\s+push|docker\s+push|(?:npm|pnpm|yarn)\s+publish|gh\s+release/i.test(prompt)) return '会向外部仓库发布或推送内容';
  if (/权限|密钥|secret|token/i.test(prompt)) return '涉及权限或敏感凭证';
  return '命中高风险操作规则';
}

/** CLI PreToolUse 的第二道防线：拦截模型自行生成的危险 Bash/MCP 调用。 */
export function highRiskToolCallReason(toolName: string, input: unknown): string | undefined {
  if (toolName === 'Bash') {
    const command = input && typeof input === 'object'
      ? (input as { command?: unknown }).command
      : undefined;
    if (typeof command === 'string' && isHighRiskTask(command)) return highRiskReason(command);
    return undefined;
  }
  const normalizedName = toolName.toLowerCase();
  if (
    /(?:^|__|_)(?:delete|destroy|drop|deploy|publish|release|push|grant|revoke|rotate_secret|execute_sql|run_command|run_shell)(?:$|__|_)/
      .test(normalizedName)
  ) {
    return `外部工具 ${toolName} 可能产生高风险副作用`;
  }
  return undefined;
}
