import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import {
  extractMessageText,
  extractResourceKeys,
  parseMentions,
  resolveMentions,
} from '../src/im/message-parser.js';
import { parseCommand } from '../src/core/command-parser.js';
import {
  documentClientToken,
  parseCardAction,
  resourceLocalName,
  sanitizeDocumentTitle,
} from '../src/im/lark.js';
import { buildSpecConfirmationCard } from '../src/im/workflow-card.js';
import type { ProductSpec } from '../src/core/spec-store.js';

function spec(status: ProductSpec['status']): ProductSpec {
  return {
    id: 'spec-1',
    title: '登录',
    content: '### RQ-001 登录\n可执行 Spec',
    chatId: 'oc',
    topicId: 'omt',
    messageId: 'om',
    botId: 'pm',
    ownerOpenId: 'ou',
    workflowId: 'wf-1',
    status,
    version: 1,
    contentHash: 'a'.repeat(64),
    canonical: false,
    comments: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('卡片回调同时保留应用级和跨应用稳定用户 ID', () => {
  const action = parseCardAction({
    operator: {
      open_id: 'ou_qa_scoped',
      user_id: 'u_tenant_stable',
      union_id: 'on_developer_stable',
    },
    context: { open_message_id: 'om_card' },
    action: { value: { action: 'abort_task' }, form_value: { reason: 'stop' } },
  });
  assert.deepEqual(action, {
    operatorOpenId: 'ou_qa_scoped',
    operatorUserId: 'u_tenant_stable',
    operatorUnionId: 'on_developer_stable',
    messageId: 'om_card',
    value: { action: 'abort_task' },
    formValue: { reason: 'stop' },
  });
});

test('Spec 确认卡在待确认状态同时提供云文档评审与直接开始两个入口', () => {
  const card = buildSpecConfirmationCard(spec('pending_confirmation'));
  const serialized = JSON.stringify(card);
  assert.match(serialized, /confirm_spec/);
  assert.match(serialized, /confirm_spec_start/);
  assert.match(serialized, /确认并直接开始技术交付/);
  // Schema 2.0 禁止 tag=action；按钮应直接出现在 body.elements
  assert.doesNotMatch(serialized, /"tag":"action"/);
  const elements = (card as { body: { elements: Array<{ tag?: string }> } }).body.elements;
  assert.ok(elements.some((el) => el.tag === 'button'));
});

test('Spec 确认卡在已确认状态保留发布按钮并允许直接开始技术交付', () => {
  const card = buildSpecConfirmationCard(spec('confirmed'));
  const serialized = JSON.stringify(card);
  assert.match(serialized, /publish_spec/);
  assert.match(serialized, /confirm_spec_start/);
  assert.match(serialized, /直接开始技术交付/);
  assert.doesNotMatch(serialized, /"tag":"action"/);
});

test('含风险接受条款的 Spec 只能进入完整云文档评审', () => {
  const riskyContent = [
    '### RQ-001 登录',
    '[RISK_WAIVER] {"findingId":"FIND-1","owner":"owner","reason":"known risk","scope":"one route","compensatingControl":"monitor","expiresAt":"2099-01-01T00:00:00.000Z"}',
  ].join('\n');
  const pending = buildSpecConfirmationCard({ ...spec('pending_confirmation'), content: riskyContent });
  const pendingSerialized = JSON.stringify(pending);
  assert.match(pendingSerialized, /confirm_spec/);
  assert.doesNotMatch(pendingSerialized, /confirm_spec_start/);
  assert.match(pendingSerialized, /必须发布到飞书云文档完成全文评审/);

  const confirmed = buildSpecConfirmationCard({ ...spec('confirmed'), content: riskyContent });
  const confirmedSerialized = JSON.stringify(confirmed);
  assert.match(confirmedSerialized, /publish_spec/);
  assert.doesNotMatch(confirmedSerialized, /confirm_spec_start/);
});

test('缺少稳定需求 ID 的历史待确认卡不显示任何确认入口', () => {
  const card = buildSpecConfirmationCard({
    ...spec('pending_confirmation'),
    content: '## 需要确认\n1. 登录方式是什么？',
  });
  const serialized = JSON.stringify(card);
  assert.doesNotMatch(serialized, /confirm_spec/);
  assert.doesNotMatch(serialized, /confirm_spec_start/);
  assert.match(serialized, /reject_spec/);
  assert.match(serialized, /不提供确认入口/);
});

test('云文档标题会去掉换行并截断到飞书上限', () => {
  assert.equal(
    sanitizeDocumentTitle('产品 Spec · 目标\n第二行还有很多字'),
    '产品 Spec · 目标 第二行还有很多字',
  );
  assert.equal(sanitizeDocumentTitle('   '), '产品 Spec');
  assert.equal(sanitizeDocumentTitle('a'.repeat(801)).length, 800);
  assert.match(sanitizeDocumentTitle('a'.repeat(801)), /…$/);
});

test('飞书 client_token 使用 UUID 形态且同一步幂等', () => {
  const token = documentClientToken('doc:initial', 'insert:0');
  assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(token, documentClientToken('doc:initial', 'insert:0'));
  assert.notEqual(token, documentClientToken('doc:initial', 'insert:1'));
});

test('畸形飞书消息不会打断解析', () => {
  assert.equal(extractMessageText('text', '{bad json'), '');
  assert.equal(extractMessageText('text', '{"text":{"bad":true}}'), '');
  assert.deepEqual(extractResourceKeys('image', 'null'), []);
  assert.deepEqual(parseMentions([null, { key: '', name: '空' }, { key: '@_user_1', id: null }]), [
    { key: '@_user_1', name: '', openId: '' },
  ]);
});

test('提及占位符按长 key 优先还原', () => {
  const text = resolveMentions('@_user_10 请和 @_user_1 评审', [
    { key: '@_user_1', name: '开发', openId: 'ou_1' },
    { key: '@_user_10', name: '评审', openId: 'ou_10' },
  ]);
  assert.equal(text, '@评审 请和 @开发 评审');
});

test('富文本、图片、文件、音视频资源可解析并去重', () => {
  const post = JSON.stringify({
    zh_cn: {
      title: '需求附件',
      content: [[
        { tag: 'text', text: '请查看' },
        { tag: 'img', image_key: 'img_v2_key' },
        { tag: 'img', image_key: 'img_v2_key' },
      ]],
    },
  });
  assert.equal(extractMessageText('post', post), '需求附件\n请查看');
  assert.deepEqual(extractResourceKeys('post', post), [{ type: 'image', key: 'img_v2_key' }]);
  assert.deepEqual(extractResourceKeys('audio', '{"file_key":"file_audio"}'), [
    { type: 'file', key: 'file_audio' },
  ]);
  assert.deepEqual(extractResourceKeys('media', '{"file_key":"file_video","file_name":"demo.mp4"}'), [
    { type: 'file', key: 'file_video', fileName: 'demo.mp4' },
  ]);
});

test('富文本提及后的斜杠命令可被识别', () => {
  const post = JSON.stringify({
    zh_cn: {
      content: [[
        { tag: 'at', user_id: 'ou_bot' },
        { tag: 'text', text: ' /help' },
      ]],
    },
  });
  const text = extractMessageText('post', post);
  assert.equal(text, '@ou_bot /help');
  assert.deepEqual(parseCommand(text), { name: 'help' });
});

test('飞书资源 key 不能控制本地保存路径', () => {
  const name = resourceLocalName('../../outside', 'file', 'report.pdf', 'application/pdf');
  assert.match(name, /^file-[a-f0-9]{32}\.pdf$/);
  assert.equal(resolve('/tmp/downloads', name).startsWith('/tmp/downloads/'), true);
  assert.doesNotMatch(name, /outside|\.\./);
});
