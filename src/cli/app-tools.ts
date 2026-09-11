import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLARIFICATION_TOOL_NAME,
  PRODUCT_SPEC_TOOL_NAME,
  DISPATCH_TASK_TOOL_NAME,
  type AppToolName,
} from '../core/app-tool-policy.js';
export { CLARIFICATION_TOOL_NAME, PRODUCT_SPEC_TOOL_NAME, DISPATCH_TASK_TOOL_NAME };
export const CLAUDE_CLARIFICATION_TOOL_NAME =
  `mcp__agent_os__${CLARIFICATION_TOOL_NAME}`;
export const CLAUDE_PRODUCT_SPEC_TOOL_NAME =
  `mcp__agent_os__${PRODUCT_SPEC_TOOL_NAME}`;
export const CLAUDE_DISPATCH_TASK_TOOL_NAME =
  `mcp__agent_os__${DISPATCH_TASK_TOOL_NAME}`;

const CURSOR_TOOLS_ARG = '--tools=${env:AGENT_OS_ALLOWED_TOOLS}';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function serverBase(): { command: string; args: string[] } {
  const runningFromTypeScript = import.meta.url.endsWith('.ts');
  const server = fileURLToPath(new URL(
    runningFromTypeScript
      ? '../mcp/app-tools-server.ts'
      : '../mcp/app-tools-server.js',
    import.meta.url,
  ));
  if (!runningFromTypeScript) {
    return { command: process.execPath, args: [server] };
  }
  const tsxCli = fileURLToPath(
    new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url),
  );
  return { command: process.execPath, args: [tsxCli, server] };
}

function serverInvocation(allowed: readonly AppToolName[]): { command: string; args: string[] } {
  const base = serverBase();
  return { command: base.command, args: [...base.args, `--tools=${allowed.join(',')}`] };
}

export function mergeCursorMcpConfig(existing: unknown): Record<string, unknown> {
  const current = isRecord(existing) ? { ...existing } : {};
  const mcpServers = isRecord(current.mcpServers) ? { ...current.mcpServers } : {};
  const base = serverBase();
  mcpServers.agent_os = {
    type: 'stdio',
    command: base.command,
    args: [...base.args, CURSOR_TOOLS_ARG],
  };
  return { ...current, mcpServers };
}

const cursorMcpSetup = new Map<string, Promise<void>>();

function agentOsEntryMatches(existing: unknown, desired: unknown): boolean {
  if (!isRecord(existing) || !isRecord(existing.mcpServers)) return false;
  return JSON.stringify(existing.mcpServers.agent_os) === JSON.stringify(desired);
}

async function setupCursorAppToolsConfig(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  let existing: unknown = {};
  try {
    existing = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      existing = {};
    } else {
      throw new Error(`无法读取 Cursor MCP 配置: ${(error as Error).message}`);
    }
  }
  const merged = mergeCursorMcpConfig(existing);
  const servers = isRecord(merged.mcpServers) ? merged.mcpServers : {};
  if (agentOsEntryMatches(existing, servers.agent_os)) return;
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(merged, null, 2)}\n`);
  await rename(tempPath, filePath);
}

export function ensureCursorAppToolsConfig(
  filePath = join(homedir(), '.cursor', 'mcp.json'),
): Promise<void> {
  let pending = cursorMcpSetup.get(filePath);
  if (!pending) {
    pending = setupCursorAppToolsConfig(filePath).catch((error) => {
      cursorMcpSetup.delete(filePath);
      throw error;
    });
    cursorMcpSetup.set(filePath, pending);
  }
  return pending;
}

export function claudeAppToolArgs(allowed: readonly AppToolName[] = []): string[] {
  const invocation = serverInvocation(allowed);
  return [
    '--mcp-config',
    JSON.stringify({
      mcpServers: {
        agent_os: {
          type: 'stdio',
          command: invocation.command,
          args: invocation.args,
        },
      },
    }),
  ];
}

export function codexAppToolArgs(allowed: readonly AppToolName[] = []): string[] {
  const invocation = serverInvocation(allowed);
  return [
    '-c',
    `mcp_servers.agent_os.command=${JSON.stringify(invocation.command)}`,
    '-c',
    `mcp_servers.agent_os.args=${JSON.stringify(invocation.args)}`,
  ];
}
