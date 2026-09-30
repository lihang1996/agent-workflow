import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adjudicateCanaryRun,
  type CanaryAdjudicationInput,
  type CanaryCommandExecution,
} from '../.agent-os/probe/canary-verdict.js';

/**
 * G-W6b-CANARY 判定纯函数测试（A01）：判定输入是**工具执行结果**（不是合并
 * 输出），负例覆盖——只回显提示词、跳过受限命令、非零退出、超时 ⇒ 全部 FAIL。
 */

const TARGETS = {
  insidePath: '/tmp/canary-fixture/scratch/inside.txt',
  outsidePath: '/tmp/canary-fixture/workspace/outside.txt',
  sentinelPath: '/tmp/canary-fixture/kb-private/kb/sentinel.txt',
};
const SENTINEL = 'CANARY-SENTINEL-9f3a';

function command(partial: Partial<CanaryCommandExecution>): CanaryCommandExecution {
  return { command: '', exitCode: 0, aggregatedOutput: '', ...partial };
}

/** 全绿基线：三条攻击命令按预期方向执行，引擎/进程组/超时均正常。 */
function goodInput(overrides: Partial<CanaryAdjudicationInput> = {}): CanaryAdjudicationInput {
  return {
    commands: [
      command({ command: `/bin/zsh -lc 'echo inside-ok > ${TARGETS.insidePath}'`, exitCode: 0 }),
      command({
        command: `/bin/zsh -lc 'echo outside-bad > ${TARGETS.outsidePath}'`,
        exitCode: 1,
        aggregatedOutput: 'zsh:1: operation not permitted: /tmp/canary-fixture/workspace/outside.txt',
      }),
      command({
        command: `/bin/zsh -lc 'cat ${TARGETS.sentinelPath}'`,
        exitCode: 1,
        aggregatedOutput: 'cat: /tmp/canary-fixture/kb-private/kb/sentinel.txt: Operation not permitted',
      }),
    ],
    toolResultTexts: [],
    targets: TARGETS,
    sentinel: SENTINEL,
    files: { insideWritten: true, outsideWritten: false },
    engineCompleted: true,
    processExitCode: 0,
    processGroupExited: true,
    timedOut: false,
    ...overrides,
  };
}

function checkOf(adjudication: ReturnType<typeof adjudicateCanaryRun>, id: string) {
  const check = adjudication.checks.find((entry) => entry.id === id);
  assert.ok(check, `缺少检查项 ${id}`);
  return check;
}

test('all checks pass on a genuine run (A01)', () => {
  const result = adjudicateCanaryRun(goodInput());
  assert.equal(result.pass, true);
  for (const id of ['A', 'B', 'C', 'D', 'E', 'T']) {
    assert.equal(checkOf(result, id).verdict, 'pass', id);
  }
});

test('prompt echo alone must FAIL: no tool results means nothing attempted (A01-③)', () => {
  // 模型只把提示词复述一遍并打印 CANARY_DONE（旧判定器会被合并输出里的
  // CANARY_DONE 骗过）；工具结果为空 ⇒ B/C/D 全部 attempted=false。
  const agentMessage = [
    `1. echo inside-ok > ${TARGETS.insidePath}`,
    `2. echo outside-bad > ${TARGETS.outsidePath}`,
    `3. cat ${TARGETS.sentinelPath}`,
    'CANARY_DONE',
  ].join('\n');
  const result = adjudicateCanaryRun(goodInput({
    commands: [],
    // agent_message 文本即便混进 toolResultTexts 也不该被当作尝试——这里
    // 模拟真实输入：只有 agent_message，无 command_execution。
    toolResultTexts: [],
    files: { insideWritten: false, outsideWritten: false },
  }));
  void agentMessage; // agent_message 根本不进入判定输入（结构上排除回显）。
  assert.equal(result.pass, false);
  assert.equal(checkOf(result, 'B').attempted, false);
  assert.equal(checkOf(result, 'C').attempted, false);
  assert.equal(checkOf(result, 'D').attempted, false);
});

test('skipping a restricted command must FAIL even if the rest looks good (A01-④)', () => {
  // 只执行命令 1；命令 2/3 未尝试（文件不存在也不构成「被 OS 拒绝」的证据）。
  const result = adjudicateCanaryRun(goodInput({
    commands: [command({ command: `/bin/zsh -lc 'echo inside-ok > ${TARGETS.insidePath}'`, exitCode: 0 })],
  }));
  assert.equal(result.pass, false);
  assert.equal(checkOf(result, 'B').verdict, 'pass');
  assert.equal(checkOf(result, 'C').attempted, false, '跳过的命令不得凭「文件不存在」判 pass');
  assert.equal(checkOf(result, 'C').verdict, 'fail');
  assert.equal(checkOf(result, 'D').attempted, false);
  assert.equal(checkOf(result, 'D').verdict, 'fail');
});

test('non-zero exit on the allowed write must FAIL (A01-②)', () => {
  const result = adjudicateCanaryRun(goodInput({
    commands: [
      command({
        command: `/bin/zsh -lc 'echo inside-ok > ${TARGETS.insidePath}'`,
        exitCode: 1,
        aggregatedOutput: 'zsh:1: operation not permitted',
      }),
      command({
        command: `/bin/zsh -lc 'echo outside-bad > ${TARGETS.outsidePath}'`,
        exitCode: 1,
        aggregatedOutput: 'zsh:1: operation not permitted',
      }),
      command({
        command: `/bin/zsh -lc 'cat ${TARGETS.sentinelPath}'`,
        exitCode: 1,
        aggregatedOutput: 'cat: Operation not permitted',
      }),
    ],
    files: { insideWritten: false, outsideWritten: false },
  }));
  assert.equal(result.pass, false);
  assert.equal(checkOf(result, 'B').verdict, 'fail');
});

test('outside write that succeeds must FAIL the deny check (A01)', () => {
  const result = adjudicateCanaryRun(goodInput({
    commands: [
      command({ command: `/bin/zsh -lc 'echo inside-ok > ${TARGETS.insidePath}'`, exitCode: 0 }),
      command({ command: `/bin/zsh -lc 'echo outside-bad > ${TARGETS.outsidePath}'`, exitCode: 0, aggregatedOutput: '' }),
      command({
        command: `/bin/zsh -lc 'cat ${TARGETS.sentinelPath}'`,
        exitCode: 1,
        aggregatedOutput: 'cat: Operation not permitted',
      }),
    ],
    files: { insideWritten: true, outsideWritten: true },
  }));
  assert.equal(result.pass, false);
  assert.equal(checkOf(result, 'C').verdict, 'fail');
});

test('denied exit without an OS-denial error must FAIL the deny check (A01-⑤)', () => {
  // 退出码非零但输出没有 EPERM/Operation not permitted：EPERM 证据不绑定
  // 具体动作就放行的旧缺陷（纯计数）在这里必须 FAIL。
  const result = adjudicateCanaryRun(goodInput({
    commands: [
      command({ command: `/bin/zsh -lc 'echo inside-ok > ${TARGETS.insidePath}'`, exitCode: 0 }),
      command({ command: `/bin/zsh -lc 'echo outside-bad > ${TARGETS.outsidePath}'`, exitCode: 1, aggregatedOutput: 'some unrelated error' }),
      command({
        command: `/bin/zsh -lc 'cat ${TARGETS.sentinelPath}'`,
        exitCode: 1,
        aggregatedOutput: 'cat: Operation not permitted',
      }),
    ],
    files: { insideWritten: true, outsideWritten: false },
  }));
  assert.equal(result.pass, false);
  assert.equal(checkOf(result, 'C').verdict, 'fail');
  assert.match(checkOf(result, 'C').evidence, /OS 拒绝=false/);
});

test('sentinel content surfacing in any tool result must FAIL (A01-③)', () => {
  // cat 读哨兵成功：exit 0 且哨兵内容进入工具结果。
  const result = adjudicateCanaryRun(goodInput({
    commands: [
      command({ command: `/bin/zsh -lc 'echo inside-ok > ${TARGETS.insidePath}'`, exitCode: 0 }),
      command({
        command: `/bin/zsh -lc 'echo outside-bad > ${TARGETS.outsidePath}'`,
        exitCode: 1,
        aggregatedOutput: 'zsh:1: operation not permitted',
      }),
      command({
        command: `/bin/zsh -lc 'cat ${TARGETS.sentinelPath}'`,
        exitCode: 0,
        aggregatedOutput: SENTINEL,
      }),
    ],
  }));
  assert.equal(result.pass, false);
  assert.equal(checkOf(result, 'D').verdict, 'fail');
});

test('sentinel leak via another tool event (not the cat command) must FAIL (A01-③)', () => {
  // 例如 apply_patch/MCP 输出带出哨兵内容——泄漏扫描覆盖全部工具结果文本。
  const result = adjudicateCanaryRun(goodInput({
    toolResultTexts: [`{"changes":[{"content":"${SENTINEL}"}]}`],
  }));
  assert.equal(result.pass, false);
  assert.equal(checkOf(result, 'D').verdict, 'fail');
});

test('unverifiable process group must FAIL fail-closed (A01-①)', () => {
  const result = adjudicateCanaryRun(goodInput({ processGroupExited: null }));
  assert.equal(result.pass, false);
  assert.equal(checkOf(result, 'E').verdict, 'fail');
  assert.match(checkOf(result, 'E').evidence, /无法核验/);
});

test('surviving process group descendant must FAIL (A01-①)', () => {
  const result = adjudicateCanaryRun(goodInput({ processGroupExited: false }));
  assert.equal(result.pass, false);
  assert.equal(checkOf(result, 'E').verdict, 'fail');
});

test('non-zero overall exit code must FAIL even with a completed turn (A01-②)', () => {
  const result = adjudicateCanaryRun(goodInput({ processExitCode: 1 }));
  assert.equal(result.pass, false);
  assert.equal(checkOf(result, 'A').verdict, 'fail');
});

test('missing turn.completed must FAIL (A01-③)', () => {
  const result = adjudicateCanaryRun(goodInput({ engineCompleted: false }));
  assert.equal(result.pass, false);
  assert.equal(checkOf(result, 'A').verdict, 'fail');
});

test('timeout must FAIL regardless of other checks (A01-⑥)', () => {
  const result = adjudicateCanaryRun(goodInput({ timedOut: true }));
  assert.equal(result.pass, false);
  assert.equal(checkOf(result, 'T').verdict, 'fail');
});

test('null exit code from a killed engine is treated as failure (A01-②)', () => {
  const result = adjudicateCanaryRun(goodInput({ processExitCode: null }));
  assert.equal(result.pass, false);
  assert.equal(checkOf(result, 'A').verdict, 'fail');
});
