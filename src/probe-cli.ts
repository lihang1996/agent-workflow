/**
 * AI CLI 事件流解析器：从 stdin 读 headless 模式的 JSON 行，打印事件时间线。
 * 用法：
 *   claude -p "..." --output-format stream-json --verbose | pnpm probe:cli
 *   agent -p --force --output-format stream-json "..." | pnpm probe:cli
 *   zcode --prompt "..." --mode yolo --output-format stream-json | pnpm probe:cli
 */
import { createInterface } from 'node:readline';

const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return; // 非 JSON 行（日志噪音）直接跳过
  }

  switch (ev.type) {
    // ── Claude Code ──
    case 'system':
      if (ev.subtype === 'init') console.log(`${stamp()} 会话开始 session_id=${ev.session_id} model=${ev.model}`);
      break;
    case 'assistant':
      for (const block of ev.message?.content ?? []) {
        if (block.type === 'text' && block.text) console.log(`${stamp()} 模型说: ${block.text}`);
        if (block.type === 'tool_use') console.log(`${stamp()} 调用工具: ${block.name}`);
      }
      break;
    case 'result':
      // Claude 用 result 字段；ZCode 顶层汇总用 response 字段。
      if (ev.result !== undefined || ev.num_turns !== undefined) {
        console.log(`${stamp()} 完成 turns=${ev.num_turns} 耗时=${ev.duration_ms}ms 成本=$${ev.total_cost_usd}`);
        console.log(`${stamp()} 最终回答: ${ev.result}`);
      } else if (ev.response !== undefined) {
        console.log(`${stamp()} 最终回答: ${ev.response}`);
        if (ev.usage) console.log(`${stamp()} 本轮用量: ${JSON.stringify(ev.usage)}`);
        if (ev.projection) {
          console.log(`${stamp()} 上下文: used=${ev.projection.contextUsed ?? '-'} window=${ev.projection.contextWindow ?? '-'}`);
        }
      }
      break;
    case 'tool_call':
      if (ev.subtype === 'started') console.log(`${stamp()} 开始工具: ${ev.call_id}`);
      if (ev.subtype === 'completed') console.log(`${stamp()} 完成工具: ${ev.call_id}`);
      break;

    // ── ZCode ──
    case 'session.created':
    case 'session.resumed':
      console.log(`${stamp()} 会话${ev.type === 'session.created' ? '开始' : '续接'} sessionId=${ev.sessionId}`);
      break;
    case 'tool.updated':
      console.log(`${stamp()} 工具 ${ev.payload?.kind}: ${ev.payload?.toolName ?? ''} (${ev.payload?.toolCallId ?? ''})`);
      break;
    case 'turn.failed':
      console.log(`${stamp()} 失败: ${ev.payload?.error?.message ?? '(无消息)'}`);
      break;

    // ── Codex ──
    case 'thread.started':
      console.log(`${stamp()} 会话开始 thread_id=${ev.thread_id}`);
      break;
    case 'item.completed':
      if (ev.item?.type === 'agent_message') console.log(`${stamp()} 模型说: ${ev.item.text}`);
      if (ev.item?.type === 'command_execution') console.log(`${stamp()} 执行命令: ${ev.item.command}`);
      break;
    case 'turn.completed':
      console.log(`${stamp()} 完成 tokens=${JSON.stringify(ev.usage)}`);
      break;
  }
});
