import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentPromptSection } from '../src/app/cli-execution.js';
import { getCliAdapter } from '../src/cli/registry.js';
import type { CliAttachment } from '../src/cli/types.js';

const attachments: CliAttachment[] = [
  { path: '/abs/downloads/img_1.png', type: 'image' },
  { path: '/abs/downloads/file_1.pdf', type: 'file', fileName: '需求.pdf' },
];

test('attachment section lists absolute paths and original names for the prompt', () => {
  assert.equal(attachmentPromptSection([]), '');
  const section = attachmentPromptSection(attachments);
  assert.match(section, /图片：\/abs\/downloads\/img_1\.png/);
  assert.match(section, /文件：\/abs\/downloads\/file_1\.pdf（原文件名：需求\.pdf）/);
  assert.match(section, /先读取这些文件/);
});

test('codex forwards images with -i on fresh and resumed runs; files stay prompt-only', () => {
  const codex = getCliAdapter('codex');
  for (const args of [
    codex.buildArgs('task', 'argument', attachments),
    codex.buildResumeArgs('task', 'thread-1', 'argument', attachments),
  ]) {
    const imageIndex = args.indexOf('-i');
    assert.notEqual(imageIndex, -1);
    assert.equal(args[imageIndex + 1], '/abs/downloads/img_1.png');
    assert.equal(args.filter((arg) => arg === '-i').length, 1);
    assert.ok(imageIndex < args.indexOf('task'), 'options must precede the positional prompt');
    assert.ok(!args.includes('/abs/downloads/file_1.pdf'));
  }
  assert.ok(!codex.buildResumeArgs('task', 'thread-1', 'argument', attachments).includes('-i', codex.buildResumeArgs('task', 'thread-1', 'argument', attachments).indexOf('thread-1')));
  assert.deepEqual(codex.buildArgs('task', 'argument', []), codex.buildArgs('task', 'argument'));
});

test('claude and cursor rely on the prompt paths and ignore attachments in their arguments', () => {
  for (const id of ['claude', 'cursor'] as const) {
    const adapter = getCliAdapter(id);
    assert.deepEqual(adapter.buildArgs('task', 'argument', attachments), adapter.buildArgs('task', 'argument'));
    assert.deepEqual(
      adapter.buildResumeArgs('task', 'session', 'argument', attachments),
      adapter.buildResumeArgs('task', 'session', 'argument'),
    );
  }
});
