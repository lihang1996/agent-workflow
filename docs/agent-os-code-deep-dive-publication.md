# Agent OS 源码深度导读发布记录

- 发布日期：2026-08-27
- 飞书文档：https://my.feishu.cn/docx/RjpJdatwio5Ohdxp4wlcQvUln2e
- 文档 ID：`RjpJdatwio5Ohdxp4wlcQvUln2e`
- 创建返回版本：`revision_id = 6`
- 初学者版重构版本：`revision_id = 15`
- 跟学项目文档版本：`revision_id = 163`（2026-08-28）
- 本地正文：`docs/agent-os-code-deep-dive.md`
- 验证报告：`docs/agent-os-code-deep-dive-verification.md`
- 确认规格：`.scratch/agent-os-single-article/spec.md`

## 发布校验

- 飞书草稿 Profile Check：通过。
- 云端目录回查：11 个主节和 8 道自测均存在。
- 关键词回查：`request_spec_approval`、`CollaborationService.dispatch`、`/doctor` 均可检索。
- 未发现可复用的既有 Docx URL，因此本次创建了新文档。

## 初学者版重构校验

- 复用原 Docx URL，整篇重排后覆盖更新成功，未创建副本。
- 文档标题更新为“Agent OS 源码导读（初学者版）：跟着一条飞书消息看懂整个项目”。
- 新增阅读指南、主链文本地图、38 个三级教学小节、逐步拆解、输入/输出/下一站和章节检查。
- 24 个源码/配置片段恢复为正常多行布局；云端回查 `IncomingMessage`、`runCli`、`ThrottledCardUpdater` 均未被压成单行。
- Mermaid 主链图已在飞书转换为 whiteboard block；更新返回 `result=success`、`warnings=[]`。

## 跟学项目文档重构校验（2026-08-28）

- 复用原 Docx URL，按「学习方案 + 详细项目文档 + 文中带代码」整篇覆盖，未创建副本。
- 标题更新为「Agent OS 项目学习文档：跟着一条飞书消息把整个仓库学透」。
- 去掉外包公司 / 西天取经故事壳，改为可跟学结构：三条路径、环境预检、仓库地图、每节动手验证、8 道自测和速查表。
- 代码片段按当前工作区校正：`IncomingMessage` 补齐字段，`CliEvent` 含 `tool_call`，编排层使用 `executeCli` / `ensureProductSpecSubmission`，不再使用文中虚构的 `runCliTask`。
- 当前基线 `pnpm exec tsc --noEmit` 可通过；`CreateClarificationFlowOptions` 已包含 `collaboration`。
- Mermaid 主链图已转为 whiteboard；更新返回 `result=success`、`warnings=[]`。

## 已知边界

工作区相对 commit `150e49e` 仍有未提交改动。文章解释当前代码表达的设计和可静态确认的控制流；完整飞书端到端验收仍需读者在测试群自行跑通。
