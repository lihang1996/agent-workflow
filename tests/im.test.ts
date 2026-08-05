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
import { resourceLocalName } from '../src/im/lark.js';

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
