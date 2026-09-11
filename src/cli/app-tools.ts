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

function serverInvocation(allowed: readonly AppToolName[]): { command: string; args: string[] } {
  const policyArgs = [`--tools=${allowed.join(',')}`];
  const runningFromTypeScript = import.meta.url.endsWith('.ts');
  const server = fileURLToPath(new URL(
    runningFromTypeScript
      ? '../mcp/app-tools-server.ts'
      : '../mcp/app-tools-server.js',
    import.meta.url,
  ));
  if (!runningFromTypeScript) {
    return { command: process.execPath, args: [server, ...policyArgs] };
  }
  const tsxCli = fileURLToPath(
    new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url),
  );
  return { command: process.execPath, args: [tsxCli, server, ...policyArgs] };
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
