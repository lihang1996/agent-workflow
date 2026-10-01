import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readJsonState, writeJsonState } from './json-state.js';
const schema = z.object({ authorizationId: z.string().min(1), taskId: z.string().min(1), sessionId: z.string().min(1), sessionVersion: z.number().int().nonnegative(),
    botId: z.string().min(1), ownerOpenId: z.string().min(1), ownerUnionId: z.string().optional(), consumedAt: z.string().datetime().optional(),
    operationId: z.string().min(1), state: z.enum(['issued', 'reserved', 'launching', 'running', 'terminal', 'launch_unknown', 'revoked']),
    expiresAt: z.string().datetime(), attempts: z.number().int().min(0).max(3), pid: z.number().int().positive().optional(),
    scopeDigest: z.string().optional(), lastError: z.string().optional() }).strict();
export type CodingIntentHandoff = z.infer<typeof schema>;
export type CodingHandoffIssue = Omit<CodingIntentHandoff, 'operationId' | 'state' | 'expiresAt' | 'attempts'> & Partial<Pick<CodingIntentHandoff, 'operationId' | 'expiresAt'>>;
export const codingOperationId = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
/** One host writer (application lock); every transition persists before replacing memory. */
export class CodingIntentHandoffStore {
    private rows = new Map<string, CodingIntentHandoff>();
    constructor(private readonly file?: string) {
        const loaded = z.array(schema).parse(readJsonState(file) ?? []);
        if (new Set(loaded.map(r => r.authorizationId)).size !== loaded.length)
            throw new Error('Duplicate coding handoff');
        for (const row of loaded)
            this.rows.set(row.authorizationId, { ...row,
                state: row.state === 'reserved' ? 'issued' : row.state === 'running' || row.state === 'launching' ? 'launch_unknown' : row.state });
        if (loaded.some(row => row.state === 'reserved' || row.state === 'running' || row.state === 'launching'))
            writeJsonState(this.file, [...this.rows.values()]);
    }
    private save(row: CodingIntentHandoff): void {
        schema.parse(row);
        const next = new Map(this.rows);
        next.set(row.authorizationId, structuredClone(row));
        writeJsonState(this.file, [...next.values()]);
        this.rows = next;
    }
    issue(input: CodingHandoffIssue): void {
        const operationId = input.operationId ?? codingOperationId(input), old = this.rows.get(input.authorizationId);
        if (old) {
            if (old.operationId === operationId && codingOperationId({ taskId: old.taskId, sessionId: old.sessionId, sessionVersion: old.sessionVersion, botId: old.botId, ownerOpenId: old.ownerOpenId, ownerUnionId: old.ownerUnionId, scopeDigest: old.scopeDigest })
                === codingOperationId({ taskId: input.taskId, sessionId: input.sessionId, sessionVersion: input.sessionVersion, botId: input.botId, ownerOpenId: input.ownerOpenId, ownerUnionId: input.ownerUnionId, scopeDigest: input.scopeDigest }))
                return;
            throw new Error('授权已有一次性交接，需新授权版本，拒绝重复签发');
        }
        this.save({ ...input, operationId, state: 'issued', attempts: 0, expiresAt: input.expiresAt ?? new Date(Date.now() + 1800000).toISOString() });
    }
    get(id: string): CodingIntentHandoff | undefined { return structuredClone(this.rows.get(id)); }
    reserve(id: string, at: string): CodingIntentHandoff | undefined {
        const row = this.rows.get(id);
        if (!row || row.state !== 'issued' || Date.parse(row.expiresAt) <= Date.parse(at) || row.attempts >= 3)
            return undefined;
        const next = { ...row, state: 'reserved' as const, attempts: row.attempts + 1 };
        this.save(next);
        return structuredClone(next);
    }
    transition(id: string, operationId: string, state: CodingIntentHandoff['state'], detail?: {
        pid?: number;
        error?: string;
    }): void {
        const row = this.rows.get(id);
        if (!row || row.operationId !== operationId)
            throw new Error('Coding operation mismatch');
        const allowed: Record<CodingIntentHandoff['state'], CodingIntentHandoff['state'][]> = { issued: ['revoked'], reserved: ['issued', 'launching', 'revoked'], launching: ['running', 'issued', 'launch_unknown'], running: ['terminal', 'launch_unknown'], terminal: [], launch_unknown: ['revoked'], revoked: [] };
        if (!allowed[row.state].includes(state))
            throw new Error(`Illegal coding transition ${row.state}→${state}`);
        this.save({ ...row, state, ...(detail?.pid ? { pid: detail.pid } : {}), ...(detail?.error ? { lastError: detail.error } : {}), ...(state === 'terminal' ? { consumedAt: new Date().toISOString() } : {}) });
    }
    /** Compatibility API is explicit final consumption, never used before prepare in the production path. */
    consume(id: string, at: string): CodingIntentHandoff | undefined {
        const row = this.rows.get(id);
        if (!row || row.state !== 'issued' || row.consumedAt)
            return undefined;
        const next = { ...row, state: 'terminal' as const, consumedAt: at };
        this.save(next);
        return structuredClone(next);
    }
}
