/**
 * MCP 配置：内置「结构化提问」server，注入 Claude / Codex。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
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

/**
 * Claude Code 在 non-interactive `dontAsk` 模式下不会仅因 MCP server 已配置就自动授权工具。
 * 只预授权创建/读取当前工作流问卷；答案必须经飞书卡片的人类操作写入，
 * 不把 record_answers 交给模型，避免模型替用户完成澄清。
 */
export const BUNDLED_ASK_MCP_PERMISSION_RULES = [
  'mcp__agent-os-ask__propose_questions',
  'mcp__agent-os-ask__get_questionnaire',
] as const;

/** Codex `exec` 无交互面，未预授权的 MCP 会被当成 user cancelled。 */
export const CODEX_ASK_MCP_APPROVED_TOOLS = [
  'propose_questions',
  'get_questionnaire',
] as const;
export const CODEX_ASK_MCP_PROMPTED_TOOLS = [
  'record_answers',
] as const;

/** 提问 MCP 需要的任务作用域；Codex 必须写进 mcp_servers.*.env，不能只靠 CLI 进程环境。 */
export const ASK_MCP_CONTEXT_ENV_KEYS = [
  'AGENT_OS_WORKFLOW_ID',
  'AGENT_OS_CHAT_ID',
  'AGENT_OS_TOPIC_ID',
  'AGENT_OS_OWNER_OPEN_ID',
  'AGENT_OS_BOT_ID',
  'AGENT_OS_MESSAGE_ID',
] as const;

const here = dirname(fileURLToPath(import.meta.url));
export const AGENT_OS_ROOT = resolve(here, '../..');

export function pickAskMcpContextEnv(
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string> {
  const picked: Record<string, string> = {};
  if (!env) return picked;
  for (const key of ASK_MCP_CONTEXT_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) picked[key] = value;
  }
  return picked;
}

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
export function bundledAskServer(contextEnv: Record<string, string> = {}): McpStdioServer {
  return {
    type: 'stdio',
    command: process.execPath,
    args: [
      '--import',
      tsxLoaderPath(),
      join(AGENT_OS_ROOT, 'src', 'mcp', 'ask-server.ts'),
    ],
    env: { AGENT_OS_ROOT, ...pickAskMcpContextEnv(contextEnv) },
  };
}

export function resolveMcpConfig(contextEnv: Record<string, string> = {}): McpConfigFile {
  return {
    mcpServers: {
      'agent-os-ask': bundledAskServer(contextEnv),
    },
  };
}

export function ensureClaudeMcpConfigFile(contextEnv: Record<string, string> = {}): string {
  const env = pickAskMcpContextEnv(contextEnv);
  const body = `${JSON.stringify(resolveMcpConfig(env), null, 2)}\n`;
  const dir = join(AGENT_OS_ROOT, 'data', 'mcp');
  mkdirSync(dir, { recursive: true });
  const suffix = Object.keys(env).length === 0
    ? 'runtime-claude.json'
    : `runtime-claude-${createHash('sha256').update(JSON.stringify(env)).digest('hex').slice(0, 12)}.json`;
  const path = join(dir, suffix);
  writeFileSync(path, body, 'utf8');
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
    `[MCP] 已启用 server=agent-os-ask tools=propose_questions,record_answers,get_questionnaire preauthorized=propose_questions,get_questionnaire answers=feishu-card strict=${isMcpStrict()}`,
  );
}

export function claudeMcpFlags(contextEnv: Record<string, string> = {}): string[] {
  if (!isMcpEnabled()) return [];
  const flags = ['--mcp-config', ensureClaudeMcpConfigFile(contextEnv)];
  if (isMcpStrict()) flags.push('--strict-mcp-config');
  return flags;
}

export function codexMcpFlags(contextEnv: Record<string, string> = {}): string[] {
  if (!isMcpEnabled()) return [];
  const flags: string[] = [];
  for (const [name, server] of Object.entries(resolveMcpConfig(contextEnv).mcpServers)) {
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
    if (name === 'agent-os-ask') {
      flags.push('-c', `mcp_servers.${name}.default_tools_approval_mode=${tomlString('approve')}`);
      for (const tool of CODEX_ASK_MCP_APPROVED_TOOLS) {
        flags.push('-c', `mcp_servers.${name}.tools.${tool}.approval_mode=${tomlString('approve')}`);
      }
      for (const tool of CODEX_ASK_MCP_PROMPTED_TOOLS) {
        flags.push('-c', `mcp_servers.${name}.tools.${tool}.approval_mode=${tomlString('prompt')}`);
      }
    }
  }
  return flags;
}
