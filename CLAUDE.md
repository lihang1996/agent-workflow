# agent-os

以飞书话题群为操作界面、Claude Code 与 Codex 为执行引擎的个人生产系统。团队成员由配置文件注册，分别拥有角色、项目 Skill、默认引擎与独立的话题会话。

## 运行

```bash
pnpm start       # watch 模式启动，源码变化后自动重启
pnpm dev         # pnpm start 的别名
pnpm start:once  # 单次启动
```

## 约定

- ESM only，Node 22+，pnpm
- 凭证只放 `.env`（已 gitignore），绝不硬编码、绝不提交
- 测试话题群 chat_id 见 `.env`

## 错题本

> 踩坑后追加一行：现象 → 原因 → 正确做法。给未来的 AI 和人看。

- pnpm v11 默认拒绝依赖的构建脚本（esbuild 装完不可用）→ 在 `pnpm-workspace.yaml` 写 `allowBuilds: { esbuild: true }` 放行
- 已完成任务被「隔离进程组仍有存活后代」判失败、结果整体丢弃 → close 后一次瞬时核验不给辅助进程（MCP server、shell 等）有序退出时间，僵尸成员也被判活 → 正常退出路径改用 settleGroupAfterExit：有界宽限 → 升级整组终止 → 终验（僵尸不算存活），失败关闭原则不变
