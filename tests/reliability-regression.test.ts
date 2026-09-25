import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { startBot, type Bot, type IncomingMessage, type IncomingDocumentComment } from '../src/im/lark.js';
import { ThrottledCardUpdater } from '../src/im/card.js';
import { SessionManager } from '../src/core/session-manager.js';
import { JsonSessionStore } from '../src/core/session-store.js';
import { ClarificationFlowStore } from '../src/core/clarification.js';
import { JsonProductSpecFlowStore } from '../src/core/product-spec-store.js';
import { CollaborationInbox, type CollaborationMessage } from '../src/core/collaboration.js';
import { TaskExecutionStore } from '../src/core/task-execution.js';
import { TeamRegistry } from '../src/core/team-registry.js';
import { topicTaskId } from '../src/core/topic-task.js';
import type { BotConfig } from '../src/core/bot-registry.js';
import type { AppRuntime } from '../src/app/runtime.js';
import { createTaskCardUpdater, resolveResultCard } from '../src/app/result-delivery.js';
import { DeliveryOutbox } from '../src/app/delivery-outbox.js';
import { CollaborationService } from '../src/app/collaboration-service.js';
import { createMessageHandler } from '../src/app/message-handler.js';
import { createCardActionHandler } from '../src/app/card-action-handler.js';
import { continueClarificationFlow } from '../src/app/clarification-runner.js';
import { runProductDocumentComment } from '../src/app/product-comment-runner.js';
import { ProductCommentScheduler } from '../src/app/product-comment-scheduler.js';
import { beginTask, executeTask, releaseTask } from '../src/app/task-lifecycle.js';
import { getCliAdapter } from '../src/cli/registry.js';
import { handleSessionCommand } from '../src/app/command-handler.js';

const wait = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > end) throw new Error('等待任务收尾超时'); await wait(); }
}
const message: IncomingMessage = { messageId: 'user-message', chatId: 'chat', chatType: 'group', threadId: 'thread', rootId: 'root', messageType: 'text', text: '检查任务', rawContent: '{"text":"检查任务"}', mentions: [], senderType: 'user', senderOpenId: 'owner', senderUnionId: 'union-owner' };
const request = { title: '方案', summary: '说明', deliveryMode: 'lark-doc' as const, documentUrl: 'https://team.feishu.cn/docx/docToken' };
const comment: IncomingDocumentComment = { eventId: 'event', fileToken: 'docToken', fileType: 'docx', commentId: 'comment', replyId: 'reply', senderOpenId: 'owner', senderUnionId: 'union-owner', mentionedBot: true };

async function fixture(t: { after: (callback: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config: BotConfig = { id: 'product', appId: 'fixture', appSecret: 'fixture', defaultCliId: 'claude', modelOverrides: {}, role: '产品', skills: ['lark-doc', 'lark-drive'], systemPrompt: '', workspaceDir: dir, collaborationMaxRounds: 16 };
  const leader: BotConfig = { ...config, id: 'leader', skills: [] };
  const calls = { cards: 0, updates: 0, texts: [] as string[], comments: [] as string[] };
  const bot = {
    reply: async (_id: string, text: string) => { calls.texts.push(text); return 'text'; },
    replyCard: async () => `card-${++calls.cards}`,
    updateCard: async () => { calls.updates++; },
    replyMention: async () => 'notice',
    replyToDocumentComment: async (_comment: IncomingDocumentComment, text: string) => { calls.comments.push(text); },
    setDocumentCommentWorking: async () => {},
  } as unknown as Bot;
  const runtime: AppRuntime = {
    sessions: await SessionManager.open({ store: new JsonSessionStore(join(dir, 'sessions.json')) }),
    activeRuns: new Map(), contextWindows: new Map(), botRuntimes: new Map(), processedCollaborationTurns: new Set(),
    teamRegistry: new TeamRegistry('leader', [leader, config]),
    clarificationFlows: new ClarificationFlowStore(join(dir, 'clarifications.json')),
    productSpecFlows: new JsonProductSpecFlowStore(join(dir, 'specs.json')),
    collaborationInbox: new CollaborationInbox(join(dir, 'inbox.json')),
    taskExecutions: new TaskExecutionStore(join(dir, 'executions.json')),
  };
  for (const cfg of [leader, config]) runtime.botRuntimes.set(cfg.id, { config: cfg, bot, identity: { openId: `bot-${cfg.id}`, name: cfg.id } });
  runtime.deliveries = new DeliveryOutbox((id) => runtime.botRuntimes.get(id)?.bot, join(dir, 'deliveries.json'), 0, (operation) => resolveResultCard(runtime, operation));
  const { session } = await runtime.sessions.resolve(message, 'claude', 'product', dir);
  await runtime.sessions.transition(session.id, 'idle');
  await runtime.sessions.setCliSessionId(session.id, 'original-cli');
  const owner = { ownerOpenId: 'owner', ownerUnionId: 'union-owner', ownerBotId: 'product' };
  const createClarification = () => runtime.clarificationFlows.create({
    ...owner, taskId: topicTaskId(message), botId: 'product', sessionId: session.id, sessionVersion: runtime.sessions.get(session.id)?.version ?? 0,
    originalMessageId: message.messageId, cardMessageId: 'clarification-card', replyInThread: true,
    request: { title: '范围', intro: '', questions: [{ id: 'q', prompt: '范围？', options: [{ id: 'a', label: '小' }, { id: 'b', label: '大' }] }] },
  });
  const createSpec = () => runtime.productSpecFlows.create({ ...owner, taskId: topicTaskId(message), botId: 'product', sessionId: session.id, sessionVersion: runtime.sessions.get(session.id)?.version ?? 0, request });
  const cardAction = (token: string) => ({ operatorOpenId: 'owner', operatorUnionId: 'union-owner', messageId: 'clarification-card', formValue: {}, value: { action: 'answer_clarification', flowToken: token, questionId: 'q', optionId: 'a' } });
  const handler = (execute: Parameters<typeof createMessageHandler>[0]['execute']) => createMessageHandler({ runtime, config, defaultProductDeliveryMode: 'lark-doc', collaborationService: new CollaborationService(runtime), execute });
  const command = async (name: 'new' | 'close' | 'cd', senderOpenId = 'owner', path?: string) => handleSessionCommand({
    runtime, config, bot, msg: { ...message, senderOpenId, senderUnionId: senderOpenId === 'owner' ? 'union-owner' : 'other' },
    session: runtime.sessions.get(session.id)!, cliAdapter: getCliAdapter('claude'), isNew: false, hasThread: true,
    command: name === 'cd' ? { name, path } : { name },
  });
  const restart = async () => {
    runtime.sessions = await SessionManager.open({ store: new JsonSessionStore(join(dir, 'sessions.json')) });
    runtime.collaborationInbox = new CollaborationInbox(join(dir, 'inbox.json'));
    runtime.taskExecutions = new TaskExecutionStore(join(dir, 'executions.json'));
    runtime.clarificationFlows = new ClarificationFlowStore(join(dir, 'clarifications.json'));
    runtime.productSpecFlows = new JsonProductSpecFlowStore(join(dir, 'specs.json'));
    runtime.deliveries = new DeliveryOutbox((id) => runtime.botRuntimes.get(id)?.bot, join(dir, 'deliveries.json'), 0, (operation) => resolveResultCard(runtime, operation));
  };
  return { runtime, bot, config, session, dir, owner, calls, createClarification, createSpec, cardAction, command, handler, restart };
}

test('a rejected progress update does not reject the process or poison later/final updates', async () => {
  const received: unknown[] = [];
  const updater = new ThrottledCardUpdater(async (card) => { received.push(card); if (received.length === 1) throw new Error('transient'); }, 1);
  updater.push({ state: 'first' }); await wait(15);
  updater.push({ state: 'second' }); await wait(15);
  await updater.finish({ state: 'done' });
  assert.deepEqual(received, [{ state: 'first' }, { state: 'second' }, { state: 'done' }]);
});

test('failed final card can be retried and a concurrent finish does not duplicate delivery', async () => {
  let calls = 0;
  const updater = new ThrottledCardUpdater(async () => { if (++calls === 1) throw new Error('network'); });
  await assert.rejects(updater.finish({}));
  await Promise.all([updater.finish({}), updater.finish({})]);
  assert.equal(calls, 2);
});

test('actual Bot wrappers reject nonzero API codes and missing message IDs', async (t) => {
  t.mock.method(Lark.WSClient.prototype, 'start', async () => {});
  const bot = startBot({ appId: 'fixture', appSecret: 'fixture', onMessage: async () => {} });
  t.mock.method(bot.client.im.v1.message, 'patch', async () => ({ code: 123, msg: 'denied' }));
  t.mock.method(bot.client.im.v1.message, 'reply', async () => ({ code: 123, msg: 'denied' }));
  await assert.rejects(bot.updateCard('m', {}), /123/);
  await assert.rejects(bot.replyCard('m', {}), /123/);
  await assert.rejects(bot.reply('m', 'text'), /123/);
  await assert.rejects(bot.replyMention('m', { openId: 'owner', name: '' }, 'text'), /123/);
  t.mock.method(bot.client.im.v1.message, 'reply', async () => ({ code: 0, data: {} }));
  await assert.rejects(bot.replyCard('m', {}), /message_id/);
});

test('real message handler keeps dispatch retryable after preflight failure, including restart and duplicate delivery', async (t) => {
  const f = await fixture(t);
  const job: CollaborationMessage = { ...f.owner, dispatchId: 'abcdef012345', taskId: topicTaskId(message), fromBotId: 'leader', toBotId: 'product', reportToBotId: 'leader', objective: 'task', instruction: 'do it', round: 1, maxRounds: 16, workspaceDir: f.dir, replyToMessageId: 'root' };
  f.runtime.collaborationInbox.register(job);
  const incoming = { ...message, messageId: 'dispatch-message', senderType: 'app', senderOpenId: 'bot-leader', text: '任务编号：abcdef012345', messageType: 'post', mentions: [{ key: 'at', openId: 'bot-product', name: 'product' }] };
  let executed = 0;
  f.bot.replyCard = async () => { throw new Error('card offline'); };
  await assert.rejects(f.handler(async () => { executed++; return { answer: 'done' }; })(incoming, f.bot), /offline/);
  assert.equal(f.runtime.collaborationInbox.pending().length, 1);
  assert.equal(f.runtime.collaborationInbox.hasConsumed(job.dispatchId), false);
  assert.equal(f.runtime.activeRuns.size, 0);
  await f.restart();
  f.bot.replyCard = async () => 'progress-card';
  const receive = f.handler(async () => { executed++; return { answer: 'done' }; });
  f.bot.replyMention = async (_id, _target, text) => {
    if (text.includes('任务编号')) {
      assert.match(text, /abcdef012345/);
      await receive(incoming, f.bot);
    }
    return 'notice';
  };
  await new CollaborationService(f.runtime).recover();
  await until(() => f.runtime.activeRuns.size === 0);
  await receive(incoming, f.bot);
  assert.equal(executed, 1);
  assert.equal(f.runtime.collaborationInbox.get(job.dispatchId)?.status, 'completed');
  assert.equal(f.runtime.collaborationInbox.pending().length, 0);
});

test('restart requeues received work but quarantines work that crossed the execution boundary', async (t) => {
  const f = await fixture(t);
  for (const dispatchId of ['000000000001', '000000000002']) {
    f.runtime.collaborationInbox.register({ ...f.owner, dispatchId, taskId: 'task', fromBotId: 'leader', toBotId: 'product', reportToBotId: 'leader', objective: 'task', instruction: 'do', round: 1, maxRounds: 2, workspaceDir: f.dir });
    f.runtime.collaborationInbox.acquire(dispatchId, 'product', f.session.id);
  }
  f.runtime.collaborationInbox.beginExecution('000000000002');
  f.runtime.taskExecutions!.start('uncertain', f.session.id, 'product');
  await f.restart();
  assert.equal(f.runtime.collaborationInbox.pending()[0].dispatchId, '000000000001');
  assert.equal(f.runtime.collaborationInbox.get('000000000002')?.status, 'interrupted');
  let executed = false;
  await assert.rejects(executeTask({ runtime: f.runtime, id: 'uncertain', sessionId: f.session.id, botId: 'product', execute: async () => { executed = true; return { answer: 'duplicate' }; } }), /不会自动重复执行/);
  assert.equal(executed, false);
});

test('completed CLI survives failed result delivery; restart only sends saved results', async (t) => {
  const f = await fixture(t); let executions = 0; let notices = 0;
  f.bot.replyMention = async () => { notices++; return 'notice'; };
  f.bot.updateCard = async () => { throw new Error('card unavailable'); };
  await f.handler(async () => { executions++; return { answer: 'saved answer' }; })(message, f.bot);
  await until(() => f.runtime.activeRuns.size === 0);
  assert.equal(f.runtime.taskExecutions?.get(`product:${message.messageId}`)?.status, 'completed');
  assert.equal(f.runtime.deliveries?.pending(), 2);
  assert.equal(notices, 0, 'do not announce a result card before it has been delivered');
  assert.ok(f.calls.texts.some((text) => text.includes('结果已保存')));
  await f.restart();
  let delivered = '';
  f.bot.updateCard = async (_id, card) => { delivered = JSON.stringify(card); };
  await f.runtime.deliveries!.recover(); await f.runtime.deliveries!.recover();
  assert.match(delivered, /saved answer/); assert.equal(executions, 1); assert.equal(f.runtime.deliveries?.pending(), 0);
  assert.equal(notices, 1);
});

for (const change of ['new', 'cd', 'resume'] as const) test(`${change} invalidates old clarification and product flows durably`, async (t) => {
  const f = await fixture(t); const flow = f.createClarification(); const spec = f.createSpec();
  if (change === 'resume') {
    // Native session enumeration reads only this temporary project directory.
    const claudeDir = join(f.dir, 'claude');
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    t.after(() => { if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfigDir; });
    const project = join(claudeDir, 'projects', f.dir.replace(/[^A-Za-z0-9]/g, '-')); mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'other.jsonl'), JSON.stringify({ type: 'user', sessionId: 'other-cli', cwd: f.dir, message: { content: 'other task' } }) + '\n');
    const handler = createCardActionHandler({ runtime: f.runtime, config: f.config, defaultProductDeliveryMode: 'lark-doc' });
    assert.equal((await handler({ ...f.cardAction(flow.token), value: { action: 'resume_cli_session', agentSessionId: f.session.id, cliSessionId: 'other-cli' } }))?.toast?.type, 'success');
  } else {
    if (change === 'cd') mkdirSync(join(f.dir, 'other'));
    await f.command(change, 'owner', change === 'cd' ? join(f.dir, 'other') : undefined);
  }
  await f.restart(); let executions = 0;
  const handler = createCardActionHandler({ runtime: f.runtime, config: f.config, defaultProductDeliveryMode: 'lark-doc', continueFlow: async () => { executions++; } });
  assert.equal((await handler(f.cardAction(flow.token)))?.toast?.type, 'error');
  await handler({ ...f.cardAction(flow.token), value: { action: 'approve_product_spec', flowToken: spec.token } });
  assert.equal(f.runtime.productSpecFlows.get(spec.token)?.status, 'pending');
  await assert.rejects(runProductDocumentComment({ runtime: f.runtime, bot: f.bot, flow: spec, comment, execute: async () => { executions++; return { answer: '' }; } }), /失效/);
  assert.equal(executions, 0);
});

test('non-owner cannot close, reset, switch workspace or select a historical session', async (t) => {
  const f = await fixture(t); const flow = f.createClarification();
  const handler = createCardActionHandler({ runtime: f.runtime, config: f.config, defaultProductDeliveryMode: 'lark-doc' });
  const action = { ...f.cardAction(flow.token), operatorOpenId: 'other', operatorUnionId: 'other', value: { action: 'resume_cli_session', agentSessionId: f.session.id, cliSessionId: 'any' } };
  assert.equal((await handler(action))?.toast?.type, 'warning');
  await f.command('new', 'other'); await f.command('cd', 'other', join(f.dir, 'unauthorized'));
  assert.equal(f.runtime.sessions.get(f.session.id)?.cliSessionId, 'original-cli');
  assert.equal(f.runtime.sessions.get(f.session.id)?.workspaceDir, f.dir);
  const run = await beginTask(f.runtime, f.session.id, f.owner, 0);
  await f.command('close', 'other');
  assert.equal(run.signal.aborted, false); assert.equal(f.runtime.sessions.get(f.session.id)?.status, 'active');
  await f.command('close'); assert.equal(run.signal.aborted, true);
  await releaseTask(f.runtime, f.session.id, run);
});

test('ordinary messages, clarification callbacks and document comments cannot run one session concurrently', async (t) => {
  const f = await fixture(t); const flow = f.createClarification(); f.createSpec();
  let executions = 0; let unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const execute = async () => { executions++; await gate; return { answer: 'done' }; };
  const callback = createCardActionHandler({ runtime: f.runtime, config: f.config, defaultProductDeliveryMode: 'lark-doc', continueFlow: (options) => continueClarificationFlow({ ...options, execute }) });
  await callback(f.cardAction(flow.token)); await until(() => executions === 1);
  const scheduler = new ProductCommentScheduler(f.runtime, (options) => runProductDocumentComment({ ...options, execute }));
  scheduler.schedule(f.config, f.bot, comment);
  await f.handler(execute)({ ...message, messageId: 'another-message' }, f.bot);
  await scheduler.drain(); assert.equal(executions, 1);
  unblock(); await until(() => f.runtime.activeRuns.size === 0);
  assert.equal(f.runtime.sessions.get(f.session.id)?.status, 'idle');
});

test('document edits do not repeat after a comment reply failure and process restart', async (t) => {
  const f = await fixture(t); const flow = f.createSpec(); let edits = 0;
  f.bot.replyToDocumentComment = async () => { throw new Error('reply unavailable'); };
  const execute = async () => { edits++; return { answer: 'document updated' }; };
  await runProductDocumentComment({ runtime: f.runtime, bot: f.bot, flow, comment, execute });
  await f.restart();
  f.bot.replyToDocumentComment = async (_comment, text) => { f.calls.comments.push(text); };
  await f.runtime.deliveries!.recover();
  await runProductDocumentComment({ runtime: f.runtime, bot: f.bot, flow, comment, execute });
  assert.equal(edits, 1); assert.deepEqual(f.calls.comments, ['document updated']);
});

test('session version, owner, and completed execution records survive reload', async (t) => {
  const f = await fixture(t);
  const run = await beginTask(f.runtime, f.session.id, f.owner, 0);
  await executeTask({ runtime: f.runtime, id: 'persist', sessionId: f.session.id, botId: 'product', execute: async () => ({ answer: 'done', sessionId: 'new-native', stats: { contextWindowTokens: 100 } }) });
  await releaseTask(f.runtime, f.session.id, run); await f.command('new'); await f.restart();
  assert.equal(f.runtime.sessions.get(f.session.id)?.version, 1);
  assert.deepEqual(f.runtime.sessions.get(f.session.id)?.owner, f.owner);
  assert.equal(f.runtime.taskExecutions!.get('persist')?.result?.answer, 'done');
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'sessions.json'), 'utf8'))[0].version, 1);
});

test('failed session reset rolls back its version and preserves the original clarification', async (t) => {
  const f = await fixture(t); const flow = f.createClarification();
  mkdirSync(join(f.dir, 'sessions.json.tmp'));
  await assert.rejects(f.command('new'));
  assert.equal(f.runtime.sessions.get(f.session.id)?.version, 0);
  assert.equal(f.runtime.sessions.get(f.session.id)?.cliSessionId, 'original-cli');
  assert.equal(f.runtime.clarificationFlows.get(flow.token)?.currentIndex, 0);
});

test('concurrent run claims preserve the first controller and run at most one engine', async (t) => {
  const f = await fixture(t);
  const claims = await Promise.allSettled([
    beginTask(f.runtime, f.session.id, f.owner, 0),
    beginTask(f.runtime, f.session.id, f.owner, 0),
  ]);
  const accepted = claims.filter((c) => c.status === 'fulfilled');
  assert.equal(accepted.length, 1);
  const run = accepted[0].value;
  assert.equal(f.runtime.activeRuns.get(f.session.id)?.controller, run);
  await releaseTask(f.runtime, f.session.id, new AbortController());
  assert.equal(f.runtime.sessions.get(f.session.id)?.status, 'active');
  await releaseTask(f.runtime, f.session.id, run);
});

test('retrying a timed-out approval card preserves a later user approval after restart', async (t) => {
  const f = await fixture(t); const flow = f.createSpec();
  f.bot.updateCard = async () => { throw new Error('response lost after server accepted the card'); };
  const updater = createTaskCardUpdater({ runtime: f.runtime, bot: f.bot, botId: 'product', sessionId: f.session.id,
    cardId: 'approval-card', replyToMessageId: message.messageId, replyInThread: true });
  await updater.finish({ state: 'pending' }, { kind: 'product', token: flow.token });
  const callback = createCardActionHandler({ runtime: f.runtime, config: f.config, defaultProductDeliveryMode: 'lark-doc' });
  assert.equal((await callback({ ...f.cardAction(flow.token), messageId: 'approval-card', value: { action: 'approve_product_spec', flowToken: flow.token } }))?.toast?.type, 'success');
  await f.restart(); let delivered = '';
  f.bot.updateCard = async (_id, card) => { delivered = JSON.stringify(card); };
  await f.runtime.deliveries!.recover();
  assert.match(delivered, /产品方案已确认/);
  assert.doesNotMatch(delivered, /approve_product_spec/);
});
