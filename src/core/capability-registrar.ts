/** Signed controller attestations; writable verdict/raw files alone never grant launch capability. */
import { randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { readJsonState, writeJsonState } from './json-state.js';
import { readProtectedJson, CONTROL_ROOT } from './protected-control.js';
import { ExecutionDescriptorSchema, descriptorDigest, rawHash, type ExecutionDescriptor } from './execution-descriptor.js';
import { computeIsolationCapabilityIdentity, computeBinaryFingerprint, protectedRootsDigest, type IsolationCapabilityReader, type IsolationCapabilityVerdicts } from './isolation-capability.js';
import { replayCanaryRawStream } from './canary-collector.js';
import { adjudicateCanaryRun, CANARY_VERDICT_VERSION } from './canary-verdict.js';
const DOMAIN = 'agent-os:capability-attestation:v1\0';
const bodySchema = z.object({ nonce: z.string().uuid(), key: z.string().regex(/^[a-f0-9]{64}$/),
    descriptor: ExecutionDescriptorSchema, issuedAt: z.string().datetime(), expiresAt: z.string().datetime(),
    rawDigest: z.string().regex(/^[a-f0-9]{64}$/), controllerId: z.string().min(1),
    probes: z.array(z.object({ direction: z.enum(['read', 'write', 'descendant']), command: z.string().startsWith('/'), args: z.array(z.string()), exitCode: z.number().int(), blocked: z.literal(true) }).strict()).length(3),
    processTreeStopped: z.literal(true), timedOut: z.literal(false), verdictVersion: z.literal(CANARY_VERDICT_VERSION),
    canary: z.object({ probes: z.array(z.object({ id: z.enum(['B', 'C', 'D']), direction: z.enum(['read', 'write']), target: z.string().startsWith('/'), canonicalCommand: z.string().min(1) }).strict()).length(3),
        sentinel: z.string().min(16), files: z.object({ insideWritten: z.literal(true), outsideWritten: z.literal(false) }).strict(), processExitCode: z.literal(0) }).strict() }).strict();
export type CapabilityAttestationBody = z.infer<typeof bodySchema>;
export interface CapabilityAttestation {
    body: CapabilityAttestationBody;
    signature: string;
}
const stateSchema = z.object({ version: z.number().int().nonnegative(), entries: z.record(z.string(), z.object({ body: bodySchema, signature: z.string() }).strict()), nonces: z.record(z.string(), z.string()) }).strict();
export function descriptorCapabilityKey(descriptor: ExecutionDescriptor): string {
    return computeIsolationCapabilityIdentity({ command: descriptor.command, purpose: descriptor.purpose,
        protectedRootsVersion: descriptor.protectedRootsVersion, protectedRootsDigest: protectedRootsDigest(descriptor.roots),
        writePolicy: descriptor.writePolicy, platform: descriptor.platform as NodeJS.Platform,
        binaryFingerprint: computeBinaryFingerprint({ binaryRealPath: descriptor.binary, contentSha256: descriptor.binaryDigest }),
        executionDescriptorDigest: descriptorDigest(descriptor), templateVersion: descriptor.template });
}
export function signControllerAttestation(body: CapabilityAttestationBody, key: KeyObject): CapabilityAttestation {
    const parsed = bodySchema.parse(body);
    return { body: parsed, signature: sign(null, Buffer.from(DOMAIN + JSON.stringify(parsed)), key).toString('hex') };
}
export function validateAttestation(input: CapabilityAttestation, keys: ReadonlyMap<string, KeyObject>, now = Date.now()): CapabilityAttestationBody {
    const body = bodySchema.parse(input.body), key = keys.get(body.controllerId);
    if (!key || !/^[a-f0-9]{128}$/.test(input.signature) || !verify(null, Buffer.from(DOMAIN + JSON.stringify(body)), key, Buffer.from(input.signature, 'hex'))
        || Date.parse(body.issuedAt) > now + 60000 || Date.parse(body.expiresAt) <= now || Date.parse(body.expiresAt) - Date.parse(body.issuedAt) > 604800000
        || Date.parse(body.expiresAt) <= Date.parse(body.issuedAt))
        throw new Error('Capability attestation invalid/expired');
    if (new Set(body.probes.map(p => p.direction)).size !== 3 || body.probes.some(p => p.exitCode === 0))
        throw new Error('Incomplete failed-closed probe matrix');
    if (body.key !== descriptorCapabilityKey(body.descriptor))
        throw new Error('Capability key/descriptor mismatch');
    return structuredClone(body);
}
/** Single-writer CAS journal. Idempotent nonce cannot be rebound to another attestation. */
export class CapabilityRegistrar implements IsolationCapabilityReader {
    constructor(private readonly file: string, private readonly keys: () => ReadonlyMap<string, KeyObject>, private readonly audience: ExecutionDescriptor['audience']) { }
    private state(): {
        version: number;
        entries: Record<string, CapabilityAttestation>;
        nonces: Record<string, string>;
    } {
        return stateSchema.parse(readJsonState(this.file) ?? { version: 0, entries: {}, nonces: {} });
    }
    register(input: CapabilityAttestation, rawEvents: Buffer, current: () => ExecutionDescriptor, expectedVersion: number): void {
        const body = validateAttestation(input, this.keys());
        const replayed = replayCanaryRawStream(rawEvents.toString('utf8'));
        const adjudicated = adjudicateCanaryRun({ ...body.canary, commands: replayed.commands, toolResultTexts: replayed.toolResultTexts, engineCompleted: replayed.engineCompleted, processGroupExited: body.processTreeStopped, timedOut: body.timedOut });
        if (!adjudicated.pass || replayed.invalidLines.length)
            throw new Error('Independent canary raw replay rejected');
        if (body.descriptor.audience !== this.audience || body.rawDigest !== rawHash(rawEvents) || descriptorDigest(current()) !== descriptorDigest(body.descriptor))
            throw new Error('Capability evidence scope/raw/descriptor mismatch');
        const lock = `${this.file}.writer-lock`;
        mkdirSync(dirname(this.file), { recursive: true });
        const fd = openSync(lock, 'wx', 0o600);
        try {
            const state = this.state(), fingerprint = rawHash(JSON.stringify(input));
            if (state.nonces[body.nonce]) {
                if (state.nonces[body.nonce] !== fingerprint)
                    throw new Error('Capability nonce rebound');
                return;
            }
            if (state.version !== expectedVersion || descriptorDigest(current()) !== descriptorDigest(body.descriptor))
                throw new Error('Capability CAS/descriptor changed');
            state.entries[body.key] = structuredClone(input);
            state.nonces[body.nonce] = fingerprint;
            state.version++;
            writeJsonState(this.file, state);
        }
        finally {
            closeSync(fd);
            rmSync(lock);
        }
    }
    revoke(key: string, expectedVersion: number): void {
        const lock = `${this.file}.writer-lock`, fd = openSync(lock, 'wx', 0o600);
        try {
            const state = this.state();
            if (state.version !== expectedVersion)
                throw new Error('Capability CAS mismatch');
            delete state.entries[key];
            state.version++;
            writeJsonState(this.file, state);
        }
        finally {
            closeSync(fd);
            rmSync(lock);
        }
    }
    lookup(key: string): IsolationCapabilityVerdicts | undefined {
        const input = this.state().entries[key];
        if (!input)
            return undefined;
        const body = validateAttestation(input, this.keys());
        if (body.key !== key || body.descriptor.audience !== this.audience)
            throw new Error('Capability audience/key mismatch');
        return { read: 'passed', write: 'passed', evidenceRef: `controller:${body.controllerId}/${body.nonce}/${body.rawDigest}`, expiresAt: body.expiresAt };
    }
}
/** Formal evidence/keyring are root protected; absent deployment stays blocked. */
export function protectedCapabilityReader(): IsolationCapabilityReader {
    return { lookup: key => {
            const file = `${CONTROL_ROOT}/capabilities.json`;
            if (!existsSync(file))
                return undefined;
            const input = stateSchema.parse(readProtectedJson(file));
            const item = input.entries[key];
            if (!item)
                return undefined;
            // Keys are installed separately from evidence; task processes cannot mint attestations.
            const ring = z.record(z.string(), z.string()).parse(readProtectedJson(`${CONTROL_ROOT}/controller-public-keys.json`));
            // Dynamic import is unnecessary: only public Ed25519 PEM keys accepted below.
            const keys = publicAttestationKeys(ring), body = validateAttestation(item, keys);
            if (body.key !== key || body.descriptor.audience !== 'production')
                throw new Error('Local capability cannot unlock production / key mismatch');
            return { read: 'passed', write: 'passed', evidenceRef: `controller:${body.controllerId}/${body.nonce}`, expiresAt: body.expiresAt };
        } };
}
import { createPublicKey } from 'node:crypto';
function publicAttestationKeys(ring: Record<string, string>): Map<string, KeyObject> {
    return new Map(Object.entries(ring).map(([id, pem]) => { if (!pem.startsWith('-----BEGIN PUBLIC KEY-----'))
        throw new Error('Public keys only'); const key = createPublicKey(pem); if (key.asymmetricKeyType !== 'ed25519')
        throw new Error('Ed25519 only'); return [id, key]; }));
}
export const newControllerNonce = () => randomUUID();
