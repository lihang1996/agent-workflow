import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { startBot, type Bot, type IncomingMessage, type IncomingDocumentComment } from '../src/im/lark.js';
import { ThrottledCardUpdater } from '../src/im/card.js';
import { SessionManager } from '../src/core/session-manager.js';
import { JsonSessionStore } from '../src/core/session-store.js';
import { ClarificationFlowStore } from '../src/core/clarification.js';
import { JsonProductSpecFlowStore } from '../src/core/product-spec-store.js';
import { computeLocalArtifactDigest } from '../src/core/artifact-digest.js';
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
const localRequest = { title: '方案', summary: '说明', deliveryMode: 'local' as const, specPath: '.fx/spec.md', ticketsPath: '.fx/tickets' };
const comment: IncomingDocumentComment = { eventId: 'event', fileToken: 'docToken', fileType: 'docx', commentId: 'comment', replyId: 'reply', senderOpenId: 'owner', senderUnionId: 'union-owner', mentionedBot: true };

async function fixture(t: { after: (callback: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config: BotConfig = { id: 'product', appId: 'fixture', appSecret: 'fixture', defaultCliId: 'claude', modelOverrides: {}, role: '产品', skills: ['lark-doc', 'lark-drive'], systemPrompt: '', workspaceDir: dir, collaborationMaxRounds: 16, specStages: ['product'] };
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
  sessionScratches: new Map(),
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
  // 本地模式 spec（带完整摘要绑定，G1 审批路径用）；制品落在会话工作区 dir 内。
  const createLocalSpec = async () => {
    mkdirSync(join(dir, '.fx', 'tickets'), { recursive: true });
    writeFileSync(join(dir, '.fx', 'spec.md'), '# 方案\n\n本地交付。\n');
    writeFileSync(join(dir, '.fx', 'tickets', 't1.md'), '## 需求 1\n\n下单展示会员价。');
    const digest = await computeLocalArtifactDigest(dir, localRequest);
    return runtime.productSpecFlows.create({ ...owner, taskId: topicTaskId(message), botId: 'product', sessionId: session.id, sessionVersion: runtime.sessions.get(session.id)?.version ?? 0, request: localRequest, content_digest: digest.digest, digest_algorithm: 'canonical-sha256-v1', content_sources: digest.content_sources });
  };
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
  return { runtime, bot, config, session, dir, owner, calls, createClarification, createSpec, createLocalSpec, cardAction, command, handler, restart };
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
    // T-022（W6b）：Claude 全局会话历史（~/.claude 或外部 CLAUDE_CONFIG_DIR）
    // 未隔离前，resume 入口的会话列表一律 blocked——不再直读任何全局目录。
    const handler = createCardActionHandler({ runtime: f.runtime, config: f.config, defaultProductDeliveryMode: 'lark-doc' });
    const blocked = await handler({ ...f.cardAction(flow.token), value: { action: 'resume_cli_session', agentSessionId: f.session.id, cliSessionId: 'other-cli' } });
    assert.equal(blocked?.toast?.type, 'error');
    assert.match(blocked?.toast?.content ?? '', /隔离|isolation|blocked|失败关闭|无法读取/s);
    // 版本失效逻辑（本测试的本体）经会话 API 直接驱动（resume 列表被阻断后，
    // 正常路径无从选择历史会话；此处只验证 selectCliSessionId 的失效语义）。
    await f.runtime.sessions.selectCliSessionId(f.session.id, 'other-cli');
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
  assert.equal(edits, 1);
  // T-019/61 号 P1：飞书路径没有已核验的完整回读 reader（U-3），回复由服务端
  // 生成中性文案——不回显 CLI 的「document updated」完成自述，只陈述处理
  // 尝试与核验缺口。
  assert.equal(f.calls.comments.length, 1);
  assert.ok(!f.calls.comments[0]!.includes('document updated'));
  assert.match(f.calls.comments[0]!, /未能完成制品完整性核验/);
  assert.match(f.calls.comments[0]!, /U-3/);
});

test('collaboration terminal state follows post-processing: artifact failure marks failed, plain success marks completed', async (t) => {
  const f = await fixture(t);
  const register = (dispatchId: string) => f.runtime.collaborationInbox.register({
    dispatchId, taskId: `task-${dispatchId}`, ownerOpenId: 'owner', ownerUnionId: 'union-owner',
    fromBotId: 'leader', toBotId: 'product', reportToBotId: 'leader',
    objective: '生成本地方案', instruction: '生成并提交方案', round: 1, maxRounds: 16,
    workspaceDir: f.dir,
  });
  const collabMessage = (dispatchId: string): IncomingMessage => ({
    ...message,
    senderType: 'app',
    senderOpenId: 'bot-leader',
    messageType: 'post',
    text: `@product 任务编号：${dispatchId}`,
    rawContent: '{}',
    mentions: [{ key: '@_user_1', name: 'product', openId: 'bot-product' }],
  });

  // 1) 工具调用声称提交本地方案，但制品不完整：flow 创建失败关闭——协作终态
  //    必须是 failed，不得先记 completed 再丢制品（work/30 状态时序）。
  register('aabbccddeeff');
  const failing = async () => ({ answer: '方案已生成', toolCalls: [{ toolUseId: 'tu1', toolName: 'request_spec_approval', input: { ...localRequest } }] });
  await f.handler(failing)(collabMessage('aabbccddeeff'), f.bot);
  await until(() => f.runtime.sessions.get(f.session.id)?.status === 'idle');
  assert.equal(f.runtime.collaborationInbox.get('aabbccddeeff')?.status, 'failed');
  assert.equal(f.runtime.productSpecFlows.forSession(f.session.id).length, 0);

  // 2) 普通成功协作：全部后处理结束后才落 completed。
  register('aabbccddeef1');
  const succeeding = async () => ({ answer: '已完成' });
  await f.handler(succeeding)(collabMessage('aabbccddeef1'), f.bot);
  await until(() => f.runtime.collaborationInbox.get('aabbccddeef1')?.status === 'completed');
});

test('plain-text authorization phrases are never executed or auto-authorized (T-021)', async (t) => {
  const f = await fixture(t);
  // 同一 bot 开放架构阶段（模拟开发角色会话入口）。
  const architectureStageConfig: BotConfig = { ...f.config, specStages: ['product', 'architecture'] };
  let executed = 0;
  const handler = createMessageHandler({
    runtime: f.runtime, config: architectureStageConfig,
    defaultProductDeliveryMode: 'lark-doc',
    collaborationService: new CollaborationService(f.runtime),
    execute: async () => { executed += 1; return { answer: 'done' }; },
  });
  await handler({ ...message, text: '可以开发了' }, f.bot);
  await handler({ ...message, messageId: 'm-2', text: '开始编码！' }, f.bot);
  const hints = f.calls.texts.filter((text) => text.includes('不能自动创建授权'));
  assert.equal(hints.length, 2);
  assert.equal(executed, 0, '授权口令文本不得进入任务执行');
  assert.equal(f.runtime.productSpecFlows.forSession(f.session.id).length, 0);
  // 正常任务文本（含子串）不被拦截。
  await handler({ ...message, messageId: 'm-3', text: '评估一下什么时候可以开发了，先做技术调研' }, f.bot);
  await until(() => f.runtime.sessions.get(f.session.id)?.status === 'idle');
  assert.equal(executed, 1);
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
  // 持久化失败注入：目标文件换成目录（唯一 tmp 写入成功、rename 撞目录失败）。
  rmSync(join(f.dir, 'sessions.json'));
  mkdirSync(join(f.dir, 'sessions.json'));
  await assert.rejects(f.command('new'));
  rmSync(join(f.dir, 'sessions.json'), { recursive: true, force: true });
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

test('local spec submissions bind the full artifact digest at creation and approve via G1', async (t) => {
  const f = await fixture(t);
  mkdirSync(join(f.dir, '.fx', 'tickets'), { recursive: true });
  writeFileSync(join(f.dir, '.fx', 'spec.md'), '# 方案\n\n本地交付。\n');
  writeFileSync(join(f.dir, '.fx', 'tickets', 't1.md'), '## 需求 1\n\n下单展示会员价。');
  // W6b：本地制品提交需要当前任务的 scratch 绑定（fixture 直接 seed 等价状态）。
  f.runtime.sessionScratches.set(f.session.id, { relative: '.fx', taskKey: topicTaskId(message), at: Date.now(), workspaceRealpath: realpathSync(f.dir) });
  const execute = async () => ({ answer: '方案已生成', toolCalls: [{ toolUseId: 'tu1', toolName: 'request_spec_approval', input: { ...localRequest } }] });
  await f.handler(execute)(message, f.bot);
  await until(() => f.runtime.productSpecFlows.forSession(f.session.id).length === 1);
  const flow = f.runtime.productSpecFlows.forSession(f.session.id)[0]!;
  const digest = await computeLocalArtifactDigest(f.dir, localRequest);
  assert.equal(flow.content_digest, digest.digest);
  assert.deepEqual(flow.content_sources, [{ kind: 'local', path: '.fx/spec.md' }, { kind: 'local', path: '.fx/tickets' }]);
  assert.equal(flow.status, 'pending');
  const handler = createCardActionHandler({ runtime: f.runtime, config: f.config, defaultProductDeliveryMode: 'lark-doc' });
  const approved = await handler({ operatorOpenId: 'owner', operatorUnionId: 'union-owner', messageId: 'approval-card', formValue: {}, value: { action: 'approve_product_spec', flowToken: flow.token } });
  assert.equal(approved?.toast?.type, 'success');
  assert.equal(f.runtime.productSpecFlows.get(flow.token)?.status, 'approved');
});

test('incomplete local artifacts never create an approval flow (fail closed)', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.dir, 'spec.md'), '# 方案\n');
  // tickets 目录缺失：提交即失败关闭，不生成确认卡对应的 flow。
  const execute = async () => ({ answer: '方案已生成', toolCalls: [{ toolUseId: 'tu1', toolName: 'request_spec_approval', input: { ...localRequest } }] });
  await f.handler(execute)(message, f.bot);
  await until(() => f.runtime.sessions.get(f.session.id)?.status === 'idle');
  assert.equal(f.runtime.productSpecFlows.forSession(f.session.id).length, 0);
});

test('retrying a timed-out approval card preserves a later user approval after restart', async (t) => {
  const f = await fixture(t); const flow = await f.createLocalSpec();
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

test('W5 返修：澄清后创建的本地方案也绑定完整摘要，并可通过 G1 审批（共享创建路径）', async (t) => {
  const f = await fixture(t);
  mkdirSync(join(f.dir, '.fx', 'tickets'), { recursive: true });
  writeFileSync(join(f.dir, '.fx', 'spec.md'), '# 方案\n\n澄清后本地交付。\n');
  writeFileSync(join(f.dir, '.fx', 'tickets', 't1.md'), '## 需求 1\n\n按澄清结果展示会员价。');
  const flow = f.createClarification();
  f.runtime.sessionScratches.set(f.session.id, { relative: '.fx', taskKey: flow.taskId, at: Date.now(), workspaceRealpath: realpathSync(f.dir) });
  await f.runtime.sessions.transition(f.session.id, 'active');
  const run = new AbortController();
  f.runtime.activeRuns.set(f.session.id, { controller: run, ownerOpenId: 'owner' });
  await continueClarificationFlow({
    runtime: f.runtime, bot: f.bot, config: f.config, flow, run,
    defaultDeliveryMode: 'local',
    execute: async () => ({
      answer: '方案已生成',
      toolCalls: [{ toolUseId: 'tu1', toolName: 'request_spec_approval', input: { ...localRequest } }],
    }),
  });
  const created = f.runtime.productSpecFlows.forSession(f.session.id);
  assert.equal(created.length, 1, '澄清后提交必须生成确认 flow');
  const digest = await computeLocalArtifactDigest(f.dir, localRequest);
  assert.equal(created[0]!.content_digest, digest.digest, '澄清路径与直接提交共用同一摘要绑定（此前恒为 null 导致 G1 永远拒绝）');
  assert.deepEqual(created[0]!.content_sources, [{ kind: 'local', path: '.fx/spec.md' }, { kind: 'local', path: '.fx/tickets' }]);
  const handler = createCardActionHandler({ runtime: f.runtime, config: f.config, defaultProductDeliveryMode: 'lark-doc' });
  const approved = await handler({ operatorOpenId: 'owner', operatorUnionId: 'union-owner', messageId: 'approval-card', formValue: {}, value: { action: 'approve_product_spec', flowToken: created[0]!.token } });
  assert.equal(approved?.toast?.type, 'success');
  assert.equal(f.runtime.productSpecFlows.get(created[0]!.token)?.status, 'approved');
});
