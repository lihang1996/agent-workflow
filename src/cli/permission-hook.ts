import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_OS_ROOT,
  BUNDLED_ASK_MCP_PERMISSION_RULES,
  tsxLoaderPath,
} from '../mcp/config.js';

let cachedClaudeSettingsPath: string | undefined;
let cachedClaudeSettingsBody: string | undefined;

/**
 * 普通任务（dontAsk）只能跑预授权工具；否则 Write/Bash 会被直接拒绝，开发步骤会假阻塞。
 * 这里放行工作区内常规读写与构建，高风险 Bash/MCP 仍由 PreToolUse 闸门拦截。
 */
const STANDARD_ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'NotebookEdit',
  ...BUNDLED_ASK_MCP_PERMISSION_RULES,
  'Bash(pnpm *)',
  'Bash(npm *)',
  'Bash(npx *)',
  'Bash(node *)',
  'Bash(tsc *)',
  'Bash(prisma *)',
  'Bash(mkdir *)',
  'Bash(touch *)',
  'Bash(cp *)',
  'Bash(mv *)',
  'Bash(ls *)',
  'Bash(pwd)',
  'Bash(which *)',
  'Bash(cat *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(echo *)',
  'Bash(test *)',
  'Bash(git status *)',
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git add *)',
  'Bash(git commit *)',
  'Bash(git checkout *)',
  'Bash(git branch *)',
  'Bash(git stash *)',
];

/** 为 Claude Code 注入 Agent OS 自有 PreToolUse 审批闸门。 */
export function ensureClaudePermissionSettingsFile(): string {
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
    permissions: {
      allow: STANDARD_ALLOWED_TOOLS,
    },
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
  const body = `${JSON.stringify(settings, null, 2)}\n`;
  if (cachedClaudeSettingsPath === path && cachedClaudeSettingsBody === body && existsSync(path)) {
    return path;
  }
  writeFileSync(path, body, { encoding: 'utf8', mode: 0o600 });
  cachedClaudeSettingsPath = path;
  cachedClaudeSettingsBody = body;
  return path;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
