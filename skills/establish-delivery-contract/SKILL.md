---
name: establish-delivery-contract
description: "在新项目、功能交付、迁移、恢复旧任务或存在多个需求来源时，统一用户目标、规格版本、项目环境、验收标准和质量门禁；不用于纯解释、无行为变化的拼写修正或交付后的代码审查。"
---

# 建立交付契约

本 Skill 的 `scripts/` 属于编排框架，不是目标仓库代码。请运行
`workflow_context.skillsRoot/establish-delivery-contract/scripts/...`；没有该字段时使用本文件所在目录。

## 必需输入

- 获取目标项目绝对路径、用户目标、可读取的规格和项目级指令。
- 获取 Git 状态、运行时、包管理器、构建与测试配置。
- 缺少目标路径、关键规格不可读或规格冲突无法定夺时，停止并报告阻塞。

## 执行流程

1. 验证目标路径和现有用户改动，不修改任何项目文件。
2. 运行 `scripts/discover-project.mjs <project-root>` 生成技术与质量命令清单。
3. 枚举需求来源并记录路径、状态、更新时间和 SHA-256。
4. 比较范围、非目标、路由、数据模型、验收和部署约束。
5. 把冲突标记为已解决、需所有者决定或已被取代；禁止自行猜测权威版本。
6. 为每条可交付要求分配 `RQ-001`、`RQ-002`…格式的稳定唯一 ID；每条必须以该 ID
   开头（例如 `### RQ-001 登录`），并定义可观察验收、负向场景和证据类型。
7. 定义运行时、浏览器、数据库、构建、部署和安全基线；不适用项给出依据。
8. 没有用户已明确接受的风险时，Spec 正文不要出现 RISK_WAIVER 标记（包括说明、示例、
   非目标）。只有用户已经明确接受的已知风险，才可单独一行写入该标记并紧跟完整 JSON：
   findingId、owner、reason、scope、compensatingControl、expiresAt（带时区 ISO）。
   不得替用户决定、使用占位值、代填批准时间，或为未来未知 finding 预授权。
9. 在 Agent OS 团队流水线中输出含稳定需求 ID 的完整 Spec 正文。交卷前把正文写入临时
   markdown 并运行 `scripts/validate-spec-markdown.mjs`；失败则先修正。控制器在人工确认后
   保存 canonical 版本、内容 SHA-256 和项目绑定。独立使用本 Skill 时另生成
   `delivery-contract.json` 并运行 `scripts/validate-delivery-contract.mjs`。

## 强制检查

- 只允许一个 canonical 规格。
- 每条 P0/P1 要求必须有来源、唯一 ID 和可验证验收。
- 从真实项目配置确定运行时和依赖版本。
- 登记所有适用的 lint、typecheck、test、build、migration 和 E2E 命令。
- 把未验证项明确标为 unverified，禁止写成已通过。
- 流水线 Spec 必须先通过 `scripts/validate-spec-markdown.mjs` 再输出。
- `waived` 只能引用人工确认前已存在于 canonical Spec 的同 ID `RISK_WAIVER`；后续 Agent
  生成的 owner、期限或“审批证据”都不构成人工授权。

## 禁止行为

- 不得按文件名或目录位置擅自认定权威规格。
- 不得静默忽略与实现冲突的已批准要求。
- 不得把框架默认能力当作项目已实现能力。
- 不得修改源码、规格、测试或质量配置。
- 不得用自然语言总结替代结构化契约。

## 输出与阻断

流水线 Spec 必须包含项目范围、稳定需求 ID、优先级、可观测验收、非目标、
开放决策、运行时基线和质量命令。独立 JSON 模式必须包含 `projectRoot`、
`projectFingerprint`、`canonicalSpec`、`sourceHashes`、`requirements`、`nonGoals`、
`openDecisions`、`runtimeBaseline`、`qualityCommands`、`requiredGateIds` 和 `status`。
产品评审通过后由控制器保存版本、canonical 状态和内容 SHA-256；在此之前不得进入架构阶段。

没有 canonical 规格、任一 P0/P1 缺验收、目标目录不明确或存在未解决冲突时，阻止进入架构阶段。
只有任务所有者的明确决定或更新后的规格可以解除阻断。

## 按需参考

- 项目发现与命令识别：读取 `references/project-discovery.md`。
- 多规格冲突、需求 ID 和验收设计：读取 `references/requirement-reconciliation.md`。

## 回归验证

- 真实失败：用存在多份冲突 Spec 的项目，期望因无 canonical 版本而 fail。
- 通用案例：用不同目录结构的 API 服务，期望从实际配置生成契约并 pass。
- 不触发：纯解释或只读代码审查不调用本 Skill。
- 绕过案例：省略 P0 验收、把冲突写成 warning，或把 RISK_WAIVER 说明/示例抄进 Spec
  且后面没有完整 JSON，校验脚本必须 fail。
- 修复案例：确定 canonical、补齐验收和门禁后应 pass，输出可由架构节点读取。
