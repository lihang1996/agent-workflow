/**
 * CLI 引擎注册表。
 *
 * 管理三个适配器（Claude/Codex/Cursor）的注册和创建。
 * 提供 getAdapter（只读原型）和 createAdapter（每次新建实例）两种获取方式。
 *
 * 为什么需要两种方式？
 * - getAdapter：用于查展示名/命令名等只读信息，不涉及运行态
 * - createAdapter：每次 CLI 运行创建新实例，避免 Codex/Cursor 会话状态串线
 */

import { ClaudeAdapter } from './claude-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { CursorAdapter } from './cursor-adapter.js';
import type { CliAdapter, CliId } from './types.js';

/**
 * 适配器原型注册表。
 *
 * 用单例对象，因为展示名/命令名等只读信息不会变化。
 * 运行态（如 Codex 的会话上下文）不存在原型上。
 *
 * key 是 CliId（'claude' | 'codex' | 'cursor'）
 * value 是对应的适配器实例
 */
const prototypes: Record<CliId, CliAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  cursor: new CursorAdapter(),
};

/**
 * 获取只读原型适配器。
 *
 * 用于查展示名、命令名等不涉及运行态的信息。
 * 例如：index.ts 启动时打印引擎列表、/engine 命令显示当前引擎。
 *
 * 真正执行 CLI 时请用 createAdapter()。
 */
export function getAdapter(cliId: CliId): CliAdapter {
  return prototypes[cliId];
}

/**
 * 每次执行创建新的适配器实例。
 *
 * 为什么不直接用 prototypes 里的单例？
 * 因为 Codex 和 Cursor 的适配器可能有运行态（如缓存的会话参数），
 * 如果多个 CLI 任务并发使用同一个实例，会导致状态串线。
 * Claude 适配器无状态，但为了统一也每次 new。
 *
 * 调用方：cli-task.ts → runner.ts → createAdapter(session.cliId)
 */
export function createAdapter(cliId: CliId): CliAdapter {
  if (cliId === 'codex') return new CodexAdapter();
  if (cliId === 'cursor') return new CursorAdapter();
  return new ClaudeAdapter();
}

/**
 * 列出所有已注册引擎的只读信息。
 *
 * 用于：
 * - index.ts 启动时打印 `[CLI] claude=claude ...`
 * - /help 文本中列出可选引擎
 *
 * @returns 数组，每项包含 { id, displayName, command }
 */
export function listEngines(): Array<{ id: CliId; displayName: string; command: string }> {
  return (Object.keys(prototypes) as CliId[]).map((id) => ({
    id,
    displayName: prototypes[id].displayName,
    command: prototypes[id].command,
  }));
}
