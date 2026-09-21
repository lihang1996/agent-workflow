# ZCode CLI 接入方案（精简版）

状态：代码接入已按第 5 节落地（含独立测试），官方 CLI 的 headless 新建与续接尚未通过验证；投入使用前必须先通过第 6 节第 1 步的前置验证。目标是在现有 Claude、Codex、Cursor 旁边增加官方 ZCode CLI 执行引擎。

## 1．范围

沿用现有链路：飞书消息 → CLI Adapter → Runner → CLI 子进程 → 统一事件与业务处理。

- 新话题通过 `/zcode <任务>` 选择 ZCode；机器人可配置 `defaultCli: "zcode"`。
- 同话题使用 Session 保存的 `cliSessionId` 续接，继续使用 `workspaceDir`。
- 复用进度卡、最终回答、取消、超时、附件和已有业务 MCP 工具。
- 保留三个旧引擎的参数、权限、解析和默认行为；不修改现有机器人配置中的默认引擎。
- 首版按当前 macOS 环境验收；其他平台须验证启动与输入方式后再标为支持。

不增加常驻 Agent 服务、ACP/ZCode Protocol 客户端、会话数据库、锁系统或插件框架。ZCode 的 `app-server` 与 Codex 的 `app-server` 不是同一协议，本次不使用它们执行普通任务。

## 2．官方 CLI 与本机前置条件

本次依据本机官方 ZCode 桌面版附带的 CLI `0.16.9`，不是社区 npm 包 `zcode-app-cli`。

当前全局 `zcode` 启动脚本调用：

```text
/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
```

**当前验证结果：** `zcode --version`、`--help` 可用；原启动环境进入 prompt 模式时报找不到 Built-in Provider Config。补充探测在指定配置路径后进入了模型创建阶段，但仍输出 `turn.failed`，消息为 `Select a model before continuing`。已查看外部核对者保留的 `/tmp/zcode-probe/stream1.ndjson` 至 `stream7.ndjson`，尚无成功任务样本。

本文引用的 `/tmp/zcode-probe/` 文件均为临时探测记录，可能被系统清理，不作为持久测试依赖。当前仅保留正文中的核对结论；实施时按第 6 节保存必要的脱敏测试样本。

外部核对者报告已尝试 `config.defaultModelSelection` 加 `options.reasoningLevel` 的多个组合，以及环境覆盖、沙箱副本和真实文件临时修改；现存失败输出不能独立证明每次配置都已生效。**当前已尝试指定默认模型及 reasoningLevel，仍失败；原因尚未定位，不能确认是版本缺陷或配置未生效。** 历史日志中的 `source: "config"` 不足以证明当前配置路径、字段结构或版本行为相同。

接入前先补齐官方运行环境，再做一次真实任务验证：

- 本机官方内置配置位于 `/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json`。
- CLI 源码支持 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 和 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`；个人配置默认路径为 `~/.zcode/v2/provider_config.json`。
- 新会话源码存在读取 `config.defaultModelSelection` 的路径；模型需满足当前 Provider Registry 的可选条件及有效的 `options.reasoningLevel`，不能仅凭写入字段认定已生效。
- 在安装/启动环境中正确指定这些路径，复用官方登录与模型配置；不复制密钥到仓库，不覆盖个人 Provider 配置。
- 上述 macOS 路径属于本机安装说明，不硬编码到通用 Adapter。全局启动脚本依赖官方桌面应用保留在原位置；当前为 `#!/bin/sh` 启动器，仅按 macOS 验收，不宣称可直接用于 Windows。

Adapter 只新增可选 `ZCODE_CLI_COMMAND`，默认 `zcode`。当前参数解析器没有 `--model`，首版沿用 ZCode 自己的模型选择，不虚设 `ZCODE_CLI_MODEL` 或照搬 Codex 的模型参数。

## 3．Adapter 与事件适配

新增 `src/cli/zcode-adapter.ts`，实现现有 `buildArgs`、`buildResumeArgs`、`parseEvents`、`buildEnv`。附件参数签名沿用 `CliAdapter`。

基础调用：

```bash
zcode --prompt "任务内容" --mode yolo --output-format stream-json
zcode --prompt "继续任务" --resume "<保存的 sess_… ID>" --mode yolo --output-format stream-json
```

- 本机源码已确认支持 `--output-format stream-json`，虽然当前 `--help` 未展示此参数。`--json` 是最终汇总输出，不能替代逐行事件流（源码已核对，待成功样本验证）。
- `--mode yolo` 显式指定自动执行模式；不照搬 Cursor 的 `--force` 或 Codex 的 `--yolo` 参数。
- 只用明确的 `--resume <ID>`，不用 `--continue` 选择最近会话。
- 使用参数数组和现有 spawn `cwd`；不拼接 shell 命令，不切换全局工作目录。
- 附件可使用重复的 `--attach <绝对路径>`；保留现有 prompt 附件说明，并验证图片/文件实际可读。
- 本机源码的 prompt 入口读取 `--prompt` 参数，不能假设 stdin 自动变成 prompt，也不能用 `--prompt -` 冒充支持。现有 Runner 在 Windows 固定走 stdin；若后续支持 Windows，需增加 Adapter 可选的输入方式声明，旧引擎仍使用原默认策略。首版不扩展 WSL 或平台启动桥接。

以下字段来自本机官方 CLI 的序列化实现。除已查看的失败样本外，其余仍须用实际 stdout 的 NDJSON 校正；内部 transcript 的 `turn_started`、`tool_call_scheduled` 等格式不能代替 stdout 样本。

| ZCode 原始事件 | 转成现有 `CliEvent` | 验证状态 |
| --- | --- | --- |
| `session.created` / `session.resumed`，顶层 `sessionId` | `session`；其他事件携带的有效 `sessionId` 也可补获会话 ID | 源码已核对，待样本 |
| `tool.updated`，`payload.kind=scheduled` | 按 `payload.toolCallId` 暂存 `toolName` 与 `input`，不提交业务动作 | 源码已核对，待样本 |
| `tool.updated`，`payload.kind=started` | `tool_start`，ID 使用 `payload.toolCallId`；名称可从暂存记录补齐 | 源码已核对，待样本 |
| `tool.updated`，`payload.kind=result` | 根据 `payload.result` 判断成功/失败，输出 `tool_end`；确认成功的业务 MCP 另输出业务 `tool_call` | 源码已核对，待样本 |
| `tool.updated`，`payload.kind=error` | `tool_end`，`failed: true`；丢弃该调用的业务提交候选 | 源码已核对，待样本 |
| `turn.failed`，`payload.error` | `error`，提取错误消息 | 已核对外部探测的失败样本 |
| 顶层 `type=result`、`response`、`sessionId` | `result`，`answer=response`；仍由 Runner 检查错误事件和退出码 | 源码已核对，待样本 |
| `turn.completed`、`message.upserted`、`model.streaming` 等 | 不当作最终成功，不与最终 `response` 重复拼接 | 源码已核对，待样本 |

ZCode 的最终结果没有 Cursor 的 `subtype=success` / `is_error=false` 契约，不照搬 Cursor 的成功条件。`tool.updated` 的 `result` 是工具结果，顶层 `type=result` 才是本轮终止汇总。

工具结果可能不再带名称和输入，需要用 ID 关联前面的 `scheduled` 事件；本机普通工具成功分支会写 `payload.result.success=true`，MCP 失败如何包装仍须样本验证，不能只因 `kind=result` 就提交业务动作。遇到 `inputOmitted` 或输入不完整，不猜测参数、不错误派发；真实探测时确认三个业务工具的完整输入能被获取。

只识别来源为 `agent_os` 的三个业务工具：`request_clarification`、`request_spec_approval`、`dispatch_task`。本机源码使用 `mcp__<server>__<tool>` 名称解析，实施时核对实际名称，不把普通读写、Shell 或其他 MCP 的同名工具当成业务调用。

关联记录与去重状态仅属于本次执行。ZCode 每次执行使用独立 Adapter，包括空权限的评论执行；不改旧引擎的单例行为。未知事件忽略，JSON 顶层类型先校验。统计按实际字段映射，缺失不补零，不把会话累计 token 冒充本轮用量。

## 4．业务 MCP：复用服务，小幅接线

本机 CLI 的用户配置是 `~/.zcode/cli/config.json`，服务字段为 **`mcp.servers`**，不是 Cursor 的 `mcpServers`。本机未确认可用的进程级 `--mcp-config` 或 MCP 配置环境覆盖参数，不凭空增加这些参数。

首版方案：首次使用前合并 `mcp.servers.agent_os`，注册 stdio 服务，`command` 与 `args` 使用绝对路径。本机核对时该配置文件不存在：先创建父目录，仅在 `ENOENT` 时从空配置新建；其他读取或解析错误均报错并保留原文件。保留其他配置和 MCP 条目；复用进程内初始化 Promise，并用临时文件替换，避免每个任务重写共享配置。不要在构造函数、注册表或启动日志中进行配置写入。

权限仍来自 `adapter.appTools`，每次 ZCode spawn 通过现有 `buildEnv()` 注入：

```ts
{ AGENT_OS_ALLOWED_TOOLS: this.appTools.join(',') }
```

现有 Runner 已把覆盖值叠加到 `process.env`，不需要重新改造环境传递。空权限必须显式传空字符串。

**不假设 ZCode 支持 Cursor 的 `${env:…}` 插值。** 为避免改变现有 MCP server 的权限解析，新增一个很小的 ZCode 专用入口 `src/mcp/zcode-app-tools-server.ts`：读取上述环境变量，追加现有 `--tools=<列表>` 参数，再动态导入 `app-tools-server`。共享配置只指向此入口；不另建业务 MCP 实现。开发态/构建态启动方式复用 `app-tools.ts` 现有绝对路径逻辑。

外部核对者的沙箱探测已记录目标权限变量 `AGENT_OS_ALLOWED_TOOLS` 到达 MCP 子进程，值为 `request_clarification`；已查看其 `/tmp/zcode-probe/mcp-env.json` 与探测脚本。这证明该变量在该次探测中可传递，不代表所有环境变量全量透传或业务权限已验收。实施时仍须在真实任务中验证 Agent OS → ZCode → MCP 的角色权限及空权限。评论入口仍不传角色工具。旧 server 的 `--tools=` 解析和其他三个 Adapter 的 MCP 接入不变。

## 5．改动位置与辅助能力

| 文件 | 必要改动 |
| --- | --- |
| `src/cli/zcode-adapter.ts`（新增） | 启动、指定会话续接、事件转换、权限环境 |
| `src/cli/types.ts` | `CLI_IDS` 增加 `zcode` |
| `src/cli/registry.ts` | 注册 ZCode 工厂及启动展示；`getCliAdapter('zcode', …)` 无论是否传 tools 都返回新实例，不复用 `emptyToolAdapters`；旧三引擎单例行为及默认 Claude 不变 |
| `src/cli/app-tools.ts` | ZCode 专用 `mcp.servers.agent_os` 合并与 `ensureZcodeAppToolsConfig()`，参照现有初始化模式独立实现 |
| `src/cli/runner.ts` | `runCli()` 增加 ZCode 分支，执行前调用 `ensureZcodeAppToolsConfig()`；继续共用正常执行及环境 overlay，旧引擎路径不变 |
| `src/mcp/zcode-app-tools-server.ts`（新增） | 仅将本轮环境权限转为旧 server 的 `--tools=` 参数 |
| `src/app/command-handler.ts`、`card-action-handler.ts` | `/zcode` 帮助；历史选择的命令入口及卡片回调均拦截 ZCode 并提示未支持 |
| `.env.example`、使用文档 | `defaultCli` 可选值注释增加 `zcode`，新增可选 `ZCODE_CLI_COMMAND` 及官方安装/Provider 说明；不替换现有机器人默认配置 |
| `src/probe-cli.ts`、`probe-app-tool.ts` | ZCode 事件展示与 MCP 探测 |
| ZCode 独立测试与 fixtures（新增） | 真实事件回放、共享配置合并、角色/空权限、实例隔离、重复 `--attach` 参数；不强行改造仅用于 Claude/Codex 的 `serverParameters()` 测试辅助函数 |

`bot-registry.ts`、`session-store.ts`、`command-parser.ts` 已复用 `CLI_IDS`，主要确认扩展后生效，不再各写一份枚举。保留 `listCliAdapters()` 导出及所有引擎的启动展示，展示用 ZCode 实例不用于任务执行。`product-comment-runner.ts` 继续调用不传工具的 `getCliAdapter(session.cliId)`，由工厂保证 ZCode 空权限实例也独立。

首版 `/resume` 历史选择和 `/compact` 明确提示暂不支持；同话题的指定 ID 自动续接必须支持。现有 `native-sessions.ts` 已对其他引擎返回未支持，compact 已有可选方法检查，ZCode 不提供假的 compact protocol。命令和卡片回调中的 Cursor 特判要覆盖 ZCode；不要改动 Claude/Codex 的原生操作路径。

ZCode TUI 有 `/compact` 不代表当前 `CliCompactPlan` 能直接调用它。现有可选方法检查自然拦截 ZCode，无需修改 `message-handler.ts` 的 Codex compact 专用文案。本次不为辅助能力实现 app-server 客户端，不解析官方私有数据库。

## 6．实施顺序与验收

1. **先验证官方 headless，作为实施前置条件。** 安装、登录及模型选择通过官方方式人工完成。必须同时满足：不带 `--resume` 的新任务执行成功；用该任务返回的 `sessionId` 续接成功。TUI 旧会话的续接仅用于差分排查，不计入验收，也不能供所有新话题共用。续接成功而新建失败时，优先排查新会话初始化与默认模型选择，不能据此唯一确定原因。若确认当前版本无法满足，记录具体限制与证据，暂停接入，不将修复 ZCode 本身纳入 Agent OS，不做 TUI 自动化或私有状态注入。
2. **验证 stdout 与业务 MCP。** 在临时工作区验证改文件、流式输出及真实业务 MCP 调用；保存新任务、上述 ID 续接和工具调用的脱敏 NDJSON 到测试 fixtures，校正事件表后再写解析测试。确认三个业务工具的完整参数可取得、角色权限及空权限有效，不能用内部 transcript 替代样本。
3. **完成最小适配并验收。** 新增 Adapter、ID/工厂和 MCP 入口，补必要初始化、提示和环境示例。验证 `/zcode` 与 `defaultCli` 路由、续接、附件、进度/最终回答、取消/超时/失败、三个业务工具及评论空权限；两个不同角色同时运行不串权限，`/cd` 后 MCP 仍可用。未安装或未配置 ZCode 时，只影响选用 ZCode 的任务，三个旧引擎仍可启动。

测试重点：scheduled/started/result 关联、失败不提交、重复不重复派发、其他 MCP 不误识别、缺失输入不造业务调用、终止结果与非零退出码、损坏配置不覆盖。保持旧测试要求，运行 `pnpm typecheck`、`pnpm test`、`pnpm build`，回归 Claude/Codex/Cursor 的新建与续接。

以“新增一个可用的官方 CLI 引擎”为完成标准，不把未来多 CLI 框架、可靠性改造或 ZCode 自身的工作流功能纳入本次。

依据：[ZCode 官方仓库](https://github.com/zai-org/ZCode)、本机官方 CLI `0.16.9` 的参数解析、headless 序列化和配置加载实现，以及当前 Agent OS 源码。本文明确区分源码已核对的字段与尚待真实调用验证的行为。
