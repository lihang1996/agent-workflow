# Agent OS 单篇源码深度导读验证报告

验证日期：2026-08-27（Asia/Shanghai）

## 结论

文章产物已完成结构、篇幅、片段、A/B/C 文件、关键符号、双 adapter 脱敏夹具和本地文档检查。根项目当前无法通过类型检查和构建，且尚未完成维护者事实审阅与目标读者 60～90 分钟试读，因此按 Spec Definition of Done 判定为“内容完成，发布验收阻塞”，不能记录为完整 DoD 通过。

2026-08-27 可读性重构补充：正文已按初学者反馈完成整篇重排，并覆盖更新原飞书 Docx 至 `revision_id = 15`。新增“阅读路线、主链地图、先说人话、逐步拆解、输入/输出/下一站、本节检查”，关键 TypeScript 片段恢复为多行格式；云端目录与 `IncomingMessage`、`runCli`、`ThrottledCardUpdater` 片段已回读确认。下方文章统计以 revision 15 为准；源码构建风险结论未改变。

## 基线与工作区

- Git commit：`150e49e1e0a63aa98130221953f78439a3207284`
- 分支：`leon_cladue`
- 快照口径：上述 commit + 2026-08-27 当前未提交工作区；不是干净副本或 tag。
- 工作区状态：26 个 tracked modified、1 个 tracked deleted、14 个 untracked 条目，共 41 个 porcelain 条目。本文只新增/编辑 `docs/agent-os-code-deep-dive.md` 与本报告，没有修改业务源码。
- 环境：Darwin 24.6.0 arm64；Node v22.15.0；pnpm 10.33.0；Claude Code 2.1.221；Codex CLI 0.146.0。
- 根项目约 7,254 行 TypeScript（含 `src/index.ts` 862 行）；`package.json` 有 build/start/probe，无根 test/lint 脚本。

## 篇幅与结构统计

统计脚本先移除 fenced code/diagram，再排除“最后按我想找什么反查”之后的最终索引；中文正文按去空白后的 Unicode 字符近似统计。

- 去除 fenced block 后的非空白正文约 31,441 字符；可读性重构增加了逐步解释与章节导航，不再以原 22,000 字上限作为删减目标。
- 结构：1 个“开始之前”阅读指南、11 个连续主节（0～10）、38 个三级教学小节。
- 源码/配置片段：24 个，共 888 个物理行；另有 2 个文本流程块和 1 张 Mermaid 主链路图。行数增加主要来自把原先压缩在单行内的 TypeScript 恢复为正常格式。
- 自测：8 道，均附折叠答案。
- 最终索引：1 张，按“我想找什么”组织，覆盖 17 个主题。
- 禁用旧结构词扫描：未出现“30 章、周计划、阶段作业、毕业项目”结构。

## 片段验证清单

24 个片段覆盖配置/启动、飞书入口、命令/会话、主编排、CLI 契约与 runner、双 adapter、进度/卡片、MCP 澄清/产品方案、真实 Bot 协作和 Docx 评论回改。revision 15 保留原有类型名称、控制流与错误语义，删除部分非关键字段，并把关键判断恢复为适合初学者阅读的多行布局。片段用于理解控制流，不替代完整源文件。

## A/B/C 文件覆盖

- A 级：22/22 文件存在，22/22 在正文有源码片段与职责说明。机械检查缺失 0。
- B 级：17/17 文件/配置存在并在正文或最终索引定位。覆盖配置/团队/Runtime、CLI 转发与 MCP 参数、停止与卡片动作、产品 flow 持久化与 local 文件验证、topic/workspace、通知/收尾、原生 resume/compact。
- C 级：已按类别说明 `src/probe-*.ts`、`example-project/`、`workspace-template/`、`SETUP.md/CLAUDE.md/.env.example`、构建文件及纯 UI/格式/schema 辅助函数，没有逐文件扩写。

## 关键符号覆盖

按 Spec 拆分合并项后建立 59 个搜索词：源码存在 59/59，文章出现 59/59。覆盖 `load/parseAgentOsConfig`、`buildBotPrompt`、TeamRegistry、启动/消息解析、命令与 topic、SessionManager/store、CLI registry/execution/runner/spawn、双 adapter 与 MCP 参数、progress/card/abort、澄清、产品方案与审批、协作、评论、原生 resume/compact、长答案/通知/收尾。

说明：机械“出现”之外，正文沿调用路径为深讲枢纽写了输入、输出、调用者、下一跳、状态副作用和至少一个边界；最终仍需熟悉仓库的维护者完成语义复核。

## 实际执行命令与结果

- `pnpm install --frozen-lockfile`：退出 0；lockfile 已是最新。pnpm 随后检查自身更新时出现 registry TLS 元数据告警，不影响本次依赖安装退出码。
- `pnpm exec tsc --noEmit`：退出 1。错误：`src/index.ts(448,15) TS2353`，`CreateClarificationFlowOptions` 不接受 `collaboration`。
- `pnpm build`：退出 2；同一 TS2353 阻塞生成可验证构建。
- Claude/Codex adapter 脱敏内存夹具（`pnpm exec tsx`）：退出 0。两者分别验证 session、tool start、Agent OS tool_call、tool end、answer/result、stats（Codex）与 error 映射。
- 脱敏 Codex NDJSON 管道输入 `pnpm probe:cli`：退出 0；观察到 thread、agent_message、usage 三类输出。
- `pnpm --dir example-project test`：退出 0；4/4 Node tests 通过。该测试仅证明示例项目 seam，不替代根项目测试。
- 本地 Markdown 检查：27 个 fenced block 起止成对，尾随空白扫描无命中。
- revision 15 结构检查：阅读指南 + 11 个主节 + 38 个教学小节；24 个源码/配置片段，共 888 行；A/B 文件与关键符号覆盖口径保持不变。
- 飞书云端回查：目录层级完整；`IncomingMessage`、`runCli`、`ThrottledCardUpdater` 代码块保持多行；写入返回 `result=success`、`warnings=[]`。
- 敏感模式扫描 `rg`：退出 1，表示文章未命中 secret/token 变量模式、完整 open/chat id、真实 Docx URL或敏感绝对路径。

未执行 `pnpm probe:tool <claude|codex>`、`pnpm start:once` 或真实飞书链路：这些会使用真实 CLI 高权限参数、凭据和外部系统，超出安全本地文档验证；本次以脱敏 adapter 夹具代替协议验证。

## 未解决风险与影响

1. 根项目编译阻塞：clarification flow 的类型没有 `collaboration`，但 index 试图传入。影响是当前快照不能 build/发布，且“澄清后继续保留协作来源”契约未闭合。
2. `JsonProductSpecFlowStore` 的 Zod 持久化 schema 未包含 `collaboration`。即使编译错误修复，来自协作的 pending 产品方案在重启后可能失去回交 Leader 的来源，需要业务修复与迁移验证。
3. 工作区很脏且无冻结 tag/干净副本；文章已绑定 commit+worktree 日期，但未形成可复现归档。后续源码变更可能使片段漂移。
4. 根项目没有 test/lint 脚本；adapter 夹具为本次临时只读验证，没有沉淀为仓库回归测试。
5. 未运行真实 Claude/Codex、飞书 WS/REST、MCP 产品工具、真实 Bot dispatch 与 Docx 评论端到端；凭据、外部权限、速率限制和 CLI 版本兼容尚未实证。
6. `activeRuns`、协作 inbox/turn 去重、评论事件去重与队列是进程内状态；重启会丢在途协作和去重记录。
7. `/cd` 接受可访问的绝对路径，CLI 使用跳过权限/沙箱参数；必须依赖受控系统账户、最小权限 workspace 与可恢复版本控制。
8. 没有维护者事实审阅、目标读者连续试读、7 项理解测试和 5 次索引定位盲测，因此阅读效果验收未完成。

## Definition of Done 判定

- 结构、主链路、产品/协作/评论分支、文件与符号覆盖、篇幅、片段、自测和索引：通过。
- 脱敏与基础静态/夹具验证：通过。
- 教学基线 typecheck/build：失败，已准确披露，发布阻塞。
- 熟悉仓库的维护者事实审阅：未完成。
- 60～90 分钟目标读者试读与理解/定位验收：未完成。
- 真实 Claude、Codex、飞书与评论最小链路：未完成。

最终结论：两份本地产物可交给 ceo-assistant 组织修复与审阅，但当前不满足 Spec 的完整 Definition of Done，不能声称“已通过发布验收”。先修复并验证源码契约，再由维护者事实审阅和目标读者试读，才能解除阻塞。
