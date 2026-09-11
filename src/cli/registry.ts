import { ClaudeAdapter } from './claude-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { CursorAdapter } from './cursor-adapter.js';
import { CLI_IDS, type CliAdapter, type CliId } from './types.js';
import type { AppToolName } from '../core/app-tool-policy.js';

const factories = {
  claude: (tools: readonly AppToolName[]) => new ClaudeAdapter(tools),
  codex: (tools: readonly AppToolName[]) => new CodexAdapter(tools),
  cursor: (tools: readonly AppToolName[]) => new CursorAdapter(tools),
} satisfies Record<CliId, (tools: readonly AppToolName[]) => CliAdapter>;

const emptyToolAdapters = {
  claude: factories.claude([]),
  codex: factories.codex([]),
  cursor: factories.cursor([]),
} satisfies Record<CliId, CliAdapter>;

export function getCliAdapter(
  id: CliId,
  tools?: readonly AppToolName[],
): CliAdapter {
  return tools ? factories[id](tools) : emptyToolAdapters[id];
}

export function listCliAdapters(): CliAdapter[] {
  return CLI_IDS.map((id) => emptyToolAdapters[id]);
}

export function parseCliId(value: string | undefined): CliId {
  if (!value) return 'claude';
  if ((CLI_IDS as readonly string[]).includes(value)) return value as CliId;
  throw new Error(`不支持的 DEFAULT_CLI: ${value}，请填写 ${CLI_IDS.join(' 或 ')}`);
}
