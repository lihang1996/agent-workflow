/** Synthetic OS validation only; this controller cannot issue production attestations. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { type KeyObject } from 'node:crypto';
import { buildIsolationProfile } from './isolation.js';
import { descriptorCapabilityKey, newControllerNonce, signControllerAttestation, type CapabilityAttestationBody } from './capability-registrar.js';
import { assertDescriptorCurrent, rawHash, type ExecutionDescriptor } from './execution-descriptor.js';
import { CANARY_VERDICT_VERSION, type CanaryProbeAction } from './canary-verdict.js';
export function runLocalCapabilityController(options: {
    descriptor: ExecutionDescriptor;
    fixtureRoot: string;
    scratchDir: string;
    sentinelFile: string;
    controllerId: string;
    key: KeyObject;
}) {
    const { descriptor, controllerId, key } = options;
    assertDescriptorCurrent(descriptor);
    if (descriptor.audience !== 'local-test')
        throw new Error('Local controller cannot sign production evidence');
    const fixtureRoot = realpathSync(options.fixtureRoot), scratchDir = realpathSync(options.scratchDir), sentinelFile = realpathSync(options.sentinelFile);
    if (!fixtureRoot.startsWith('/private/tmp/') || !scratchDir.startsWith(fixtureRoot + '/') || !sentinelFile.startsWith(fixtureRoot + '/')
        || !descriptor.roots.some(root => sentinelFile.startsWith(root + '/')))
        throw new Error('Controller requires synthetic temporary targets');
    const inside = join(scratchDir, 'controller-inside.txt'), outside = join(fixtureRoot, 'controller-outside.txt');
    const profile = buildIsolationProfile({ scratchRealpath: scratchDir, allowedPathRealpaths: [], protectedRootRealpaths: descriptor.roots });
    const commands: Array<{
        command: string;
        exitCode: number;
        output: string;
    }> = [];
    const run = (command: string, args: string[]) => {
        const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '--', command, ...args], { cwd: fixtureRoot,
            env: { PATH: '/usr/bin:/bin', HOME: scratchDir, TMPDIR: scratchDir }, encoding: 'utf8', timeout: 5000, maxBuffer: 262144 });
        if (result.error || result.status === null)
            throw new Error('Controller probe timed out or did not exit');
        const row = { command: [command, ...args].join(' '), exitCode: result.status, output: result.stdout + result.stderr };
        commands.push(row);
        return row;
    };
    const b = run('/usr/bin/touch', [inside]), c = run('/usr/bin/touch', [outside]), d = run('/bin/cat', [sentinelFile]);
    const descendant = run('/bin/sh', ['-c', `/bin/cat ${sentinelFile}`]);
    const probes: CanaryProbeAction[] = [{ id: 'B', direction: 'write', target: inside, canonicalCommand: b.command },
        { id: 'C', direction: 'write', target: outside, canonicalCommand: c.command }, { id: 'D', direction: 'read', target: sentinelFile, canonicalCommand: d.command }];
    const raw = Buffer.from(commands.map(row => JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: row.command, exit_code: row.exitCode, aggregated_output: row.output } })).join('\n')
        + '\n' + JSON.stringify({ type: 'turn.completed' }) + '\n');
    const blocked = (row: typeof d) => row.exitCode !== 0 && /Operation not permitted|Permission denied/.test(row.output) && row.output.includes(sentinelFile === row.command.split(' ').at(-1) ? sentinelFile : outside);
    if (b.exitCode !== 0 || !existsSync(inside) || existsSync(outside) || !blocked(c) || !blocked(d) || !blocked(descendant)
        || commands.some(row => row.output.includes(readFileSync(sentinelFile, 'utf8'))))
        throw new Error('Controller boundary matrix failed');
    const body: CapabilityAttestationBody = { nonce: newControllerNonce(), key: descriptorCapabilityKey(descriptor), descriptor,
        issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), rawDigest: rawHash(raw), controllerId,
        probes: [{ direction: 'read' as const, command: '/bin/cat', args: [sentinelFile], exitCode: d.exitCode, blocked: true as const },
            { direction: 'write' as const, command: '/usr/bin/touch', args: [outside], exitCode: c.exitCode, blocked: true as const },
            { direction: 'descendant' as const, command: '/bin/sh', args: ['-c', `/bin/cat ${sentinelFile}`], exitCode: descendant.exitCode, blocked: true as const }],
        processTreeStopped: true as const, timedOut: false as const, verdictVersion: CANARY_VERDICT_VERSION,
        canary: { probes, sentinel: readFileSync(sentinelFile, 'utf8'), files: { insideWritten: true as const, outsideWritten: false as const }, processExitCode: 0 as const } };
    return { attestation: signControllerAttestation(body, key), raw };
}
