---
name: design-risk-aware-change
description: "在代码、数据、接口、权限、缓存、依赖、部署或交互行为将发生变化时，设计可验证的模块边界、失败语义、并发事务、兼容和回滚方案；不用于只读分析、纯文案调整或尚未建立交付契约的任务。"
---

# 设计风险感知变更

## 必需输入

- 读取控制器提供的 canonical Spec 正文与 `canonical_spec` 元数据（ID、版本、
  内容 SHA-256）、当前项目快照、相关源码和测试。若项目另有已批准
  `delivery-contract.json`，也必须校验其与 canonical Spec 一致。
- 获取预期修改范围、禁止修改范围、数据库和部署环境。
- `contractHash` 使用 `canonical_spec.sha256`；该 hash 不匹配或项目已偏离契约快照时，
  停止并要求重建基线。
- `projectFingerprint` 使用 `workflow_context.projectFingerprintBeforeStep`；需要复核时实际运行
  `workflow_context.fingerprintCommand`，读取其 JSON 输出中的 `fingerprint`，不得改用 Git hash。

## 执行流程

1. 读取与需求 ID 相关的模块、调用方、schema、配置和测试。
2. 运行 `scripts/detect-change-risks.mjs <project-root> [files...]`。
3. 建立需求到模块、接口、数据、状态和测试的追踪矩阵。
4. 为认证、输入、并发、事务、幂等、缓存、兼容和部署风险制定控制。
5. 定义调用方可观察的错误、状态码和部分失败语义。
6. 定义迁移、回滚、降级、数据恢复和可观测性方案。
7. 为正常、异常、边界、并发和攻击场景设计验证。
8. 生成 `change-plan.json` 并运行 `scripts/validate-change-plan.mjs`；在 Gate 检查中记录
   原始 argv、cwd、起止时间、退出码和 required/status。
9. `change-plan.json.checks` 是设计检查的权威集合；最终 `[GATE_RESULT].checks` 不得重复
   其中任何 ID，没有额外检查时必须输出 `[]`，由控制器从主 artifact 水合。确需记录
   写入 artifact 之后的额外检查时，只能使用新的唯一 ID。

## 强制检查

- 每条 P0/P1 要求至少映射一个实现点和一个验证点。
- 同一实体出现先读后写时，必须说明原子性、隔离或条件写策略。
- 可重试写操作必须定义幂等性。
- 唯一约束冲突必须映射为稳定业务错误。
- 破坏性测试必须有环境身份保护。
- 不适用风险必须提供源码或架构依据。

## 禁止行为

- 不得用“放进事务”替代明确事务范围和隔离说明。
- 不得只设计正常路径或只依赖前端按钮禁用。
- 不得通过降低类型、lint、测试或安全配置解决兼容问题。
- 不得直接实现代码。

## 输出与阻断

输出 `change-plan.json`，包含 `contractHash`、`projectFingerprint`、`requirementTrace`、
`affectedModules`、`riskAssessments`、`failureSemantics`、`migrationPlan`、`rollbackPlan`、
`testPlan`、`allowedPaths`、`forbiddenPaths`、非空 `checks` 和 `status`。
`riskAssessments[].disposition` 只能是 `applicable|not-applicable|analysis-required`。
若同时输出 `findings[]` 或 `[GATE_RESULT].findings`，字段必须与控制器对齐：
`severity=P0|P1|P2|P3`，`status=planned|open|resolved|waived`（设计可用 `planned`），
可选 `category` 只能是
`correctness|security|reliability|architecture|performance|maintainability|testing|compatibility|scope|other`，
禁止自造标签。
把结构化输出保存到控制器提供的 `evidenceRoot`，计算真实 SHA-256，并写入 `[GATE_RESULT].artifacts`。
`checks[].command` 每个数组元素上限 10000 字符。长内联脚本（如 `node -e '...'` 或 `/bin/zsh -lc '...'`）
必须先写入临时文件（如 `evidenceRoot/check-xxx.mjs`），再用 `node check-xxx.mjs` 作为 command，避免超限截断。

P0/P1 缺映射、数据写存在未解决竞争、迁移不可恢复或关键兼容条件未验证时阻止开发（`[RESULT:failed]`）。
已给出实现点与验证点、标记为 `planned` 的 P0/P1 随设计门禁 pass 通过，必须输出 `[RESULT:done]` 交给开发闭环；禁止把这些 FIND 写成 `[RESULT:failed]`。

## 按需参考

- 风险触发规则：读取 `references/risk-taxonomy.md`。
- 数据写和竞争控制：读取 `references/concurrency-and-transactions.md`。
- 运行时、接口和部署边界：读取 `references/compatibility-and-boundaries.md`。

## 回归验证

- 真实失败：对先查询再更新的数据写路径，缺少并发控制时必须 fail。
- 通用案例：不同目录的队列消费者变更能识别幂等、外部 I/O 和回滚风险。
- 不触发：纯文案调整或尚无交付契约时不执行设计门禁。
- 绕过案例：只写“使用事务”但无范围、隔离和验证，校验必须 fail。
- 修复案例：需求映射、风险处置、范围和测试计划齐全后应 pass。
