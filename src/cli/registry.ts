import { ClaudeAdapter } from './claude-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { CursorAdapter } from './cursor-adapter.js';
import { ZcodeAdapter } from './zcode-adapter.js';
import { CLI_IDS, type CliAdapter, type CliId } from './types.js';
import type { AppToolName } from '../core/app-tool-policy.js';

const factories = {
  claude: (tools: readonly AppToolName[]) => new ClaudeAdapter(tools),
  codex: (tools: readonly AppToolName[]) => new CodexAdapter(tools),
  cursor: (tools: readonly AppToolName[]) => new CursorAdapter(tools),
  zcode: (tools: readonly AppToolName[]) => new ZcodeAdapter(tools),
} satisfies Record<CliId, (tools: readonly AppToolName[]) => CliAdapter>;

const emptyToolAdapters = {
  claude: factories.claude([]),
  codex: factories.codex([]),
  cursor: factories.cursor([]),
} satisfies Record<Exclude<CliId, 'zcode'>, CliAdapter>;

// ZcodeAdapter 携带每次执行的关联与去重状态，不进入共享单例；
// 评论入口等空权限执行同样由工厂返回独立实例。
let zcodeDisplayAdapter: CliAdapter | undefined;

export function getCliAdapter(
  id: CliId,
  tools?: readonly AppToolName[],
): CliAdapter {
  if (id === 'zcode') return factories.zcode(tools ?? []);
  return tools ? factories[id](tools) : emptyToolAdapters[id];
}

export function listCliAdapters(): CliAdapter[] {
  // 展示用 ZCode 实例只用于启动日志，不参与任务执行。
  zcodeDisplayAdapter ??= factories.zcode([]);
  return CLI_IDS.map((id) =>
    id === 'zcode' ? zcodeDisplayAdapter! : emptyToolAdapters[id],
  );
}

export function parseCliId(value: string | undefined): CliId {
  if (!value) return 'claude';
  if ((CLI_IDS as readonly string[]).includes(value)) return value as CliId;
  throw new Error(`不支持的 DEFAULT_CLI: ${value}，请填写 ${CLI_IDS.join(' 或 ')}`);
}
