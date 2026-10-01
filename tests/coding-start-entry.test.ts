import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, release } from 'node:os';
import { join } from 'node:path';
import { startCoding } from '../src/app/coding-start.js';
import { createCardActionHandler } from '../src/app/card-action-handler.js';
import { createMessageHandler } from '../src/app/message-handler.js';
import { CollaborationService } from '../src/app/collaboration-service.js';
import { executeCli } from '../src/app/cli-execution.js';
import { executionStore } from '../src/app/task-lifecycle.js';
import { CodingIntentHandoffStore } from '../src/core/coding-handoff.js';
import { CodingAuthorizationStore, createCodingAuthorizationDraft, confirmCodingAuthorization, revokeCodingAuthorization } from '../src/core/coding-authorization.js';
import { ProductSpecFlowStore } from '../src/core/product-spec.js';
import { computeLocalArtifactDigest, computeArchitectureArtifactDigest } from '../src/core/artifact-digest.js';
import { SessionManager } from '../src/core/session-manager.js';
import { TeamRegistry } from '../src/core/team-registry.js';
import { ClarificationFlowStore } from '../src/core/clarification.js';
import { CollaborationInbox } from '../src/core/collaboration.js';
import { runCli } from '../src/cli/runner.js';
import { CapabilityRegistrar, descriptorCapabilityKey } from '../src/core/capability-registrar.js';
import { runLocalCapabilityController } from '../src/core/local-capability-controller.js';
import { createLocalDescriptorIsolationPreparer, describeWritePolicy, type IsolationPrepareInput } from '../src/core/isolation.js';
import { rawHash, type ExecutionDescriptor } from '../src/core/execution-descriptor.js';
import type { AppRuntime } from '../src/app/runtime.js';
import type { BotConfig } from '../src/core/bot-registry.js';
import type { CardAction, Bot, IncomingMessage } from '../src/im/lark.js';
import type { CliAdapter } from '../src/cli/types.js';
import type { ExecutionModelPlan } from '../src/app/execution-model.js';
const plan = async (): Promise<ExecutionModelPlan> => ({ desired: { cliId: 'claude', selection: { model: null, reasoningEffort: null }, source: 'native-default', roleDefaultFingerprint: '' },
    decision: { action: 'keep' }, modelSelection: null, resumeCliSessionId: undefined,
    runtimeCheck: { cliId: 'claude', command: 'synthetic', version: 'fixture', checkedAt: new Date().toISOString(), capabilities: { supportsModelSelection: false, supportsReasoningEffort: false, supportsInPlaceModelSwitch: false }, notes: ['synthetic only'] } });
async function fixture(t: TestContext) {
    const root = realpathSync(mkdtempSync(join(process.env.AO_DIRECT_OS === '1' ? '/private/tmp' : tmpdir(), 'ao-entry-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const product = join(root, 'product'), dev = join(root, 'dev'), privateRoot = join(root, 'private'), scratch = join(root, 'controller-scratch');
    for (const dir of [product, dev, privateRoot, scratch, join(product, 'tickets'), join(dev, 'src')])
        mkdirSync(dir, { recursive: true });
    writeFileSync(join(product, 'prd.md'), '# Approved synthetic feature\n');
    writeFileSync(join(product, 'tickets/t1.md'), 'Implement the synthetic feature');
    writeFileSync(join(dev, 'arch.md'), '# Approved synthetic architecture\n');
    writeFileSync(join(dev, 'src/placeholder.ts'), '// fixture\n');
    const sentinelFile = join(privateRoot, 'sentinel');
    writeFileSync(sentinelFile, 'synthetic-private-sentinel-123456789');
    const config: BotConfig = { id: 'developer', role: 'developer', appId: 'fixture', appSecret: 'fixture', defaultCliId: 'claude', modelOverrides: {}, skills: [], systemPrompt: '', collaborationMaxRounds: 3, workspaceDir: dev };
    const sessions = new SessionManager();
    const p = (await sessions.resolve({ chatId: 'p', messageId: 'p', threadId: 'p', rootId: 'p' }, 'claude', 'product', product)).session;
    const d = (await sessions.resolve({ chatId: 'd', messageId: 'd', threadId: 'd', rootId: 'd' }, 'claude', config.id, dev)).session;
    await sessions.transition(p.id, 'idle');
    await sessions.transition(d.id, 'idle');
    const flows = new ProductSpecFlowStore(), owner = { ownerOpenId: 'owner', ownerUnionId: 'owner-union' };
    const prdRequest = { title: 'fixture', summary: 'fixture', deliveryMode: 'local' as const, specPath: 'prd.md', ticketsPath: 'tickets' };
    const pd = await computeLocalArtifactDigest(product, prdRequest);
    const prd = flows.create({ taskId: 'prd', botId: 'product', sessionId: p.id, sessionVersion: 0, ...owner, request: prdRequest, content_digest: pd.digest, content_sources: pd.content_sources });
    flows.approve(prd.token);
    const archRequest = { title: 'fixture arch', summary: 'fixture', deliveryMode: 'local' as const, designPath: 'arch.md' };
    const ad = await computeArchitectureArtifactDigest(dev, archRequest);
    const arch = flows.create({ taskId: 'arch', botId: config.id, sessionId: d.id, sessionVersion: 0, ...owner, artifact_kind: 'architecture', request: archRequest,
        content_digest: ad.digest, content_sources: ad.content_sources, upstream: { prdToken: prd.token, prdDigest: pd.digest, prdTaskId: prd.taskId, prdSessionId: p.id, knowledgeRefs: [], knowledgeState: null } });
    flows.approve(arch.token);
    const authorizations = new CodingAuthorizationStore();
    const operator = { operatorOpenId: owner.ownerOpenId, operatorUnionId: owner.ownerUnionId, operatorBotId: config.id };
    const workspace = (id: string) => sessions.get(id)?.workspaceDir;
    const draft = await createCodingAuthorizationDraft({ store: authorizations, flows, operator, input: { flowToken: arch.token, allowedPaths: ['src'] }, resolveWorkspaceDir: workspace });
    const authorization = await confirmCodingAuthorization({ store: authorizations, flows, operator, authorizationId: draft.id, resolveWorkspaceDir: workspace });
    const runtime: AppRuntime = { sessions, teamRegistry: new TeamRegistry('developer', [config, { ...config, id: 'product', workspaceDir: product }]), activeRuns: new Map(), contextWindows: new Map(), botRuntimes: new Map(), processedCollaborationTurns: new Set(),
        sessionScratches: new Map(), collaborationInbox: new CollaborationInbox(), clarificationFlows: new ClarificationFlowStore(), productSpecFlows: flows, codingAuthorizations: authorizations, codingHandoffs: new CodingIntentHandoffStore(join(root, 'handoffs.json')), authorizeCodingOperator: () => true };
    const action: CardAction = { messageId: 'trusted-card', ...operator, formValue: {}, value: { action: 'start_coding', authorizationId: authorization.id } };
    return { root, product, dev, privateRoot, scratch, sentinelFile, config, runtime, authorization, action, prd, arch, operator, session: d };
}
for (const scenario of ['wrong-owner', 'wrong-bot', 'old-session', 'revoked', 'expired', 'prd-drift', 'arch-drift', 'role-revoked', 'workspace-changed', 'path-escape'] as const) {
    test(`A06 trusted card rejects ${scenario} before invoking execution`, async (t) => {
        const f = await fixture(t);
        let calls = 0;
        if (scenario === 'wrong-owner') {
            f.action.operatorOpenId = 'other';
            f.action.operatorUnionId = 'other';
        }
        if (scenario === 'wrong-bot')
            f.config.id = 'other';
        if (scenario === 'old-session')
            await f.runtime.sessions.setWorkspaceDir(f.session.id, f.product);
        if (scenario === 'revoked')
            revokeCodingAuthorization({ store: f.runtime.codingAuthorizations!, operator: f.operator, authorizationId: f.authorization.id });
        if (scenario === 'expired') {
            const record = f.runtime.codingAuthorizations!.get(f.authorization.id)!;
            f.runtime.codingAuthorizations = new CodingAuthorizationStore([{ ...record, expiresAt: new Date(Date.now() - 1).toISOString() }]);
        }
        if (scenario === 'prd-drift')
            writeFileSync(join(f.product, 'prd.md'), 'drift');
        if (scenario === 'arch-drift')
            writeFileSync(join(f.dev, 'arch.md'), 'drift');
        if (scenario === 'role-revoked')
            f.runtime.authorizeCodingOperator = () => false;
        if (scenario === 'workspace-changed')
            await f.runtime.sessions.setWorkspaceDir(f.session.id, f.product);
        if (scenario === 'path-escape') {
            const record = f.runtime.codingAuthorizations!.get(f.authorization.id)!;
            f.runtime.codingAuthorizations = new CodingAuthorizationStore([{ ...record, allowedPaths: ['../product'] }]);
        }
        const handler = createCardActionHandler({ runtime: f.runtime, config: f.config, defaultProductDeliveryMode: 'local', startCoding: opts => startCoding({ ...opts, background: false, plan, run: async () => { calls++; return { answer: 'must never run' }; } }) });
        const response = await handler(f.action);
        assert.equal(response?.toast?.type, 'error');
        assert.equal(calls, 0);
        assert.equal(f.runtime.activeRuns.size, 0);
    });
}
test('A06 prepare failures allow three durable retries, same card does not reissue or bypass the limit', async (t) => {
    const f = await fixture(t);
    let prepares = 0;
    f.runtime.isolationPreparer = async () => { prepares++; throw new Error('missing signed capability'); };
    for (let i = 0; i < 3; i++)
        await assert.rejects(startCoding({ ...f, plan }), /missing signed capability/);
    assert.equal(f.runtime.codingHandoffs!.get(f.authorization.id)?.attempts, 3);
    await assert.rejects(startCoding({ ...f, plan }), /预留|消费/);
    assert.equal(prepares, 3);
    f.runtime.codingHandoffs = new CodingIntentHandoffStore(join(f.root, 'handoffs.json'));
    await assert.rejects(startCoding({ ...f, plan }), /预留|消费/);
    assert.equal(prepares, 3);
});
test('A02+A06 actual controller → signed registrar → authenticated card → seatbelt child → durable terminal', { skip: process.env.AO_DIRECT_OS !== '1', timeout: 30000 }, async (t) => {
    const f = await fixture(t), { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const binary = realpathSync(process.execPath), capabilities = new CapabilityRegistrar(join(f.privateRoot, 'capabilities.json'), () => new Map([['local-controller', publicKey]]), 'local-test');
    const writePolicy = describeWritePolicy({ taskId: 'fixture', purpose: 'task', command: binary, cwd: f.dev, authorizationId: f.authorization.id, allowedRelatives: ['src'] });
    const descriptor: ExecutionDescriptor = { schema: 'execution-descriptor/1', command: binary, protectedRootsVersion: 'local-v1', binary, binaryDigest: rawHash(readFileSync(binary)), payloadDigests: {}, cliMode: 'fresh', purpose: 'task', roots: [f.privateRoot], template: 'seatbelt/2', writePolicy, platform: process.platform, osVersion: release(), sandboxBinary: '/usr/bin/sandbox-exec', sandboxDigest: rawHash(readFileSync('/usr/bin/sandbox-exec')), configFingerprint: rawHash('synthetic-config'), requestedModel: null, confirmedModel: null, requestedEffort: null, confirmedEffort: null, authAssembly: 'none', bootstrapContract: 'local-os/1', audience: 'local-test' };
    const signed = runLocalCapabilityController({ descriptor, fixtureRoot: f.root, scratchDir: f.scratch, sentinelFile: f.sentinelFile, controllerId: 'local-controller', key: privateKey });
    const supplier = createLocalDescriptorIsolationPreparer({ descriptor: () => descriptor, capabilityStore: capabilities, baselineStoreDir: join(f.privateRoot, 'baselines'), envBase: { PATH: '/usr/bin:/bin' } });
    f.runtime.isolationPreparer = supplier;
    const echo: CliAdapter = { id: 'claude', command: binary, displayName: 'synthetic OS fixture', appTools: [], buildArgs: () => ['-e', `require('node:fs').writeFileSync('src/implemented.ts','// synthetic implementation');console.log(JSON.stringify({type:'result',answer:'done'}))`], buildResumeArgs: () => [], parseEvents: line => { const value = JSON.parse(line); return [{ type: 'result', answer: value.answer }]; } };
    let launches = 0;
    const run: typeof runCli = opts => { assert.match(opts.prompt, /Approved synthetic feature/); launches++; return runCli({ ...opts, adapter: echo }); };
    // Same real card entry, no constant-passed capability reader.
    const handler = createCardActionHandler({ runtime: f.runtime, config: f.config, defaultProductDeliveryMode: 'local', startCoding: opts => startCoding({ ...opts, background: false, run, plan }) });
    const blocked = await handler(f.action);
    assert.equal(blocked?.toast?.type, 'error');
    assert.equal(f.runtime.codingHandoffs!.get(f.authorization.id)?.state, 'issued');
    capabilities.register(signed.attestation, signed.raw, () => descriptor, 0);
    assert.equal(capabilities.lookup(descriptorCapabilityKey(descriptor))?.read, 'passed');
    const response = await handler(f.action);
    assert.equal(response?.toast?.type, 'success', JSON.stringify(response));
    assert.equal(readFileSync(join(f.dev, 'src/implemented.ts'), 'utf8'), '// synthetic implementation');
    assert.equal(f.runtime.codingHandoffs!.get(f.authorization.id)?.state, 'terminal');
    const before = launches;
    await handler(f.action);
    assert.equal(launches, before);
    f.runtime.codingHandoffs = new CodingIntentHandoffStore(join(f.root, 'handoffs.json'));
    await handler(f.action);
    assert.equal(launches, before);
    const input: IsolationPrepareInput = { taskId: 'bad-scope', purpose: 'task', command: binary, cwd: f.dev, cliMode: 'resume' };
    await assert.rejects(supplier(input), /scope changed/);
    capabilities.revoke(descriptorCapabilityKey(descriptor), 1);
    await assert.rejects(supplier({ ...input, cliMode: 'fresh', authorizationId: f.authorization.id, allowedRelatives: ['src'] }), /证据|capability/);
});
test('A02 actual message handler uses registered identity and refuses revoked evidence before spawning', { skip: process.env.AO_DIRECT_OS !== '1', timeout: 30000 }, async (t) => {
    const f = await fixture(t), { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const binary = realpathSync(process.execPath);
    const descriptor: ExecutionDescriptor = { schema: 'execution-descriptor/1', command: binary, protectedRootsVersion: 'local-message-v1', binary, binaryDigest: rawHash(readFileSync(binary)), payloadDigests: {}, cliMode: 'fresh', purpose: 'task', roots: [f.privateRoot], template: 'seatbelt/2', writePolicy: 'none', platform: process.platform, osVersion: release(), sandboxBinary: '/usr/bin/sandbox-exec', sandboxDigest: rawHash(readFileSync('/usr/bin/sandbox-exec')), configFingerprint: rawHash('synthetic-message-config'), requestedModel: null, confirmedModel: null, requestedEffort: null, confirmedEffort: null, authAssembly: 'none', bootstrapContract: 'local-os/1', audience: 'local-test' };
    const signed = runLocalCapabilityController({ descriptor, fixtureRoot: f.root, scratchDir: f.scratch, sentinelFile: f.sentinelFile, controllerId: 'message-controller', key: privateKey });
    const capabilities = new CapabilityRegistrar(join(f.privateRoot, 'message-capabilities.json'), () => new Map([['message-controller', publicKey]]), 'local-test');
    const base = createLocalDescriptorIsolationPreparer({ descriptor: () => descriptor, capabilityStore: capabilities, baselineStoreDir: join(f.privateRoot, 'baselines'), envBase: { PATH: '/usr/bin:/bin' } });
    let preparedCount = 0;
    f.runtime.isolationPreparer = async (input) => { assert.equal(input.authorizationId, undefined); assert.equal(input.allowedRelatives, undefined); const prepared = await base(input); preparedCount++; return prepared; };
    const echo: CliAdapter = { id: 'claude', command: binary, displayName: 'message fixture', appTools: [], buildArgs: () => ['-e', `console.log(JSON.stringify({type:'result',answer:'synthetic message done'}))`], buildResumeArgs: () => [], parseEvents: line => [{ type: 'result', answer: JSON.parse(line).answer }] };
    const bot = { reply: async () => 'text', replyCard: async () => 'card', replyMention: async () => 'notice', updateCard: async () => { } } as unknown as Bot;
    const handler = createMessageHandler({ runtime: f.runtime, config: f.config, defaultProductDeliveryMode: 'local', collaborationService: new CollaborationService(f.runtime), planModel: plan,
        execute: (_adapter, prompt, cwd, nativeSession, signal, onEvent, attachments, modelSelection, isolation, taskId) => executeCli(echo, prompt, cwd, nativeSession, signal, onEvent, attachments, modelSelection, isolation, taskId) });
    const message: IncomingMessage = { messageId: 'fixture-message-1', chatId: 'd', chatType: 'group', threadId: 'd', rootId: 'd', messageType: 'text', text: '检查合成业务资料', rawContent: '{"text":"检查合成业务资料"}', mentions: [], senderType: 'user', senderOpenId: 'owner', senderUnionId: 'owner-union' };
    const send = async (id: string) => {
        await handler({ ...message, messageId: id }, bot);
        const deadline = Date.now() + 10000;
        while (f.runtime.activeRuns.size && Date.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(f.runtime.activeRuns.size, 0, 'handler must finish and release execution');
        return executionStore(f.runtime).forSession(f.session.id);
    };
    assert.equal((await send('fixture-message-1'))?.status, 'failed');
    assert.equal(preparedCount, 0);
    capabilities.register(signed.attestation, signed.raw, () => descriptor, 0);
    assert.equal((await send('fixture-message-2'))?.status, 'completed');
    assert.equal(preparedCount, 1);
    capabilities.revoke(descriptorCapabilityKey(descriptor), 1);
    assert.equal((await send('fixture-message-3'))?.status, 'failed');
    assert.equal(preparedCount, 1);
});
