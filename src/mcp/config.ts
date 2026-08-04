/**
 * MCP 配置：内置「结构化提问」server，注入 Claude / Codex。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface McpStdioServer {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfigFile {
  mcpServers: Record<string, McpStdioServer>;
}

const here = dirname(fileURLToPath(import.meta.url));
export const AGENT_OS_ROOT = resolve(here, '../..');

let cachedClaudeConfigPath: string | undefined;
let loggedOnce = false;

/** MCP 默认开启；MCP_ENABLED=0/false/off 关闭。 */
export function isMcpEnabled(): boolean {
  const value = process.env.MCP_ENABLED?.trim().toLowerCase();
  if (!value) return true;
  return !(value === '0' || value === 'false' || value === 'off' || value === 'no');
}

export function isMcpStrict(): boolean {
  const value = process.env.MCP_STRICT?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function tsxLoaderPath(): string {
  return join(AGENT_OS_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
}

/** 内置结构化提问 MCP server。 */
export function bundledAskServer(): McpStdioServer {
  return {
    type: 'stdio',
    command: process.execPath,
    args: [
      '--import',
      tsxLoaderPath(),
      join(AGENT_OS_ROOT, 'src', 'mcp', 'ask-server.ts'),
    ],
    env: { AGENT_OS_ROOT },
  };
}

export function resolveMcpConfig(): McpConfigFile {
  return {
    mcpServers: {
      'agent-os-ask': bundledAskServer(),
    },
  };
}

export function ensureClaudeMcpConfigFile(): string {
  if (cachedClaudeConfigPath && existsSync(cachedClaudeConfigPath)) {
    return cachedClaudeConfigPath;
  }
  const dir = join(AGENT_OS_ROOT, 'data', 'mcp');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'runtime-claude.json');
  writeFileSync(path, `${JSON.stringify(resolveMcpConfig(), null, 2)}\n`, 'utf8');
  cachedClaudeConfigPath = path;
  return path;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`;
}

export function logMcpStatus(): void {
  if (loggedOnce) return;
  loggedOnce = true;
  if (!isMcpEnabled()) {
    console.log('[MCP] 已关闭（MCP_ENABLED=false）');
    return;
  }
  console.log(
    `[MCP] 已启用 server=agent-os-ask tools=propose_questions,record_answers,get_questionnaire strict=${isMcpStrict()}`,
  );
}

export function claudeMcpFlags(): string[] {
  if (!isMcpEnabled()) return [];
  const flags = ['--mcp-config', ensureClaudeMcpConfigFile()];
  if (isMcpStrict()) flags.push('--strict-mcp-config');
  return flags;
}

export function codexMcpFlags(): string[] {
  if (!isMcpEnabled()) return [];
  const flags: string[] = [];
  for (const [name, server] of Object.entries(resolveMcpConfig().mcpServers)) {
    flags.push('-c', `mcp_servers.${name}.command=${tomlString(server.command)}`);
    if (server.args?.length) {
      flags.push('-c', `mcp_servers.${name}.args=${tomlArray(server.args)}`);
    }
    if (server.env) {
      for (const [key, value] of Object.entries(server.env)) {
        flags.push('-c', `mcp_servers.${name}.env.${key}=${tomlString(value)}`);
      }
    }
    flags.push('-c', `mcp_servers.${name}.cwd=${tomlString(AGENT_OS_ROOT)}`);
    flags.push('-c', `mcp_servers.${name}.enabled=true`);
  }
  return flags;
}
