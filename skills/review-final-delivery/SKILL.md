---
name: review-final-delivery
description: "在代码准备交付、合并或发布时，基于最终项目快照、需求追踪和全部 gate 证据执行独立审查；不用于开发阶段自我审查、直接修复代码、早期方案讨论或仅凭开发总结给出 APPROVED。"
---

# 审查最终交付

## 必需输入

- 读取 canonical 契约、最终和基准 fingerprint、方案、实现、验证与运行时证据。
- 获取全部失败、警告、未验证项和 waiver。
- 缺少适用 gate 或 fingerprint 不一致时直接 blocked。
- 实际运行 `workflow_context.fingerprintCommand`，将 JSON 输出中的 `fingerprint` 作为
  `finalFingerprint`；不得用 Git hash、缓存值或开发总结替代。

## 执行流程

1. 运行 `scripts/verify-evidence-chain.mjs <evidence-chain.json>`。
2. 审查最终快照相对基准的完整 diff，不依赖开发总结。
3. 按 P0 到 P3 检查需求遗漏、非目标越界、权限、输入、秘密、并发、事务、
   错误、缓存、兼容、性能、可维护性和测试真实性。
4. 对最高风险路径至少抽查一个源码位置及其测试证据。
5. 验证 QA/运行时审计后没有源码或配置变化。
6. 区分事实、推断、建议和未验证。
7. 生成 `final-review.json` 并运行 `scripts/validate-final-review.mjs`。
8. 只有校验通过后才输出 `[APPROVED]`；存在有效 waiver 时必须使用
   `decision=approved-with-waiver`，不得宣称 clean pass。
9. Gate 检查记录验证器的原始 argv、cwd、起止时间、退出码和 required/status；
   不得把说明文字写成命令证据。

## 强制检查

- 所有 P0/P1 要求有实现和验证证据。
- 所有适用 gate 的最新 attempt 为 pass。
- 无未处理 P0/P1 finding。
- waiver 必须与人工确认前 canonical Spec 中同 ID 的 `[RISK_WAIVER]` 完全一致；批准时间和
  `approvalEvidence` 只能沿用控制器绑定值，不能由 Reviewer 生成、修补或用 URL 冒充。
- 最终 fingerprint 与已验证 fingerprint 完全一致。
- 工具和命令失败没有被自然语言掩盖。

## 禁止行为

- 不得直接修改被审查代码。
- 不得把 APPROVED、LGTM 或“测试通过”文字当作证据。
- 不得只审查开发列出的文件。
- 不得忽略 staged、unstaged 或 untracked 文件。
- 不得把明确 P0/P1 降级为 warning。

## 输出与阻断

输出 `final-review.json`，包含 `finalFingerprint`、`reviewedDiff`、
`reviewScope`、`requirementCoverage`、`evidenceChain`、`findings`、`waivers`、
`notReviewed`、`residualRisks`、`decision` 和 `status`。
其中 `evidenceChain` 必须原样复制 `workflow_context.controllerEvidenceChain`，形状为
`{"path":"绝对路径/evidence-chain.json","sha256":"64位真实哈希"}`；只写文件名或口头声称已读取无效。
把结构化输出保存到控制器提供的 `evidenceRoot`，计算真实 SHA-256，并写入 `[GATE_RESULT].artifacts`。
`evidence-chain.json` 由控制器生成且只读，Reviewer 不得修改或重算其中登记值。

最终快照未验证、有未解决 P0/P1、证据缺失/过期/hash 不匹配或只给文本结论时阻止交付。

## 按需参考

- 严重级别和 waiver：读取 `references/severity-and-waivers.md`。
- 独立最终检查：读取 `references/final-review-checklist.md`。

## 回归验证

- 真实失败：QA 后源码变化、缺少运行时证据或开放 P1 时必须 blocked/fail。
- 通用案例：不同业务和目录结构只依赖契约、diff、fingerprint 与 gate 证据。
- 不触发：开发中自检、早期方案讨论或单纯解释不调用本 Skill。
- 绕过案例：文本写 APPROVED、伪造旧 artifact 或跳过 gate 不能解除阻断。
- 修复案例：最新快照一致、全部 gate pass 且无开放 P0/P1 时才可 approved。
