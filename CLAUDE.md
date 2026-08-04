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
