/** Reads only a protected, non-secret official runtime receipt, never personal provider credentials. */
import { z } from 'zod';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { CONTROL_ROOT, readProtectedJson } from './protected-control.js';
import type { ModelSelection } from './model-selection.js';
import { ExecutionDescriptorSchema } from './execution-descriptor.js';
const receiptSchema = z.object({ schema: z.literal('zcode-model-receipt/1'), source: z.literal('official-runtime-metadata'),
    providerId: z.string().min(1), modelId: z.string().min(1), nativeSessionId: z.string().min(1), runId: z.string().min(1),
    configFingerprint: z.string().regex(/^[a-f0-9]{64}$/), payloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    bootstrapCwd: z.string().startsWith('/'), bootstrapContract: z.literal('no-project-dotenv/1'),
    mode: z.enum(['fresh', 'resume', 'recreate']), status: z.literal('completed'), observedAt: z.string().datetime(), expiresAt: z.string().datetime() }).strict();
export type ZcodeModelReceipt = z.infer<typeof receiptSchema>;
export function validateZcodeModelBinding(input: unknown, options: {
    requested: ModelSelection;
    mode: ZcodeModelReceipt['mode'];
    sessionId?: string;
    configFingerprint: string;
    payloadFingerprint: string;
    now?: number;
}): ZcodeModelReceipt {
    const receipt = receiptSchema.parse(input), now = options.now ?? Date.now();
    if (options.requested.reasoningEffort !== null || !options.requested.model || receipt.modelId !== options.requested.model
        || receipt.mode !== options.mode || (options.mode === 'resume' && receipt.nativeSessionId !== options.sessionId)
        || receipt.configFingerprint !== options.configFingerprint || receipt.payloadFingerprint !== options.payloadFingerprint
        || Date.parse(receipt.observedAt) > now + 60000 || Date.parse(receipt.expiresAt) <= now
        || Date.parse(receipt.expiresAt) <= Date.parse(receipt.observedAt) || Date.parse(receipt.expiresAt) - Date.parse(receipt.observedAt) > 3600000)
        throw new Error('ZCode actual model/config/session binding is unverified or changed');
    return structuredClone(receipt);
}
export function readProtectedZcodeModelReceipt(): unknown {
    const file = join(CONTROL_ROOT, 'zcode-model-receipt.json');
    if (!existsSync(file))
        throw new Error('ZCode GLM 模型未取得当前 official-runtime-metadata 凭据，模型与引导环境尚未核验');
    return readProtectedJson(file);
}
/** Validate only host metadata; no provider secrets or model self-report is accepted. */
export function inspectProtectedZcodeBinding(requested: ModelSelection, sessionId?: string): ZcodeModelReceipt {
    const descriptor = ExecutionDescriptorSchema.parse(readProtectedJson(join(CONTROL_ROOT, 'execution-descriptor.json')));
    return validateZcodeModelBinding(readProtectedZcodeModelReceipt(), { requested, mode: sessionId ? 'resume' : 'fresh', sessionId,
        configFingerprint: descriptor.configFingerprint, payloadFingerprint: descriptor.binaryDigest });
}
