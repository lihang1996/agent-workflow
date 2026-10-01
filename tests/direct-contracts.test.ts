import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, release } from 'node:os';
import { join } from 'node:path';
import { CapabilityRegistrar, descriptorCapabilityKey, signControllerAttestation, newControllerNonce, type CapabilityAttestationBody } from '../src/core/capability-registrar.js';
import { rawHash, descriptorDigest, type ExecutionDescriptor } from '../src/core/execution-descriptor.js';
import { CodingIntentHandoffStore } from '../src/core/coding-handoff.js';
import { SourceContextGrantStore, type SourceContextBinding } from '../src/core/source-context-grant.js';
import { validateZcodeModelBinding } from '../src/core/zcode-model-binding.js';
import { CANARY_VERDICT_VERSION } from '../src/core/canary-verdict.js';
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'ao-direct-')));
test('A02: signed controller evidence, independent replay, CAS, revocation and local audience', () => {
    const root = scratch();
    try {
        const { publicKey, privateKey } = generateKeyPairSync('ed25519'), keys = new Map([['controller', publicKey]]);
        const descriptor: ExecutionDescriptor = { schema: 'execution-descriptor/1', binary: '/bin/cat', binaryDigest: 'a'.repeat(64), payloadDigests: { '/fixture/payload': 'b'.repeat(64) }, command: '/bin/cat', protectedRootsVersion: 'fixture-v1', cliMode: 'fresh', purpose: 'task', roots: ['/fixture/private'], template: 'seatbelt/2', writePolicy: 'none', platform: process.platform, osVersion: release(), sandboxBinary: '/usr/bin/sandbox-exec', sandboxDigest: 'c'.repeat(64), configFingerprint: 'd'.repeat(64), requestedModel: null, confirmedModel: null, requestedEffort: null, confirmedEffort: null, authAssembly: 'none', bootstrapContract: 'fixture/1', audience: 'local-test' };
        const probes = [{ id: 'B' as const, direction: 'write' as const, target: '/fixture/inside', canonicalCommand: 'echo inside-ok > /fixture/inside' }, { id: 'C' as const, direction: 'write' as const, target: '/fixture/outside', canonicalCommand: 'echo outside-bad > /fixture/outside' }, { id: 'D' as const, direction: 'read' as const, target: '/fixture/private/sentinel', canonicalCommand: '/bin/cat /fixture/private/sentinel' }];
        const raw = Buffer.from(probes.map((p, i) => JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: p.canonicalCommand, exit_code: i ? 1 : 0, aggregated_output: i ? `${p.target}: Operation not permitted` : '' } })).join('\n') + '\n' + JSON.stringify({ type: 'turn.completed' }) + '\n');
        const body: CapabilityAttestationBody = { nonce: newControllerNonce(), key: descriptorCapabilityKey(descriptor), descriptor, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), rawDigest: rawHash(raw), controllerId: 'controller',
            probes: [{ direction: 'read', command: '/bin/cat', args: ['/fixture/private/sentinel'], exitCode: 1, blocked: true }, { direction: 'write', command: '/usr/bin/touch', args: ['/fixture/outside'], exitCode: 1, blocked: true }, { direction: 'descendant', command: '/bin/sh', args: ['-c', '/bin/cat /fixture/private/sentinel'], exitCode: 1, blocked: true }], processTreeStopped: true, timedOut: false, verdictVersion: CANARY_VERDICT_VERSION, canary: { probes, sentinel: 'synthetic-sentinel-123456', files: { insideWritten: true, outsideWritten: false }, processExitCode: 0 } };
        const signed = signControllerAttestation(body, privateKey), file = join(root, 'capabilities.json');
        const store = new CapabilityRegistrar(file, () => keys, 'local-test');
        assert.equal(store.lookup(body.key), undefined);
        store.register(signed, raw, () => descriptor, 0);
        assert.equal(store.lookup(body.key)?.read, 'passed');
        store.register(signed, raw, () => descriptor, 0);
        const changed = { ...descriptor, configFingerprint: 'e'.repeat(64) };
        assert.notEqual(descriptorDigest(descriptor), descriptorDigest(changed));
        assert.throws(() => store.register(signControllerAttestation({ ...body, nonce: newControllerNonce() }, privateKey), raw, () => changed, 1), /mismatch/);
        const badRaw = Buffer.from(raw.toString().replace('/bin/cat', 'echo cat'));
        assert.throws(() => store.register(signControllerAttestation({ ...body, nonce: newControllerNonce(), rawDigest: rawHash(badRaw) }, privateKey), badRaw, () => descriptor, 1), /replay/);
        keys.clear();
        assert.throws(() => store.lookup(body.key), /invalid/);
        keys.set('controller', publicKey);
        assert.throws(() => new CapabilityRegistrar(file, () => keys, 'production').lookup(body.key), /audience/);
        store.revoke(body.key, 1);
        assert.equal(store.lookup(body.key), undefined);
        writeFileSync(file, '{bad');
        assert.throws(() => store.lookup(body.key));
        assert.equal(readFileSync(file, 'utf8'), '{bad');
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test('A06: durable reservation retry versus uncertain spawn; same authorization never reissued', () => {
    const root = scratch();
    try {
        const file = join(root, 'handoff.json'), base = { authorizationId: 'ca-1', taskId: 'task', sessionId: 'session', sessionVersion: 0, botId: 'dev', ownerOpenId: 'owner', operationId: 'event-1' };
        let store = new CodingIntentHandoffStore(file);
        store.issue(base);
        store.issue(base);
        assert.ok(store.reserve(base.authorizationId, new Date().toISOString()));
        assert.equal(store.reserve(base.authorizationId, new Date().toISOString()), undefined);
        store = new CodingIntentHandoffStore(file);
        assert.equal(store.get('ca-1')?.state, 'issued');
        assert.ok(store.reserve('ca-1', new Date().toISOString()));
        store.transition('ca-1', 'event-1', 'launching');
        store = new CodingIntentHandoffStore(file);
        assert.equal(store.get('ca-1')?.state, 'launch_unknown');
        assert.equal(store.reserve('ca-1', new Date().toISOString()), undefined);
        assert.throws(() => store.issue({ ...base, operationId: 'event-2' }), /重复签发/);
        assert.throws(() => store.transition('ca-1', 'event-1', 'issued'), /Illegal/);
        const other = { ...base, authorizationId: 'ca-2' };
        store.issue(other);
        for (let i = 0; i < 3; i++) {
            assert.ok(store.reserve('ca-2', new Date().toISOString()));
            store.transition('ca-2', 'event-1', 'issued');
        }
        assert.equal(store.reserve('ca-2', new Date().toISOString()), undefined);
        const bad = join(root, 'dir');
        mkdirSync(bad);
        assert.throws(() => new CodingIntentHandoffStore(bad));
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test('K11: host grants bind principal/session/workspace, source epoch and expiry; no coding authority', async () => {
    const root = scratch();
    try {
        let allowed = true, epoch = 'sha256:' + 'a'.repeat(64), expires = new Date(Date.now() + 60000).toISOString();
        const object = () => ({ id: 'rule', revision: 1, publication_status: 'published', verification_status: 'verified', source_state: { status: 'current', fact_kind: 'source-current', reason: 'verified', checked_at: new Date(Date.now() - 1000).toISOString(), expires_at: expires, epoch_digest: epoch, evidence_digest: 'sha256:' + 'b'.repeat(64), repo_commits: { repo: 'c'.repeat(40) }, trust_scope: 'local-dev' } });
        const issuedObject = object();
        let currentObject = issuedObject;
        const frame = (result: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ contract_version: 1, request_id: 'fixture', status: 'ok', system_id: 'sys', snapshot_ref: 'snapshot', availability_checked_at: new Date().toISOString(), examined_scope: {}, missing_evidence: [], truncated: false, truncation_reasons: [], warnings: [], result }) }] });
        const store = new SourceContextGrantStore({ audience: 'local-dev', systems: new Set(['sys']), authorize: () => allowed, client: { call: async (tool) => frame(tool === 'search_knowledge' ? { results: [{ ...currentObject, publication_status: 'published', verification_status: 'verified' }] } : tool === 'build_prd_context' ? { context_ref: 'context' } : { context: { objects: [currentObject] } }) } });
        const binding: SourceContextBinding = { taskId: 't', sessionId: 's', sessionVersion: 0, botId: 'dev', principalId: 'owner', role: 'developer', systemId: 'sys', workspaceRealpath: root };
        const grant = await store.issue(binding, 'rule');
        assert.equal(grant.codingAuthority, false);
        assert.match(await store.read(grant.grantId, binding), /不证明已上线/);
        for (const altered of [{ ...binding, principalId: 'other' }, { ...binding, sessionVersion: 1 }, { ...binding, taskId: 'other' }, { ...binding, botId: 'product' }])
            await assert.rejects(store.read(grant.grantId, altered), /mismatch/);
        allowed = false;
        await assert.rejects(store.read(grant.grantId, binding), /revoked/);
        allowed = true;
        currentObject = { ...issuedObject, source_state: { ...issuedObject.source_state, epoch_digest: 'sha256:' + 'd'.repeat(64) } };
        await assert.rejects(store.read(grant.grantId, binding), /changed/);
        currentObject = { ...issuedObject, source_state: { ...issuedObject.source_state, expires_at: new Date(Date.now() - 1).toISOString() } };
        await assert.rejects(store.read(grant.grantId, binding), /expired/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test('A04: official metadata contract fresh/resume/recreate rejects wrong model/session/config/expiry', () => {
    const receipt = { schema: 'zcode-model-receipt/1', source: 'official-runtime-metadata', providerId: 'synthetic-plan', modelId: 'GLM-5.3', nativeSessionId: 'sess-fixture', runId: 'fixture', configFingerprint: 'a'.repeat(64), payloadFingerprint: 'b'.repeat(64), bootstrapCwd: '/private/tmp/fixture', bootstrapContract: 'no-project-dotenv/1', mode: 'fresh', status: 'completed', observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
    const opts = { requested: { model: 'GLM-5.3', reasoningEffort: null }, mode: 'fresh' as const, configFingerprint: 'a'.repeat(64), payloadFingerprint: 'b'.repeat(64) };
    assert.equal(validateZcodeModelBinding(receipt, opts).modelId, 'GLM-5.3');
    for (const mode of ['resume', 'recreate'] as const)
        assert.equal(validateZcodeModelBinding({ ...receipt, mode }, { ...opts, mode, sessionId: 'sess-fixture' }).mode, mode);
    assert.throws(() => validateZcodeModelBinding(receipt, { ...opts, requested: { model: 'GLM-5.3-Flash', reasoningEffort: null } }), /unverified/);
    assert.throws(() => validateZcodeModelBinding({ ...receipt, mode: 'resume' }, { ...opts, mode: 'resume', sessionId: 'wrong' }), /unverified/);
    assert.throws(() => validateZcodeModelBinding(receipt, { ...opts, configFingerprint: 'd'.repeat(64) }), /unverified/);
    assert.throws(() => validateZcodeModelBinding({ ...receipt, expiresAt: new Date(Date.now() - 1).toISOString() }, opts), /unverified/);
});
