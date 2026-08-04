# Agent OS

> 把飞书变成 AI 编程 CLI（Claude Code / Codex）的指挥台。

## README 目标

本文档用于说明项目定位、运行方式、配置项和核心交互；飞书应用创建、权限申请及生产部署步骤可在后续补充。

## 项目简介

- 一个飞书话题对应一个任务和一组按角色隔离的 CLI 会话。
- 支持多个 Bot 角色在同一话题中协作，并通过 `/handoff` 在进程内交接任务。
- 支持 Claude Code 与 Codex 两种本地 CLI 引擎，可按话题切换。
- 任务执行过程通过飞书交互式卡片反馈状态、进度和最近活动。
- 话题项目目录、会话状态和 CLI 会话 ID 持久化到本地 `data/`。

## 功能概览

- 飞书 WebSocket 长连接接收消息，REST API 回复文本、卡片和资源。
- 支持私聊和群聊；群聊仅响应被 @ 的目标 Bot。
- 支持文本、富文本、图片和文件消息，任务执行前可下载资源到 `data/downloads/`。
- 话题级工作目录共享：目录优先级为“话题目录 > Bot 默认目录 > 引擎目录 > 当前目录”。
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
src/index.ts（路由、命令、任务编排）
        ├── SessionManager + JsonSessionStore
        ├── JsonTopicStore + workdir resolver
        ├── Claude/Codex adapter + CLI runner
        └── 飞书文本 / 任务卡片 / 资源下载
```

### 目录说明

| 路径 | 作用 |
| --- | --- |
| `src/index.ts` | 应用入口、消息路由、命令处理和任务生命周期 |
| `src/im/` | 飞书接入、消息解析、交互式任务卡片 |
| `src/core/` | Bot 配置、会话、话题目录、命令和任务交接 |
| `src/cli/` | Claude/Codex 适配器、事件解析和子进程运行器 |
| `src/probe-cli.ts` | 手工检查 CLI `stream-json` 输出的探针 |
| `data/` | 运行时生成的会话、话题目录和下载文件（不提交） |

## 环境要求

- Node.js `>= 22`
- pnpm
- 可用的飞书应用凭证，并为每个应用开启事件长连接
- 本机 PATH 中可执行的 `claude` CLI；使用 Codex 时还需要 `codex` CLI

## 快速开始

### 1. 准备环境

- Node.js `>= 22`
- pnpm
- 至少一个飞书 Bot 的 App ID 和 App Secret，并为应用开启事件长连接
- 默认使用 Claude 时，确保 `claude` CLI 已在 PATH 中；使用 Codex 时额外确保 `codex` CLI 可用

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

先执行 TypeScript 构建检查，再启动本地服务：

```bash
pnpm build
pnpm start
```

`pnpm start` 使用 `tsx watch` 监听源码和 `.env`，适合本地开发热重载；如需不带 watch 的前台启动，可使用：

```bash
pnpm start:once
```

### 5. 验证启动

- `pnpm build` 无报错。
- 终端出现 `Agent OS 启动` 和至少一个 `[Bot] 已连接` 日志。
- 在飞书私聊已连接的 Bot 发送 `/help` 或 `/status`，确认收到回复。
- 群聊中需要先 @ 对应 Bot；项目没有 HTTP 服务或固定端口，验证方式以启动日志和飞书消息回复为准。

更多命令参见[飞书内置命令](#飞书内置命令)，遇到问题可查看[故障排查](#故障排查)。

开发时还可使用：

```bash
pnpm dev        # pnpm start 的别名
pnpm probe:cli  # 手工查看 CLI 的 JSON 流事件
```

## 配置说明

### Bot 凭证

按角色配置以下环境变量（缺少凭证的角色会被跳过）：

| 角色 | 环境变量前缀 | 默认显示名 |
| --- | --- | --- |
| CEO | `BOT_CEO` | CEO助手 |
| PM | `BOT_PM` | 产品经理 |
| 架构师 | `BOT_ARCH` | 架构师 |
| 开发 | `BOT_DEV` | 开发工程师 |
| QA | `BOT_QA` | 测试工程师 |
| 评审 | `BOT_REVIEWER` | 代码评审 |

每个前缀至少需要 `<PREFIX>_APP_ID` 和 `<PREFIX>_APP_SECRET`，还可设置 `<PREFIX>_NAME`、`<PREFIX>_WORKDIR`。开发 Bot 兼容旧变量 `BOT_A_APP_ID` / `BOT_A_APP_SECRET`。

### 引擎、流水线和工作目录

| 变量 | 说明 | 默认/回退 |
| --- | --- | --- |
| `DEFAULT_CLI` | 新会话默认引擎：`claude` 或 `codex` | `claude` |
| `COLLAB_MAX_ROUNDS` | `/review` 评审↔开发的最大协作轮次（1–10；非法值回退为 2） | `2` |
| `PIPELINE_STEPS` | CEO `/pipeline` 的步骤，逗号分隔：`pm`、`architect`、`dev`、`review`、`qa`、`summary` | `pm,architect,dev,review,qa,summary` |
| `CLAUDE_WORKDIR` | Claude 全局回退目录 | 当前工作目录 |
| `CODEX_WORKDIR` | Codex 全局回退目录；未设置时继续回退到 `CLAUDE_WORKDIR`、当前工作目录 | 未设置时按上述顺序回退 |
| `CODEX_SANDBOX` | Codex 沙箱模式：`read-only`、`workspace-write` 或 `danger-full-access` | `workspace-write` |

不要把真实 Secret 提交到 git；`.env` 和 `data/` 已被忽略。

## 飞书内置命令

在私聊中直接发送命令；群聊中需先 @ 对应 Bot。

| 命令 | 作用 |
| --- | --- |
| `/help` | 查看命令帮助 |
| `/status` | 查看当前会话、引擎和实际工作目录 |
| `/workdir [路径]` | 查看或设置本话题项目目录；`/workdir clear` 清除 |
| `/engine claude\|codex` | 切换当前会话引擎并清理旧 CLI 上下文 |
| `/handoff <角色> <任务>` | 将任务交给同话题的其他 Bot |
| `/review <任务>` | 评审→开发协作（意见自动回传，可多轮；需同时配置 reviewer 和 dev Bot） |
| `/pipeline <目标>` | **仅 CEO**：启动团队交付流水线；未配置的步骤会跳过 |
| `/reset` | 清理 CLI 上下文，但保留 Agent OS 会话 |
| `/close` | 关闭当前会话 |
| `/reopen` | 重新打开已关闭会话 |
| `/clean` | 删除所有已关闭会话记录 |

示例：

```text
/workdir /path/to/project
/engine codex
/handoff dev 根据当前仓库写一段 README 大纲
@CEO助手 /pipeline 给 README 补一节快速开始说明
```

## 会话与协作模型

- 会话键由 `chatId + topicId + botId` 组成，因此同一话题中的不同角色拥有各自的上下文。
- `topicId` 优先使用飞书 `threadId`，其次是 `rootId`，最后回退到消息 ID。
- `/workdir` 绑定的是话题目录，同一话题下的 Bot 共享该目录。
- 切换或清除话题目录、切换引擎、`/reset` 和 `/reopen` 都会清理对应 CLI 上下文，避免跨目录或跨引擎恢复错误会话。
- 运行中任务不能重复执行、切换引擎或切换目录；可用 `/close` 取消任务。
- `/pipeline` 默认步骤：PM → 架构 → 开发 → 评审协作 → 测试 → CEO 汇总；可用 `PIPELINE_STEPS` 裁剪；未连接的角色会跳过。

## 开发与扩展

1. 在 `src/cli/` 实现新的 `CliAdapter`（参数构造和流式事件解析）。
2. 在 `src/cli/registry.ts` 注册引擎。
3. 如需新的飞书消息类型，在 `src/im/message-parser.ts` 和 `src/im/lark.ts` 扩展解析/下载逻辑。
4. 修改命令时同步更新 `src/core/command-parser.ts`、`src/index.ts` 的帮助文本和本文档。

提交前建议执行：

```bash
pnpm build
```

## 故障排查

- **未找到任何 Bot 凭证**：检查 `.env` 中至少一个 Bot 的 App ID 和 Secret 是否非空。
- **`claude` / `codex: command not found`**：确认 CLI 已安装，并且启动 `pnpm start` 的终端能通过 `which claude` / `which codex` 找到它。
- **群聊没有响应**：确认已 @ 正确的 Bot、应用已加入群，并已开启飞书事件长连接。
- **工作目录不存在**：`/workdir` 设置前确认路径是已存在的目录。
- **恢复了旧上下文但目录已变更**：重新发送 `/workdir <路径>` 或 `/reset`，让系统建立新的 CLI 会话。

## 已知限制 / 待补充

- 当前仓库未提供自动化测试脚本；可补充适配器、会话状态机和消息解析的单元测试。
- 飞书应用创建、权限清单、生产进程托管和日志/监控方案需要补充部署章节。
- `cron` 定时巡检属于产品设想，当前入口代码未提供独立的定时任务配置。

## 许可证

> 待确定。
