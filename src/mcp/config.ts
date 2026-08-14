/**
 * MCP 配置：内置「结构化提问」server，注入 Claude / Codex / Cursor。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

/**
 * Cursor `--add-dir` / `--workspace` 会变成可写 workspace root。
 * 不能放在 Agent OS 仓库的 `data/` 里，否则 `--force` 可能改控制器文件。
 * 按本仓库路径分桶，避免多份 Agent OS 抢同一临时目录。
 */
export function cursorRuntimeRoot(): string {
  const instance = createHash('sha256').update(AGENT_OS_ROOT).digest('hex').slice(0, 8);
  return join(tmpdir(), 'agent-os', `cursor-${instance}`);
}

/**
 * overlay 目录身份：包含 MESSAGE_ID 以完全隔离每条消息。
 * 旧设计（不含 MESSAGE_ID）会导致同一 workflow 的不同消息覆盖同一目录，
 * 虽然实测 Cursor 启动后不会重新扫描 MCP，但为安全起见完全隔离。
 */
function cursorOverlayScopeEnv(env: Record<string, string>): Record<string, string> {
  // 包含所有上下文字段，确保每条消息独立
  return pickAskMcpContextEnv(env);
}

/**
 * Cursor CLI 没有 `--mcp-config`，只扫描 workspace / 全局的 mcp.json。
 * 把问卷 MCP 写到隔离 overlay，再通过 `--add-dir` 挂成额外 workspace root。
 * `--approve-mcps` 会放行整个 server，因此 overlay 里强制拒绝 record_answers。
 */
export function ensureCursorMcpOverlay(contextEnv: Record<string, string> = {}): string {
  const env = pickAskMcpContextEnv(contextEnv);
  const scope = cursorOverlayScopeEnv(env);
  const suffix = Object.keys(scope).length === 0
    ? 'runtime'
    : createHash('sha256').update(JSON.stringify(scope)).digest('hex').slice(0, 12);
  const overlayDir = join(cursorRuntimeRoot(), `mcp-${suffix}`);
  const cursorDir = join(overlayDir, '.cursor');
  mkdirSync(cursorDir, { recursive: true });
  const server = bundledAskServer(env);
  const body = `${JSON.stringify({
    mcpServers: {
      'agent-os-ask': {
        command: server.command,
        ...(server.args?.length ? { args: server.args } : {}),
        env: {
          ...server.env,
          AGENT_OS_MCP_DENY_RECORD_ANSWERS: '1',
        },
      },
    },
  }, null, 2)}\n`;
  writeFileSync(join(cursorDir, 'mcp.json'), body, 'utf8');
  writeFileSync(join(overlayDir, 'mcp.json'), body, 'utf8');
  return overlayDir;
}

export function cursorMcpFlags(contextEnv: Record<string, string> = {}): string[] {
  if (!isMcpEnabled()) return [];
  return ['--add-dir', ensureCursorMcpOverlay(contextEnv), '--approve-mcps'];
}

/** 仅输入分析：把 Cursor workspace 指到空目录，避免 --mode ask 仍能读用户仓库。 */
export function ensureCursorInputOnlyWorkspace(): string {
  const dir = join(cursorRuntimeRoot(), 'input-only');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'README.txt'),
    'Agent OS input-only jail. Do not read user project files from here.\n',
    'utf8',
  );
  return dir;
}

/**
 * `--approve-mcps` 会放行当前工作区全部 MCP，不只是问卷 overlay。
 * 项目 `.cursor/mcp.json` 和 `~/.cursor/mcp.json` 都会被 Cursor 加载。
 */
export function warnIfCursorProjectMcps(cwd: string): void {
  const globalPath = join(homedir(), '.cursor', 'mcp.json');
  const candidates = [
    join(cwd, '.cursor', 'mcp.json'),
    join(cwd, 'mcp.json'),
    globalPath,
  ];
  for (const path of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const record = parsed as Record<string, unknown>;
    const servers = record.mcpServers ?? (isRecord(record.mcp) ? record.mcp.servers : undefined);
    if (!servers || typeof servers !== 'object') continue;
    const names = Object.keys(servers).filter((name) => name !== 'agent-os-ask');
    if (names.length === 0) continue;
    const scope = path === globalPath ? '全局' : '项目';
    console.warn(
      `[MCP] Cursor --approve-mcps 会一并放行${scope} MCP（${path}）：${names.join(', ')}。`
      + '只有问卷 overlay 设置了 AGENT_OS_MCP_DENY_RECORD_ANSWERS。',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
