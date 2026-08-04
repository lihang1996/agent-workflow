import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_OS_ROOT, tsxLoaderPath } from '../mcp/config.js';

let cachedClaudeSettingsPath: string | undefined;

/** 为 Claude Code 注入 Agent OS 自有 PreToolUse 审批闸门。 */
export function ensureClaudePermissionSettingsFile(): string {
  if (cachedClaudeSettingsPath && existsSync(cachedClaudeSettingsPath)) {
    return cachedClaudeSettingsPath;
  }
  const dir = join(AGENT_OS_ROOT, 'data', 'approval');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'runtime-claude-settings.json');
  const command = [
    shellQuote(process.execPath),
    '--import',
    shellQuote(tsxLoaderPath()),
    shellQuote(join(AGENT_OS_ROOT, 'src', 'hooks', 'approval-gate.ts')),
  ].join(' ');
  const settings = {
    hooks: {
      PreToolUse: [{
        matcher: '^(Bash|mcp__.*)$',
        hooks: [{
          type: 'command',
          command,
          timeout: 5,
        }],
      }],
    },
  };
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  cachedClaudeSettingsPath = path;
  return path;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
