import {
  formatHighRiskClasses,
  highRiskToolCallClasses,
  highRiskToolCallReason,
  isHighRiskClass,
  type HighRiskClass,
} from '../core/risk.js';

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;

async function main(): Promise<void> {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += String(chunk);
    if (Buffer.byteLength(raw, 'utf8') > MAX_HOOK_INPUT_BYTES) {
      return deny('工具参数过大，Agent OS 为安全起见已阻止执行。');
    }
  }

  let event: { tool_name?: unknown; tool_input?: unknown };
  try {
    event = JSON.parse(raw) as { tool_name?: unknown; tool_input?: unknown };
  } catch {
    return deny('无法解析工具调用，Agent OS 为安全起见已阻止执行。');
  }
  if (typeof event.tool_name !== 'string') return deny('工具名称缺失，Agent OS 已阻止执行。');
  const requestedClasses = highRiskToolCallClasses(event.tool_name, event.tool_input);
  if (requestedClasses.length === 0) return;
  const reason = highRiskToolCallReason(event.tool_name, event.tool_input);
  if (process.env.AGENT_OS_EXECUTION_POLICY !== 'approved') {
    return deny(`${reason ?? '命中高风险操作规则'}；请在飞书中通过 /approval 发起并由负责人拍板。`);
  }

  const approvedClasses = parseApprovedClasses(process.env.AGENT_OS_APPROVED_RISK_CLASSES);
  const outsideScope = requestedClasses.filter((riskClass) => !approvedClasses.includes(riskClass));
  if (outsideScope.length > 0) {
    const approvedLabel = approvedClasses.length > 0
      ? formatHighRiskClasses(approvedClasses)
      : '无可验证的高风险类别';
    return deny(
      `${reason ?? '高风险工具调用'}超出本次审批范围；`
      + `本次批准：${approvedLabel}；本次请求：${formatHighRiskClasses(requestedClasses)}。`
      + '请针对新增风险重新发起 /approval。',
    );
  }
}

function parseApprovedClasses(raw: string | undefined): HighRiskClass[] {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((item) => item.trim()).filter(isHighRiskClass))];
}

function deny(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

await main();
