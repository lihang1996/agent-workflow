# 工作流修复与回归验证

验证日期：2026-09-11。基于 `4df83f6` 修复，改动保留在工作区。

## 当前行为

- 产品确认只保存确认记录，流程到此结束。不会自动派发开发或交回 Leader。
- 开发内部按 `implement-ticket` 调用 Tester 和 Code Reviewer；运行时不识别 `reviewBy` / `reviewMaxRounds`，也不存在 `automatic-review.test.ts`。循环由工作区 Skill 管理，没有运行时统一的三轮限制。
- 只有 Leader 可以派发；执行成员可以澄清需求，产品成员可以提交方案。

## 本轮修复

| 问题 | 修复与验证 |
| --- | --- |
| 进度卡更新异常导致服务退出 | 每次更新独立捕获失败，后续进度和最终结果仍可发送；失败终态允许再次提交 |
| HTTP 成功但飞书业务失败被忽略 | 消息、卡片与提及统一校验业务错误码和必需的 message_id |
| 发卡失败后协作任务消失 | 接收和执行分开持久化；发卡失败释放接收状态，重启仍用原 dispatchId 派发 |
| 进程中断导致重复执行 | 执行边界前的 received 状态恢复为 pending；running 恢复为 interrupted，提示检查，禁止自动重跑 |
| CLI 成功但通知失败又执行一遍 | 保存 CLI 结果后再交付；补发队列只处理卡片、正文、提及和评论回复，不调用 CLI |
| 结果卡不可见却提示查看结果 | 提及通知依赖对应结果卡成功交付；卡片失败先发备用说明，保存待补发记录 |
| 超时卡片补发覆盖用户后续确认 | 补发交互卡片时读取最新流程状态，已确认不会退回待确认 |
| /new、/cd、/resume 后旧卡片操作错误上下文 | 切换操作增加会话版本；澄清、方案确认和评论修改检查版本，重启后仍生效 |
| /close 绕过停止按钮的身份校验 | 命令与回调共用任务所有者校验；活动任务和待处理流程均受保护 |
| 三条执行路径状态处理不一致 | 普通消息、澄清续跑、评论修改共用 beginTask / executeTask / releaseTask |
| 启动入口难以集成测试 | 消息用例抽到 createMessageHandler，测试直接调用生产处理器，注入本地 CLI 替身 |

## 验证命令

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm exec tsc -p tsconfig.tests.json --noUnusedLocals --noUnusedParameters
pnpm --dir example-project test
git diff --check
```

本次验证结果：主项目 59/59 测试通过（原有 43 项，新增 16 项）；示例项目 4/4 测试通过；源码与测试类型检查、构建、未使用代码检查以及 `git diff --check` 全部通过。

新增 `tests/reliability-regression.test.ts` 覆盖实际消息入口、命令与卡片回调、评论调度、会话并发、进程重启、持久化回滚、业务错误码和结果补发。原有测试保留，结果卡失败用例调整为验证“排队补发且不重跑”，而非把已完成的 CLI 任务判为失败。

## 验证边界

- 飞书 API 使用替身注入业务失败和网络失败；没有向真实群聊或文档发送测试消息。
- CLI 业务执行使用替身；现有 MCP 协议测试启动真实本地 MCP 子进程。
- 没有调用真实 Claude/Codex 执行业务任务，也没有在 Windows 上运行进程；保留 npm shim 参数与路径相关测试。
- 单进程独占 data 目录。完整状态迁移、恢复边界和去重保留范围见 [可靠性与迁移](reliability-and-migration.md)。
