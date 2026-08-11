---
name: implement-traceable-change
description: "在已批准交付契约和风险方案下实现功能、修复、重构或迁移，并记录需求、文件和测试追踪；不用于无方案的大范围编码、纯审查、直接发布或通过修改质量门禁掩盖失败。"
---

# 实现可追踪变更

## 必需输入

- 读取已批准 canonical Spec 及其内容 SHA-256、变更方案和匹配的项目快照；
  `contractHash` 必须等于控制器传入的 `canonical_spec.sha256`。
- 获取允许、禁止修改的路径以及已有用户改动。
- 无法安全区分用户改动与任务修改时，停止并报告冲突。
- `fingerprintBefore` 使用 `workflow_context.projectFingerprintBeforeStep`；完成修改后实际运行
  `workflow_context.fingerprintCommand`，以其 JSON 输出中的 `fingerprint` 作为 `fingerprintAfter`。
  `planHash` 必须是最新 `change-plan.json` 文件内容的真实 SHA-256。

## 执行流程

1. 读取项目指令和方案引用的源码。
2. 保存实现前 fingerprint；实现过程中不得把 Git commit hash 当成项目 fingerprint。
3. 按需求 ID 实现最小完整变更。
4. 逐项落实并发、权限、校验、幂等、错误、缓存和回滚约束。
5. 增加能证明行为的目标测试，包括方案要求的负向和竞争场景。
6. 运行目标模块的快速检查。
   每项记录原始 argv、`required`/`status`、cwd、起止时间、退出码和耗时，禁止用自然语言命令代替。
7. 运行 `scripts/check-change-scope.mjs <scope.json>`。
8. 生成 `implementation-manifest.json` 并运行
   `scripts/validate-implementation-manifest.mjs`。

## 强制检查

- 每个变更文件对应至少一个需求或风险控制。
- 每个 P0/P1 风险都有代码位置和测试位置。
- 错误不能被吞掉或只记录后假装成功。
- 数据状态检查和写入符合方案的原子性要求。
- 公共接口、配置和环境变量具有兼容或迁移说明。
- 测试覆盖和断言强度没有被降低。

## 禁止行为

- 不得增加 skip、only、空断言或宽松选择器绕过失败。
- 不得删除失败测试来获得绿色结果。
- 不得修改 lint、typecheck 或覆盖率阈值，除非契约明确批准。
- 不得重写无关用户改动。
- 不得宣称完整交付通过。

## 输出与阻断

输出 `implementation-manifest.json`，包含 `contractHash`、`planHash`、
`fingerprintBefore`、`fingerprintAfter`、`changedFiles`、`requirementImplementations`、
`riskControls`、`testsAddedOrChanged`、`targetedCheckResults`、`deviations` 和 `status`。
把结构化输出保存到控制器提供的 `evidenceRoot`，计算真实 SHA-256，并写入 `[GATE_RESULT].artifacts`。

修改越界、P0/P1 控制未实现、目标测试失败或质量门禁被弱化时阻止 QA。

## 按需参考

- 范围、错误和质量门禁约束：读取 `references/implementation-constraints.md`。
- 数据写入：读取 `references/data-write-patterns.md`。
- UI 状态与重复交互：读取 `references/frontend-interaction-patterns.md`。

## 回归验证

- 真实失败：改变质量配置或越过方案允许路径时，范围脚本必须 fail。
- 通用案例：不同业务的 API 修复能产出需求到文件、测试的追踪 manifest。
- 不触发：只读分析、方案设计和最终审查不调用本 Skill。
- 绕过案例：新增 skip、删除测试或隐藏失败命令必须形成阻断 finding。
- 修复案例：范围、P0/P1 控制和目标测试均满足时应 pass 并交给 QA。
