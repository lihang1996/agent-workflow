import { ClaudeAdapter } from './claude-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import type { CliAdapter, CliId } from './types.js';

/** 展示名/命令等只读信息；Codex 有运行态，执行时请用 createAdapter。 */
const prototypes: Record<CliId, CliAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
};

/** 取只读原型（查展示名等）；真正执行请用 createAdapter。 */
export function getAdapter(cliId: CliId): CliAdapter {
  return prototypes[cliId];
}

/** 每次 CLI 运行创建新实例，避免 Codex 会话状态串线。 */
export function createAdapter(cliId: CliId): CliAdapter {
  if (cliId === 'codex') return new CodexAdapter();
  return new ClaudeAdapter();
}

/** 列出已注册引擎，供启动日志与 /help 使用。 */
export function listEngines(): Array<{ id: CliId; displayName: string; command: string }> {
  return (Object.keys(prototypes) as CliId[]).map((id) => ({
    id,
    displayName: prototypes[id].displayName,
    command: prototypes[id].command,
  }));
}
