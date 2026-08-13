import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_PIPELINE_STEPS } from '../src/core/pipeline.js';
import {
  RuntimeSourceChangedError,
  RuntimeSourceGuard,
} from '../src/core/runtime-source-guard.js';
import { JsonWorkflowStore } from '../src/core/workflow-store.js';
import type { AppContext } from '../src/runtime/app-context.js';
import {
  continueDeliveryWorkflow,
  pauseForRuntimeSourceChangeIfNeeded,
  resumeBlockedWorkflowStep,
} from '../src/runtime/pipeline-runner.js';

async function write(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, ...path.split('/'));
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, content);
}

test('运行时源码快照只追踪 Agent OS 控制面文件，不受业务项目变化影响', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-runtime-source-scope-'));
  try {
    await Promise.all([
      write(root, 'src/index.ts', 'export const version = 1;'),
      write(root, 'skills/delivery/SKILL.md', '# Delivery v1'),
      write(root, 'skills/delivery/scripts/check.mjs', 'export default 1;'),
      write(root, 'scripts/verify.mjs', 'export default 1;'),
      write(root, 'scripts/nested/ignored.mjs', 'export default 1;'),
      write(root, 'package.json', '{"name":"fixture"}'),
      write(root, '.env', 'SECRET=first'),
      write(root, 'dist/index.js', 'export const version = 1;'),
      write(root, 'data/runtime.json', '{"state":1}'),
      write(root, 'node_modules/pkg/index.js', 'module.exports = 1;'),
      write(root, 'leon-blog/src/app.ts', 'export const app = 1;'),
    ]);

    const guard = await RuntimeSourceGuard.capture(root);
    await Promise.all([
      write(root, 'leon-blog/src/app.ts', 'export const app = 2;'),
      write(root, 'data/runtime.json', '{"state":2}'),
      write(root, 'node_modules/pkg/index.js', 'module.exports = 2;'),
      write(root, 'dist/index.js', 'export const version = 2;'),
      write(root, 'scripts/nested/ignored.mjs', 'export default 2;'),
    ]);
    assert.equal((await guard.compare()).changed, false);

    await Promise.all([
      write(root, 'src/index.ts', 'export const version = 3;'),
      write(root, 'skills/delivery/SKILL.md', '# Delivery v3'),
      write(root, 'skills/delivery/scripts/check.mjs', 'export default 3;'),
      write(root, 'scripts/verify.mjs', 'export default 3;'),
      write(root, 'package.json', '{"name":"fixture","version":"3"}'),
      write(root, '.env', 'SECRET=third'),
    ]);
    const comparison = await guard.compare();
    assert.equal(comparison.changed, true);
    assert.deepEqual(comparison.modified, [
      '.env',
      'package.json',
      'scripts/verify.mjs',
      'skills/delivery/SKILL.md',
      'skills/delivery/scripts/check.mjs',
      'src/index.ts',
    ]);
    await assert.rejects(guard.assertCurrent(), (error) => {
      assert.ok(error instanceof RuntimeSourceChangedError);
      assert.match(error.message, /Agent OS 源码已更新，请重启服务后重试/);
      // .env 内容只参与 hash，不会进入错误或快照字段。
      assert.doesNotMatch(JSON.stringify(error), /SECRET=third/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dist 仅在生产运行模式加入快照，tsx 模式不会被单独 rebuild 误阻塞', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-runtime-source-dist-'));
  try {
    await Promise.all([
      write(root, 'src/index.ts', 'export const source = 1;'),
      write(root, 'dist/index.js', 'export const built = 1;'),
      write(root, 'package.json', '{"name":"fixture"}'),
    ]);
    const sourceMode = await RuntimeSourceGuard.capture(root);
    const distMode = await RuntimeSourceGuard.capture(root, { includeDist: true });

    await write(root, 'dist/index.js', 'export const built = 2;');
    assert.equal((await sourceMode.compare()).changed, false);
    const distComparison = await distMode.compare();
    assert.equal(distComparison.changed, true);
    assert.deepEqual(distComparison.modified, ['dist/index.js']);

    const newFileMode = await RuntimeSourceGuard.capture(root, { includeDist: true });
    await write(root, 'dist/runtime/new-module.js', 'export default true;');
    assert.deepEqual((await newFileMode.compare()).added, ['dist/runtime/new-module.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('非 PM 技术步骤在读取业务项目之前原子暂停，陈旧进程不能重试', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-runtime-source-pause-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const projectRoot = join(root, 'leon-blog');
    const created = await workflows.create({
      kind: 'team',
      name: '团队交付流水线',
      initiatorBotId: 'ceo',
      goal: '更新博客',
      stepIds: DEFAULT_PIPELINE_STEPS.map((step) => step.id),
      qualityPolicy: 'gated',
      projectRoot,
      message: {
        messageId: 'om-source-drift',
        topicId: 'omt-source-drift',
        chatId: 'oc-source-drift',
        chatType: 'group',
        rootId: '',
        threadId: 'omt-source-drift',
        senderOpenId: 'ou-owner',
      },
    });
    await workflows.update(created.id, {
      nextStepIndex: 1,
      priorOutputs: { pm: '### RQ-001 更新博客' },
    });

    let projectReads = 0;
    const cards: unknown[] = [];
    const staleGuard = {
      assertCurrent: async () => { throw new RuntimeSourceChangedError(); },
    };
    const ctx = {
      shuttingDown: false,
      workflows,
      runtimeSourceGuard: staleGuard,
      topics: {
        getWorkdir: () => {
          projectReads += 1;
          throw new Error('源码 guard 之前不应读取 leon-blog 绑定');
        },
      },
      botsById: new Map([['ceo', {
        id: 'ceo',
        name: 'CEO',
        replyCard: async (_messageId: string, card: unknown) => {
          cards.push(card);
          return 'om-card';
        },
        reply: async () => undefined,
      }]]),
    } as unknown as AppContext;

    await continueDeliveryWorkflow(ctx, created.id);

    const paused = workflows.get(created.id)!;
    assert.equal(paused.status, 'awaiting_step_unblock');
    assert.equal(paused.nextStepIndex, 1);
    assert.equal(paused.priorOutputs.runtime_source_changed, 'Agent OS 源码已更新，请重启服务后重试。');
    assert.match(paused.priorOutputs.blocked_architect ?? '', /Agent OS 源码已更新/);
    assert.match(paused.error ?? '', /请重启服务后重试/);
    assert.equal(projectReads, 0);
    assert.equal(cards.length, 1);

    const pausedVersion = paused.updatedAt;
    await assert.rejects(
      resumeBlockedWorkflowStep(ctx, created.id),
      /Agent OS 源码已更新，请重启服务后重试/,
    );
    assert.equal(workflows.get(created.id)?.status, 'awaiting_step_unblock');
    assert.equal(workflows.get(created.id)?.updatedAt, pausedVersion);
    assert.equal(workflows.get(created.id)?.priorOutputs.runtime_source_changed !== undefined, true);
    assert.equal(projectReads, 0);
    assert.equal(cards.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('新进程校验通过后原子清理源码阻塞 marker，并从原步骤进入 ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-runtime-source-resume-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const projectRoot = join(root, 'leon-blog');
    const created = await workflows.create({
      kind: 'team',
      name: '团队交付流水线',
      initiatorBotId: 'ceo',
      goal: '更新博客',
      stepIds: DEFAULT_PIPELINE_STEPS.map((step) => step.id),
      qualityPolicy: 'gated',
      projectRoot,
      message: {
        messageId: 'om-source-resume',
        topicId: 'omt-source-resume',
        chatId: 'oc-source-resume',
        chatType: 'group',
        rootId: '',
        threadId: 'omt-source-resume',
        senderOpenId: 'ou-owner',
      },
    });
    await workflows.update(created.id, {
      status: 'awaiting_step_unblock',
      nextStepIndex: 1,
      priorOutputs: {
        pm: '### RQ-001 更新博客',
        runtime_source_changed: 'Agent OS 源码已更新，请重启服务后重试。',
        blocked_architect: '旧进程源码漂移',
      },
      error: 'Agent OS 源码已更新，请重启服务后重试。',
    });

    let checks = 0;
    const ctx = {
      // 校验后会调用 continueDeliveryWorkflow；测试以停机态代表“已安全排队，等待服务接管”。
      shuttingDown: true,
      workflows,
      runtimeSourceGuard: { assertCurrent: async () => { checks += 1; } },
      topics: { getWorkdir: () => projectRoot },
      botsById: new Map(),
    } as unknown as AppContext;

    const resumed = await resumeBlockedWorkflowStep(ctx, created.id);
    assert.equal(checks, 1);
    assert.equal(resumed.status, 'ready');
    assert.equal(resumed.nextStepIndex, 1);
    assert.equal(resumed.priorOutputs.runtime_source_changed, undefined);
    assert.equal(resumed.priorOutputs.blocked_architect, undefined);
    assert.equal(resumed.error, undefined);

    // 同一阻塞的并发/重复重试不会再被认领。
    assert.equal(
      await workflows.resumeCurrentRuntimeSourceBlock(created.id, 1, 'architect'),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('结果提交边界即使收到清洗后的普通 Error，也会重新校验并暂停旧控制器', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-runtime-source-commit-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const created = await workflows.create({
      kind: 'team',
      name: '团队交付流水线',
      initiatorBotId: 'ceo',
      goal: '更新博客',
      stepIds: DEFAULT_PIPELINE_STEPS.map((step) => step.id),
      qualityPolicy: 'gated',
      projectRoot: join(root, 'leon-blog'),
      message: {
        messageId: 'om-source-commit',
        topicId: 'omt-source-commit',
        chatId: 'oc-source-commit',
        chatType: 'group',
        rootId: '',
        threadId: 'omt-source-commit',
        senderOpenId: 'ou-owner',
      },
    });
    await workflows.update(created.id, { nextStepIndex: 1, priorOutputs: { pm: 'RQ-001' } });
    await workflows.claimReady(created.id);
    let checks = 0;
    const ctx = {
      workflows,
      runtimeSourceGuard: {
        assertCurrent: async () => {
          checks += 1;
          throw new RuntimeSourceChangedError();
        },
      },
      botsById: new Map([['ceo', {
        id: 'ceo',
        replyCard: async () => 'om-card',
        reply: async () => undefined,
      }]]),
    } as unknown as AppContext;

    assert.equal(await pauseForRuntimeSourceChangeIfNeeded(
      ctx,
      created.id,
      new Error('执行没有完成。你可以调整指令后重试。'),
      { stepIndex: 1, stepId: 'architect' },
    ), true);
    assert.equal(checks, 1);
    assert.equal(workflows.get(created.id)?.status, 'awaiting_step_unblock');
    assert.equal(workflows.get(created.id)?.priorOutputs.runtime_source_changed !== undefined, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('最终结算边界发生源码漂移会原子退回 summary，避免旧汇总跨重启复用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-os-runtime-source-finalize-'));
  try {
    const workflows = await JsonWorkflowStore.open(join(root, 'workflows.json'));
    const created = await workflows.create({
      kind: 'team',
      name: '团队交付流水线',
      initiatorBotId: 'ceo',
      goal: '更新博客',
      stepIds: DEFAULT_PIPELINE_STEPS.map((step) => step.id),
      qualityPolicy: 'gated',
      projectRoot: join(root, 'leon-blog'),
      message: {
        messageId: 'om-source-finalize',
        topicId: 'omt-source-finalize',
        chatId: 'oc-source-finalize',
        chatType: 'group',
        rootId: '',
        threadId: 'omt-source-finalize',
        senderOpenId: 'ou-owner',
      },
    });
    const summaryIndex = DEFAULT_PIPELINE_STEPS.length - 1;
    await workflows.update(created.id, {
      nextStepIndex: summaryIndex,
      priorOutputs: { summary: '旧进程生成的汇总' },
    });
    await workflows.claimReady(created.id);
    await workflows.completeCurrentStep(created.id, summaryIndex, 'summary', '旧进程生成的汇总');
    await workflows.claimReady(created.id);
    const ctx = {
      workflows,
      runtimeSourceGuard: { assertCurrent: async () => { throw new RuntimeSourceChangedError(); } },
      botsById: new Map([['ceo', {
        id: 'ceo', replyCard: async () => 'om-card', reply: async () => undefined,
      }]]),
    } as unknown as AppContext;

    assert.equal(await pauseForRuntimeSourceChangeIfNeeded(
      ctx,
      created.id,
      new RuntimeSourceChangedError(),
      { stepIndex: summaryIndex, stepId: 'summary' },
    ), true);
    const paused = workflows.get(created.id)!;
    assert.equal(paused.status, 'awaiting_step_unblock');
    assert.equal(paused.nextStepIndex, summaryIndex);
    assert.equal(paused.priorOutputs.summary, undefined);
    assert.equal(paused.priorOutputs.runtime_source_changed !== undefined, true);
    assert.match(paused.priorOutputs.blocked_summary ?? '', /请重启服务后重试/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
