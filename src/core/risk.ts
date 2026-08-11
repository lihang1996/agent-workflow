/**
 * 高风险操作需经 OWNER_OPEN_ID（未设置时由发起者）确认。
 * 除了识别「是否高风险」，还保留风险类别：审批执行时只授予原请求命中的类别，
 * 防止「批准 git push」被模型扩大成删除数据或生产部署。
 */
export const HIGH_RISK_CLASSES = [
  'production-change',
  'destructive-change',
  'external-publish',
  'privilege-change',
  'credential-change',
  'external-execution',
] as const;
export type HighRiskClass = typeof HIGH_RISK_CLASSES[number];

const RISK_CLASS_PATTERNS: Readonly<Record<HighRiskClass, readonly RegExp[]>> = {
  'production-change': [
    /\b(?:deploy|release)\b/i,
    /\bkubectl\s+(?:delete|apply|patch|rollout)\b|\bhelm\s+(?:install|upgrade|uninstall)\b|\bterraform\s+(?:apply|destroy)\b/i,
    /\b(?:systemctl|service|launchctl)\s+(?:restart|stop|disable|unload|bootout)\b|\b(?:restart|stop)-computer\b/i,
    /生产(?:环境|库)?|线上(?:环境|服务)?|部署|上线|重启(?:服务|服务器)/i,
  ],
  'destructive-change': [
    /\bgit\b[^\n;&|]{0,160}\b(?:reset\s+--hard\b|clean\s+-[^\s]*f|branch\s+-D\b|checkout\s+--(?:\s|$)|restore\b|stash\s+(?:drop|clear)\b)/i,
    /\b(?:rm|rmdir|unlink|shred|wipefs|mkfs)\b|\bfind\b[^\n]*(?:\s-delete\b|\s-exec\s+rm\b)|\b(?:remove-item|clear-content)\b/i,
    /\bdocker\s+(?:system\s+prune|volume\s+rm)\b|\bkubectl\s+delete\b|\bhelm\s+uninstall\b|\bterraform\s+destroy\b/i,
    /\bdrop\s+(?:database|schema|table)\b|\btruncate\s+table\b|\bdelete\s+from\b(?![^;\n]*\bwhere\b)|\b(?:flushall|flushdb)\b/i,
    /删除(?:全部|数据|目录)?|清空(?:数据|数据库)?|不可逆/i,
  ],
  'external-publish': [
    /\bpublish\b/i,
    /\bgit\b[^\n;&|]{0,160}\bpush\b|\bdocker\s+push\b|\b(?:npm|pnpm|yarn)\s+publish\b|\bgh\s+(?:release\s+create|pr\s+merge)\b/i,
    /发布|强推|强制推送|推送(?:代码|分支|仓库)?/i,
  ],
  'privilege-change': [
    /\b(?:sudo|su|chmod|chown)\b|\b(?:grant|revoke)\b/i,
    /提权|高权限|权限(?:提升|变更|授予|撤销)/i,
  ],
  'credential-change': [
    /\b(?:rotate[_-]?secret|secret|token)\b/i,
    /密钥|凭证(?:轮换|变更)/i,
  ],
  'external-execution': [
    /\b(?:execute[_ -]?sql|run[_ -]?(?:command|shell))\b/i,
    /执行\s*(?:SQL|数据库命令|远程命令|shell)|运行\s*(?:远程命令|shell)|外部工具\s*(?:执行|调用)/i,
    /\b(?:curl|wget)\b[^\n|;]*(?:\||;)\s*(?:ba|z|fi)?sh\b/i,
  ],
};

const RISK_CLASS_LABELS: Record<HighRiskClass, string> = {
  'production-change': '生产/线上变更',
  'destructive-change': '不可逆删除或破坏性变更',
  'external-publish': '外部发布或推送',
  'privilege-change': '系统或业务权限变更',
  'credential-change': '密钥或凭证变更',
  'external-execution': '外部命令或 SQL 执行',
};

export function isHighRiskTask(prompt: string): boolean {
  return highRiskClasses(prompt).length > 0;
}

export function highRiskReason(prompt: string): string {
  const classes = highRiskClasses(prompt);
  if (classes.includes('destructive-change')) return '可能造成数据或工作区不可逆变更';
  if (classes.includes('production-change')) return '可能影响生产/线上环境';
  if (classes.includes('external-publish')) return '会向外部仓库发布或推送内容';
  if (classes.includes('privilege-change')) return '涉及系统或业务权限变更';
  if (classes.includes('credential-change')) return '涉及密钥或敏感凭证';
  if (classes.includes('external-execution')) return '涉及外部命令或 SQL 执行';
  return '命中高风险操作规则';
}

export function highRiskClasses(prompt: string): HighRiskClass[] {
  const normalized = normalizeRiskText(prompt);
  return HIGH_RISK_CLASSES.filter((riskClass) =>
    RISK_CLASS_PATTERNS[riskClass].some((pattern) => pattern.test(normalized)));
}

export function formatHighRiskClasses(classes: readonly HighRiskClass[]): string {
  return classes.map((riskClass) => RISK_CLASS_LABELS[riskClass]).join('、');
}

function normalizeRiskText(prompt: string): string {
  return prompt
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '')
    .replace(/\\\r?\n/g, '')
    .replace(/['"`]/g, '')
    .replace(/\\(?=[A-Za-z])/g, '')
    .replace(/\s+/g, ' ');
}

/** CLI PreToolUse 的第二道防线：拦截模型自行生成的危险 Bash/MCP 调用。 */
export function highRiskToolCallReason(toolName: string, input: unknown): string | undefined {
  const classes = highRiskToolCallClasses(toolName, input);
  if (classes.length === 0) return undefined;
  if (toolName === 'Bash') return highRiskReason(toolCallText(input));
  return `外部工具 ${toolName} 可能产生高风险副作用（${formatHighRiskClasses(classes)}）`;
}

export function highRiskToolCallClasses(toolName: string, input: unknown): HighRiskClass[] {
  if (toolName === 'Bash') return highRiskClasses(toolCallText(input));
  const normalizedName = toolName.toLowerCase();
  const detected = new Set<HighRiskClass>();
  const hasOperation = (operation: string) =>
    new RegExp(`(?:^|__|_)${operation}(?:$|__|_)`).test(normalizedName);
  if (hasOperation('delete') || hasOperation('destroy') || hasOperation('drop')) {
    detected.add('destructive-change');
  }
  if (hasOperation('deploy') || hasOperation('release')) detected.add('production-change');
  if (hasOperation('publish') || hasOperation('push')) detected.add('external-publish');
  if (hasOperation('grant') || hasOperation('revoke')) detected.add('privilege-change');
  if (hasOperation('rotate_secret')) detected.add('credential-change');
  if (hasOperation('execute_sql') || hasOperation('run_command') || hasOperation('run_shell')) {
    detected.add('external-execution');
  }
  // 只有工具名本身已被认定有副作用时才分析参数；否则 record_answers 一类安全工具
  // 携带“部署范围”等普通文本也会被误拦截。
  if (detected.size > 0) {
    for (const riskClass of highRiskClasses(safeToolInputText(input))) detected.add(riskClass);
  }
  return HIGH_RISK_CLASSES.filter((riskClass) => detected.has(riskClass));
}

export function isHighRiskClass(value: string): value is HighRiskClass {
  return (HIGH_RISK_CLASSES as readonly string[]).includes(value);
}

function toolCallText(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' ? command : '';
}

function safeToolInputText(input: unknown): string {
  try {
    return JSON.stringify(input).slice(0, 20_000);
  } catch {
    return '';
  }
}
