import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CONTROL_ROOT, readProtectedJson, assertProtectedPath, assertProtectedPayloadTree } from './protected-control.js';
import { SourceContextGrantStore } from './source-context-grant.js';
import type { KbMcpToolResponse } from './kb-prefetch.js';
const settingsSchema = z.object({ node: z.string().startsWith('/'), deploymentRoot: z.string().startsWith('/'), entry: z.string().startsWith('/'), entryDigest: z.string().regex(/^[a-f0-9]{64}$/),
    kbConfig: z.string().startsWith('/'), caller: z.string().min(1), systems: z.array(z.string()).min(1),
    principals: z.record(z.string(), z.object({ roles: z.array(z.string()), bots: z.array(z.string()), systems: z.array(z.string()), workspaces: z.array(z.string()) }).strict()) }).strict();
/** No service installation here; absent formal settings leaves source consumption disabled. */
export function createProtectedSourceContexts(): SourceContextGrantStore | undefined {
    const file = join(CONTROL_ROOT, 'knowledge-consumer.json');
    if (!existsSync(file))
        return undefined;
    const settings = () => settingsSchema.parse(readProtectedJson(file));
    const initial = settings();
    return new SourceContextGrantStore({ audience: 'source', systems: new Set(initial.systems), authorize: binding => {
            const s = settings(), principal = s.principals[binding.principalId];
            return !!principal && s.systems.includes(binding.systemId) && principal.roles.includes(binding.role) && principal.bots.includes(binding.botId)
                && principal.systems.includes(binding.systemId) && principal.workspaces.map(p => realpathSync(p)).includes(binding.workspaceRealpath);
        }, client: { call: async (tool, args) => {
                const s = settings();
                assertProtectedPath(s.node, true);
                assertProtectedPath(s.kbConfig);
                assertProtectedPayloadTree(s.deploymentRoot, s.entry);
                if (createHash('sha256').update(readFileSync(s.entry)).digest('hex') !== s.entryDigest)
                    throw new Error('KB worker payload changed');
                // KB worker is trusted host code. CLI children receive only a pruned text grant.
                const transport = new StdioClientTransport({ command: s.node, args: [s.entry], cwd: CONTROL_ROOT,
                    env: { PATH: '/usr/bin:/bin', KB_CONFIG: s.kbConfig, KB_CALLER: s.caller } });
                const client = new Client({ name: 'agent-os-host', version: '1' });
                try {
                    await client.connect(transport);
                    return await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 10000 }) as KbMcpToolResponse;
                }
                finally {
                    await client.close();
                }
            } } });
}
