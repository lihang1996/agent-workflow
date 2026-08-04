import { highRiskToolCallReason } from '../core/risk.js';

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;

async function main(): Promise<void> {
  // 只有飞书审批门启动的本轮进程才允许越过 Agent OS 自有规则；系统/项目其它策略仍然有效。
  if (process.env.AGENT_OS_EXECUTION_POLICY === 'approved') return;
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
  const reason = highRiskToolCallReason(event.tool_name, event.tool_input);
  if (reason) deny(`${reason}；请在飞书中通过 /approval 发起并由负责人拍板。`);
}

function deny(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

await main();
