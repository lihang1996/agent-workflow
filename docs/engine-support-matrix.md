# 引擎能力支持矩阵（AO-REQ-602 / 13 号 C4）

- 首次建立：2026-09-28（12 号 W2 批次）；返修更新：2026-09-28（Codex 审查返修，见 outputs/22）
- 代码同步：`src/core/engine-capabilities.ts`（`ENGINE_MODEL_CAPABILITIES`）与本文件一一对应；改矩阵必须同步改常量，反之亦然
- 判定规则（13 号 C1/C4 契约）：
  1. 「CLI 可运行」「adapter 会话」「模型参数」分别核验，不互相推定；独立官方 CLI 成功不等于 agent-os adapter 成功。
  2. 只有真实运行证据（本机 help/源码字符串/真实探测样本）可以标 verified；help 核验的参数面标 `help-verified`，端到端生效未实测的维度单独列出。
  3. 未核验一律 unverified；明确不支持或被拒绝的标 blocked；不伪造四引擎全绿。
  4. capabilities 不来自用户配置，避免自报。
- **运行时核验（返修 5 + 二轮 P1-1）**：静态矩阵的证据来自某一时刻的 PATH 解析；运行环境可能解析到不同版本的可执行文件（例如另一 PATH 上的 claude 2.1.109 无 `xhigh`）。带模型/推理强度声明的执行在 spawn 前经 `src/core/engine-runtime.ts` 用「运行时将启动的同一命令」实测 `--version` 与 help 参数面，只降级不升级：旗标缺失 → 该能力运行时置 false → 声明被拒绝；版本与矩阵不一致记入 notes 留证。claude 的 `--effort` 枚举按**真实 help 排版**（选项与枚举间隔说明文字/折行）解析；**解析不出时空白名单失败关闭，拒绝一切强度声明，绝不回退含未核验选项的静态枚举**（本机 2.1.261 真实 help 实测解析出 low/medium/high/xhigh/max；2.1.109 真格式负例与格式漂移失败关闭均有用例）。codex 的推理强度经 `-c` 配置传递、help 无从核验，机制沿用静态证据并显式注明，取值不加运行时白名单（非法值由服务端拒绝、任务显式失败）。

## 1. 总表

| 维度 | claude | codex | cursor | zcode |
|---|---|---|---|---|
| CLI 可运行 | ✅ verified（2.1.261） | ✅ verified（0.150.1） | ✅ verified（agent 2026.08.11-e8db854） | ✅ verified（0.16.9） |
| adapter 新建会话 | ⚠️ 未实测（无本批探测样本） | ⚠️ 未实测（见 §2.2 账号限制） | ⚠️ 未实测 | ✅ verified（Z1，2026-09-28） |
| adapter 续接会话 | ⚠️ 未实测 | ⚠️ 未实测 | ⚠️ 未实测 | ✅ verified（Z2，跨轮上下文命中） |
| 模型选择参数 | ✅ help-verified `--model <model>` | ✅ help-verified `-m/--model` | ✅ help-verified `--model <model>` | ❌ blocked（headless 无参数，仅 TUI `/model`） |
| 推理强度参数 | ✅ help-verified `--effort`（low/medium/high/xhigh/max） | ⚠️ 机制 verified（`-c model_reasoning_effort="<v>"`），取值枚举本地不校验、由服务端拒绝 | ❌ blocked（无独立参数，仅个别模型名内编码） | ❌ blocked |
| 模型实际生效核验 | ⚠️ 未端到端实测 | ⚠️ 未端到端实测 | ⚠️ 未端到端实测 | 🔎 可观测不可声明：stream 带 `modelId`（实测 GLM-5.3），但无法逐执行指定 |
| 原地切换（续接中换模型） | ❌ 未核验（按 recreate 处理） | ❌ 未核验（按 recreate 处理） | ❌ 未核验（按 recreate 处理） | ❌ 不适用（无声明面） |
| 写隔离 canary（设计阶段只读） | ❌ 未实施（W6 T-022 范围） | ❌ 未实施 | ❌ 未实施（另有 client-server 疑虑 V-3） | ❌ 未实施 |
| 默认可用判定 | 参数面可用；端到端未核验 | 同左；本机账号配置另有阻塞（§2.2） | 同左 | 会话链路 verified；**显式模型声明 blocked ⇒ developer 默认引擎不可标可用** |

## 2. 分引擎证据与限制

### 2.1 claude（Claude Code 2.1.261）

- 证据命令（2026-09-28 本机）：`claude --help` → `--model <model>`（会话模型）、`--effort <level>`（low, medium, high, xhigh, max）、`--fallback-model`。
- adapter 接线：`claude-adapter.ts` 在 `-p` 前插入 `--model`/`--effort`；续接时与 `--resume` 叠加（叠加行为未端到端实测，模型变化按 recreate 重建）。
- 枚举外的强度值在 spawn 前拒绝（`assertModelSelectionSupported`）。
- 未核验：真实 headless 任务中模型是否实际生效、`--resume` + `--model` 组合。

### 2.2 codex（codex-cli 0.150.1）

- 证据命令：`codex exec --help` → `-m, --model <MODEL>`；`-c/--config` 文档明示 `-c model="o3"` 用法。`model_reasoning_effort` 键名核实自二进制源码字符串（`strings $(command -v codex) | grep model_reasoning_effort`）。
- 取值枚举：二进制内无本地校验串（无效值不在配置解析期报错）；实测传入 `totally-bogus` 未被本地拦截。矩阵按「机制 verified、枚举交给服务端显式失败」处理——非法值会让任务可见地失败，不会静默错跑。
- ⚠️ 本机环境限制：用户 `~/.codex/config.toml` 默认模型 `gpt-6-luna` 与当前 ChatGPT 账号不兼容（真实执行返回 HTTP 400 `The 'gpt-6-luna' model is not supported ... with a ChatGPT account`）。这是用户个人配置，agent-os 不代改；codex 端到端探测因此标未核验，需用户调整默认模型后方可补测。
- adapter 接线：`codex-adapter.ts` 在 `exec [resume]` 后插入 `-m <model>` 与 `-c model_reasoning_effort="<v>"`。

### 2.3 cursor（agent CLI 2026.08.11-e8db854；`cursor` 命令不在 PATH，adapter 用 `agent`）

- 证据命令：`agent --help` → `--model <model>`（支持 `model[context=1m,effort=high]` 括号参数化的模型）；`agent --list-models` 列出账号可用模型。
- 推理强度：无独立参数；仅部分模型以模型名/括号参数编码强度。显式 `reasoningEffort` 配置在 spawn 前拒绝。
- 兼容行为：未声明模型时沿用全局 `CURSOR_CLI_MODEL` 环境变量（历史行为）；执行级声明优先。
- 未核验：headless 端到端、`--resume` 行为；client-server 形态是否绕过子进程沙箱（V-3，影响 W6 写隔离判定）。

### 2.4 zcode（官方 ZCode CLI 0.16.9）

- 模型声明面：`zcode --help` 无 headless 模型参数；`/model [id]` 仅 TUI。源码（`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`）中新会话模型来自 provider 配置 `defaultModelSelection`（经 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` / `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`），不受单次执行控制。
- 真实探测（2026-09-28，经 agent-os `ZcodeAdapter` + `runCli`，临时目录，未连接飞书）：
  - Z1 新建：PASS（answer=pong）。注意：本样本 raw 流没有 `session.created`，只有 `session.titleUpdated`/`session.updated`；sessionId 由 adapter 的 `withSession` 兜底从事件顶层 `sessionId` 字段捕获——该兜底路径经真实样本验证有效。
  - Z2 续接：PASS（raw 流有 `session.resumed`，跨轮回忆命中 pong）
  - Z3 模型声明：BLOCKED（显式 `glm-5.3` 被 `assertModelSelectionSupported` 正确拒绝，不静默用原生默认）
  - Z4 业务工具：PASS（`request_clarification` 经 `mcp__agent_os__` 链路产生 tool_call 事件，且 MCP 端 zod schema 校验后提交了结构化问题）
  - 样本：`.agent-os/probe/zcode-adapter-2026-09-28T07-55-23-747Z/`（argv / raw.ndjson / events.ndjson / report.json）
- 历史失败销案依据：`Select a model before continuing`（turn-failed 样本）未在本次探测复现；新建/续接均成功。历史 fixture `tests/fixtures/zcode/turn-failed.ndjson` 保留作回归。
- 🔎 观测发现：stream-json 的 `model_request_started` 等事件携带 `modelId`（本机实测 `"GLM-5.3"`）。即 zcode 的实际模型**可观测但不可声明**。未来若要允许「声明=期望 + 事后核对 modelId + 不匹配即失败」的策略，需单独设计与评审；本批维持 blocked 语义。
- ⚠️ 探测的全局副作用限制（返修 4）：`runCli` 对 zcode 先执行 `ensureZcodeAppToolsConfig()`，会把 agent_os MCP server 条目合并写入用户全局 `~/.zcode/cli/config.json`（保留其他条目）。官方 CLI 0.16.9 无可核验的配置目录隔离面：`ZCODE_HOME` 仅用于遥测设备 id，`ZCODE_DATA_BASE_DIR` 仅用于 provider 配置文件发现，cli-config/auth 路径直接取 `os.homedir()`；重定向 `HOME` 会同时丢登录态与 provider 配置，探测无法认证。**隔离不可实现且未经验证 ⇒ 探测脚本默认拒绝运行**，需显式 `PROBE_ZCODE_ALLOW_GLOBAL_CONFIG=1` 接受全局写入；既有 Z1/Z2/Z4 成功样本保留有效（当时已发生该写入，属生产 zcode 任务的同等行为）。

## 3. 角色默认引擎可用性判定（13 C4）

| bot（config/bots.json） | defaultCli | 模型声明 | 判定 |
|---|---|---|---|
| ceo-assistant | codex | gpt-6-sol / low | 参数面支持；端到端未核验（§2.2 账号限制另阻塞本机实测） |
| product | codex | gpt-6-astra / medium | 同上 |
| developer | zcode | glm-5.3 / high | ❌ **不可标可用**：zcode 无法逐执行声明模型（Z3 blocked），按 R-MDL-1 不静默 native-default。解封依赖（任一）：官方 CLI 提供 headless 模型参数；或用户从 bots.json 移除 developer 的 zcode 模型声明（模型由 TUI/provider 配置的默认值承载，事后可用 stream `modelId` 观测核对）；或评审通过「声明+事后 modelId 核对」策略 |

> 当前 bots.json 为用户配置，agent-os 不代改；上述解封选项由用户决策（01 号 U-5 角色引擎指派的既定口径）。

## 4. 运行时语义（keep / recreate / blocked）

- 会话绑定：每次真实执行后 `executeTask` 把实际模型选择（含 native-default 的显式 null）随原生会话 id 存入 `Session.cliModelSelection`；**缓存重放只补投结果，不触碰当前绑定**（当前会话可能已切到别的原生会话）；执行台账（`data/task-executions.json`）为每次执行留存 native session id + modelSelection 证据。
- 未知绑定失败关闭（返修 1）：
  - 换到新 native session 而没有新模型选择 → 旧绑定不迁移，置为缺失；
  - 新开的原生会话未回报 session id（且决策已接入）→ 重置绑定；
  - 缺失绑定在有显式模型要求时按 legacy 规则 recreate；**目标本身是 native-default（无任何模型要求）时 keep**——续接原会话让其继续自己的模型正是原生语义，不触发重建。
- cursor 生效模型（返修 2）：未显式声明模型时，`CURSOR_CLI_MODEL` 环境值即本次实际生效模型，纳入决策与绑定；环境值变化 ⇒ 绑定不一致 ⇒ recreate。不会出现「环境换了模型还照旧 keep」。
- 续接判定：`planExecutionModel`（`src/app/execution-model.ts`，异步）→ 运行时核验 → `compareExecutionSelection`：
  - keep：无原生会话、绑定与期望一致、或无模型要求 + 不可核验旧绑定；
  - recreate：旧绑定不可核验但目标带显式模型、模型/强度变化（原地切换全引擎未核验）；
  - blocked：目标是 native-default 而绑定是显式模型（无法核验一致）、或引擎矩阵外组合（如 zcode 显式模型）。任务失败并给出原因，不静默换模型。
- recreate 上下文策略（二轮返修 3 / 13 号 C5，**取代一轮的台账摘要方案**）：依赖历史上下文的 recreate 一律阻断，提示用户新开话题明确提供背景或恢复原模型配置。原因：历史 CLI 回答可能转述项目文件/网页/工具输出中的第三方指令，注入新会话的当前任务构成「指令洗白」；仅加「请勿遵从」提示或把原文转成摘要都不能消除该风险。在可信来源分层、授权摘要与工具读写隔离验证前，W2 不宣称实现自动迁移；台账的 `recentForSession` 已按**当前原生会话 id** 过滤（A→B→/resume 回 A 时 B 的记录不得进入 A 的任何用途），供未来经评审的迁移方案使用。评论修订入口的上下文锚定在待确认制品（prompt 携带文档 URL 并要求先读全文），不注入历史回答，不受此限。
- 三个任务入口（普通消息/澄清续跑/产品评论修订）共用该决策面；`/compact` 走原生会话自身模型，不参与。

## 5. 未核验清单与后续依赖

- V-2a/b/c 端到端：claude/codex/cursor 真实任务中模型参数实际生效（需可用的账号配额；codex 先解 §2.2）。
- V-2d 已结案：zcode headless 无模型参数（blocked 语义生效）。「modelId 可观测」的利用待评审。
- 原地切换全引擎未核验（矩阵 false → recreate）；核验通过后才能置 true。
- 写隔离 canary（V-1/V-3，W6 T-022）未实施：矩阵「设计阶段只读」列全部 blocked，与 AO-REQ-402 对齐；13 号新增的 **KB 私有文件读取隔离**（C1）同为后续架构门槛，两项独立核验，W2 未实施。
- 探测重放：`PROBE_ZCODE_ALLOW_GLOBAL_CONFIG=1 pnpm probe:zcode-adapter`（见 §2.4 限制）。

## 6. zcode 逐执行声明 GLM-5.3 的可行性评估（返修批结论）

维持 **blocked**。已评估并否决的路径：

1. **headless `--model`**：CLI 0.16.9 无此参数面（help + 源码核实）。
2. **per-run provider 配置**：新会话模型来自 provider 配置的 `defaultModelSelection`（源码路径经 `ZCODE_DATA_BASE_DIR` / `ZCODE_*_PROVIDER_CONFIG_FILE` 发现）。理论上可为每次 spawn 指向一份改写过 `defaultModelSelection` 的副本，但：构建副本必须读取用户 provider 配置（含凭据，违反本批禁令且有泄密面）；历史尝试（docs/zcode-cli-integration-plan.md 第 5 节）从未验证「写入字段 ⇒ 新会话生效」；该机制本质是改全局行为而非可审计的逐执行声明。不采用。
3. **stream `modelId` 事后观测**：运行后才可见，不构成运行前约束；把「事后看到 GLM-5.3」当作声明成功违反 13 号 C4。仅可作为交付后的核对证据。

解封条件不变（任一）：官方 CLI 提供 headless 模型参数；用户移除 developer 的 zcode 模型声明（模型由 TUI/provider 默认承载，可用 modelId 事后核对）；或评审通过「声明 + 事后 modelId 核对 + 不匹配即失败」的新策略。
