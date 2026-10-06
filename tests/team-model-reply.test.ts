import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageHandler } from '../src/app/message-handler.js';
import { CollaborationService } from '../src/app/collaboration-service.js';
import type { AppRuntime } from '../src/app/runtime.js';
import type { BotConfig } from '../src/core/bot-registry.js';
import { ClarificationFlowStore } from '../src/core/clarification.js';
import { CollaborationInbox } from '../src/core/collaboration.js';
import { engineModelCapabilities } from '../src/core/engine-capabilities.js';
import { resolveModel } from '../src/core/model-selection.js';
import { ProductSpecFlowStore } from '../src/core/product-spec.js';
import { SessionManager } from '../src/core/session-manager.js';
import { TaskExecutionStore } from '../src/core/task-execution.js';
import { TeamRegistry } from '../src/core/team-registry.js';
import type { CardJson } from '../src/im/card.js';
import type { Bot, IncomingMessage } from '../src/im/lark.js';

async function waitForTaskEnd(runtime: AppRuntime): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (runtime.activeRuns.size > 0) {
    assert.ok(Date.now() < deadline, 'message handler did not release its active run');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

for (const initialSession of ['fresh', 'resumed'] as const) {
  test(`team model query carries role defaults every turn in a ${initialSession} session and only reports a reply`, async () => {
    const leader: BotConfig = {
      id: 'leader',
      appId: 'fixture-app',
      appSecret: 'fixture-secret',
      defaultCliId: 'codex',
      modelOverrides: { codex: { model: 'gpt-6-sol', reasoningEffort: 'low' } },
      role: '老板助理',
      skills: [],
      systemPrompt: '',
      workspaceDir: process.cwd(),
      collaborationMaxRounds: 4,
    };
    const product: BotConfig = {
      ...leader,
      id: 'product',
      role: '产品',
      modelOverrides: { codex: { model: 'gpt-6-astra', reasoningEffort: 'medium' } },
    };
    const developer: BotConfig = {
      ...leader,
      id: 'developer',
      role: '开发',
      defaultCliId: 'zcode',
      modelOverrides: { zcode: { model: 'glm-5.3', reasoningEffort: 'high' } },
    };
    const cards = new Map<string, CardJson>();
    const notices: Array<{ messageId: string; text: string }> = [];
    const texts: string[] = [];
    let cardCount = 0;
    const botImplementation: Pick<Bot, 'reply' | 'replyCard' | 'updateCard' | 'replyMention'> = {
      reply: async (_messageId, text) => {
        texts.push(text);
        return 'text';
      },
      replyCard: async (_messageId, card) => {
        const cardId = `card-${++cardCount}`;
        cards.set(cardId, card);
        return cardId;
      },
      updateCard: async (cardId, card) => {
        cards.set(cardId, card);
      },
      replyMention: async (messageId, target, text) => {
        assert.equal(target.openId, 'owner');
        notices.push({ messageId, text });
        return `notice-${notices.length}`;
      },
    };
    const bot = botImplementation as Bot;
    const runtime: AppRuntime = {
      sessions: new SessionManager(),
      teamRegistry: new TeamRegistry(leader.id, [leader, product, developer]),
      activeRuns: new Map(),
      contextWindows: new Map(),
      botRuntimes: new Map([[leader.id, {
        config: leader,
        bot,
        identity: { openId: 'bot-leader', name: leader.role },
      }]]),
      processedCollaborationTurns: new Set(),
      sessionScratches: new Map(),
      clarificationFlows: new ClarificationFlowStore(),
      productSpecFlows: new ProductSpecFlowStore(),
      collaborationInbox: new CollaborationInbox(),
      taskExecutions: new TaskExecutionStore(),
    };
    const message: IncomingMessage = {
      messageId: 'query-1',
      chatId: 'chat',
      chatType: 'group',
      threadId: 'thread',
      rootId: 'root',
      messageType: 'text',
      text: '@_user_1 现在产品 开发都用的什么模型',
      rawContent: '{"text":"@_user_1 现在产品 开发都用的什么模型"}',
      mentions: [{ key: '@_user_1', openId: 'bot-leader', name: '老板助理' }],
      senderType: 'user',
      senderOpenId: 'owner',
      senderUnionId: 'union-owner',
    };
    const nativeSessionId = 'native-leader';
    if (initialSession === 'resumed') {
      const { session } = await runtime.sessions.resolve(message, 'codex', leader.id, leader.workspaceDir);
      await runtime.sessions.transition(session.id, 'idle');
      await runtime.sessions.setCliSessionId(session.id, nativeSessionId, leader.modelOverrides.codex);
    }
    const executions: Array<{ prompt: string; resumeId?: string }> = [];
    const answers = [
      '目前无法确认引擎实际使用值，尚未解答模型生效问题。',
      '当前实际模型未知，需要更多证据。',
    ];
    let plannedCalls = 0;
    const handler = createMessageHandler({
      runtime,
      config: leader,
      defaultProductDeliveryMode: 'lark-doc',
      collaborationService: new CollaborationService(runtime),
      planModel: async (overrides, session) => {
        plannedCalls++;
        const desired = resolveModel(overrides, session.cliId, null);
        return {
          desired,
          decision: { action: 'keep' },
          modelSelection: desired.selection,
          resumeCliSessionId: session.cliSessionId,
          runtimeCheck: {
            cliId: session.cliId,
            command: 'fixture-command',
            version: 'fixture',
            checkedAt: '2026-10-07T00:00:00.000Z',
            capabilities: engineModelCapabilities(session.cliId),
            notes: [],
          },
        };
      },
      execute: async (adapter, prompt, _cwd, resumeId) => {
        assert.equal(adapter.id, 'codex');
        const answer = answers[executions.length];
        assert.ok(answer, 'unexpected execution beyond the two query messages');
        executions.push({ prompt, resumeId });
        return { answer, sessionId: nativeSessionId };
      },
    });

    for (let round = 0; round < answers.length; round++) {
      const incoming = { ...message, messageId: `query-${round + 1}` };
      await handler(incoming, bot);
      await waitForTaskEnd(runtime);

      assert.equal(executions.length, round + 1);
      assert.equal(plannedCalls, round + 1);
      const execution = executions[round]!;
      assert.match(execution.prompt, /现在产品 开发都用的什么模型/);
      assert.match(execution.prompt, /- product：默认引擎=codex；model=gpt-6-astra；effort=medium/);
      assert.match(execution.prompt, /- developer：默认引擎=zcode；model=glm-5\.3；effort=high\n\s+状态：声明受阻断/);
      assert.match(execution.prompt, /不代表某个话题当前的执行引擎/);
      assert.doesNotMatch(execution.prompt, /fixture-secret/);
      assert.equal(execution.resumeId, initialSession === 'fresh' && round === 0 ? undefined : nativeSessionId);
      assert.deepEqual(notices[round], {
        messageId: incoming.messageId,
        text: '已回复，请查看上方结果。',
      });
      const finalCard = cards.get(`card-${round + 1}`);
      assert.ok(finalCard, 'missing final result card');
      assert.deepEqual(finalCard.header, {
        template: 'green',
        title: { tag: 'plain_text', content: 'Codex · 执行结束' },
      });
      assert.match(JSON.stringify(finalCard), new RegExp(answers[round]!));
      assert.doesNotMatch(JSON.stringify(finalCard), /已完成/);
      const { session } = await runtime.sessions.resolve(incoming, 'codex', leader.id, leader.workspaceDir);
      assert.equal(session.status, 'idle');
      assert.equal(session.cliSessionId, nativeSessionId);
    }
    assert.equal(notices.length, 2);
    assert.deepEqual(texts, []);
  });
}
