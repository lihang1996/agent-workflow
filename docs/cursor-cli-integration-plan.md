# Cursor CLI 接入方案（精简版）

状态：待实施。本次目标是在现有 Claude Code、Codex 旁边增加 Cursor CLI，并让后续增加其他 CLI 更方便。

**1．接入目标**

沿用现有调用链：

```text
飞书消息 → 选择 CLI Adapter → 现有 Runner → CLI 子进程
                                      ↓
                           统一事件 → 进度卡和业务处理
```

Cursor 接入后应支持：

- 新话题发送 `/cursor <任务>`，使用 Cursor 执行。
- 机器人配置 `defaultCli: "cursor"`，新话题默认使用 Cursor。
- 同话题继续对话时，使用保存的 Cursor 会话 ID 续接。
- 复用现有进度卡、最终回答、取消、超时和附件处理。
- 通过现有 MCP server 使用澄清、方案确认和任务派发工具，保持现有角色及入口权限。
- `/new`、`/cd`、`/close` 继续遵循现有会话行为。

Cursor 与其他引擎使用同一套业务流程。引擎自身不支持的辅助功能，明确提示即可。Claude/Codex 的现有行为必须保持不变，约束见第 6 节。

**2．核心改动：一个 Adapter，加一个注册项**

新增 `src/cli/cursor-adapter.ts`，实现现有 `CliAdapter`：

| 方法 | 职责 |
| --- | --- |
| `buildArgs()` | 构造 Cursor 新任务参数；遵守现有 `promptInput` 与 `attachments` 签名 |
| `buildResumeArgs()` | 构造指定会话 ID 的续接参数，同样遵守上述签名 |
| `parseEvents()` | 将 Cursor 输出转换成现有 `CliEvent` |
| `buildEnv()`（可选） | 仅 Cursor 声明本轮环境覆盖；未声明的 Adapter 不改 spawn 环境 |

沿用 headless 方式。新建和续接都带 `--force`，以对标 Claude 的 skip-permissions 和 Codex 的 `--yolo`，直接改文件。`--force` 不会覆盖显式 deny 规则。必须传入明确的 session ID，不要使用 `--continue` 或 `--resume=-1`。不要启用 `--stream-partial-output`。

```bash
agent -p --force --output-format stream-json "任务内容"
agent -p --force --output-format stream-json --resume "<session-id>" "继续任务"
```

| 参数 | 本次要求 |
| --- | --- |
| `-p` / `--print`、`--output-format stream-json` | 必加 |
| `--force`（`--yolo` 是别名） | 新建和续接都加；不覆盖显式禁止规则 |
| `--resume <exact-session-id>` | 仅续接；必须是话题里保存的 ID |
| `--model` | 仅当配置了 `CURSOR_CLI_MODEL` 时传入 |
| `--trust` | 只处理工作区信任提示，不是与 `--force` 绑定的必传项；探测后按需再加 |
| `--approve-mcps` | 只处理 MCP 批准，不是固定必传项。也可事先 `agent mcp enable agent_os` |

实际代码使用参数数组启动，不拼接 shell 字符串。执行目录继续使用会话的 `workspaceDir`。`promptInput === 'stdin'` 时不要把 prompt 再拼进参数。Windows 下现有 runner 仍会把 prompt 写入 stdin，必须实测 Cursor 是否真的收到内容；只做到参数里不重复拼接还不够。附件继续走 prompt 中的绝对路径，与官方 headless 用法一致。[Cursor 参数文档](https://cursor.com/docs/cli/reference/parameters)、[Headless 文档](https://cursor.com/docs/cli/headless)

将引擎 ID 集中定义，配置校验、命令解析和引擎校验复用它：

```ts
export const CLI_IDS = ['claude', 'codex', 'cursor'] as const;
export type CliId = typeof CLI_IDS[number];
```

注册层改成工厂表，替换现有“是 Claude，否则就是 Codex”的判断。保留：默认 Claude、无工具参数时的空权限、`listCliAdapters()` 导出；可以继续保留现有空工具单例，避免无谓改变对象身份。

```ts
const factories = {
  claude: (tools: readonly AppToolName[]) => new ClaudeAdapter(tools),
  codex: (tools: readonly AppToolName[]) => new CodexAdapter(tools),
  cursor: (tools: readonly AppToolName[]) => new CursorAdapter(tools),
} satisfies Record<CliId, (tools: readonly AppToolName[]) => CliAdapter>;

const emptyToolAdapters = {
  claude: factories.claude([]),
  codex: factories.codex([]),
  cursor: factories.cursor([]),
} satisfies Record<CliId, CliAdapter>;

export function getCliAdapter(
  id: CliId,
  tools?: readonly AppToolName[],
): CliAdapter {
  return tools ? factories[id](tools) : emptyToolAdapters[id];
}

export function listCliAdapters(): CliAdapter[] {
  return CLI_IDS.map((id) => emptyToolAdapters[id]);
}
```

上述 `emptyToolAdapters.cursor` 会在模块加载时构造，启动时 `listCliAdapters()` 也会碰到它。因此 CursorAdapter 构造和注册不得做安装检查、登录检查或 MCP 配置写入。未安装或未登录 Cursor 时，Claude/Codex 仍能正常启动和运行；仅在选择 Cursor 执行时报告对应错误。

评论入口继续调用 `getCliAdapter(session.cliId)`，不要改成传入角色权限。以后增加其他 CLI，主要是新增 Adapter、加入 ID 和注册工厂。个别原生能力仍按该 CLI 实际支持情况处理，不引入插件系统或通用协议框架。

**3．Cursor 需要适配的差异**

**输出事件。** Cursor 原生 `type: 'tool_call'` 不是现有 `CliEvent.tool_call`。前者是读文件、写文件等进度事件；后者只表示澄清、方案确认、任务派发。Adapter 不得把原生 `tool_call` 原样交给 runner。误映射时，runner 会因工具名或参数对不上业务 schema 而校验失败，不会把它当成一次 `dispatch_task`。[输出格式文档](https://cursor.com/docs/cli/reference/output-format)

| Cursor 原始字段 | 现有 `CliEvent` |
| --- | --- |
| `system.subtype=init` + `session_id` | `{ type: 'session', sessionId }` |
| `tool_call.subtype=started` + `call_id` | `{ type: 'tool_start', toolUseId: call_id, ... }` |
| `tool_call.subtype=completed` | `{ type: 'tool_end', toolUseId: call_id, failed }` |
| 确认成功的业务 MCP（三个工具之一） | `{ type: 'tool_call', toolUseId, toolName, input }` |
| `assistant` | 忽略，不当作最终成功 |
| 同时满足 `type=result`、`subtype=success`、`is_error=false` | `{ type: 'result', answer: result, sessionId }` |

成功条件是上述三个字段同时成立，不要写成“满足其中一个就算成功”。进程退出后仍由 runner 检查退出码。缺少的 token 等统计不补零。最终回答只取终止 `result`，不要再拼接中途 `assistant` 文本。

官方只说其他工具**可能**使用 `tool_call.function`，没有保证 MCP 一定采用该结构。工具名、参数位置、参数是否为 JSON 字符串、成功状态字段，都以本机样本确认为准。Cursor Adapter 只有在确认业务工具调用成功后才返回统一的业务 `tool_call`，并去除同 ID 的重复事件；失败或未完成的调用不交给业务层。不从普通回答推断派发。

**业务 MCP。** 复用现有 `app-tools-server.ts` 和三个业务工具的 schema、处理流程。不要改 server 现有的 `--tools=` 解析。Cursor 没有每次进程传入 `--mcp-config` 的对等通道，因此走共享配置：首次真正使用 Cursor 前（独立设置步骤或第一次执行前），生成并合并用户级 `~/.cursor/mcp.json` 的 `agent_os` 条目，保留其他 MCP 条目，不覆盖整个文件。不要只写当前项目的 `.cursor/mcp.json`，否则 `/cd` 后会丢业务工具。不要把这次写入放进构造函数或 `listCliAdapters()`。MCP 的 `command` / `args` 复用现有 `serverInvocation` 的绝对路径，避免换工作区后找不到服务。不为此增加配置管理系统。Cursor 支持在 MCP `args` 中插值环境变量，但必须实测非空权限和空字符串权限两条链路，并验证 `/cd` 后业务工具仍可用，不能只凭配置形式认定已通。[Cursor MCP 文档](https://cursor.com/docs/mcp)

当前 server 只读取 `--tools=`，不读取环境变量。因此仅给 spawn 设置 `AGENT_OS_ALLOWED_TOOLS` 不够。共享配置的 args 中加入：

```json
"--tools=${env:AGENT_OS_ALLOWED_TOOLS}"
```

只有声明了环境覆盖的 Adapter 才给 spawn 传 `env`，且必须 overlay，不整份替换（否则会丢掉 PATH、登录态、代理等）。未声明的 Adapter 继续继承 `process.env`：

```ts
env: {
  ...process.env,
  ...overrides,
}
```

其中 Cursor 的 `overrides` 至少包含 `AGENT_OS_ALLOWED_TOOLS: adapter.appTools.join(',')`。空权限必须显式传空字符串。本次工具集合直接使用 `adapter.appTools`。Claude/Codex 继续用各自启动参数里的 `--tools=`，不走这条环境覆盖。

**会话。** 继续使用现有 Session 中的 `cliId`、`cliSessionId`、`workspaceDir`。同话题自动续接必须可用；历史会话选择 `/resume` 与自动续接是不同功能。`agent ls` 若不能稳定机器读取，`/resume` 明确提示未支持，不要假定有原生列表。

**历史列表与 compact。** 有稳定、可调用的原生方式就直接适配；暂时无法接入时提示“Cursor 暂不支持此操作”。不为此新增托管历史数据库。

- `native-sessions.ts` 当前是非 Claude 全走 Codex，必须为 Cursor 增加明确分支。Claude/Codex 的 `/resume` 路径保持原样。
- `native-compact.ts` 判断的是 `plan.protocol`，不是 CLI ID。将 `buildCompactPlan` 改为可选后，必须先判断方法存在再调用；不存在则按未支持处理。不要写成 `adapter.buildCompactPlan?.(id)`，返回值会变成 `CliCompactPlan | undefined`。
- `tests/app-tool-policy.test.ts` 的 replay 夹具虽然外层提供了 `buildCompactPlan`，但内部 `parser` 的类型是 `CliAdapter`。接口改为可选后，直接调用会报 `TS2722`；写成 `parser.buildCompactPlan?.(id)` 会报 `TS2322`，因为方法一旦写出就必须返回 `CliCompactPlan`。也不要把方法取出来再执行（`const fn = parser.buildCompactPlan; fn(id)`），现有 Claude compact 会使用 `this.command`。正确写法是先判断存在再作为方法调用，不存在时明确抛错：

```ts
buildCompactPlan: (id) => {
  if (!parser.buildCompactPlan) {
    throw new Error('测试所用 Adapter 必须支持 compact');
  }
  return parser.buildCompactPlan(id);
},
```

这是小范围类型适配，不改变 Claude/Codex 的 compact 实现。
- `command-handler.ts` 的 `continue` 表示允许进入执行，不是整理成功。Cursor 不支持 compact 时应提示并返回 `handled`，不要再进入 `compactCliSession`。Claude/Codex 仍走现有 `continue` 路径。
- 相关卡片回调做同样的未支持检查。

`serverParameters()` 目前把非 Claude 都按 Codex 解析，但现有测试只循环 Claude/Codex；只把 `CliId` 加上 `cursor` 不会让这组测试失败。新增 Cursor 用例时，再按其配置和环境方式取 MCP 启动参数。不能删掉或放宽旧测试来通过检查。

**运行配置。** 最多补充可选的 `CURSOR_CLI_COMMAND`（默认 `agent`）和 `CURSOR_CLI_MODEL`。登录使用已有 Cursor 登录状态。其余超时、取消和工作目录沿用当前 runner。

先保持现有 runner 成功判定。当前 Codex 与 runner 的配合是：`agent_message` 提供回答；随后的 `turn.completed` 可以只带统计并保留前面的回答。不要把这种情况写成“空的 `turn.completed` 都被跳过”。只有真实 Cursor 样本证明必须兼容空最终文本时，才增加**仅对 Cursor 生效**的处理；不顺手改变所有引擎的结果规则，也不重写执行生命周期。

**4．涉及文件**

以下为仓库内的改动位置，接口示例尚未实现：

| 文件 | 改动 |
| --- | --- |
| `src/cli/cursor-adapter.ts`（新增） | Cursor 启动参数、续接、事件和业务工具适配；新建/续接都带 `--force` |
| `src/cli/types.ts` | 集中 `CLI_IDS`；`buildCompactPlan` 可选；必要时增加可选环境方法 |
| `src/cli/registry.ts` | 工厂表注册三种 CLI；保留空工具单例、默认 Claude 和 `listCliAdapters()` |
| `src/core/bot-registry.ts`、`session-store.ts` | 接受 cursor，并复用统一 ID 集合 |
| `src/core/command-parser.ts` | 支持 `/cursor`，CLI 名称从统一集合生成 |
| `src/cli/app-tools.ts` | 生成用户级 `~/.cursor/mcp.json` 的 `agent_os` 合并内容；args 使用绝对路径和 `--tools=${env:AGENT_OS_ALLOWED_TOOLS}` |
| `src/cli/runner.ts` | 仅对声明了环境覆盖的 Adapter overlay `env`；默认不改成功判定 |
| `src/cli/native-sessions.ts` | 显式处理 Cursor 支持或未支持；禁止落入 Codex 分支 |
| `src/cli/native-compact.ts` | 先判断 `buildCompactPlan` 存在再调用；不存在按未支持处理 |
| `src/app/command-handler.ts` | 帮助文案；Cursor 不支持 compact 时提示并 `handled` |
| `src/app/card-action-handler.ts` | `/resume` 回调对未支持列表做同样检查 |
| `src/app/product-comment-runner.ts` | 保持 `getCliAdapter(session.cliId)`，不传入角色工具 |
| `.env.example`、`config/bots.example.json` | 可选 `CURSOR_CLI_COMMAND` / `CURSOR_CLI_MODEL`；`defaultCli` 示例 |
| `src/probe-cli.ts`、`src/probe-app-tool.ts` | 增加 Cursor 事件与工具探测 |
| `tests/app-tool-policy.test.ts` | 先判断 `parser.buildCompactPlan` 存在再调用，不存在则抛错；新增 Cursor 用例时按其 MCP 配置取参数；现有 Claude/Codex 循环保持不变 |

飞书消息处理、业务提交、协作派发、结果补发继续复用已有实现，通常不需要为 Cursor 单独改写。不要修改 `app-tools-server.ts` 现有的 `--tools=` 解析。

**5．实施与验证**

按三个步骤完成：

1. **验证本机 CLI。** 跑通一次任务、同 ID 续接和现有业务 MCP，记录必要的真实输出样本。确认 `--force`、MCP 事件的来源/工具名/参数/成功字段、`${env:AGENT_OS_ALLOWED_TOOLS}` 在非空权限和空字符串权限下都能传到 server、以及 Windows stdin 是否真能收到 prompt。按实际结果分别决定是否加 `--trust` 或 `--approve-mcps`。这些都是接入验证，不扩大架构。
2. **完成适配。** 新增 CursorAdapter，更新 ID、注册表、`listCliAdapters()`、配置、命令，以及仅 Cursor 使用的 runner 环境 overlay。用户级 MCP 合并放在首次使用 Cursor 前，不放进构造或启动列举。
3. **回归旧引擎并验收 Cursor。** 实施前记录现有 `typecheck / test / build` 结果；实施后再次运行，不能靠删掉或放宽旧测试通过。

必须验证：

- `/cursor` 和 `defaultCli: "cursor"` 路由正确。
- 未安装或未登录 Cursor 时，Agent OS 仍能启动，Claude/Codex 仍可新建、续接和执行。
- 同话题第二轮保留上下文，new/cd 后按现有行为创建新会话；`/cd` 后 Cursor 业务工具仍可用。
- 读文件、改文件、执行命令、进度卡及最终回答正常。
- 三个业务 MCP 工具接入现有流程；评论入口不获得额外业务权限。
- 附件能读取；取消、超时、执行失败能按现有方式反馈。
- 历史列表、compact 支持时正常执行，不支持时明确提示，且不会误走 Codex 分支。
- Cursor 事件解析测试覆盖成功、失败、重复及未完成业务调用。

Claude/Codex 重点回归：新建、续接、业务工具权限、评论空权限、compact，以及 Codex「回答后补统计」。

```bash
pnpm typecheck
pnpm test
pnpm build
```

**6．范围边界与旧引擎约束**

本次交付是“新增一个可用的 CLI 引擎”。原方案里的持久化提交状态机、额外会话/工作区锁、托管历史索引、多账号隔离、灰度平台、复杂迁移及 ACP 运行器，均移出本次范围。

这些属于独立的系统改进，不作为接入 Cursor 的前置任务。本次以现有 Claude/Codex 的架构和使用方式为标准；只处理 Cursor 接入必需的协议差异和兼容问题。

| 位置 | 本次约束 |
| --- | --- |
| Claude/Codex Adapter | 保持现有启动参数、续接参数、附件处理、事件解析和 compact 实现 |
| CursorAdapter 构造与注册 | 不执行安装检查、登录检查或 MCP 配置写入；未安装 Cursor 不影响 Claude/Codex 启动 |
| 注册层 | 保留默认 Claude、无工具参数时的空权限，以及 `listCliAdapters()` 导出；可以保留现有空工具单例行为 |
| Runner 环境 | 只有声明环境覆盖的 Adapter 才新增 `env`，使用 `{ ...process.env, ...overrides }`；旧 Adapter 继续原有继承方式 |
| Runner 成功判定 | 先保持现有回答、统计、错误和退出码语义；不为 Cursor 猜测去改所有引擎 |
| MCP 配置 | 首次使用 Cursor 前合并用户级 `~/.cursor/mcp.json`，复用绝对路径，保留其他条目；不写入构造函数或启动列举 |
| MCP server | 保留现有 `--tools=` 解析；Cursor 插值接入这条已有通道 |
| 原生功能 | Cursor 未支持时单独提示；Claude/Codex 的 `/resume`、`/compact` 路径保持原样 |
| 评论入口 | 继续 `getCliAdapter(session.cliId)`，保持空业务权限 |
| 测试 | 不为了让 Cursor 过检而删除或放宽 Claude/Codex 测试 |
