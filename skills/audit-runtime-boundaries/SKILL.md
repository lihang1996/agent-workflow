---
name: audit-runtime-boundaries
description: "在交付包含浏览器界面、HTTP API、公开输入、缓存、部署响应或性能目标时，验证真实运行时的可访问性、响应式、状态码、安全头、缓存和兼容边界；不用于没有运行时表面的纯库或无法启动产物的静态分析。"
---

# 审计运行时边界

## 必需输入

- 读取契约、实现和验证报告。
- 获取可运行的隔离环境、页面/API 清单、目标浏览器、视口和性能预算。
- 无法启动 P0 运行环境时返回 unverified/blocked。
- 实际运行 `workflow_context.fingerprintCommand`，将 JSON 输出中的 `fingerprint` 写入
  `projectFingerprint`；它必须与 QA 验证时的快照一致。

## 执行流程

1. 从 canonical Spec、change plan 和项目配置建立运行时表面清单；若存在与
   `canonical_spec.sha256` 一致的已批准 `delivery-contract.json`，再运行
   `scripts/discover-runtime-surfaces.mjs <delivery-contract.json>` 辅助发现。
2. 建立“表面 × 状态 × 环境”矩阵，包含正常、空、加载、错误、404 和权限失败。
3. 对 HTTP 表面运行 `scripts/probe-http-contract.mjs <http-probes.json>`。
4. 验证导航、表单反馈、重复提交、对话框焦点、横向溢出和布局稳定性。
5. 按契约运行目标浏览器和视口；缺失目标标为 unverified。
6. 检查安全头、共享缓存、资源大小、图片尺寸、性能预算和错误可观察性。
7. 保存截图、响应头、trace 或网络证据。
8. 生成 `runtime-audit.json` 并运行 `scripts/validate-runtime-matrix.mjs`；所有探测和校验
   都记录原始 argv、cwd、起止时间、退出码和 required/status。

## 强制检查

- 不存在资源的真实 HTTP 状态符合契约。
- 认证和个性化响应不使用危险共享缓存。
- 公开页面具备适用安全头。
- 对话框、菜单和表单具有可操作的键盘与焦点行为。
- 所有要求视口无页面级横向滚动。
- 自动扫描不能替代键盘与焦点人工验证。

## 禁止行为

- 不得只保存正常桌面截图。
- 不得把 Chrome 通过外推为 Safari 或 Edge 通过。
- 不得用页面文字“404”替代 HTTP 状态。
- 不得把开发服务器表现直接声明为生产 CDN 表现。
- 不得在本阶段修改代码。

## 输出与阻断

输出 `runtime-audit.json`，包含 `environment`、`buildHash`、`projectFingerprint`、
`verificationHash`、`surfaceMatrix`、
`browserAndViewportResults`、`accessibilityResults`、`httpContractResults`、
`securityAndCacheResults`、`performanceResults`、`evidenceArtifacts`、`findings`、`waivers`、
`unverified` 和 `status`。
`findings[]` 必须与控制器对齐：`severity=P0|P1|P2|P3`，`status=open|resolved|waived`
（运行时审计不得保留 `planned`），可选 `category` 只能是
`correctness|security|reliability|architecture|performance|maintainability|testing|compatibility|scope|other`，
可选 `confidence=low|medium|high`，安全类 P0/P1 还需合法 `exploitability`。
`verificationHash` 必须等于最新 `verification-report.json` 的文件 SHA-256，
`projectFingerprint` 必须等于本轮运行时审计的项目快照，`buildHash` 必须等于该 QA 报告中
登记的 `buildHash`；有独立构建产物时使用 `workflow_context.hashPathCommandPrefix` 复核实际
运行产物，并确认 QA 的 `buildArtifact.path` 仍产生同一 hash，不得启动或探测另一份未验证构建。
把结构化输出保存到控制器提供的 `evidenceRoot`，计算真实 SHA-256，并写入 `[GATE_RESULT].artifacts`。
`checks[].command` 每个数组元素上限 10000 字符。长内联脚本（如 `node -e '...'` 或 `/bin/zsh -lc '...'`）
必须先写入临时文件（如 `evidenceRoot/check-xxx.mjs`），再用 `node check-xxx.mjs` 作为 command，避免超限截断。
运行时新发现的风险不得由 Agent 自行 waived；只有人工确认前 canonical Spec 已登记的同 ID
`[RISK_WAIVER]` 才可沿用，控制器会复核 Spec hash 与批准绑定。
纯库经项目发现证明没有浏览器、HTTP 或部署运行时表面时，输出
`status=not-applicable`，并提供 `applicability:{reason,evidence[]}` 和空 `findings`；
仍需运行适用性发现与报告校验命令，不得伪造表面或写成未验证的 pass。

P0 表面缺证据，或存在越权、数据泄露、软成功、不可完成交互、严重键盘阻塞时阻止最终审查。

## 按需参考

- 键盘、焦点和语义：读取 `references/web-accessibility.md`。
- HTTP 安全头与缓存：读取 `references/http-security-and-cache.md`。
- 视口与浏览器：读取 `references/responsive-and-compatibility.md`。
- 性能和可观测性：读取 `references/runtime-performance.md`。

## 回归验证

- 真实失败：404 页面返回 200、缺少错误/空状态或移动端溢出时必须 fail。
- 通用案例：不同目录的 HTTP API 可用状态码、头和缓存矩阵验证。
- 不触发：无页面、HTTP 或其他运行时表面的纯库不调用本 Skill。
- 绕过案例：只有桌面截图、未启动服务或把 Chrome 外推到其他浏览器不得 pass。
- 修复案例：适用状态、浏览器、视口和安全证据齐全后应 pass。
