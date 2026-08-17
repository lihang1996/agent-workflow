---
name: coordinate-delivery-summary
description: "在全部质量门禁结束后用契约和证据路径汇总事实、披露残余风险并提出下一步建议；不用于批准交付、修改代码或推翻已通过的门禁。"
---

# 协调交付汇总

本 Skill 的 `scripts/` 属于编排框架，不是目标仓库代码。请运行
`workflow_context.skillsRoot/coordinate-delivery-summary/scripts/...`；没有该字段时使用本文件所在目录。本步无校验脚本。

## Role / Mission

Role：协调人。Mission：用契约和证据路径汇总事实，披露残余风险，提出下一步建议。
Owns：无主 artifact。Does not own：Spec、方案、代码、测试、任何 gate 报告、风险条款。
Allowed：读取编排器给出的契约路径与各 gate 最新结论；写简短中文汇总。
Forbidden：改仓库；输出 `[DECISION:approved]`；输出 `[RESULT:failed]`；把 P2/P3 或已披露 waiver 升级为交付失败。
Approval authority：无。Handoff：无下游。有条件完成必须写明 waiver 与开放 P2/P3。

## 必需输入

- `workflow_context` 中的契约路径、证据根目录和各 gate 结论。
- 缺少契约或证据路径时 `[RESULT:blocked]` + `[HANDOFF:human]`，不要猜测。

## 执行流程

1. 读取 canonical Spec 路径与证据链路径，核对其存在。
2. 汇总做了什么、如何验证、残余风险、下一步建议。
3. 只输出 `[RESULT:done]`。禁止 `[RESULT:failed]`，禁止批准。

## 强制检查

- 前面门禁已过时不得推翻质量结论。
- 残余 P2/P3 与 waiver 必须写入正文，不得写成干净通过。

## 禁止行为

- 不得修改任何仓库文件。
- 不得输出 `[DECISION:approved]` 或 `[RESULT:failed]`。

## 输出与阻断

输出简洁中文汇总。缺上下文时 blocked；不得把已通过流水线打成失败。

## 回归验证

- 真实失败：缺少契约路径时应 blocked，而不是编造通过。
- 通用案例：不同项目只依赖证据路径与 gate 结论做汇总。
- 不触发：门禁未完成时不调用本 Skill。
- 绕过案例：把残余 P2 写成 `[RESULT:failed]` 或输出批准必须被控制器拒绝。
- 修复案例：披露残余风险后 `[RESULT:done]` 即可结束。
