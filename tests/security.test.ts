import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isAuthorizedOperator } from '../src/core/access.js';
import { assertLogFile, buildLogInspectionPrompt, readLogTail } from '../src/core/log-inspection.js';
import { isHighRiskTask } from '../src/core/risk.js';
import { assertWorkdir } from '../src/core/workdir.js';

test('群聊默认拒绝，配置 owner 后只允许 owner', () => {
  const previousOwner = process.env.OWNER_OPEN_ID;
  const previousAllowed = process.env.AGENT_OS_ALLOWED_OPEN_IDS;
  delete process.env.OWNER_OPEN_ID;
  delete process.env.AGENT_OS_ALLOWED_OPEN_IDS;
  assert.equal(isAuthorizedOperator({ senderOpenId: 'ou_a', chatType: 'group' }), false);
  assert.equal(isAuthorizedOperator({ senderOpenId: 'ou_a', chatType: 'p2p' }), true);
  process.env.OWNER_OPEN_ID = 'ou_owner';
  assert.equal(isAuthorizedOperator({ senderOpenId: 'ou_owner', chatType: 'group' }), true);
  assert.equal(isAuthorizedOperator({ senderOpenId: 'ou_other', chatType: 'group' }), false);
  if (previousOwner === undefined) delete process.env.OWNER_OPEN_ID;
  else process.env.OWNER_OPEN_ID = previousOwner;
  if (previousAllowed === undefined) delete process.env.AGENT_OS_ALLOWED_OPEN_IDS;
  else process.env.AGENT_OS_ALLOWED_OPEN_IDS = previousAllowed;
});

test('常见破坏性命令会进入审批', () => {
  for (const prompt of [
    '运行 rm -rf ./data',
    'sudo chmod 777 /tmp/demo',
    'git push -f origin main',
    'docker system prune',
    'kubectl delete deployment api',
  ]) {
    assert.equal(isHighRiskTask(prompt), true, prompt);
  }
});

test('工作目录和日志不能通过符号链接逃出允许根目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'agent-os-outside-'));
  const previousRoots = process.env.AGENT_OS_ALLOWED_ROOTS;
  process.env.AGENT_OS_ALLOWED_ROOTS = root;
  try {
    const project = join(root, 'project');
    await mkdir(project);
    assert.equal(await assertWorkdir(project), await realpath(project));
    const outsideLog = join(outside, 'server.log');
    await writeFile(outsideLog, 'secret');
    const link = join(root, 'linked.log');
    await symlink(outsideLog, link);
    await assert.rejects(() => assertLogFile(link), /不在 Agent OS 允许范围/);
  } finally {
    if (previousRoots === undefined) delete process.env.AGENT_OS_ALLOWED_ROOTS;
    else process.env.AGENT_OS_ALLOWED_ROOTS = previousRoots;
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('日志由宿主读取、限制行数并脱敏', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-log-'));
  const previousRoots = process.env.AGENT_OS_ALLOWED_ROOTS;
  process.env.AGENT_OS_ALLOWED_ROOTS = root;
  try {
    const path = join(root, 'server.log');
    await writeFile(path, ['old', 'password=hello', 'Authorization: Bearer abc.def', 'last'].join('\n'));
    const tail = await readLogTail(path, 3);
    assert.equal(tail.includes('old'), false);
    const prompt = buildLogInspectionPrompt(path, tail);
    assert.equal(prompt.includes('hello'), false);
    assert.equal(prompt.includes('abc.def'), false);
    assert.match(prompt, /不可信数据/);
  } finally {
    if (previousRoots === undefined) delete process.env.AGENT_OS_ALLOWED_ROOTS;
    else process.env.AGENT_OS_ALLOWED_ROOTS = previousRoots;
    await rm(root, { recursive: true, force: true });
  }
});
