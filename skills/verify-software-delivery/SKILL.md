---
name: verify-software-delivery
description: "在代码或配置准备交付时，发现并运行适用的静态检查、单元、集成、迁移、构建和 E2E 门禁，验证测试资源安全并识别假阳性；不用于需求设计、产品代码修复或只运行用户随手指定的一条测试。"
---

# 验证软件交付

本 Skill 的 `scripts/` 属于编排框架，不是目标仓库代码。请运行
`workflow_context.skillsRoot/verify-software-delivery/scripts/...`；没有该字段时使用本文件所在目录。

## 必需输入

- 读取交付契约、变更方案、实现 manifest 和相同的项目 fingerprint。
- 获取质量命令、测试环境和允许使用的隔离资源。
- 只记录环境变量名称，不记录真实秘密值。
- 实际运行 `workflow_context.fingerprintCommand`，将 JSON 输出中的 `fingerprint` 写入
  `projectFingerprint`；不得用 Git hash 或开发总结替代。

## 执行流程

1. 运行 `scripts/discover-quality-gates.mjs <project-root>`。
2. 合并契约、项目脚本和 CI 配置，建立适用门禁列表。
3. 在 migration、truncate、drop 或 seed 前运行
   `scripts/preflight-test-resources.mjs <resource-policy.json>`。
   `resource-policy.json.sentinelEnv` 必须原样使用
   `workflow_context.testResourceSafety.sentinelEnv`，不得临时发明其它 sentinel
   变量名；上下文中 `sentinelAuthorized=false` 时先阻塞，不执行破坏性命令。
4. 使用 `scripts/run-quality-gates.mjs <gate-config.json>` 执行命令。
5. 捕获每条命令的原始 argv、required/status、cwd、起止时间、退出码、耗时和脱敏日志；
   禁止把自然语言命令摘要登记为已执行命令。
6. 检查测试是否覆盖需求的正常、异常、边界、并发和攻击场景。
7. 检查 mock、选择器、共享数据、base URL 和服务启动是否可能导致假阳性。
8. 生成 `verification-report.json` 并运行
   `scripts/validate-verification-report.mjs`。

## 强制检查

- 按适用性运行 lint、类型/编译、unit、integration、migration、production build 和 E2E。
- QA 是完整 production build、dev/production server、集成与浏览器普通功能 E2E 的验收责任方；
  开发 manifest 中因环境缺证而记为 `required=false` 的项只是交接信息，不是 QA 豁免。
- 对 implementation check 中的 `delegatedTo="verification"`，QA 必须在 `executedChecks`
  中保留完全相同的 `id`、`command` 原始 argv 和 `cwd`，并真实执行到
  `required=true/status=pass/exitCode=0`。不得用前缀/子串相似 ID、自然语言摘要
  或任意其他通过检查代替；未被精确覆盖的委派仍是残余风险。
- 普通功能 E2E 由 QA 在本阶段完成；下游 runtime audit 复用本报告与已验证构建，
  只补充 HTTP、缓存/安全、权限、可访问性、响应式、性能和可观测性等边界探测，不应重复普通 E2E。
- 破坏性资源必须验证测试命名、与运行库不相等以及统一 sentinel 或一次性资源 ID；
  sentinel 只能作为最后一道授权，不能替代隔离性检查。
- 必需命令缺环境时使用 required=true + status=unverified/blocked，整个 verification gate 禁止 pass。
- P0/P1 要求必须具有行为级证据。

## 禁止行为

- 不得在本阶段修改产品代码或测试。
- 不得把浏览器未安装、数据库不可达记录为通过。
- 不得只运行默认 test 而忽略已配置的 integration/E2E。
- 不得以输出文字替代退出码。
- 不得泄露连接串、Cookie 或 Token。

## 输出与阻断

输出 `verification-report.json`，包含 `implementationHash`、`changeReviewHash`、`projectFingerprint`、`buildHash`、
`buildArtifact`、`discoveredGates`、`executedChecks`、`resourcePreflight`、`requirementResults`、`findings`、`waivers`、
`falsePositiveAssessment`、`failures`、`warnings`、`unverified` 和 `status`。
`findings[]` 必须与控制器对齐：`severity=P0|P1|P2|P3`，`status=open|resolved|waived`
（QA 不得保留 `planned`），可选 `category` 只能是
`correctness|security|reliability|architecture|performance|maintainability|testing|compatibility|scope|other`，
可选 `confidence=low|medium|high`，安全类 P0/P1 还需合法 `exploitability`。
其中 `implementationHash` 必须等于最新 `implementation-manifest.json` 的文件 SHA-256，
`changeReviewHash` 必须等于最新 `change-review.json` 的文件 SHA-256，
`projectFingerprint` 必须等于本轮 QA 实际项目快照；`buildHash` 必须标识本轮实际验证的
生产构建产物：用 `workflow_context.hashPathCommandPrefix` 追加产物路径并实际运行；无独立构建
产物的源码包可使用已验证项目快照。存在独立产物时，`buildArtifact` 必须记录该命令返回的
项目内绝对 `path` 与 `sha256`（等于 `buildHash`）；控制器会在下游门禁和最终完成时重新哈希，
不能只登记一个不可复核的字符串。无独立产物时 `buildHash=projectFingerprint` 且可省略该字段。
`discoveredGates` 中每个 id 必须在 `executedChecks` 中有同 id 记录；必需项必须
`required=true/status=pass/exitCode=0`。可选或不适用项也要登记，并提供 reason 或
applicabilityEvidence，禁止发现后静默省略。
`requirementResults.status=waived` 时必须提供 `findingId`，并指向同一报告/Gate 中具有完整
人工批准证据的 waived finding；该 finding 还必须引用人工确认前 canonical Spec 中同 ID
的 `[RISK_WAIVER]`，不得由 QA 新增 owner、期限或批准证据，也不得把需求豁免藏在 findings 之外。
`executedChecks` 是 QA 检查的权威集合；`[GATE_RESULT].checks` 不得重复其中任何 ID，没有额外
检查时必须写空数组，由控制器从报告水合。确需登记报告校验等额外命令时，必须使用新的唯一 ID。
把结构化输出保存到控制器提供的 `evidenceRoot`，计算真实 SHA-256，并写入 `[GATE_RESULT].artifacts`。
`executedChecks[].command` 每个数组元素上限 10000 字符。长内联脚本（如 `node -e '...'` 或 `/bin/zsh -lc '...'`）
必须先写入临时文件（如 `evidenceRoot/check-xxx.mjs`），再用 `node check-xxx.mjs` 作为 command，避免超限截断。

必需命令非零、资源校验失败、P0/P1 缺证据、必需环境不可用或测试被弱化时阻止后续阶段。
仅因浏览器、端口、数据库、网络或授权环境不可用时，保留必需项的
`required=true/status=blocked|unverified`，报告与 Gate 不得 pass，并用 `[RESULT:blocked]`
停留在 QA 等待环境；不得倒退给开发修“环境”。命令已运行且确认是产品代码或测试失败时，
记为 `status=fail`，创建可复现 finding，并用 `[RESULT:failed]` 交回开发。

## 按需参考

- 分层与覆盖策略：读取 `references/test-strategy.md`。
- 数据库及破坏性测试：读取 `references/test-resource-safety.md`。
- 不同技术栈的命令发现：读取 `references/framework-command-routing.md`。

## 回归验证

- 真实失败：对非隔离数据库运行破坏性测试，资源预检必须先于命令失败。
- 通用案例：不同目录的 Node、Python 或 Go 项目能发现自身质量命令。
- 不触发：纯需求讨论或无代码交付的问答不调用本 Skill。
- 绕过案例：空命令、伪造退出码、缺失 E2E 环境不得报告 pass。
- 修复案例：资源隔离且所有适用命令 exitCode=0 时应 pass 并保存脱敏证据。
