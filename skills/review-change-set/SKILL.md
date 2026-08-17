---
name: review-change-set
description: "在功能、修复、重构或迁移完成实现后、进入 QA 或合并前，独立审查完整变更集及其关联契约，检查范围、架构、安全、可靠性、边界和删除风险，并生成可机器校验的 review artifact；不用于早期方案设计、开发者自我证明、直接修改代码或最终发布证据链审查。"
---

# 审查实现变更集

## 必需输入

- 读取 canonical 契约、批准方案、最新 implementation manifest 和项目指令。
- 获取项目根目录、基线、当前 fingerprint、控制器提供的 `evidenceRoot`。
- 无法确定基线、完整变更范围或已有用户改动归属时，报告 blocked，不得猜测。
- 实际运行 `workflow_context.fingerprintCommand`；`implementationFingerprint` 与
  `reviewFingerprint` 都必须等于其 JSON 输出中的 `fingerprint`，不得使用 Git hash。

## 执行流程

1. 运行 `scripts/discover-review-scope.mjs <review-scope-config.json>`，保存输出。
2. 核对 staged、unstaged、untracked、删除文件与 implementation manifest；任何差异都要解释。
3. 按逻辑模块审查完整 diff，并搜索调用方、公共接口、配置、数据模型和测试。
4. 将需求和 P0/P1 风险逐项追踪到实现及验证位置。
5. 检查正确性、错误路径、权限、输入、并发、事务、兼容、性能、可维护性和测试真实性。
6. 对删除或废弃判断立即安全删除还是延期迁移，并记录验证和回滚条件。
7. 区分事实、推断、建议和未验证；记录未覆盖范围与残余风险。
8. 生成 `change-review.json`，运行 `scripts/validate-review-report.mjs <change-review.json>`；
   在 Gate 检查中记录原始 argv、cwd、起止时间、退出码和 required/status，禁止用自然语言命令冒充执行证据。
9. 只有校验通过且没有开放 P0/P1 时才输出 `[APPROVED]` 与 `[RESULT:done]`。
   未通过时输出 `[RESULT:done]` 且不要 `[APPROVED]`。

## 强制检查

- 变更范围同时来自版本控制状态和 implementation manifest，不能只读开发总结。
- 大型或混合 diff 按模块分批，但最终覆盖所有文件。
- P0/P1 finding 必须包含证据、影响和置信度；安全 finding 还需说明可达性。
- 所有删除、公共契约变化和质量配置变化必须显式审查。
- 即使没有 finding，也要输出 `notReviewed` 和 `residualRisks`。

## 禁止行为

- 不得直接修改被审查代码或在 reviewer 身份下完成修复。
- 不得忽略 untracked 文件、失败命令、动态调用方或外部消费者风险。
- 不得用 `[APPROVED]`、LGTM 或开发说明替代结构化证据。
- 不得通过删除测试、降低规则、吞异常或降级 P0/P1 获得通过。
- 不得把建议性重构升级为阻断问题，除非能证明实际影响。
- 不得把新发现风险自行标为 waived；只有人工确认前 canonical Spec 中同 ID 的
  `[RISK_WAIVER]` 可沿用，批准时间和证据由控制器绑定。

## 输出与阻断

输出 `change-review.json`，包含 `implementationFingerprint`、`reviewFingerprint`、
`baseline`、`reviewScope`、`requirementCoverage`、`relatedContracts`、`findings`、
`removalPlans`、`notReviewed`、`residualRisks`、`decision` 和 `status`。
`findings[]` 字段必须与控制器 `GateFindingSchema` 对齐：
`severity=P0|P1|P2|P3`，`status=open|resolved|waived`（审查不得保留 `planned`），
可选 `category` 只能是
`correctness|security|reliability|architecture|performance|maintainability|testing|compatibility|scope|other`
（优先写枚举原值；未知自造标签会被本地校验拒绝；常见近义别名由共享模块归一化），
可选 `confidence=low|medium|high`，安全类 P0/P1 还需
`exploitability=not-applicable|unreachable|conditional|reachable|unverified`。
把文件保存到 `evidenceRoot`，计算真实 SHA-256，并作为 `review-report` 写入
`[GATE_RESULT].artifacts`；finding 摘要必须与 artifact 一致。
`checks[].command` 每个数组元素上限 10000 字符。长内联脚本（如 `node -e '...'` 或 `/bin/zsh -lc '...'`）
必须先写入临时文件（如 `evidenceRoot/check-xxx.mjs`），再用 `node check-xxx.mjs` 作为 command，避免超限截断。

基线不明、manifest 与真实变更无法调和、当前 fingerprint 与实现证据不一致、
未覆盖完整变更集、校验脚本失败或仅输出文本批准时阻止进入 QA（`[RESULT:blocked]` + `[BLOCK_KIND:gate-evidence]`，审查本身无法完成）。
开放 P0/P1 时不得输出 `[APPROVED]`，必须 `[RESULT:done]`（可加 `[DECISION:rejected]` + `[HANDOFF:dev]`）让协作回传开发；禁止把这些 FIND 写成
`[RESULT:failed]`（那会跳过回传）。存在有效契约 waiver 且无开放 P0/P1 时使用 `decision=approved-with-waiver`。

## 按需参考

- 确定 diff 基线、分批和关联影响：读取 `references/diff-scoping.md`。
- 出现职责、依赖或公共接口问题：读取 `references/solid-and-architecture-smells.md`。
- 涉及输入、权限、数据写入、资源消耗或并发：读取 `references/security-and-reliability.md`。
- 涉及删除、废弃或兼容层移除：读取 `references/removal-and-deprecation.md`。

## 回归验证

- 真实失败：manifest 遗漏 untracked 文件或开放 P1 时必须 fail。
- 通用案例：不同目录结构的 CLI、API 或前端项目均能按变更和契约审查。
- 不触发：早期方案讨论、纯解释和最终交付证据链审查不调用本 Skill。
- 绕过案例：只写 `[APPROVED]`、隐藏文件或把 P1 降为 warning 不能通过门禁。
- 修复案例：修复后重生成 implementation evidence，完整复审并校验通过才可进入 QA。
