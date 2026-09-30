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
import { computeLocalArtifactDigest } from '../src/core/artifact-digest.js';
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
import { type BotConfig } from '../src/core/bot-registry.js';
import type { AppRuntime } from '../src/app/runtime.js';

const request = { title: '方案', summary: '说明', deliveryMode: 'lark-doc' as const, documentUrl: 'https://team.feishu.cn/docx/abc' };
const localRequest = { title: '方案', summary: '说明', deliveryMode: 'local' as const, specPath: 'spec.md', ticketsPath: 'tickets' };
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
// fixture 自身的会话工作区：本地模式方案的制品文件必须落在会话工作区里，
// G1 才能回读重算摘要。多数用例没有 test 上下文，统一登记到进程退出清理。
const workspaces: string[] = [];
process.on('exit', () => { for (const dir of workspaces) rmSync(dir, { recursive: true, force: true }); });
async function fixture() {
  const workspaceDir = mkdtempSync(join(tmpdir(), 'agent-os-workspace-'));
  workspaces.push(workspaceDir);
  const config: BotConfig = { id: 'product', appId: 'app', appSecret: 'test', defaultCliId: 'claude', modelOverrides: {}, workspaceDir, role: '产品', skills: ['grill-me', 'lark-doc'], systemPrompt: '', collaborationMaxRounds: 16 };
  const leader: BotConfig = { ...config, id: 'leader', skills: [] };
  const bot = { reply: async () => 'text', replyCard: async () => 'card', replyMention: async () => 'notice', updateCard: async () => {}, replyToDocumentComment: async () => {}, setDocumentCommentWorking: async () => {}, subscribeToDocumentComments: async () => {} } as unknown as Bot;
  const sessions = new SessionManager();
  const { session } = await sessions.resolve({ chatId: 'chat', threadId: 'thread', rootId: 'root', messageId: 'msg' }, 'claude', config.id, workspaceDir);
  await sessions.transition(session.id, 'idle');
  await sessions.setCliSessionId(session.id, 'cli-session');
  const runtime: AppRuntime = { sessions, teamRegistry: new TeamRegistry('leader', [leader, config]), activeRuns: new Map(), contextWindows: new Map(), botRuntimes: new Map(), processedCollaborationTurns: new Set(),
  sessionScratches: new Map(), collaborationInbox: new CollaborationInbox(), clarificationFlows: new ClarificationFlowStore(), productSpecFlows: new ProductSpecFlowStore() };
  for (const cfg of [config, leader]) runtime.botRuntimes.set(cfg.id, { config: cfg, bot, identity: { openId: `bot-${cfg.id}`, name: cfg.id } });
  const createFlow = (collaboration = true) => runtime.productSpecFlows.create({ taskId: 'task', botId: config.id, sessionId: session.id, ownerOpenId: 'leader-owner', ownerUnionId: 'union-owner', ownerBotId: 'leader', request, ...(collaboration ? { collaboration: origin } : {}) });
  // 本地模式 flow：真实制品文件 + 提交时绑定的完整摘要（G1 审批路径用）。
  const createLocalFlow = async (collaboration = true) => {
    writeFileSync(join(workspaceDir, 'spec.md'), '# 方案\n\n本地交付。\n');
    mkdirSync(join(workspaceDir, 'tickets'), { recursive: true });
    writeFileSync(join(workspaceDir, 'tickets', 't1.md'), '## 需求 1\n\n下单展示会员价。');
    const digest = await computeLocalArtifactDigest(workspaceDir, localRequest);
    return runtime.productSpecFlows.create({ taskId: 'task', botId: config.id, sessionId: session.id, ownerOpenId: 'leader-owner', ownerUnionId: 'union-owner', ownerBotId: 'leader', request: localRequest, content_digest: digest.digest, digest_algorithm: 'canonical-sha256-v1', content_sources: digest.content_sources, ...(collaboration ? { collaboration: origin } : {}) });
  };
  const handler = () => createCardActionHandler({ runtime, config, defaultProductDeliveryMode: 'lark-doc' });
  const action = (token: string): CardAction => ({ messageId: 'approval-card', operatorOpenId: 'product-owner', operatorUnionId: 'union-owner', formValue: {}, value: { action: 'approve_product_spec', flowToken: token } });
  return { runtime, bot, config, session, workspaceDir, createFlow, createLocalFlow, handler, action };
}

test('approval of a leader-dispatched proposal ends the flow: recorded, durable, never dispatched', async (t) => {
  const f = await fixture(); const dir = temp(t);
  const specPath = join(dir, 'specs.json'), inboxPath = join(dir, 'inbox.json');
  f.runtime.productSpecFlows = new JsonProductSpecFlowStore(specPath);
  f.runtime.collaborationInbox = new CollaborationInbox(inboxPath);
  const flow = await f.createLocalFlow(); let notices = 0, cards = 0;
  f.bot.replyCard = async () => { cards++; return 'card'; };
  f.bot.replyMention = async () => { notices++; return 'notice'; };
  const first = await f.handler()(f.action(flow.token));
  assert.equal(first?.toast?.type, 'success');
  assert.match(JSON.stringify(first?.card), /没有自动派发/);
  const approved = f.runtime.productSpecFlows.get(flow.token)!;
  assert.equal(approved.status, 'approved'); assert.equal(approved.approvalMessageId, 'approval-card'); assert.ok(approved.approvedAt);
  assert.equal(approved.content_digest, flow.content_digest);
  f.runtime.productSpecFlows = new JsonProductSpecFlowStore(specPath);
  f.runtime.collaborationInbox = new CollaborationInbox(inboxPath);
  assert.equal(f.runtime.productSpecFlows.get(flow.token)?.status, 'approved');
  const again = await f.handler()(f.action(flow.token));
  assert.equal(again?.toast?.type, 'info'); assert.equal(f.runtime.productSpecFlows.get(flow.token)?.approvedAt, approved.approvedAt);
  assert.equal(notices, 0); assert.equal(cards, 0);
  assert.equal(f.runtime.collaborationInbox.pending().length, 0);
});

test('concurrent confirmation clicks approve exactly once', async () => {
  const f = await fixture(); const flow = await f.createLocalFlow();
  const handler = f.handler();
  const results = await Promise.all([handler(f.action(flow.token)), handler(f.action(flow.token)), handler(f.action(flow.token))]);
  const types = results.map((result) => result?.toast?.type).sort();
  assert.equal(types.filter((type) => type === 'success').length, 1);
  assert.ok(types.every((type) => type === 'success' || type === 'warning' || type === 'info'));
  assert.equal(f.runtime.productSpecFlows.get(flow.token)?.status, 'approved');
});

test('G1 blocks approval when local artifact files drift after submission', async () => {
  const f = await fixture(); const flow = await f.createLocalFlow();
  writeFileSync(join(f.workspaceDir, 'tickets', 't2.md'), '## 需求 2\n\n提交后被外部修改。');
  const gate = await f.handler()(f.action(flow.token));
  assert.equal(gate?.toast?.type, 'warning');
  assert.match(gate?.toast?.content ?? '', /发生了变化/);
  assert.equal(f.runtime.productSpecFlows.get(flow.token)?.status, 'pending');
});

test('approval rejects other users, queued comments block confirmation, lark approval stays blocked (U-3)', async () => {
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
  // 评论队列排空后审批互斥解除；但飞书完整回读能力未核验（U-3），
  // G1 对 lark 交付保持 blocked——确认被拒、状态保持 pending。
  const blocked = await handler(f.action(flow.token));
  assert.equal(blocked?.toast?.type, 'error');
  assert.match(blocked?.toast?.content ?? '', /blocked/);
  assert.equal(f.runtime.productSpecFlows.get(flow.token)?.status, 'pending');
  // 方案仍是 pending：新的评论修订继续被调度处理（原“审批后拒绝评论”
  // 行为仅在 approved 状态成立）。
  scheduler.schedule(f.config, f.bot, { ...comment, eventId: 'after-approval' });
  await scheduler.drain(); assert.equal(edits, 3);
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
    assert.match(JSON.stringify(buildProductSpecApprovalCard(flow)), /不会自动派发.*授权开发/);
    await f.handler()(f.action(flow.token)); assert.equal(dispatched, 0);
    // 84 号 P2：已确认卡指引显式授权入口（不再是“@ 开发”自由文本）。
    assert.match(JSON.stringify(buildProductSpecApprovedCard(flow)), /没有自动派发.*授权开发/);
    assert.ok(!JSON.stringify(buildProductSpecApprovedCard(flow)).includes('请 @ 开发'));
  }
});

test('W5 返修（work/44-5）：无法确认的 flow 展示 blocked 原因，不放误导性确认按钮', async () => {
  const f = await fixture();
  // 飞书模式（U-3，digest 恒 null）：G1 必拒，卡片不得提供可点确认。
  const larkFlow = f.createFlow();
  const larkCard = JSON.stringify(buildProductSpecApprovalCard(larkFlow));
  assert.match(larkCard, /blocked/);
  assert.match(larkCard, /U-3/);
  assert.ok(!larkCard.includes('确认产品方案'), '不可确认的 flow 不得出现确认按钮');
  assert.match(larkCard, /不会自动派发.*授权开发/);

  // 本地旧 pending 未绑定摘要：同样 blocked 展示。
  const legacyLocal = f.runtime.productSpecFlows.create({
    taskId: 'task-legacy', botId: f.config.id, sessionId: f.session.id,
    ownerOpenId: 'leader-owner', ownerUnionId: 'union-owner', ownerBotId: 'leader', request: localRequest,
  });
  const legacyCard = JSON.stringify(buildProductSpecApprovalCard(legacyLocal));
  assert.match(legacyCard, /blocked/);
  assert.match(legacyCard, /没有绑定内容摘要/);
  assert.ok(!legacyCard.includes('确认产品方案'));

  // 绑定了摘要的本地 flow：正常可确认展示（对照）。
  const bound = await f.createLocalFlow();
  const boundCard = JSON.stringify(buildProductSpecApprovalCard(bound));
  assert.ok(boundCard.includes('确认产品方案'));

  // work/45-6：摘要已绑定但知识基准 degraded → blocked 展示，无确认按钮，
  // G1 必拒且例外通道未开放。
  writeFileSync(join(f.workspaceDir, 'spec.md'), '# 方案\n\n本地交付（degraded 基准）。\n');
  mkdirSync(join(f.workspaceDir, 'tickets'), { recursive: true });
  writeFileSync(join(f.workspaceDir, 'tickets', 't1.md'), '## 需求 1\n\n下单展示会员价。');
  const degradedDigest = await computeLocalArtifactDigest(f.workspaceDir, localRequest);
  const degradedFlow = f.runtime.productSpecFlows.create({
    taskId: 'task-degraded', botId: f.config.id, sessionId: f.session.id,
    ownerOpenId: 'leader-owner', ownerUnionId: 'union-owner', ownerBotId: 'leader',
    request: localRequest, content_digest: degradedDigest.digest,
    digest_algorithm: 'canonical-sha256-v1', content_sources: degradedDigest.content_sources,
    knowledge_state: 'degraded',
  });
  const degradedCard = JSON.stringify(buildProductSpecApprovalCard(degradedFlow));
  assert.match(degradedCard, /degraded/);
  assert.match(degradedCard, /例外确认通道尚未开放/);
  assert.ok(!degradedCard.includes('确认产品方案'), 'degraded flow 不得出现确认按钮');
  const degradedGate = await f.handler()(f.action(degradedFlow.token));
  assert.equal(degradedGate?.toast?.type, 'warning');
  assert.match(degradedGate?.toast?.content ?? '', /degraded|例外/);
  assert.equal(f.runtime.productSpecFlows.get(degradedFlow.token)?.status, 'pending');
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

test('CLI failure retains answers; result-card failure queues delivery without rerunning clarification', async () => {
  for (const failCard of [false, true]) {
    const f = await fixture(); const flow = f.runtime.clarificationFlows.create({ taskId: 'task', botId: 'product', sessionId: f.session.id, ownerOpenId: 'owner', request: questions, originalMessageId: 'msg', replyInThread: true });
    await f.runtime.sessions.transition(f.session.id, 'active'); const run = new AbortController();
    f.runtime.activeRuns.set(f.session.id, { controller: run, ownerOpenId: 'owner' });
    if (failCard) f.bot.updateCard = async () => { throw new Error('result card failed'); };
    const execution = continueClarificationFlow({ runtime: f.runtime, bot: f.bot, config: f.config, flow, run, defaultDeliveryMode: 'lark-doc', execute: async () => { if (!failCard) throw new Error('CLI failed'); return { answer: 'ordinary' }; } });
    if (failCard) await execution; else await assert.rejects(execution);
    assert.equal(f.runtime.sessions.get(f.session.id)?.status, 'idle'); assert.equal(f.runtime.activeRuns.size, 0);
    if (failCard) {
      assert.equal(f.runtime.clarificationFlows.get(flow.token), undefined);
      assert.equal(f.runtime.deliveries?.pending(), 2);
    } else assert.ok(f.runtime.clarificationFlows.get(flow.token));
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

test('history pruning only trims expired proposals; approved/invalidated records keep their digest and audit basis', () => {
  const store = new ProductSpecFlowStore();
  const awaiting = store.create({ taskId: 'awaiting', botId: 'product', sessionId: 's', ownerOpenId: 'owner', request, collaboration: origin });
  // approved 是版本与摘要锚点（架构上游/授权/审计依据）：数量再多也不裁剪
  //（work/30：不得仅按数量裁剪已完成 flow 丢失 approved PRD 的摘要与上游关系）。
  const approvedKept = store.create({ taskId: 'approved-kept', botId: 'product', sessionId: 's', ownerOpenId: 'owner', request, content_digest: 'a'.repeat(64) });
  store.approve(approvedKept.token);
  const invalidatedKept = store.create({ taskId: 'invalidated-kept', botId: 'product', sessionId: 's', ownerOpenId: 'owner', request, content_digest: 'b'.repeat(64) });
  store.invalidate(invalidatedKept.token, '外部编辑检测（fixture）');
  // 大量 expired（同任务滚动重建产生）仍按上限裁剪。
  const rollingFirst = store.create({ taskId: 'rolling', botId: 'product', sessionId: 's', ownerOpenId: 'owner', request });
  for (let index = 0; index < 1005; index++) {
    store.create({ taskId: 'rolling', botId: 'product', sessionId: 's', ownerOpenId: 'owner', request });
  }
  assert.equal(store.get(rollingFirst.token), undefined);
  assert.equal(store.get(approvedKept.token)?.status, 'approved');
  assert.ok(store.get(approvedKept.token)?.content_digest);
  assert.equal(store.get(invalidatedKept.token)?.status, 'invalidated');
  assert.match(store.get(invalidatedKept.token)?.invalidation_reason ?? '', /外部编辑/);
  assert.equal(store.get(awaiting.token)?.status, 'pending');
});
