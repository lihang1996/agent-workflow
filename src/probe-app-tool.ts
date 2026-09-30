import { resolve } from 'node:path';
import { getCliAdapter } from './cli/registry.js';
import { runCli } from './cli/runner.js';
import { CLI_IDS, type CliId } from './cli/types.js';
import { createProductionIsolationPreparer } from './core/isolation.js';

const cliId = process.argv[2] as CliId | undefined;
const workspace = process.argv[3] ?? process.cwd();
if (!cliId || !(CLI_IDS as readonly string[]).includes(cliId)) {
  console.error(`用法：pnpm probe:tool <${CLI_IDS.join('|')}>`);
  process.exit(1);
}

const adapter = getCliAdapter(cliId, ['request_clarification']);
const result = await runCli({
  adapter,
  cwd: resolve(workspace),
  // T-022：探测脚本与生产同一失败关闭边界（缺受保护根清单/能力证据即 blocked），
  // 不得作为绕过隔离的旁路。
  isolation: createProductionIsolationPreparer(),
  prompt: [
    '我们准备给任务列表增加优先级功能。',
    '请调用 request_clarification，询问一个会实质影响实现范围的问题。',
    '提供 2 到 4 个清晰选项，并标记推荐项。',
    '调用工具后，用一句话结束。',
  ].join('\n'),
  onEvent(event) {
    if (event.type !== 'tool_call') return;
    console.log(`\n[应用工具] ${event.toolName}`);
    console.log(JSON.stringify(event.input, null, 2));
  },
});

if (!result.toolCalls?.length) {
  throw new Error(`${adapter.displayName} 没有调用 request_clarification`);
}

console.log(`\n[完成] ${adapter.displayName} 返回 ${result.toolCalls.length} 次应用工具调用`);
