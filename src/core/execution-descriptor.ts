import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { release } from 'node:os';
import { z } from 'zod';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ExecutionDescriptorSchema = z.object({ schema: z.literal('execution-descriptor/1'),
    binary: z.string().startsWith('/'), binaryDigest: hash, payloadDigests: z.record(z.string().startsWith('/'), hash),
    command: z.string().min(1), protectedRootsVersion: z.string().min(1),
    cliMode: z.string().min(1), purpose: z.string().min(1), roots: z.array(z.string().startsWith('/')).min(1),
    template: z.literal('seatbelt/2'), writePolicy: z.string().min(1), platform: z.string().min(1), osVersion: z.string().min(1),
    sandboxBinary: z.literal('/usr/bin/sandbox-exec'), sandboxDigest: hash,
    configFingerprint: hash, requestedModel: z.string().nullable(), confirmedModel: z.string().nullable(),
    requestedEffort: z.string().nullable(), confirmedEffort: z.string().nullable(),
    authAssembly: z.enum(['none', 'host-official-session']), bootstrapContract: z.string().min(1), audience: z.enum(['production', 'local-test']) }).strict();
export type ExecutionDescriptor = z.infer<typeof ExecutionDescriptorSchema>;
export const rawHash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export function descriptorDigest(input: ExecutionDescriptor): string {
    const descriptor = ExecutionDescriptorSchema.parse(input);
    const canonical = { ...descriptor, roots: [...new Set(descriptor.roots)].sort(), payloadDigests: Object.fromEntries(Object.entries(descriptor.payloadDigests).sort(([a], [b]) => a.localeCompare(b))) };
    return rawHash(JSON.stringify(canonical));
}
export function assertDescriptorCurrent(descriptor: ExecutionDescriptor): void {
    ExecutionDescriptorSchema.parse(descriptor);
    if (descriptor.platform !== process.platform || descriptor.osVersion !== release()
        || realpathSync(descriptor.binary) !== descriptor.binary || rawHash(readFileSync(descriptor.binary)) !== descriptor.binaryDigest
        || rawHash(readFileSync(descriptor.sandboxBinary)) !== descriptor.sandboxDigest
        || Object.entries(descriptor.payloadDigests).some(([p, h]) => realpathSync(p) !== p || rawHash(readFileSync(p)) !== h))
        throw new Error('Execution descriptor binary/payload/platform changed');
}
