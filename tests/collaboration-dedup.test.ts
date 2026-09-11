import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CollaborationInbox,
  collaborationTurnKey,
  type CollaborationMessage,
} from '../src/core/collaboration.js';
import { topicTaskId } from '../src/core/topic-task.js';

const taskId = topicTaskId({
  chatId: 'chat-same-topic',
  threadId: 'thread-same-topic',
  rootId: 'root-same-topic',
  messageId: 'first-user-message',
});

const initial: CollaborationMessage = {
  dispatchId: '000000000001',
  taskId,
  ownerOpenId: 'owner',
  fromBotId: 'ceo-assistant',
  toBotId: 'developer',
  reportToBotId: 'ceo-assistant',
  objective: '实现需求',
  instruction: '完成实现并返回结果',
  round: 1,
  maxRounds: 16,
  workspaceDir: '/tmp/agent-os-test',
};

// Model the inbox consumption and processed-turn guard before CLI execution.
function receiver() {
  const inbox = new CollaborationInbox();
  const processed = new Set<string>();
  const accepted: CollaborationMessage[] = [];
  return {
    inbox,
    accepted,
    receive(dispatchId: string, botId: string) {
      const pending = inbox.consume(dispatchId, botId);
      if (!pending) return;
      const key = collaborationTurnKey(pending);
      if (processed.has(key)) return;
      processed.add(key);
      accepted.push(pending);
    },
  };
}

test('a new dispatch in the same topic executes after an earlier task', () => {
  const nextTaskId = topicTaskId({
    chatId: 'chat-same-topic',
    threadId: 'thread-same-topic',
    rootId: 'root-same-topic',
    messageId: 'next-user-message',
  });
  assert.equal(nextTaskId, taskId);
  const report: CollaborationMessage = {
    ...initial,
    dispatchId: '000000000002',
    fromBotId: 'developer',
    toBotId: 'ceo-assistant',
    round: 2,
  };
  const messages = [
    initial,
    report,
    { ...initial, taskId: nextTaskId, dispatchId: '000000000003' },
    { ...report, taskId: nextTaskId, dispatchId: '000000000004' },
  ];
  const runtime = receiver();
  for (const message of messages) {
    runtime.inbox.register(message);
    runtime.receive(message.dispatchId, message.toBotId);
  }
  assert.deepEqual(runtime.accepted, messages.map((message) => ({ ...message, status: 'pending' })));
});

test('duplicate delivery of one dispatch is accepted only once, including re-registration', () => {
  const runtime = receiver();
  runtime.inbox.register(initial);
  runtime.receive(initial.dispatchId, initial.toBotId);
  runtime.receive(initial.dispatchId, initial.toBotId);
  // Even if the same dispatch is registered again, the processed guard holds.
  runtime.inbox.register({ ...initial });
  runtime.receive(initial.dispatchId, initial.toBotId);
  assert.deepEqual(runtime.accepted, [{ ...initial, status: 'pending' }]);
});
