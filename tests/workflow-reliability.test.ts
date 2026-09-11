import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../src/core/session-manager.js';
import { TeamRegistry } from '../src/core/team-registry.js';
import { ClarificationFlowStore, isClarificationOwner } from '../src/core/clarification.js';
import { ProductSpecFlowStore, ProductSpecRequestSchema } from '../src/core/product-spec.js';
import { JsonProductSpecFlowStore } from '../src/core/product-spec-store.js';
import { CollaborationInbox, type CollaborationMessage } from '../src/core/collaboration.js';
import { requestTaskAbort } from '../src/core/task-abort.js';
import { createCardActionHandler } from '../src/app/card-action-handler.js';
import { CollaborationService } from '../src/app/collaboration-service.js';
import { continueClarificationFlow } from '../src/app/clarification-runner.js';
import { runProductDocumentComment } from '../src/app/product-comment-runner.js';
import { ProductCommentScheduler } from '../src/app/product-comment-scheduler.js';
import { ensureProductSpecSubmission } from '../src/app/product-spec-submission.js';
import { subscribeDocumentComments } from '../src/app/document-subscription.js';
import { normalizeProductDocument } from '../src/app/product-document-url.js';
import { assertProductSpecDocuments } from '../src/app/product-spec-documents.js';
import { splitLongText, buildProductSpecApprovalCard, buildProductSpecApprovedCard } from '../src/im/card.js';
import { fitFeishuText, FEISHU_TEXT_LIMIT, type Bot, type CardAction, type IncomingDocumentComment } from '../src/im/lark.js';
import { resolveWindowsInvocation } from '../src/cli/spawn-cli.js';
import { parseAgentOsConfig, type BotConfig } from '../src/core/bot-registry.js';
import type { AppRuntime } from '../src/app/runtime.js';

const request = { title: '方案', summary: '说明', deliveryMode: 'lark-doc' as const, documentUrl: 'https://team.feishu.cn/docx/abc' };
const origin = { taskId: 'task', fromBotId: 'leader', reportToBotId: 'leader', round: 1, maxRounds: 16 };
const questions = { title: '范围', intro: '', questions: [
  { id: 'q1', prompt: '范围？', options: [{ id: 'a', label: '小' }, { id: 'b', label: '大' }] },
  { id: 'q2', prompt: '颜色？', options: [{ id: 'a', label: '蓝' }, { id: 'b', label: '绿' }] },
] };
const comment: IncomingDocumentComment = { eventId: 'event', fileToken: 'abc', fileType: 'docx', commentId: 'comment', replyId: 'reply', senderOpenId: 'product-owner', senderUnionId: 'union-owner', mentionedBot: true };
function temp(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-regression-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function fixture() {
  const config: BotConfig = { id: 'product', appId: 'app', appSecret: 'test', defaultCliId: 'claude', workspaceDir: '/tmp', role: '产品', skills: ['grill-me', 'lark-doc'], systemPrompt: '', collaborationMaxRounds: 16 };
  const leader: BotConfig = { ...config, id: 'leader', skills: [] };
  const bot = { reply: async () => 'text', replyCard: async () => 'card', replyMention: async () => 'notice', updateCard: async () => {}, replyToDocumentComment: async () => {}, setDocumentCommentWorking: async () => {}, subscribeToDocumentComments: async () => {} } as unknown as Bot;
  const sessions = new SessionManager();
  const { session } = await sessions.resolve({ chatId: 'chat', threadId: 'thread', rootId: 'root', messageId: 'msg' }, 'claude', config.id, '/tmp');
  await sessions.transition(session.id, 'idle');
  await sessions.setCliSessionId(session.id, 'cli-session');
  const runtime: AppRuntime = { sessions, teamRegistry: new TeamRegistry('leader', [leader, config]), activeRuns: new Map(), contextWindows: new Map(), botRuntimes: new Map(), processedCollaborationTurns: new Set(), collaborationInbox: new CollaborationInbox(), clarificationFlows: new ClarificationFlowStore(), productSpecFlows: new ProductSpecFlowStore() };
  for (const cfg of [config, leader]) runtime.botRuntimes.set(cfg.id, { config: cfg, bot, identity: { openId: `bot-${cfg.id}`, name: cfg.id } });
  const createFlow = (collaboration = true) => runtime.productSpecFlows.create({ taskId: 'task', botId: config.id, sessionId: session.id, ownerOpenId: 'leader-owner', ownerUnionId: 'union-owner', ownerBotId: 'leader', request, ...(collaboration ? { collaboration: origin } : {}) });
  const handler = () => createCardActionHandler({ runtime, config, defaultProductDeliveryMode: 'lark-doc' });
  const action = (token: string): CardAction => ({ messageId: 'approval-card', operatorOpenId: 'product-owner', operatorUnionId: 'union-owner', formValue: {}, value: { action: 'approve_product_spec', flowToken: token } });
  return { runtime, bot, config, session, createFlow, handler, action };
}

test('approval of a leader-dispatched proposal ends the flow: recorded, durable, never dispatched', async (t) => {
  const f = await fixture(); const dir = temp(t);
  const specPath = join(dir, 'specs.json'), inboxPath = join(dir, 'inbox.json');
  f.runtime.productSpecFlows = new JsonProductSpecFlowStore(specPath);
  f.runtime.collaborationInbox = new CollaborationInbox(inboxPath);
  const flow = f.createFlow(); let notices = 0, cards = 0;
  f.bot.replyCard = async () => { cards++; return 'card'; };
  f.bot.replyMention = async () => { notices++; return 'notice'; };
  const first = await f.handler()(f.action(flow.token));
  assert.equal(first?.toast?.type, 'success');
  assert.match(JSON.stringify(first?.card), /没有自动派发/);
  const approved = f.runtime.productSpecFlows.get(flow.token)!;
  assert.equal(approved.status, 'approved'); assert.equal(approved.approvalMessageId, 'approval-card'); assert.ok(approved.approvedAt);
  f.runtime.productSpecFlows = new JsonProductSpecFlowStore(specPath);
  f.runtime.collaborationInbox = new CollaborationInbox(inboxPath);
  assert.equal(f.runtime.productSpecFlows.get(flow.token)?.status, 'approved');
  const again = await f.handler()(f.action(flow.token));
  assert.equal(again?.toast?.type, 'info'); assert.equal(f.runtime.productSpecFlows.get(flow.token)?.approvedAt, approved.approvedAt);
  assert.equal(notices, 0); assert.equal(cards, 0);
  assert.equal(f.runtime.collaborationInbox.pending().length, 0);
});

test('concurrent confirmation clicks approve exactly once', async () => {
  const f = await fixture(); const flow = f.createFlow();
  const handler = f.handler();
  const results = await Promise.all([handler(f.action(flow.token)), handler(f.action(flow.token)), handler(f.action(flow.token))]);
  const types = results.map((result) => result?.toast?.type).sort();
  assert.equal(types.filter((type) => type === 'success').length, 1);
  assert.ok(types.every((type) => type === 'success' || type === 'warning' || type === 'info'));
  assert.equal(f.runtime.productSpecFlows.get(flow.token)?.status, 'approved');
});

test('approval rejects other users and queued comments block confirmation until drained', async () => {
  const f = await fixture(); const flow = f.createFlow(); let edits = 0;
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = new ProductCommentScheduler(f.runtime, async () => { edits++; await gate; });
  scheduler.schedule(f.config, f.bot, { ...comment, senderUnionId: 'other', senderOpenId: 'other' });
  scheduler.schedule(f.config, f.bot, comment);
  scheduler.schedule(f.config, f.bot, { ...comment, eventId: 'event2' });
  const handler = f.handler();
  assert.equal((await handler({ ...f.action(flow.token), operatorUnionId: 'other' }))?.toast?.type, 'warning');
  assert.equal((await handler(f.action(flow.token)))?.toast?.type, 'warning');
  assert.equal(f.runtime.productSpecFlows.get(flow.token)?.status, 'pending');
  release(); await scheduler.drain(); assert.equal(edits, 2);
  assert.equal((await handler(f.action(flow.token)))?.toast?.type, 'success');
  scheduler.schedule(f.config, f.bot, { ...comment, eventId: 'after-approval' });
  await scheduler.drain(); assert.equal(edits, 2);
});

test('queued comments recheck expired proposal and failed comments can be retried', async () => {
  const f = await fixture(); f.createFlow(); let edits = 0;
  const scheduler = new ProductCommentScheduler(f.runtime, async () => { edits++; if (edits === 1) throw new Error('retryable'); });
  scheduler.schedule(f.config, f.bot, comment); await scheduler.drain();
  scheduler.schedule(f.config, f.bot, comment); await scheduler.drain(); assert.equal(edits, 2);
  scheduler.schedule(f.config, f.bot, { ...comment, eventId: 'stale' });
  f.createFlow(); await scheduler.drain(); assert.equal(edits, 2);
});

test('comment runner checks ownership and approval before invoking CLI', async () => {
  const f = await fixture(); const flow = f.createFlow(); let calls = 0;
  const execute = async () => { calls++; return { answer: 'updated' }; };
  await assert.rejects(runProductDocumentComment({ runtime: f.runtime, bot: f.bot, flow, comment: { ...comment, senderUnionId: 'other' }, execute }), /发起人/);
  f.runtime.productSpecFlows.approve(flow.token);
  await assert.rejects(runProductDocumentComment({ runtime: f.runtime, bot: f.bot, flow, comment, execute }), /已确认/);
  assert.equal(calls, 0);
});

for (const missingId of [false, true]) test(`clarification card ${missingId ? 'missing ID' : 'failure'} releases session and preserves answers`, async () => {
  const f = await fixture(); const flow = f.runtime.clarificationFlows.create({ taskId: 'task', botId: 'product', sessionId: f.session.id, ownerOpenId: 'leader-owner', ownerUnionId: 'union-owner', ownerBotId: 'leader', request: questions, originalMessageId: 'msg', replyInThread: true });
  f.runtime.clarificationFlows.answerWithRecommendation(flow.token, true);
  await f.runtime.sessions.transition(f.session.id, 'active'); const run = new AbortController();
  f.runtime.activeRuns.set(f.session.id, { controller: run, ownerOpenId: flow.ownerOpenId });
  f.bot.replyCard = async () => { if (missingId) return undefined; throw new Error('card unavailable'); };
  let executions = 0;
  await assert.rejects(continueClarificationFlow({ runtime: f.runtime, bot: f.bot, config: f.config, flow, run, defaultDeliveryMode: 'lark-doc', execute: async () => { executions++; return { answer: '' }; } }));
  assert.equal(f.runtime.sessions.get(f.session.id)?.status, 'idle'); assert.equal(f.runtime.activeRuns.size, 0); assert.equal(executions, 0);
  assert.equal(f.runtime.clarificationFlows.get(flow.token)?.answers.length, 2);
});

test('completed clarification survives restart and can be retried without losing selected answers', async (t) => {
  const file = join(temp(t), 'clarifications.json'); let store = new ClarificationFlowStore(file);
  const flow = store.create({ taskId: 'task', botId: 'product', sessionId: 's', ownerOpenId: 'owner', request: questions, originalMessageId: 'msg', replyInThread: true, collaboration: origin });
  store.answer(flow.token, 'q1', '大'); store = new ClarificationFlowStore(file);
  assert.equal(store.get(flow.token)?.answers[0].answer, '大');
  store.answer(flow.token, 'q2', '绿'); store = new ClarificationFlowStore(file);
  assert.equal(store.get(flow.token)?.currentIndex, 2); assert.deepEqual(store.get(flow.token)?.collaboration, origin);
});

test('card handler rejects a different union ID and stops the true owner across applications', async () => {
  const f = await fixture(); const run = new AbortController();
  f.runtime.activeRuns.set(f.session.id, { controller: run, ownerOpenId: 'leader-owner', ownerUnionId: 'union-owner', ownerBotId: 'leader' });
  const handler = f.handler(); const action = { ...f.action('unused'), value: { action: 'abort_task', sessionId: f.session.id } };
  assert.equal((await handler({ ...action, operatorUnionId: 'other' }))?.toast?.type, 'warning'); assert.equal(run.signal.aborted, false);
  assert.equal((await handler(action))?.toast?.type, 'success'); assert.equal(run.signal.aborted, true);
});

test('missing union ID never falls back to a cross-application Open ID; text and cards share ownership', () => {
  const owner = { ownerOpenId: 'same-string', ownerBotId: 'leader' };
  assert.equal(isClarificationOwner(owner, { operatorOpenId: 'same-string', operatorBotId: 'product' }), false);
  assert.equal(isClarificationOwner(owner, { operatorOpenId: 'same-string', operatorBotId: 'leader' }), true);
  assert.equal(requestTaskAbort(new Map([['s', { ...owner, controller: new AbortController() }]]), 's', 'same-string', undefined, 'product'), 'forbidden');
});

test('ordinary product reply does not retry, submit or expire an existing proposal', async () => {
  const f = await fixture(); const flow = f.createFlow();
  const result = await ensureProductSpecSubmission({ result: { answer: '你好，方案仍在等你确认。' } });
  assert.equal(result.request, undefined); assert.equal(flow.status, 'pending');
});

test('subscription failure degrades comments without rejecting startup', async () => {
  const f = await fixture(); f.bot.subscribeToDocumentComments = async () => { throw new Error('missing scope'); };
  const results = await Promise.all([subscribeDocumentComments(f.bot, 'product'), Promise.resolve('leader ready')]);
  assert.deepEqual(results, [false, 'leader ready']);
});

test('confirmation never dispatches, whether the proposal came from the leader or from the user directly', async () => {
  for (const viaLeader of [false, true]) {
    const f = await fixture(); const flow = f.createFlow(viaLeader); let dispatched = 0;
    f.bot.replyMention = async () => { dispatched++; return 'notice'; };
    f.bot.replyCard = async () => { dispatched++; return 'card'; };
    assert.match(JSON.stringify(buildProductSpecApprovalCard(flow)), /不会自动派发.*@ 开发/);
    await f.handler()(f.action(flow.token)); assert.equal(dispatched, 0);
    assert.match(JSON.stringify(buildProductSpecApprovedCard(flow)), /没有自动派发.*@ 开发/);
  }
});

test('URL validation rejects fake hosts and accepts real Wiki; Wiki resolves to Docx token', async () => {
  for (const documentUrl of ['https://example.com/docx/abc', 'http://team.feishu.cn/docx/abc', 'https://team.feishu.cn.evil.test/docx/abc', 'https://user:password@team.feishu.cn/docx/abc', 'https://team.feishu.cn/path/docx/abc']) {
    assert.equal(ProductSpecRequestSchema.safeParse({ ...request, documentUrl }).success, false);
  }
  const wiki = { ...request, documentUrl: 'https://team.feishu.cn/wiki/wikiToken' };
  assert.equal(ProductSpecRequestSchema.safeParse(wiki).success, true);
  const bot = { client: { wiki: { v2: { space: { getNode: async () => ({ code: 0, data: { node: { obj_type: 'docx', obj_token: 'resolved' } } }) } } } } } as unknown as Bot;
  assert.deepEqual(await normalizeProductDocument(bot, wiki), { ...request, documentUrl: 'https://team.feishu.cn/docx/resolved' });
});

test('Windows absolute paths, traversal and workspace symlink escape are rejected', async (t) => {
  const dir = temp(t); const workspace = join(dir, 'workspace'); mkdirSync(workspace); mkdirSync(join(workspace, 'issues')); writeFileSync(join(workspace, 'issues', 'one.md'), 'ticket');
  const local = { title: '方案', summary: '说明', deliveryMode: 'local' as const, specPath: 'spec.md', ticketsPath: 'issues' };
  for (const specPath of ['C:\\outside\\spec.md', '\\\\server\\share\\spec.md', 'C:spec.md', '../spec.md', '/tmp/spec.md']) assert.equal(ProductSpecRequestSchema.safeParse({ ...local, specPath }).success, false);
  writeFileSync(join(dir, 'outside.md'), 'outside'); symlinkSync(join(dir, 'outside.md'), join(workspace, 'spec.md'));
  await assert.rejects(assertProductSpecDocuments(workspace, local), /尚未完整/);
  rmSync(join(workspace, 'spec.md')); writeFileSync(join(workspace, 'spec.md'), 'spec'); await assertProductSpecDocuments(workspace, local);
});

test('long Chinese, emoji and whitespace text round trips through segmentation and transport limit', () => {
  const text = '中😀 文\n'.repeat(3000); const chunks = splitLongText(text);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= FEISHU_TEXT_LIMIT));
  assert.equal(chunks.map((chunk) => fitFeishuText(chunk, FEISHU_TEXT_LIMIT)).join(''), text);
  assert.throws(() => splitLongText('x', 0));
});

test('durable collaboration inbox recovers unconsumed dispatches and retains bounded dedup across restarts', async (t) => {
  const dir = temp(t); const file = join(dir, 'inbox.json'); let inbox = new CollaborationInbox(file);
  const message: CollaborationMessage = { ...origin, dispatchId: '012345abcdef', ownerOpenId: 'owner', toBotId: 'product', objective: 'spec', instruction: 'write', workspaceDir: dir, replyToMessageId: 'msg' };
  inbox.register(message); inbox = new CollaborationInbox(file); assert.equal(inbox.pending().length, 1);
  assert.equal(inbox.peek(message.dispatchId, 'product')?.objective, 'spec'); assert.equal(inbox.pending().length, 1);
  inbox.consume(message.dispatchId, 'product'); inbox = new CollaborationInbox(file); inbox.register(message);
  assert.equal(inbox.pending().length, 0); assert.equal(inbox.consume(message.dispatchId, 'product'), undefined);
});

test('failed durable writes roll back approval and answers', async (t) => {
  const dir = temp(t); const file = join(dir, 'specs.json'); const store = new JsonProductSpecFlowStore(file);
  const flow = store.create({ taskId: 'task', botId: 'product', sessionId: 's', ownerOpenId: 'owner', request });
  mkdirSync(`${file}.tmp`); assert.throws(() => store.approve(flow.token, 'card')); assert.equal(store.get(flow.token)?.status, 'pending');
  const answersFile = join(dir, 'answers.json'); const answers = new ClarificationFlowStore(answersFile);
  const q = answers.create({ taskId: 't', botId: 'p', sessionId: 's', ownerOpenId: 'owner', request: questions, originalMessageId: 'm', replyInThread: true });
  mkdirSync(`${answersFile}.tmp`); assert.throws(() => answers.answer(q.token, 'q1', '大')); assert.equal(answers.get(q.token)?.currentIndex, 0);
});

test('Windows npm shims preserve JSON, spaces and metacharacters without shell parsing', (t) => {
  const dir = temp(t); const entry = join(dir, 'node_modules', 'tool', 'cli.js'); mkdirSync(join(dir, 'node_modules', 'tool'), { recursive: true }); writeFileSync(entry, '');
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\necho POSIX shim');
  writeFileSync(join(dir, 'claude.cmd'), '@ECHO off\n"%_prog%" "%dp0%\\node_modules\\tool\\cli.js" %*\n');
  const args = ['--mcp-config', '{"command":"C:\\\\有 空格\\\\node.exe","args":["x&y","%PATH%"]}'];
  const invocation = resolveWindowsInvocation('claude', args, dir);
  assert.equal(invocation.command, process.execPath); assert.deepEqual(invocation.args, [entry, ...args]);
  writeFileSync(join(dir, 'custom.cmd'), 'echo arbitrary'); assert.throws(() => resolveWindowsInvocation('custom', [], dir), /不支持/);
});

test('full clarification callback failure offers a working retry and releases the session', async () => {
  const f = await fixture(); const cards: unknown[] = []; let attempts = 0;
  const flow = f.runtime.clarificationFlows.create({ taskId: 'task', botId: 'product', sessionId: f.session.id, ownerOpenId: 'leader-owner', ownerUnionId: 'union-owner', ownerBotId: 'leader', request: { ...questions, questions: [questions.questions[0]] }, originalMessageId: 'msg', cardMessageId: 'clarify-card', replyInThread: true });
  f.bot.updateCard = async (_id, card) => { cards.push(card); };
  f.bot.replyCard = async () => { attempts++; if (attempts === 1) throw new Error('first card failed'); return 'progress-card'; };
  let resolveRun!: () => void; let completion = new Promise<void>((resolve) => { resolveRun = resolve; });
  const handler = createCardActionHandler({ runtime: f.runtime, config: f.config, defaultProductDeliveryMode: 'lark-doc', continueFlow: async (options) => {
    try { await continueClarificationFlow({ ...options, execute: async () => ({ answer: '普通说明，未生成新方案' }) }); }
    finally { resolveRun(); }
  } });
  const action = { ...f.action(flow.token), value: { action: 'answer_clarification', flowToken: flow.token, questionId: 'q1', optionId: 'b' } };
  await handler(action); await completion; await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.runtime.sessions.get(f.session.id)?.status, 'idle');
  assert.equal(f.runtime.clarificationFlows.get(flow.token)?.answers[0].answer, '大');
  assert.ok(cards.some((card) => JSON.stringify(card).includes('重新整理')));
  completion = new Promise<void>((resolve) => { resolveRun = resolve; });
  await handler({ ...action, value: { ...action.value, decisionMode: 'remaining' } }); await completion;
  assert.equal(f.runtime.sessions.get(f.session.id)?.status, 'idle');
  assert.equal(f.runtime.activeRuns.size, 0); assert.equal(f.runtime.clarificationFlows.get(flow.token), undefined);
});

test('CLI failure and result-card failure also release clarification active run', async () => {
  for (const failCard of [false, true]) {
    const f = await fixture(); const flow = f.runtime.clarificationFlows.create({ taskId: 'task', botId: 'product', sessionId: f.session.id, ownerOpenId: 'owner', request: questions, originalMessageId: 'msg', replyInThread: true });
    await f.runtime.sessions.transition(f.session.id, 'active'); const run = new AbortController();
    f.runtime.activeRuns.set(f.session.id, { controller: run, ownerOpenId: 'owner' });
    if (failCard) f.bot.updateCard = async () => { throw new Error('result card failed'); };
    await assert.rejects(continueClarificationFlow({ runtime: f.runtime, bot: f.bot, config: f.config, flow, run, defaultDeliveryMode: 'lark-doc', execute: async () => { if (!failCard) throw new Error('CLI failed'); return { answer: 'ordinary' }; } }));
    assert.equal(f.runtime.sessions.get(f.session.id)?.status, 'idle'); assert.equal(f.runtime.activeRuns.size, 0);
    assert.ok(f.runtime.clarificationFlows.get(flow.token));
  }
});

test('product activity blocks confirmation even when it is not a document comment', async () => {
  const f = await fixture(); const flow = f.createFlow(); await f.runtime.sessions.transition(f.session.id, 'active');
  assert.equal((await f.handler()(f.action(flow.token)))?.toast?.type, 'warning'); assert.equal(flow.status, 'pending');
});

test('recovery retries an offline recipient without losing its original dispatch ID', async () => {
  const f = await fixture(); const service = new CollaborationService(f.runtime); const leader = f.runtime.botRuntimes.get('leader')!;
  f.runtime.botRuntimes.delete('leader');
  await assert.rejects(service.dispatch({ dispatchId: 'aabbccddeeff', senderConfig: f.config, senderBot: f.bot, replyToMessageId: 'm', targetBotId: 'leader', taskId: 't', ownerOpenId: 'owner', reportToBotId: 'leader', objective: 'task', instruction: 'do', round: 1, maxRounds: 2, workspaceDir: '/tmp' }), /尚未就绪/);
  assert.equal(f.runtime.collaborationInbox.pending().length, 1);
  f.runtime.botRuntimes.set('leader', leader); let notices = 0;
  f.bot.replyMention = async (_id, _target, text) => { notices++; assert.match(text, /aabbccddeeff/); f.runtime.collaborationInbox.consume('aabbccddeeff', 'leader'); return 'notice'; };
  await service.recover(); await service.recover(); assert.equal(notices, 1); assert.equal(f.runtime.collaborationInbox.pending().length, 0);
});

test('finished proposal history is bounded without dropping proposals still awaiting confirmation', () => {
  const store = new ProductSpecFlowStore();
  const awaiting = store.create({ taskId: 'awaiting', botId: 'product', sessionId: 's', ownerOpenId: 'owner', request, collaboration: origin });
  const first = store.create({ taskId: 'rolling', botId: 'product', sessionId: 's', ownerOpenId: 'owner', request }); store.approve(first.token);
  for (let index = 0; index < 1005; index++) {
    const flow = store.create({ taskId: 'rolling', botId: 'product', sessionId: 's', ownerOpenId: 'owner', request }); store.approve(flow.token);
  }
  assert.equal(store.get(first.token), undefined);
  assert.equal(store.get(awaiting.token)?.status, 'pending');
});

