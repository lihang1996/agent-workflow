# Agent OS

> 把飞书变成 AI 编程 CLI（Claude Code / Codex / Cursor Agent）的指挥台。

## README 目标

本文档用于说明项目定位、运行方式、配置项和核心交互；飞书应用创建、权限申请及生产部署步骤可在后续补充。

## 项目简介

- 一个飞书话题对应一个任务和一组按角色隔离的 CLI 会话。
- 支持多个 Bot 角色在同一话题中协作，并通过 `/handoff` 在进程内交接任务。
- 支持 Claude Code、Codex 与 Cursor Agent 三种本地 CLI 引擎，可按话题切换。
- 任务执行过程通过飞书交互式卡片反馈状态、进度和最近活动。
- 话题项目目录、会话状态和 CLI 会话 ID 持久化到本地 `data/`。

## 功能概览

- 飞书 WebSocket 长连接接收消息，REST API 回复文本、卡片和资源。
- 支持私聊和群聊；群聊仅响应被 @ 的目标 Bot。
- 支持文本、富文本、图片和文件消息，任务执行前可下载资源到 `data/downloads/`。
- 话题级工作目录共享：目录优先级为“话题目录 > Bot 默认目录 > 引擎目录 > 当前目录”。
- 话题级执行引擎共享：一次 `/engine` 会统一切换现有角色，后续新建角色也自动继承。
- 会话状态管理：创建、执行、空闲、关闭、恢复和清理。
- CLI 流式事件解析、超时/取消处理，以及卡片更新节流。

## 系统结构

```text
飞书消息 / 事件
        │
        ▼
im/lark + message-parser
        │
        ▼
runtime/message-handler（命令与统一入口）
        ├── 会话 / 话题 / CLI 任务与流式卡片
        ├── 团队流水线 / 问卷 / Spec / 云文档评审
        ├── 定时任务 / 日志巡检 / 高风险审批
        └── Claude/Codex/Cursor adapter + CLI runner

src/index.ts（启动、恢复、后台同步与信号收尾）
```

### 目录说明

| 路径 | 作用 |
| --- | --- |
| `src/index.ts` | 应用启动与信号收尾（组合根） |
| `src/runtime/` | 消息路由、CLI 任务、协作/流水线运行主线 |
| `src/im/` | 飞书接入、消息解析、交互式任务卡片 |
| `src/core/` | Bot 配置、会话、话题目录、命令和任务交接 |
| `src/cli/` | Claude/Codex/Cursor 适配器、事件解析和子进程运行器 |
| `src/mcp/` | 结构化提问 MCP（propose_questions 等） |
| `src/probe-cli.ts` | 手工检查 CLI `stream-json` 输出的探针 |
| `data/` | 运行时生成的会话、工作流、审批、定时任务、Spec 和下载文件（不提交） |

## 环境要求

- Node.js `>= 22`
- pnpm
- 可用的飞书应用凭证，并为每个应用开启事件长连接
- 本机 PATH 中可执行的 `claude` CLI；使用 Codex 时还需要 `codex` CLI；使用 Cursor 时还需要 `agent` CLI（`curl https://cursor.com/install -fsS | bash`）

## 快速开始

### 1. 准备环境

- Node.js `>= 22`
- pnpm
- 至少一个飞书 Bot 的 App ID 和 App Secret，并为应用开启事件长连接
- 默认使用 Cursor 时，确保 `agent` CLI 已在 PATH 中，并配置 `CURSOR_API_KEY` 或已 `agent login`；使用 Claude / Codex 时额外确保对应 CLI 可用

### 2. 安装依赖

```bash
pnpm install
```

### 3. 配置环境变量

复制示例配置并填入至少一个角色的真实飞书凭证：

```bash
cp .env.example .env
```

编辑 `.env`，至少配置一个 `BOT_*_APP_ID` 和对应的 `BOT_*_APP_SECRET`。角色前缀、引擎和工作目录等配置详见[配置说明](#配置说明)，完整示例见[.env.example](./.env.example)。

### 4. 检查并启动

先执行 TypeScript 构建和自动化测试，再启动本地服务：

```bash
pnpm build
pnpm test
pnpm start
```

`pnpm start` 使用稳定的单进程前台模式，源码或 `.env` 变化不会在流水线执行中发送 SIGTERM。需要开发热重载时使用：

```bash
pnpm dev
```

`pnpm dev` 会在源码或 `.env` 变化时重启服务；进行中的持久化流水线会在新进程恢复，但当前 CLI 子任务必须重新执行。因此长时间交付建议使用 `pnpm start`。

`pnpm start` 不会热加载新代码。若运行期间修改了 Agent OS 自身的 `src/`、`skills/`、`scripts/`、`package.json` 或 `.env`，控制器会在下一个技术步骤或结果提交前原地暂停，并提示“Agent OS 源码已更新，请重启服务后重试”；它不会继续运行半新半旧的门禁逻辑。重启后在原阻塞卡重试即可从同一步恢复。

生产环境若执行编译后的 `dist`，请统一使用：

```bash
pnpm start:prod
```

该命令会先重新构建并校验 `dist` 中实际生效的质量门禁契约，避免源码已更新但旧编译产物仍被运行。

### 5. 验证启动

- `pnpm build` 无报错。
- `pnpm test` 全部通过。
- 终端出现 `Agent OS 启动` 和至少一个 `[Bot] 已连接` 日志。
- 在飞书私聊已连接的 Bot 发送 `/help` 或 `/status`，确认收到回复。
- 群聊中需要先 @ 对应 Bot；项目没有 HTTP 服务或固定端口，验证方式以启动日志和飞书消息回复为准。

更多命令参见[飞书内置命令](#飞书内置命令)，遇到问题可查看[故障排查](#故障排查)。

开发时还可使用：

```bash
pnpm dev        # 开发热重载（长时间流水线建议改用 pnpm start）
pnpm probe      # 只校验 Bot 凭证和机器人身份，不发送消息
pnpm probe:cli  # 手工查看 CLI 的 JSON 流事件
```

## 配置说明

### Bot 凭证

按角色配置以下环境变量（缺少凭证的角色会被跳过）：

| 角色 | 环境变量前缀 | 默认显示名 | 是否必需 |
| --- | --- | --- | --- |
| CEO | `BOT_CEO` | CEO助手 | 团队流水线必需 |
| PM | `BOT_PM` | 产品经理 | 团队流水线必需 |
| 架构师 | `BOT_ARCH` | 架构师 | 必需 |
| 开发 | `BOT_DEV` | 开发工程师 | 必需 |
| QA | `BOT_QA` | 测试工程师 | 必需 |
| 评审 | `BOT_REVIEWER` | 代码评审 | 必需 |
| 运行时审计 | `BOT_RUNTIME_AUDITOR` | 运行时审计 | 可选；未配置回退 QA |
| 最终审查 | `BOT_FINAL_REVIEWER` | 最终审查 | 可选；未配置回退评审 |

每个前缀至少需要 `<PREFIX>_APP_ID` 和 `<PREFIX>_APP_SECRET`，还可设置 `<PREFIX>_NAME`、`<PREFIX>_WORKDIR`。开发 Bot 兼容旧变量 `BOT_A_APP_ID` / `BOT_A_APP_SECRET`。`config/bots.json` 不被运行时读取，其中的 `id` / `systemPrompt` / `workspace` / `reviewBy` 都无效。

### 用户身份与权限

飞书 `open_id` 只在单个应用内稳定；同一个人在 CEO、QA 等不同 Bot 下会得到不同的 `open_id`。Agent OS 会从飞书签名事件读取 `user_id` / `union_id`，把可信别名原子保存到 `data/user-identities.json`，因此任务停止、工作流重试、Spec、问卷、定时任务和审批都能跨 Bot 识别同一个人，服务重启后仍然有效。旧数据只有 `open_id` 时也会在该用户下一次与原 Bot 交互后自动建立映射。

| 变量 | 说明 |
| --- | --- |
| `OWNER_USER_ID` / `OWNER_UNION_ID` | 推荐的负责人稳定身份；任一即可，适合多 Bot 部署 |
| `OWNER_OPEN_ID` | 兼容单 Bot 和旧配置；运行期间会通过可信事件映射到稳定身份 |
| `AGENT_OS_ALLOWED_USER_IDS` / `AGENT_OS_ALLOWED_UNION_IDS` | 额外授权用户的稳定 ID，多个值用逗号分隔 |
| `AGENT_OS_ALLOWED_OPEN_IDS` | 兼容旧版的应用级白名单，多个值用逗号分隔 |

### 引擎、流水线和工作目录

| 变量 | 说明 | 默认/回退 |
| --- | --- | --- |
| `DEFAULT_CLI` | 新会话默认引擎：`claude`、`codex` 或 `cursor` | `cursor` |
| `COLLAB_MAX_ROUNDS` | 流水线代码评审↔开发修复的最大协作轮次（1–10；非法值回退为 2） | `2` |
| `PIPELINE_STEPS` | 固定交付链声明；只能使用完整规范顺序，不能裁剪或重排门禁 | `pm,architect,dev,review,qa,runtime_audit,final_review,summary` |
| `AGENT_OS_SKILLS_DIR` | 七个交付 Skill 的绝对根目录；通常无需设置 | 仓库内 `skills/` |
| `MCP_ENABLED` | 是否注入结构化提问 MCP | `true`（未设置即开启） |
| `MCP_STRICT` | Claude 是否加 `--strict-mcp-config` | `false` |
| `CLAUDE_WORKDIR` | Claude 全局回退目录 | 当前工作目录 |
| `CODEX_WORKDIR` | Codex 全局回退目录；未设置时继续回退到 `CLAUDE_WORKDIR`、当前工作目录 | 未设置时按上述顺序回退 |
| `CURSOR_WORKDIR` | Cursor 全局回退目录；未设置时继续回退到 `CLAUDE_WORKDIR`、当前工作目录 | 未设置时按上述顺序回退 |
| `CURSOR_API_KEY` | Cursor Agent 无头认证；也可用同一终端先 `agent login` | 未设置 |
| `CURSOR_CLI` | Cursor 可执行文件名 | `agent` |
| `CURSOR_MODEL` | 传给 `agent --model`。只接受精确的 `cursor-grok-4.6-high`；`auto` 或其它模型会被忽略 | `cursor-grok-4.6-high` |
| `CURSOR_SANDBOX` | Cursor 普通/已审批任务：`--force --trust --sandbox disabled` 才能无头写文件和本机网络。`--force` 是 YOLO，没有 Claude PreToolUse。设 `enabled` 才收紧。不传 `--auto-review` | `disabled` |
| `CODEX_SANDBOX` | Codex 普通任务权限：默认与 Claude dontAsk 对齐（`:danger-full-access` permission profile，不传 `--sandbox`）。设 `workspace-write` 或 `read-only` 才会收紧 | 未设置即全权限对齐 Claude |
| `CODEX_LOCAL_NETWORK_ACCESS` | `false` 时禁止 Codex 本机网络/绑定（会从默认全权限降到无网络的 workspace profile） | `true`（未设置即允许） |
| `CODEX_APPROVED_SANDBOX` | 已审批 Codex 任务权限；默认同样对齐 Claude skip-permissions。设 `workspace-write` 或 `read-only` 才会收紧 | 未设置即全权限对齐 Claude |
| `AGENT_OS_TEST_RESOURCE_SENTINEL` | 明确授权 QA 对已通过隔离性预检的测试库执行 migration/TRUNCATE/DROP/seed；不能替代测试库命名与运行库不相等检查 | 未设置（不授权） |
| `CLI_MAX_TOOL_COUNT` | 单次 CLI 工具调用上限（读文件/改文件/跑命令都算 1 次） | `500` |
| `CLI_TOOL_LOOP_STREAK` | 连续同目标多少次熔断；`0` 关闭。另检测窗口同参重复和同工具乒乓（警告 10 / 熔断 20） | `15` |
| `CLI_TIMEOUT_MS` | 单次 CLI **绝对**超时上限（毫秒）。持续有输出的长任务可跑到此上限；默认 6 小时，最大 12 小时 | `21600000`（6 小时） |
| `CLI_IDLE_TIMEOUT_MS` | 无 stream 输出多久视为卡住并终止（毫秒）；有工具/旁白输出会自动续命。`0` 关闭空闲检测 | `1200000`（20 分钟） |
| `APPROVAL_TTL_MINUTES` | 高风险审批有效期（1–1440 分钟） | `30` |
| `AGENT_OS_ALLOWED_ROOTS` | Agent 可访问的可信项目/日志根目录，多个路径用逗号分隔 | 当前项目和已配置工作目录 |

不要把真实 Secret 提交到 git；`.env` 和 `data/` 已被忽略。

## 飞书内置命令

在私聊中直接发送命令；群聊中需先 @ 对应 Bot。

| 命令 | 作用 |
| --- | --- |
| `/help` | 查看命令帮助 |
| `/status` | 查看当前会话、引擎和实际工作目录 |
| `/workdir [路径]` | 查看或设置本话题项目目录；`/workdir clear` 清除 |
| `/engine claude\|codex\|cursor` | 统一切换本话题所有角色的引擎，并清理被切换角色的旧 CLI 上下文 |
| `/handoff <角色> <任务>` | 将任务交给同话题的其他 Bot |
| `/review <任务>` | 只读独立审查（Cursor 走 `--mode ask`，不带 `--force`）；不会在完整交付门禁外自动改代码（需 reviewer Bot） |
| `/pipeline <目标>` | **仅 CEO**：显式启动不可跳过的团队交付流水线。缺少角色、项目目录或门禁证据会阻断；CEO 收到**非命令**自然语言目标时也会自动走流水线 |
| `/form <问卷ID>` | 把 MCP 生成的需求问卷渲染成可点选的飞书表单 |
| `/spec list|show <ID>|publish <ID>` | 查看产品 Spec，或将已确认方案发布到飞书云文档 |
| `/squad <目标>` | **开发或 CEO**：启动架构→开发→评审→QA→运行时审计→最终审查的内部交付小队 |
| `/schedule …` | 创建、查看、暂停、恢复或删除持久化定时任务 |
| `/approval <任务>` | 显式发起高风险操作审批；高风险自然语言任务也会自动拦截 |
| `/reset` | 清理 CLI 上下文，但保留 Agent OS 会话 |
| `/close` | 关闭当前会话 |
| `/reopen` | 重新打开已关闭会话 |
| `/clean` | 删除所有已关闭会话记录 |

示例：

```text
@CEO助手 给 README 补一节快速开始说明
/workdir /path/to/project
/engine cursor
/handoff dev 根据当前仓库写一段 README 大纲
@CEO助手 /pipeline 给 README 补一节快速开始说明
/schedule logs 1h /absolute/path/server.log
```

## 第六章：团队工作流

产品需求可按以下闭环推进：

```text
CEO 统一入口 → MCP 结构化问题 → /form 点选澄清
→ 产品 Spec（稳定 RQ-ID）→ 负责人确认 → 直接交付或飞书云文档评审 / PM 修订
→ 评审通过 → 架构 / 开发 / 代码评审 / QA / 运行时审计 / 最终审查
```

- 产品经理需要澄清时会通过预授权的内置 MCP 生成飞书问卷，答案只接受飞书卡片的人类提交；没有成功创建问卷时，只有包含稳定 `RQ-ID` 且通过契约校验的完整 Spec 才会落库并显示确认卡。历史无效待确认内容会在启动恢复时自动退回 PM。
- Spec 的“确认方案”与“退回修改”使用独立交互；修改意见只会随“退回修改”提交，不会被误当作确认输入。
- 确认后点击「发布到飞书云文档」，系统会创建 Docx 并按块层级写入 Markdown；后续修订覆盖同一文档，不会更换评审链接。
- 评审卡的“要求修改”和云文档里直接新增的评论/回复都会交给产品经理；修订版会重新进入确认流程，已处理评论同步标记为解决。
- 普通 Spec 的确认卡可选择直接开始技术交付，或发布到飞书云文档继续产品评审；两条路径都会先固化同一份 canonical Spec，再执行架构、开发、代码评审、QA、运行时审计和最终审查。含 `[RISK_WAIVER]` 的 Spec 不显示直接开始入口，必须发布完整云文档并由当前 `OWNER_*` 身份（未配置时为需求发起人）批准，避免在被截断的卡片预览中接受未读风险。也可用 `/squad` 单独启动内部交付小队。
- 飞书应用需具备 Docx 创建/读取/编辑、Drive 文件评论读取/写入权限。建议在事件订阅中添加 `drive.notice.comment_add_v1`；即使事件暂未配置，服务也会定时补偿拉取评审评论。

## 角色 / 步骤 / 门禁 / Skill

真实约束来自 `buildPipelineStepPrompt` 与 `skills/`，不是 `config/bots.json`。未配置独立审计/终审 Bot 时流水线不阻断，但 CLI 会话按逻辑角色切开。`pm_accept` 是另开的产品 UAT 需求，当前不实现、不插入固定链。

| 步骤 | 逻辑角色 | 默认飞书 Bot | 可选独立 Bot | Gate | 主 artifact | Skill | 未审批时写权限 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `pm` | `pm` | `BOT_PM` | — | 无（Spec 校验） | canonical Spec | `establish-delivery-contract` | `standard` |
| `architect` | `architect` | `BOT_ARCH` | — | `design` | `change-plan.json` | `design-risk-aware-change` | `evidence-write` |
| `dev` | `dev` | `BOT_DEV` | — | `implementation` | `implementation-manifest.json` | `implement-traceable-change` | `standard` |
| `review` | `reviewer` | `BOT_REVIEWER` | — | `change-review` | `change-review.json` | `review-change-set` | `evidence-write`（回传开发仍 `standard`） |
| `qa` | `qa` | `BOT_QA` | — | `verification` | `verification-report.json` | `verify-software-delivery` | `evidence-write` |
| `runtime_audit` | `runtime_auditor` | `BOT_QA` | `BOT_RUNTIME_AUDITOR` | `runtime-audit` | `runtime-audit.json` | `audit-runtime-boundaries` | `evidence-write` |
| `final_review` | `final_reviewer` | `BOT_REVIEWER` | `BOT_FINAL_REVIEWER` | `final-review` | `final-review.json` | `review-final-delivery` | `evidence-write` |
| `summary` | `ceo` | `BOT_CEO` | — | 无 | 汇总文本 | `coordinate-delivery-summary` | `evidence-write` |

## 会话与协作模型

- 会话键由 `chatId + topicId + botId[::logicalRole]` 组成；同一飞书 Bot 扮演 QA 与运行时审计、评审与终审时，CLI 上下文仍然隔离。
- `topicId` 优先使用飞书 `threadId`，其次是 `rootId`，最后回退到消息 ID。
- `/workdir` 绑定的是话题目录，同一话题下的 Bot 共享该目录。
- `/engine` 绑定的是话题统一引擎；现有角色会批量对齐，尚未创建的 PM、架构、开发、评审和测试会在首次运行时继承。`DEFAULT_CLI` 变更时，启动会把空闲话题/会话一次性对齐到新默认；之后用 `/engine` 选定的引擎会保留。
- 切换或清除话题目录、切换引擎、`/reset` 和 `/reopen` 都会清理对应 CLI 上下文，避免跨目录或跨引擎恢复错误会话。
- 运行中任务不能重复执行、切换引擎或切换目录；可用 `/close` 取消任务。
- `/pipeline` 固定步骤：PM → 架构 → 开发 → 评审协作 → 测试 → 运行时审计 → 最终审查 → CEO 汇总。`PIPELINE_STEPS` 只能声明完整顺序；未连接的必需角色会阻断，可选的独立审计/终审 Bot 缺失不阻断。业务验收发生在人确认 Spec；实现后不做第二次 PM UAT。`pm_accept` 若要做，应另开产品需求，不要塞进当前固定链。
- 同一项目根目录同一时间只允许一条已进入技术阶段的门禁工作流；确认 Spec、切换 canonical 与取得项目租约在同一临界区完成，避免不同飞书话题并发改代码或互相覆盖证据。
- 新交付工作流必须绑定真实项目目录。PM Spec 中每项需求须以稳定 ID 开头（例如 `### RQ-001 登录`）；所有设计、实现、评审、QA、运行时和终审 artifact 必须精确覆盖同一组 ID。
- 流水线写权限按步骤划分，不是整步 `read-only`：PM/开发用 `standard`（可改产品代码）；架构、评审、QA、运行时审计、终审、汇总用 `evidence-write`（只写 `.agent-os/evidence/<workflowId>/`）。工作流 `executionPolicy` 仍只表示高风险审批（`standard|approved`）；整单已审批时各步都走 `approved`。评审协作里开发回传必须继续用 `standard/approved`，不能继承质检的 evidence-write。Claude 对 evidence-write 只预授权 `Write/Edit(.agent-os/evidence/**)` 与当前证据目录；Codex 用 `workspace-write` 而不是 `:danger-full-access`。Cursor 无头 `--force` 做不到路径级写权限，需要本机网络时还会关掉 sandbox，生产质检优先 Claude。独立 `/review` 仍是 `read-only`。
- 非 PM 步骤必须显式输出 `[RESULT:done|blocked|failed]`。`[GATE_RESULT]` 后的 JSON 用括号平衡解析（可跨行），其中的检查命令、时间、退出码、artifact 路径与 SHA-256 都由控制器复核；空检查、伪造 hash、符号链接逃逸、过期证据和未闭环 P0/P1 会 fail closed。
- 控制器在证据目录写入不可由 Agent 声明或改写的 `canonical-spec.md` 与 `evidence-chain.json`。`waived` finding 必须在人工确认前以同 ID `[RISK_WAIVER]` 写入 canonical Spec，批准时间和证据引用由控制器生成；评审阶段临时填写 owner/期限不构成人工授权。含风险接受条款的 Spec 强制走完整云文档评审，只有当前负责人可以最终批准。QA 若验证独立构建产物，还必须提供 `buildArtifact`，后续门禁会重新哈希；最终完成前会重验最新一轮完整证据链、源码 fingerprint、构建产物和需求覆盖。
- Codex 交付流水线的可写任务默认与 Claude dontAsk 对齐（`:danger-full-access`，可启动本机服务、浏览器和隔离测试库）；普通聊天同样具备该运行时能力，高风险命令仍被 `untrusted` 审批阻断。启动日志会记录 `requested/configApplied/expected/reason`。migration/TRUNCATE/DROP/seed 仍需资源预检；负责人可在阻塞卡上确认隔离测试库并授权（仅当前流水线 QA 生效），也可显式设置 `AGENT_OS_TEST_RESOURCE_SENTINEL=true`。两种方式都不能绕过测试库命名和“不得等于开发/生产库”的检查。
- 最终状态分为 clean 与 conditional：存在有效 waiver、开放 P2/P3 或可选检查缺口时只能“有条件完成”，不会显示成无风险通过。步骤状态先持久化，再落终态卡、释放当前 Bot 会话，最后启动下一步，避免异步回调覆盖新任务状态。

## 主动式 Agent

`/schedule` 创建的任务会持久化在 `data/schedules.json`，服务重启后自动恢复。支持 `15m`、`1h`、`2d` 等间隔：

```text
/schedule every 1h 汇总当前项目的未解决风险
/schedule pipeline 1d 审查本周产品交付状态
/schedule logs 1h /absolute/path/server.log
/schedule list
```

每次触发都会持久化“执行中 / 成功 / 失败 / 跳过”、失败原因和累计次数；单个任务失败不会阻断同一轮其它任务。失败、Bot 离线或角色繁忙时会在不超过 5 分钟后补偿重试，服务重启时遗留的“执行中”任务也会自动恢复。暂停、恢复和删除仅允许任务负责人操作，执行中的任务不能直接删除。

日志巡检会先确认路径是可信根目录中的普通文件，再由 Agent OS 宿主以只读方式截取最后 500 行（最多 128 KiB）。凭证、Cookie、JWT、常见平台 Token 和连接串密码会先脱敏，日志内伪造的提示词/分隔符会被转义；报告固定给出异常计数、行号证据、影响和建议。巡检不会把日志路径误当成高风险执行指令，也不得调用工具、删除、截断、重启或部署；P0/P1 只上报，后续动作仍需经过审批门。日志位于项目目录之外时，请把其父目录加入 `AGENT_OS_ALLOWED_ROOTS`。

高风险词（例如生产部署、外部推送、删除数据、权限/密钥变更）会自动弹出审批卡。仅 `OWNER_USER_ID` / `OWNER_UNION_ID` / `OWNER_OPEN_ID` 指定的人可批准；未设置时，原始需求发起人拥有审批权。审批默认 30 分钟过期，批准后只放行最初审批卡绑定的这一项任务及其风险类别，例如“批准推送”不能被扩大成“删除数据”；新增风险必须重新审批。重复消息和重复点击都不会并发启动，负责人配置变更后旧负责人也不能继续使用历史卡片。执行结果会回写原审批卡，启动失败可在卡片上重试。普通 Codex 任务对不可信命令保持 `--ask-for-approval untrusted`，默认权限与 Claude dontAsk 对齐（不传 `--sandbox`，使用 `:danger-full-access`）；日志巡检使用一次性“仅输入分析”会话。已批准 Codex 默认同样对齐 Claude skip-permissions；若要收紧再设 `CODEX_APPROVED_SANDBOX=workspace-write`。Claude 已批准模式仍保留 Agent OS 的超范围 PreToolUse 拦截。

定时高风险任务在等待审批期间保持“执行中”，批准后的真实成功/失败、拒绝或超时会再回写定时任务状态，因此不会把“仅成功发出审批卡”误记成任务成功。

## 开发与扩展

1. 在 `src/cli/` 实现新的 `CliAdapter`（参数构造和流式事件解析）。
2. 在 `src/cli/registry.ts` 注册引擎。
3. 如需新的飞书消息类型，在 `src/im/message-parser.ts` 和 `src/im/lark.ts` 扩展解析/下载逻辑。
4. 修改命令时同步更新 `src/core/command-parser.ts`、`src/runtime/message-handler.ts` 的帮助文本和本文档。

提交前建议执行：

```bash
pnpm build
pnpm test
```

## 故障排查

- **未找到任何 Bot 凭证**：检查 `.env` 中至少一个 Bot 的 App ID 和 Secret 是否非空。
- **`claude` / `codex` / `agent: command not found`**：确认 CLI 已安装，并且启动 `pnpm start` 的终端能通过 `which claude` / `which codex` / `which agent` 找到它。Cursor 还需 `CURSOR_API_KEY` 或已 `agent login`。
- **群聊没有响应**：确认已 @ 正确的 Bot、应用已加入群，并已开启飞书事件长连接。
- **工作目录不存在**：`/workdir` 设置前确认路径是已存在的目录。
- **恢复了旧上下文但目录已变更**：重新发送 `/workdir <路径>` 或 `/reset`，让系统建立新的 CLI 会话。
- **提示“Agent OS 源码已更新”**：当前 `pnpm start` 进程仍在执行启动时加载的旧控制器代码。停止并重新执行 `pnpm start`（生产模式执行 `pnpm start:prod`），再点击新阻塞卡的重试按钮；不要在旧进程上反复重试。
- **本地服务/浏览器仍报 EPERM**：先确认当前进程已加载不传 `--sandbox`、带 `default_permissions=":danger-full-access"` 的新参数；旧进程热重启前仍会走 `workspace-write` 旧沙箱。若 `.env` 显式写了 `CODEX_SANDBOX=workspace-write`，需要删掉或改成与 Claude 对齐的默认。子会话若仍返回 EPERM 必须如实阻塞，不能伪造运行态通过证据。
- **云文档发布/评论失败**：检查飞书应用是否已申请并获批 Docx 创建/读取/编辑、Drive 文件评论读取/写入权限，并确认应用对目标文档有访问权；实时评论还需订阅 `drive.notice.comment_add_v1`。

## 已知限制 / 待补充

- 可运行 `pnpm test` 执行适配器、会话/工作流状态机、飞书消息解析、调度与安全边界测试；`pnpm build` 用于 TypeScript 编译检查。
- 飞书应用创建、权限清单、生产进程托管和日志/监控方案属于后续部署章节，本项目当前不展开第八章。

## 许可证

> 待确定。
