/**
 * AO-REQ-603：经 agent-os ZcodeAdapter 真实探测官方 ZCode CLI（headless）。
 *
 * - 探测任务在临时目录执行，不触碰业务仓库；不启动任何飞书 Bot/投递链路
 *   （request_clarification 的 MCP 端只回文本，卡片由主进程投递，探测不经过主进程）。
 * - 原始 stdout（onRawLine）与归一化事件、判定结论全部落盘 .agent-os/probe/，
 *   供矩阵审计；结论只认真实运行结果，不因独立 CLI 成功而推定 adapter 成功。
 *
 * ⚠️ 已知全局副作用（Codex 返修 4）：runCli 对 zcode 会先执行
 * ensureZcodeAppToolsConfig()，把 agent_os MCP server 条目合并进用户全局
 * ~/.zcode/cli/config.json。官方 CLI 0.16.9 没有可核验的配置目录隔离面
 * （ZCODE_HOME 仅遥测；ZCODE_DATA_BASE_DIR 仅 provider 文件发现；重定向
 * HOME 会同时丢登录态与 provider 配置，探测无法认证）——隔离不可实现也
 * 未经验证。因此本脚本默认拒绝运行，除非显式设置
 * PROBE_ZCODE_ALLOW_GLOBAL_CONFIG=1 确认接受该全局写入。既有 Z1/Z2/Z4
 * 成功样本保留在 .agent-os/probe/ 下，不因本限制作废。
 *
 * 用法：PROBE_ZCODE_ALLOW_GLOBAL_CONFIG=1 pnpm probe:zcode-adapter
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli/runner.js';
import { getCliAdapter } from './cli/registry.js';
import { planExecutionModel } from './app/execution-model.js';
import { createProductionIsolationPreparer } from './core/isolation.js';
import type { AppToolName } from './core/app-tool-policy.js';
import type { CliEvent, CliRunResult } from './cli/types.js';

const PROBE_TIMEOUT_MS = 4 * 60 * 1000;
const probeDir = join(
  '.agent-os',
  'probe',
  `zcode-adapter-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);

interface CaseRecord {
  case: 'cli' | 'Z1' | 'Z2' | 'Z3' | 'Z4';
  status: 'pass' | 'fail' | 'blocked' | 'skip';
  detail: string;
  evidence?: string[];
}

const records: CaseRecord[] = [];

function note(value: CaseRecord): void {
  records.push(value);
  console.log(`[${value.case}] ${value.status.toUpperCase()} — ${value.detail}`);
}

interface RunOutcome {
  events: CliEvent[];
  rawLines: string[];
  result: CliRunResult | undefined;
  error: string | undefined;
}

async function runThroughAdapter(options: {
  prompt: string;
  cwd: string;
  sessionId?: string;
  tools?: readonly AppToolName[];
  logName: string;
}): Promise<RunOutcome> {
  const adapter = getCliAdapter('zcode', options.tools ?? []);
  const events: CliEvent[] = [];
  const rawLines: string[] = [];
  const argv = options.sessionId
    ? adapter.buildResumeArgs(options.prompt, options.sessionId, 'argument')
    : adapter.buildArgs(options.prompt, 'argument');
  writeFileSync(
    join(probeDir, `${options.logName}.argv.json`),
    `${JSON.stringify({ command: adapter.command, args: argv }, null, 2)}\n`,
  );
  try {
    const result = await runCli({
      adapter,
      prompt: options.prompt,
      cwd: options.cwd,
      sessionId: options.sessionId,
      timeoutMs: PROBE_TIMEOUT_MS,
      // T-022：探测与生产同一失败关闭边界；本脚本已有 PROBE_ZCODE_ALLOW_GLOBAL_CONFIG
      // 环境门禁，隔离证据缺失时如实 blocked，不作为旁路。
      isolation: createProductionIsolationPreparer(),
      onEvent: (event) => events.push(event),
      onRawLine: (line) => rawLines.push(line),
    });
    return { events, rawLines, result, error: undefined };
  } catch (error) {
    return { events, rawLines, result: undefined, error: (error as Error).message };
  } finally {
    writeFileSync(join(probeDir, `${options.logName}.events.ndjson`), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    writeFileSync(join(probeDir, `${options.logName}.raw.ndjson`), `${rawLines.join('\n')}\n`);
  }
}

async function main(): Promise<void> {
  if (process.env.PROBE_ZCODE_ALLOW_GLOBAL_CONFIG !== '1') {
    console.error(
      [
        'probe:zcode-adapter 默认不运行：经 runCli 执行会合并写入用户全局 ~/.zcode/cli/config.json，',
        '而官方 CLI 0.16.9 的配置目录隔离不可核验（详见脚本头部说明）。',
        '如确认接受该全局写入，请使用：PROBE_ZCODE_ALLOW_GLOBAL_CONFIG=1 pnpm probe:zcode-adapter',
      ].join('\n'),
    );
    process.exitCode = 2;
    return;
  }
  // 守卫通过后才加载 .env（探测 CLI 需要 ZCODE_*_PROVIDER_CONFIG_FILE）；
  // 拒绝路径不读取任何环境文件。
  await import('dotenv/config');
  mkdirSync(probeDir, { recursive: true });
  const workspace = mkdtempSync(join(tmpdir(), 'agent-os-zcode-probe-'));
  console.log(`探测工作区：${workspace}`);
  console.log(`证据目录：${probeDir}`);
  let firstSessionId: string | undefined;

  try {
    // CLI 可运行性
    const version = spawnSync('zcode', ['--version'], { encoding: 'utf8' });
    if (version.status === 0) {
      note({ case: 'cli', status: 'pass', detail: `zcode ${version.stdout.trim()} 可运行` });
    } else {
      note({ case: 'cli', status: 'blocked', detail: `zcode --version 失败：${version.stderr.trim()}` });
      return;
    }

    // Z1 新建会话
    const z1 = await runThroughAdapter({
      prompt: 'Reply with exactly: pong. 不要调用任何工具，不要写任何文件。',
      cwd: workspace,
      logName: 'Z1-new-session',
    });
    const sessionEvent = z1.events.find(
      (event): event is Extract<CliEvent, { type: 'session' }> => event.type === 'session',
    );
    firstSessionId = z1.result?.sessionId ?? sessionEvent?.sessionId;
    if (z1.result && /pong/i.test(z1.result.answer) && firstSessionId) {
      note({
        case: 'Z1',
        status: 'pass',
        detail: `新建会话成功 sessionId=${firstSessionId} answer=${JSON.stringify(z1.result.answer.slice(0, 80))}`,
        evidence: ['Z1-new-session.raw.ndjson', 'Z1-new-session.events.ndjson'],
      });
    } else {
      note({
        case: 'Z1',
        status: 'fail',
        detail: `新建会话未成功：${z1.error ?? `answer=${JSON.stringify(z1.result?.answer)}`}`,
        evidence: ['Z1-new-session.raw.ndjson'],
      });
    }

    // Z2 续接
    if (firstSessionId) {
      const z2 = await runThroughAdapter({
        prompt: '上一轮我说的话是什么？只用英文双引号原样回答。',
        cwd: workspace,
        sessionId: firstSessionId,
        logName: 'Z2-resume',
      });
      const resumed = z2.events.some((event) => event.type === 'session');
      if (z2.result && resumed && /pong/i.test(z2.result.answer)) {
        note({
          case: 'Z2',
          status: 'pass',
          detail: `续接成功（上下文可回忆 pong）sessionId=${z2.result.sessionId ?? firstSessionId}`,
          evidence: ['Z2-resume.raw.ndjson', 'Z2-resume.events.ndjson'],
        });
      } else if (z2.result && resumed) {
        note({
          case: 'Z2',
          status: 'fail',
          detail: `续接有结果但上下文未命中：${JSON.stringify(z2.result.answer.slice(0, 80))}`,
          evidence: ['Z2-resume.raw.ndjson'],
        });
      } else {
        note({
          case: 'Z2',
          status: 'fail',
          detail: `续接失败：${z2.error ?? '未观察到 session/resumed 事件或结果'}`,
          evidence: ['Z2-resume.raw.ndjson'],
        });
      }
    } else {
      note({ case: 'Z2', status: 'skip', detail: 'Z1 未产出 sessionId，续接无从探测' });
    }

    // Z3 模型声明（矩阵外组合必须显式 blocked，不允许静默原生默认）
    const zcodeModelOverride = {
      zcode: { model: 'glm-5.3', reasoningEffort: 'high' },
    } as const;
    try {
      await planExecutionModel(zcodeModelOverride, { cliId: 'zcode' }, { command: 'zcode' });
      note({ case: 'Z3', status: 'fail', detail: 'zcode 显式模型未被拒绝——违反 R-MDL-1，需要修复' });
    } catch (error) {
      note({
        case: 'Z3',
        status: 'blocked',
        detail: `zcode headless 无模型参数，显式声明被正确拒绝：${(error as Error).message}`,
      });
    }

    // Z4 业务工具（MCP agent_os server 在场时 request_clarification 调用链）
    const z4 = await runThroughAdapter({
      prompt: [
        '请立即调用 request_clarification 工具（MCP agent_os server 已注入），只提一个问题："这是 Z4 探测问题，选一个"，给 A、B 两个选项。',
        '调用完成后停止本轮，不要再做其他事。不要写文件。',
      ].join('\n'),
      cwd: workspace,
      tools: ['request_clarification'],
      logName: 'Z4-business-tool',
    });
    const clarificationCall = z4.result?.toolCalls?.find(
      (call) => call.toolName === 'request_clarification',
    );
    if (clarificationCall && z4.result) {
      note({
        case: 'Z4',
        status: 'pass',
        detail: 'request_clarification 经 mcp__agent_os__ 调用链成功产生 tool_call 事件',
        evidence: ['Z4-business-tool.raw.ndjson', 'Z4-business-tool.events.ndjson'],
      });
    } else {
      note({
        case: 'Z4',
        status: 'fail',
        detail: `业务工具调用未观察到：${z4.error ?? `answer=${JSON.stringify(z4.result?.answer?.slice(0, 120))}`}`,
        evidence: ['Z4-business-tool.raw.ndjson'],
      });
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    const report = {
      probedAt: new Date().toISOString(),
      adapter: 'src/cli/zcode-adapter.ts',
      workspacePolicy: '一次性临时目录（mkdtemp），未触碰业务仓库，未连接飞书',
      cases: records,
    };
    writeFileSync(join(probeDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n探测结论已写入 ${join(probeDir, 'report.json')}`);
    const failed = records.filter((r) => r.status === 'fail');
    if (failed.length) {
      console.log(`有 ${failed.length} 项失败；矩阵不得把 zcode 标记为默认可用。`);
      process.exitCode = 1;
    }
  }
}

await main();
