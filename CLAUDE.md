# agent-os

把飞书变成 AI 编程 CLI（Claude Code / Codex）的指挥台。
一个话题 = 一个任务；bot 之间可互相 @ 协作；cron 定时巡检。

## 运行

pnpm dev（tsx watch）/ pnpm start / pnpm build

## 约定

- ESM only，Node 22+，pnpm
- 凭证只放 .env（已 gitignore），绝不硬编码、绝不提交

## 错题本

> 踩坑后追加一行：现象 → 原因 → 正确做法。给未来的 AI 和人看。

- Codex 双引擎依赖本机 `codex` CLI（不是 ChatGPT 桌面 App）；`command not found` → `npm i -g @openai/codex` 并保证跑 `pnpm start` 的终端能 `which codex`，再用 `/engine codex`。
- Codex 流式里 `item.started`/`item.completed` 成对出现 → 工具进度只在 started 上报；最终答案等 `turn.completed`，避免中间旁白当结果、工具事件翻倍。
- `codex exec resume` 报 `unexpected argument '--sandbox'` → `--sandbox` 只能挂在 `exec` 上，写成 `codex exec --sandbox <mode> resume --json <id> <prompt>`。
- 多 Bot 群聊必须 @ 到对应机器人才会响应；每个飞书应用都要单独开「长连接」收事件，并拉进同一个群。
- 一个话题一个项目：用 `/workdir <路径>` 绑定话题目录（全角色共享）；优先级为 话题目录 > `BOT_*_WORKDIR` > `CLAUDE_WORKDIR`/`CODEX_WORKDIR` > cwd。
- 会话管理：`/reset` 清 CLI 上下文，`/close` 关闭，`/reopen` 恢复，`/clean` 删除已关闭记录；换目录会清话题下各角色上下文。
- 同话题交接：`/handoff <角色> <任务>` 进程内交给目标 Bot 执行（不依赖飞书 bot 互 @），目标忙时拒绝。
- 协作轮次：`/review <任务>` 走 reviewer→dev 自动回传；评审含 `[APPROVED]` 则结束；上限由 `COLLAB_MAX_ROUNDS`（默认 2）控制。
- `tsx watch` 热重启会掐断进行中的 CLI → 卡片停在「运行中」；需 SIGTERM 收尾 + `data/active-runs.json` 启动时把遗留卡片标失败。长任务可用 `pnpm start:once`。
- 停机收尾：成功态不可被盖红；发卡后同步落盘；停机禁止 onSuccess 续跑；协作轮次落 `data/collab-rounds.json`；CLI 用进程组杀掉孙子进程。
- CEO 团队流水线：`/pipeline <目标>` 仅 CEO 可启；默认 PM→架构→开发→评审→测试→汇总；可用 `PIPELINE_STEPS` 裁剪。
- CEO 统一入口：`@CEO助手` 发自然语言目标（非斜杠命令）会直接启动流水线；专家 Bot 的 `/help` 引导先找 CEO。
- 运行主线在 `src/runtime/`（消息路由 / CLI 任务 / 协作 / 流水线）；`src/index.ts` 只做启动与信号。
- 结构化提问 MCP：`propose_questions` → `record_answers`；Claude 用 `--mcp-config`，Codex 用 `-c mcp_servers.*`；server 用绝对路径 `--import …/tsx/dist/loader.mjs` + `AGENT_OS_ROOT`。
