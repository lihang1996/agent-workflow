# 三角色模型配置与话题切换：架构和逐票执行计划

状态：实施计划，尚未实施业务功能。

日期：2026-09-23。

需求来源：[三角色可配置执行与飞书话题模型切换](./role-model-and-vision-workflow-spec.md)，编写时为 642 行、55 项验收标准。需求文档规定做什么，本文规定实施顺序、模块契约和检查方法；如二者冲突，停止相关任务并报告，不自行改需求。

2026-09-23 修订：补齐原生会话重建后的交接材料持久化与注入、独立 Reviewer 从 Adapter/Runner 到执行账本的证据采集，以及实际产品 systemPrompt/Skill 的职责边界；随后明确用户决定与实现结果的保存时机，范围缩小即使执行失败也必须在重建前保留。这些修订已分别落实到 P03/P05/P07、P04/P05/P13 和 P13，不新增任务票。

## 1. 给执行智能体的使用方法

本计划用于减少执行中的自由发挥，不承诺任意模型都能零错误完成。外部 CLI 的模型控制、图片输入和 Reviewer 能力必须真实验证；未知能力不能用推测参数补齐。

每次只领取一张 P 任务票：

1. 阅读第 2–7 节公共契约、当前任务票、关联验收编号。
2. 检查工作区现有修改，保留用户文件；不要修改本票以外的业务范围。
3. 先补对应测试，再实现最小闭环；未完成或失败的测试不删除、不改成跳过。
4. 跑本票定向测试及 `pnpm typecheck`；合并一个阶段前跑完整 `pnpm test`。
5. 按第 12 节格式报告文件、测试、剩余问题，再进入下一票。
6. 遇到“停止条件”就停在该分支；可以推进无依赖的票，但不能把受阻项标为完成。

默认顺序执行，不安排多个写代码的智能体同时编辑同一工作树。独立 Reviewer 只审查、不替开发修改。

本次授权是编写计划，不是执行下列开发任务；实际开始开发、真实模型探测、安装依赖、修改个人 CLI 配置和外部调用均遵守当时的用户授权。

## 2. 基线与不可改变的边界

### 2.1 本次已验证的基线

- 已运行 `pnpm typecheck`：通过。
- 已运行 `pnpm test`：88 项通过、0 项失败。
- 没有运行真实模型任务，没有验证候选模型 ID，没有修改业务代码。
- 这 88 项是现有自动测试，不代表新需求的 55 项验收已经通过。

开始实施时重新执行基线，不把本次结果当作永久有效。

### 2.2 十条不变量

| 编号 | 不变量 |
| --- | --- |
| I01 | CEO、产品、开发同样支持角色默认与话题覆盖，不绑定示例 CLI/模型 |
| I02 | 选择顺序为话题覆盖、角色默认、CLI 原生默认；显式无效值绝不回退 |
| I03 | 模型与强度整组选取；设置新模型不继承旧模型强度 |
| I04 | 角色权限不因 CLI/模型变化而扩大；产品评论仍为空业务工具权限 |
| I05 | session version 防陈旧操作，contextId 表示任务材料归属，二者不是同一字段 |
| I06 | 换模型保留同任务材料；`/new` 清任务材料但保留话题模型偏好 |
| I07 | 修改模型不打断有效澄清、产品确认、评论排队或执行收尾 |
| I08 | 图片保留不等于本轮发送；纯文本工作不被未使用的图片阻塞 |
| I09 | CLI 执行完成、通知送达、页面通过、独立审查通过是不同事实 |
| I10 | 不新增独立视觉 API/MCP/socket，不自动换模型，不新增长期角色 |

只支持当前单个 Agent OS 进程管理这些 JSON 状态文件。多实例同时写同一 data 目录不在本计划内，不用“文件 rename 是原子的”冒充跨进程并发安全。

## 3. 当前代码入口与目标模块

### 3.1 阅读导航

| 当前位置 | 需要理解的事实 |
| --- | --- |
| `src/core/bot-registry.ts:30` | Schema、BotConfig 类型与解析映射要一起增加配置字段 |
| `src/core/command-parser.ts:15` | 未识别命令返回 undefined，可能进入普通任务 |
| `src/app/message-handler.ts:74` | 命令解析在澄清判定之前，适合截断非法 `/model` |
| `src/app/message-handler.ts:200` | beginTask 后才下载附件并启动执行 |
| `src/app/message-handler.ts:336` | CLI 结束后才创建澄清/产品流程、处理派发 |
| `src/core/session-manager.ts:92` | 当前写操作先改内存、再 await 保存，不能直接当事务使用 |
| `src/core/session-store.ts:106` | 已有临时文件 rename，但文件写队列不等于状态隔离 |
| `src/app/task-lifecycle.ts:11` | activeRuns 同步预占；收尾时 idle 与 activeRuns 可能短暂并存 |
| `src/app/task-lifecycle.ts:54` | 结果里的原生 ID 当前会直接回写，新增上下文后必须防陈旧结果 |
| `src/core/clarification.ts:130` | 澄清状态已有持久化，不另建一份流程仓库 |
| `src/core/product-spec-store.ts:38` | 产品状态已有 JSON 实现，评论/审批占位另在内存 |
| `src/core/product-spec.ts:101` | 评论排队即预占，不能只看正在运行的 CLI |
| `config/bots.json:22` | 产品实际加载 grill-me、to-spec、to-tickets 等 Skill，职责边界要看实际工作区而非仓库模板 |
| `../agent-os-team-example/.agents/skills/to-spec/SKILL.md` | 当前产品 Skill 可能要求测试 seam 和实现决策，必须与 P13 的产品职责边界一起核对 |
| `src/app/result-delivery.ts:11` | 补发卡片会按最新流程重绘，新确认卡也要沿用此原则 |
| `src/app/delivery-outbox.ts:8` | 现有操作只有更新卡片、文本、提及、评论，没有首次回复卡片操作 |
| `src/cli/registry.ts:25` | 部分无工具 Adapter 仍为共享实例，不能往实例塞角色配置 |
| `src/cli/cursor-adapter.ts:135` | 目前读取全局 CURSOR_CLI_MODEL，不能保留成隐藏第四级优先级 |
| `src/cli/zcode-adapter.ts:294` | 普通工具结果当前主要保留成败状态，Reviewer 证据采集需要按 G00 实际事件扩展 |
| `src/cli/runner.ts:163` | 最终 toolCalls 只保留业务工具输入，普通工具输出和审查证据不能从这里凭空取得 |
| `src/cli/native-compact.ts:250` | compact 绕过普通 runner，必须单独核对选择与绑定 |
| `src/im/lark.ts:360` | 附件落盘文件名目前包含外部 fileKey，需安全命名 |
| `src/core/task-execution.ts:5` | 新结果字段必须加入落盘 Schema，否则重启可能被剥除 |

行号只用于第一次定位，实施后以函数名和测试为准。

### 3.2 目标分层

```text
飞书消息/卡片
  → 确定性命令解析、目标机器人与身份检查
  → 模型操作服务 / 执行准备服务
  → SessionManager 条件提交、流程快照、任务上下文
  → 每次执行的只读模型选择和附件输入
  → CLI Adapter → Runner → 当前主模型
  → 执行账本 → 上下文材料/验证结果 → 通知 Outbox
```

建议新增的文件仅限下列职责；若当前已有同职责代码可复用，不再平行新建第二套实现。

| 建议新增路径 | 唯一职责 |
| --- | --- |
| `src/core/model-selection.ts` | 模型值类型、归一化、优先级、相等性和指纹纯函数 |
| `src/core/session-change.ts` | 会话修改操作的数据结构与纯判断 |
| `src/core/task-context.ts` | 上下文、交接材料、附件引用、图像接续请求的数据结构 |
| `src/app/model-command-service.ts` | 准备/确认/取消话题模型操作，编排现有状态与通知 |
| `src/app/execution-context.ts` | 三个执行入口统一取得快照、材料和有效输入 |
| `src/app/task-attachments.ts` | 下载登记、归属校验、限制检查和选定图片物化 |
| `src/app/run-artifacts.ts` | 读取本轮限定位置的结构化产物，不信任任意模型输出路径 |

不要新增通用插件框架、模型调度服务或新的会话数据库。

## 4. 固定的数据契约

以下是新增设计，不是当前已有接口；实现时为每个持久化结构写对应 Zod Schema。

### 4.1 模型选择与来源

建议在 `model-selection.ts` 定义：

```ts
import type { CliId } from '../cli/types.js';

export interface ModelSelection {
  model: string | null;
  reasoningEffort: string | null;
}

export interface ResolvedModel {
  cliId: CliId;
  selection: ModelSelection;
  source: 'topic' | 'role' | 'native-default';
  roleDefaultFingerprint: string;
}

export type FrozenExecutionModel =
  | { kind: 'known'; value: ResolvedModel }
  | { kind: 'legacy-native' };
```

规则：

- `topicOverride: ModelSelection | null` 的外层 null 表示没有话题覆盖。
- 有覆盖时，内部 `reasoningEffort: null` 表示明确采用原生强度，不能再继承角色 high。
- 内部 `model: null` 表示采用 CLI 原生模型选择，不代表“未知模型已验证”。
- 外部配置允许省略字段；进入领域层后归一化为上述完整组合。
- `sameSelection` 只比较 CLI、模型和强度；`samePreference` 还要比较覆盖是否存在和来源，两者不能混用。
- 指纹只对规范化的非凭据配置生成，不能散列整份 `.env` 后当作配置内容使用。

三个基本函数：

```text
resolveModel(botConfig, cliId, topicOverride) → ResolvedModel
selectionForCommand(command, currentResolved) → ModelSelection | null
compareExecutionSelection(nativeBinding, desired, capabilities) → keep | recreate | blocked
```

`set` 创建新整组，未给强度就为 null；`effort` 复制当前模型选择并替换强度；`reset` 返回外层 null。不要让 `set` 复制旧强度。

### 4.2 Session 新增字段

保留当前 session ID、bot/chat/topic、cliId、owner、status 等字段，建议新增：

| 字段 | 内容与边界 |
| --- | --- |
| `topicOverride` | 完整组合或 null，不改角色配置文件 |
| `taskContext` | contextId、稳定 owner、工作区、交接材料、附件引用、非阻塞图像接续请求 |
| `nativeModelBinding` | 当前 cliSessionId 对应的已知选择或 legacy 标记、是否曾含图片输入 |
| `lastExecutionModel` | 上一轮实际请求快照与可取得的实际回显，不冒充下一轮 desired |
| `changes` | 当前待确认修改及少量已结束操作记录，模型修改结果与选择同次提交 |

`taskContext.owner` 不随陌生人的消息覆盖；创建新上下文必须来自经过权限检查的操作。附件不按可变的 session.owner 临时“重新认领”。

旧数据迁移：

- 有效旧行必须保留；新增字段不能直接设成必填导致 load 丢行并重写。
- 给旧上下文生成一次稳定 contextId 并保存，附件清单为空，不扫描下载目录补历史图片。
- 旧原生模型未知则标 legacy，不把当前默认填成历史事实。
- 已有有效流程无模型快照时按 legacy-native 续接，不在中途强行套新默认。
- 无 owner 的旧会话不能原地 `/model` 修改，提示新话题建立归属。
- 新增字段损坏时保留原文件并报错，不当作“没有覆盖”静默丢弃。

### 4.3 会话修改记录

至少记录下列信息，放在 Session 同一 JSON 提交内，不另外建模型操作数据库：

```text
id、sessionId、botId、owner、contextId、expectedVersion
kind：set-override / reset-override / apply-role-default / reset-context / change-workspace / close / select-history
targetOverride：组合或 null
targetResolvedModel、roleDefaultFingerprint
nativeAction：keep / clear / select-history
影响清单：有效流程token、附件ID、目标工作区或原生ID
status：pending / applied / cancelled / expired
createdAt、expiresAt、appliedVersion、通知来源消息ID
```

保留最近 20 条已结束操作用于重复回调；被清理的旧 token 一律拒绝，不能按参数重新执行。pending 不参与这项历史裁剪。

操作类型必须参与确认绑定：目标模型相同，set 与 reset 仍有不同结果；应用角色默认不能写出一个新的固定话题覆盖。

### 4.4 流程快照与执行戳

澄清和产品流程都增加 `contextId`、`FrozenExecutionModel`、本流程必要材料/图片引用快照；同步修改内存类型、持久化 Schema、create 参数和三个续接入口。

每次执行记录：`executionId + sessionId + contextId + version + modelSnapshot`。业务流程创建、原生 ID 回写和上下文材料更新都必须核对这组执行戳。

已保存的 completed 执行不能因投递失败重跑；旧上下文的 completed 结果可以用于说明历史，但不能重新绑定到新上下文或再次创建当前流程。

### 4.5 任务交接材料契约

`taskContext.materials` 是重建原生会话后的最小事实来源，不是完整聊天记录缓存，也不允许另起付费模型自动生成摘要。

建议最小结构：

```text
materials:
  objective: 当前一句话目标，必要时包含用户明确范围限制
  confirmedDecisions: 已回答澄清或用户明确决定的事项，按时间追加
  authoritativeDocuments: 产品文档 URL、本地 Spec/Tickets 路径、需求文档引用及确认状态
  latestDelivery: 最近一次已完成交付的标题、账本 executionId、结果摘要和代码/产物指纹
  handoffNotes: 当前仍待继续的非阻塞事项，例如已保存的图像接续请求引用
```

保存时机：

材料分两类，不能统一等执行成功后再写。

| 材料类型 | 保存时机 | 失败/取消时 |
| --- | --- | --- |
| 用户明确的目标、范围限制、已回答的澄清、文档确认状态 | 完成 owner、contextId、version 和执行戳校验后，在启动 CLI 之前原子保存 | 保留；这些是用户已经作出的决定，不因代码没跑完而失效 |
| 实现结果、测试结果、代码指纹、交付摘要、Reviewer/截图证据 | 执行收尾后按真实状态保存 | 不得写成成功交付；最多记录失败/取消状态和剩余阻塞 |

- 真实业务澄清完成并进入续接执行前，把问题和答案写入 `confirmedDecisions`；不能继续依赖旧原生历史。
- 产品流程提交或确认时，记录文档引用、确认状态和必要 Tickets 范围。
- 普通执行成功收尾后更新 `latestDelivery`；失败、取消或未验证阶段不得写成成功交付。
- 用户在后续消息中明确缩小/扩大范围时，先作为用户决定在执行前保存；后续实现结果仍按真实执行状态另行记录，不把模型建议、未完成计划或失败尝试冒充用户决定。
- 图像接续请求属于 `handoffNotes`，不是 `confirmedDecisions`；它不阻塞模型切换，也不能冒充业务授权。

注入规则：

- 保留原生会话时不重复注入完整历史；仍注入当前指令和必要文档引用。
- 重建原生会话且用户继续同任务时，注入 objective、confirmedDecisions、文档引用、latestDelivery 与仍有效的 handoffNotes，并明确这些材料来自上一模型，不是新模型已经看到的画面。
- 只注入结构化事实和短摘要；不搬运整段聊天记录、附件二进制或工具日志。
- 材料超过当前 CLI 安全输入限制时，按优先级保留目标、已确认范围、权威文档引用和最近交付摘要；被省略项要在输入中列明，并提示用户可以要求展开某一项，不悄悄截断。
- 材料为空或损坏时停止自动续接，报告缺口并请用户提供当前目标/文档；不能让新模型猜测范围。

`/new`、真正 `/cd` 或选择另一段原生历史会新建 contextId，旧 materials 不跨入新上下文；模型切换、强度修改、原生重建和进程重启都必须保留同一 contextId 的材料。

## 5. 事务与并发算法

### 5.1 两种保护分开

1. 应用层会话占位：防止同一会话开始任务、模型修改、重置和评论预占互相穿插。
2. SessionManager 全局提交队列：防止全表 JSON 保存把其他会话的未提交状态带入磁盘。

只给模型命令加锁不够，现有 resolve、transition、setCliSessionId、clearCliSessionId、setWorkspaceDir 也必须走同一提交边界。

### 5.2 SessionManager 的提交顺序

新增条件更新方法，名称建议 `commitSessionChange`；已有写方法委托它或同一内部提交函数。

```text
进入 manager 的提交队列
→ 读取最新“已提交”根状态
→ 校验 session/version/context 等条件
→ 克隆需要修改的 Session，执行同步变换
→ 根据最新已提交根状态构造本次待保存快照
→ await store.save(snapshot)
→ 保存成功后同步发布新根状态
→ 返回防外部修改的结果
```

严格要求：

- 不在排队前复制全库，不在保存前发布草稿。
- 保存失败只丢弃本次草稿，不能恢复一份旧全库从而抹掉其他已提交变化。
- get/resolve 返回值不能成为外部直接修改内部状态的通道。
- 利用现有临时文件 rename；不声称它已经解决多进程锁或所有断电持久性问题。
- 保存失败后的队列仍可处理下一次操作，不让 rejected Promise 永久阻塞。

### 5.3 应用层占位

在 runtime 新增最小的会话修改占位，或复用等价的现有锁结构；不引入外部锁服务。

- `beginTask` 在首个 await 前同步检查修改占位并设置 activeRuns；不要依赖 transition 同步改变内存状态。
- 修改操作在首个 await 前占位，再检查 owner、activeRuns、有效业务流程及评论/审批预占。
- 占位持有期间完成条件提交，finally 只释放自己持有的 token。
- 等用户点确认期间不持有锁；有新任务、新修改或重置时，旧 pending 操作持久化失效。
- 确认回调排除自身 pending 操作，但不能排除其他业务待办。
- 评论 scheduler 在预占前检查会话修改占位；冲突不能标记事件“已处理”，要给出重试提示。
- 结果收尾即使已将 status 改为 idle，只要 activeRuns 尚未释放，仍拒绝模型修改。

### 5.4 不伪造跨文件事务

Session 选择、contextId、操作结果必须一次提交。澄清/产品已有独立状态文件，不在本次把所有 JSON 合并成新数据库。

重置时先以 Session version/contextId 的提交作为权威失效点：旧流程即使因后续文件写失败仍标 pending，也因版本不匹配而不可再操作；随后清理旧流程/补发失效卡。清理失败重试清理，不重做 Session 修改。

所有流程入口、评论预占和动态卡片绘制都必须使用同一有效性判断。不能只有卡片按钮检查版本，而后台评论仍修改旧文档。

## 6. 模型命令与原生上下文算法

### 6.1 命令解析

扩展 `SlashCommand`，建议为模型家族增加明确分支：

```text
model/show
model/set(modelId, effort|null)
model/effort(value|null)
model/reset
model/invalid(reason)
```

先识别 `/model` 家族，再判断参数；只要属于该家族，非法语法也返回 invalid，不返回 undefined。

群聊修改根据原始 mentions 和 botRuntimes 的真实 openId 判断目标，不能根据显示名判断身份；必须只 @ 当前目标机器人。私聊按当前 bot 确定目标。

`/model` 查询不启动 CLI、不调用模型；尚无会话时可显示角色默认。设置可以创建有 owner 的空闲偏好会话，不应先创建无 owner 会话再等待第二步认领。

### 6.2 准备与提交

```text
解析与目标校验
→ 取得最新已提交 Session 和权限
→ 计算 targetOverride 与 targetResolvedModel
→ 校验 CLI 已知能力、状态和待办
→ 同偏好且无执行组合漂移：返回无操作
→ 无原生绑定或执行组合未变化：条件提交
→ 能保留原生上下文：条件提交新选择
→ 只能新建原生上下文：保存 pending 操作并发确认卡
→ 能力缺失：拒绝，不保存假成功
```

确认时重新读 Session、角色默认、有效流程及占位，复核 token、owner、contextId、version、默认指纹和 10 分钟有效期，再原子提交。

设置完成的文案是“已设置，下一次执行验证”。如果 CLI 后来拒绝模型，报告运行失败，不暗中用旧模型执行。无实际回显不等于配置失败，但不能展示为实际模型已核验。

### 6.3 生命周期动作

| 动作 | 覆盖 | contextId/附件 | 原生绑定/版本 |
| --- | --- | --- | --- |
| set/effort | 替换组合 | 保留 | 按能力 keep/clear；有效修改增 version |
| reset | 删除覆盖 | 保留 | 同样校验目标组合变化，不当作 `/new` |
| 应用重载默认 | 继续没有覆盖 | 保留 | 必要时确认清原生绑定 |
| `/new` | 保留 | 新 ID、清引用和交接材料 | 清绑定、增 version |
| 真正 `/cd` | 保留 | 新 ID、清引用 | 清绑定、增 version |
| `/close` | 结束覆盖 | 结束关联 | 保留磁盘历史，防迟到回写 |
| 选择另一原生历史 | 验证相容 | 新上下文，不混旧图 | 绑定所选 ID、增 version |

`/close` 原有中止执行路径要保留，不能机械套入 `/model` 的 idle 限制；关闭时清理新字段必须校验 owner 和被取消的 run 身份，迟到结果不得重绑。其他重置遇有效 pending 先确认影响，不直接作废卡片。

### 6.4 通知与恢复

复用 DeliveryOutbox，但需要增加首次回复确认卡的操作，而不是假设现有 `card` 能创建卡。

- Session 中先有操作记录，再请求送达；稳定 UUID 从 operation ID 推导。
- 发送和补发时按最新 Session/op 状态重绘，不把过时按钮重新变成有效按钮。
- 回调只用 token 定位服务端操作，不信任卡片 payload 自报的目标模型或权限。
- 业务提交成功而通知失败，不重新提交模型修改。
- 启动恢复从 Session 的待通知操作补入现有 outbox，修复“提交成功但未入通知队列”的间隙。
- 超出外部 API 的去重保证时不承诺绝对只出现一张卡，但所有重复卡都不能重复执行同一修改。

## 7. 图片按需选择、截图与审查契约

### 7.1 文件保存不是图片投递

`TaskContext` 持久化用户图与验收截图的引用。图片字节不写入 sessions JSON，不自动扫描工作区或历史下载目录。

新增本轮输入结构：

```text
ImageInputPlan
  delivery: none | native-attachments | native-read
  imageIds: 当前上下文中的引用ID
  reason: fresh-user-images | flow-continuation | explicit-image-continuation | native-read
```

`none` 不校验无关旧图片，不因其缺失而阻断纯文本任务。需要投递的图片才进行归属、大小、真实类型、像素、内容摘要等检查。

保持需求给定限制：静态 PNG/JPEG/WebP，单张 10 MiB/2000 万像素，当前上下文至多 6 张用户图片、合计 16 MiB，实际引擎上限更低时从严。不要自行写一套图像解码器；P10 前由负责人锁定一个能验证这些约束的成熟库及版本、测试方法，依赖和构建脚本变更须单独明确，不自行绕过包管理器安全检查。

下载改为程序生成安全文件名，不能直接拼外部 fileKey。参考图与截图区分来源，截图只能来自本轮约定的受控目录，不接受任意路径授权。

### 7.2 谁决定本轮需要哪些图

不引入关键词猜测器、独立分类模型或一个无人提供的 `ImageDecision` 参数。

采用同一个主 CLI 的两种已验证输入路径，由 G00 为每个实际组合选择：

1. **支持同轮原生读图**：向主模型提供当前任务图片清单及受控路径，不无条件把历史图片转为原生附件；主模型按当前任务调用其原生读图能力。实际工具必须能输送图片内容，普通文件文本读取不算。
2. **只支持启动/续接附图**：当前消息新提供且任务明确需要的图片、已有流程快照选中的图片、已存在的明确图像接续请求，可以在启动时注入；不能判断历史图是否必要时，先进行同一主 CLI 的正常文字工作，由它产出下述图像接续请求，再由用户明确继续。不是自动启动第二个预检模型，也不自动循环。

新图片与文字指令是否相关无法明确时，不静默猜；该智能体可以用现有澄清方式询问真正的业务缺口。仅仅“模型不能看图”不新建业务澄清卡。

**实现门槛**：如果某个组合既不能同轮读图，又不能可靠地产出/消费下一轮图像接续，标记其按需图片能力受阻，不用字符串关键词猜测补齐；角色模型配置和纯文本路径仍可独立交付。

### 7.3 最小本轮产物协议

为启动时才能附图的 CLI、截图登记和验证报告提供一个本地结构化出口，避免解析自然语言宣称。这是普通 CLI 在本任务目录写的小文件，不是新 MCP、API、视觉服务或长期子 Agent。

执行准备时生成唯一目录，例如工作区下 `.scratch/agent-os/<contextId>/<executionId>/`，明确告知主 CLI 固定文件 `turn-result.json` 的路径；只读取这个预定位置。普通纯文本任务不依赖它才能运行。

建议最小内容：

```json
{
  "schemaVersion": 1,
  "executionId": "<本轮ID>",
  "contextId": "<本上下文ID>",
  "materialsUpdate": null,
  "imageRequest": {
    "imageIds": ["<已登记图片ID>"],
    "reason": "需要对照原图确认尚未明确的布局"
  },
  "screenshots": [],
  "reviewEvidenceRefs": []
}
```

字段允许为空；`materialsUpdate`、`imageRequest`、截图与审查证据的完整 Schema 分别在 P05/P11/P12/P13 落实，文件上限 64 KiB。非法 JSON、越界路径、未知 ID、错 executionId/contextId 均不得改变授权或创建成功结论。

图像接续请求的处理必须完整：

- 主 CLI 没收到必要图片时输出请求并说明相关工作未完成，不先猜图实现。
- 请求在 CLI 正常结束后校验并保存到 TaskContext，标为非阻塞接续材料，不是待回答业务澄清，不占用模型切换权限。
- 当前组合不能看图时只报告限制；用户完成模型切换后仍可使用这份请求。
- 有效范围限当前 owner/contextId 内的图片；已有接续请求时，去掉目标 @ 和首尾空白后的整条消息为“继续看图”或“继续验收”，才由确定性接续分支恢复请求中的 ID。没有接续请求时这两句仍是普通任务，其他文字不靠关键词猜测自动上传图片。
- 真实业务澄清仍用现有 request_clarification；不能为了拿图片制造一组无意义问题。真实澄清同时带有效 imageRequest 时，把这些必要图片 ID 保存进该流程的续接快照，用户回答卡片即可恢复，不额外要求再发一次“继续看图”。
- 如果同时存在真正的待确认产品方案，仍按需求拒绝切模型并展示显式重置后果，不能因为图像请求不阻塞就绕过产品流程。

该协议是执行计划选择的内部接线方式，不能扩展为任意工具调用或模型生成的执行指令。主 CLI 写下“已读图/已审查”只算报告，不是证明；证明仍来自已核验输入路径、Adapter/Runner 事件、执行账本记录和验收样本。`reviewEvidenceRefs` 只能引用本轮账本中真实存在的证据 ID，不能自己创造证据。

### 7.4 流程续接与纯文本回切

- 创建真实澄清/产品流程时保存当前有效模型快照和必要的图片输入计划；优先使用已实际投递/读取的 ID，不凭用户下一条“局部”重新猜。
- 澄清回答入口恢复快照，再按当前仍未完成的视觉需求提供原图。
- 新原生会话需要图像时重投原图；纯文本轮只带已确认文字材料，不把旧视觉摘要当作新验收。
- 文本模型不能接收原生历史中的旧图片时，通过已有模型切换确认清原生绑定，保留 contextId 和图片引用；不是执行 `/new`。
- 不能仅因材料准备失败就提前删除澄清流程。先保存答案/快照，确认本次是否进入执行；能力错误要明确说明剩余有效待办，不能悄悄丢失答案。

### 7.5 截图输入与 Reviewer

截图记录至少包含：本轮受控目录内的相对文件名、页面状态、viewport、生成时间及对应的代码/产物指纹。恢复前校验 contextId、内容摘要和当前版本，旧截图不能验收新改动。

G00 证明同轮回传像素则当轮验收；否则记录截图、报告待验收，用户下一轮继续时按原生附件输入。不自动并行启动第二次执行。

独立 Reviewer 需要一条从 CLI 事件到账本的证据链：

- G00 先确认所选开发 CLI 实际存在独立审查上下文，以及可观察的启动、工具/子 Agent、返回结果和代码读取记录；没有可观察证据时不能进入 P13 的真实审查验收。
- P04 对应子票扩展 CliEvent/CliRunResult，至少保留本轮执行 ID、工具/子 Agent 调用 ID、名称、开始/结束时间、成败状态，以及用于核验的输出引用。
- Runner 将这些记录与业务 `toolCalls` 分开保存；不得扩大 Agent OS 业务工具白名单，也不把 Reviewer 事件误判为 `dispatch_task` 等动作。
- 当前 ZCode/Codex 事件默认只保留业务工具输入和工具成败，普通工具输出会丢失；P04 必须为实际所选引擎补足最小证据采集，不能直接拿现有 runner 结果声称已支持 Reviewer 验证。
- 执行账本持久化证据引用、被审查 diff/代码指纹、Reviewer 报告位置和实际结果状态；`turn-result.json` 只能引用账本中的证据，不能伪造审查记录。

Reviewer 报告至少包含：调用证据引用、需求来源、检查的 diff/代码指纹、范围、问题列表、未覆盖项。只认可当前 CLI 已核验的独立上下文调用证据，不能把主会话自检或产物文件自述当作独立审查。

没有证据时质量状态是“审查未完成”，但 CLI 执行账本仍可为 completed；不能为了审查缺失把已写过代码的执行改为可自动重跑。

## 8. 任务顺序与完成门

```text
G00 外部能力/依赖冻结
  P01 值契约
  → P02 提交隔离与占位
  → P03 持久化状态/迁移
  → P04 各引擎接线（四个子票）
  → P05 三执行入口与流程快照
  → P06 命令解析/只读展示
  → P07 修改服务与确认
  → P08 通知/恢复
  → P09 new/cd/close/resume
  → P10 附件登记与限制
  → P11 按需图像与跨轮接续
  → P12 截图真实输入
  → P13 技术分工/独立Reviewer
  → P14 全链路回归与交付
```

G00 可以按能力逐项完成；不依赖未核验能力的纯函数和存储票可先执行。每个引擎只有自己的能力证据就可以先完成对应 P04 子票，不等待另一个引擎，也不能替另一个引擎宣称通过。

P13 的文字职责规则可提前整理，真实 Reviewer 验收必须等所选 CLI 的相关能力通过。

## 9. 逐票执行说明

### G00：建立基线并冻结外部能力

**执行者**：负责人或具备调查能力的智能体；不要把未验证选择留给后续低能力执行者猜。

**读取**：需求第 2、13 节，`docs/zcode-cli-integration-plan.md`，四个 Adapter、当前 CLI help、当前机器人 systemPrompt，以及实际团队工作区中已加载的产品/开发 Skill。

**动作**：

1. 记录工作区修改，运行 `pnpm typecheck`、`pnpm test`。
2. 收集当前 CLI 版本及帮助，确认安装来源；只读帮助不是模型能力验收。
3. 用用户授权的测试模型，在隔离的非敏感临时工作区核验新建、返回 ID 续接、强度、同 CLI 两角色不同模型、切换是否保留原生上下文。
4. 核验原生会话重建后，Agent OS 注入的结构化交接材料能被新模型使用；用户只说“继续”时，已确认范围和文档引用不丢失。
5. 图片用答案没有提前写入文字输入的测试图；分别验证启动图片、同轮新截图和必要的下轮接续。
6. Reviewer 用独立上下文读取一个已知小 diff 并报告具体问题；记录可验证的启动、工具/输出事件、调用 ID、diff/代码指纹和返回来源，不能只保存最终文字。
7. 核对当前产品 Skill 是否仍要求产品输出内部架构、模块接口、Schema/API 或测试 seam，并确认哪些文件是 bot 实际加载路径；不要只检查仓库模板。
8. 为 P10 锁定图像验证库版本与静态图片检测方式；未确定前只做模拟验证接口，不让执行者自写解码器。

**产物**：脱敏能力表，至少写 CLI/version、模型标识、请求参数的官方来源、实际回显来源、fresh/resume/switch/effort/image/reviewer/observerable-evidence 状态及证据；另附当前实际加载的产品/开发 Skill 清单和职责冲突。状态只能是 verified、unsupported、unverified。

**注意**：`src/probe-cli.ts` 可以离线消费事件；`src/probe-app-tool.ts` 会真实 runCli 并可能准备个人 MCP 配置，不能把它当无副作用的 help 命令。探测不经成品 Session 功能，不写共享默认模型，不复制登录凭据入仓库。

**完成门**：至少一组实际选择的执行能力已验证，其余明确标状态；未知 ZCode flag 不得出现于后续实现。

### P01：模型值类型、配置 Schema 和纯函数

**前置**：无外部调用需求。

**修改**：`src/core/model-selection.ts`（新增）、`src/core/bot-registry.ts`、`tests/model-selection.test.ts`（新增）；只补无凭据配置示例，不把假 model ID 写入正在使用的 bots 配置。

**按顺序做**：

1. 定义第 4.1 节类型及 Zod Schema；使用四 CLI 的稀疏配置键，例如 `z.partialRecord(z.enum(CLI_IDS), ...)`。
2. 修改 BotConfig、BotSchema、parseAgentOsConfig 的映射，保持三处一致。
3. 实现整组选择、set/effort/reset 变换、值相等/偏好相等、稳定指纹。
4. 测空字符串、null 与缺省、无覆盖、显式默认强度、相同值不同来源。

**定向测试**：`node --import tsx --test tests/model-selection.test.ts`

**完成门**：C01、C04、C05、C06、S04、S05、S06 对应纯逻辑可验证；不启动 CLI、不改全局环境变量。

### P02：Session 提交隔离与运行占位

**前置**：P01；无需真实 CLI。

**修改**：`src/core/session-manager.ts`、`src/core/session-store.ts`、`src/app/runtime.ts`、`src/app/task-lifecycle.ts`、`tests/session-transactions.test.ts`（新增）。

**按顺序做**：

1. 写可暂停、拒绝指定保存的内存 SessionStore fixture。
2. 先用测试复现同会话与不同会话的“第一次保存失败，第二次保存携带未提交值”。
3. 按第 5 节统一所有 manager 写操作，保存成功才发布，失败不回滚其他会话。
4. beginTask 改为首个 await 前依靠 activeRuns/修改占位拒绝竞争，不依靠提前发布 status。
5. 本票条件提交先使用已有 expectedVersion；expectedContextId 在 P03 增加上下文字段后接线，不引用尚不存在的属性。占位只释放本次 token。

**定向测试**：`node --import tsx --test tests/session-transactions.test.ts tests/reliability-regression.test.ts`

**完成门**：保存等待期间读不到草稿；失败不污染第二个会话；原有双 beginTask 只启动一个；收尾 activeRuns 存在时仍拒绝修改。

**停止条件**：若需要跨进程文件锁或重建所有状态库才能通过，停下来复查设计，不扩平台。

### P03：Session 新状态、修改记录与旧数据迁移

**前置**：P02。

**修改**：`src/core/task-context.ts`、`src/core/session-change.ts`（新增），`src/core/session-manager.ts`、`src/core/session-store.ts`、`tests/session-transactions.test.ts`。

**按顺序做**：

1. 加 topicOverride、taskContext、nativeModelBinding、执行快照和操作记录；taskContext 按第 4.5 节包含 materials 字段，不只保存 contextId 和图片引用。
2. 实现一次提交更新“覆盖存在性/来源、绑定、version、操作结果”。
3. 增加模型变化保 contextId 与 materials、真正重置换 contextId 并清空旧 materials 的纯变换，并将 expectedContextId 校验接入 P02 的条件提交。
4. 为合法旧行补稳定 contextId，历史选择标 legacy，materials 为空且标未迁移，保留原生 ID、owner 和旧版本；不扫描聊天记录或旧流程自动补写交接材料。
5. 恢复时 pending 操作按有效期保留/失效，不恢复内存执行锁；图片引用和 materials 先恢复元数据，不立即读取或上传全部文件。

**测试**：旧 sessions JSON、空 owner、旧 active 状态、带新字段的损坏记录、重启重复操作、稳定 contextId；分别覆盖模型切换保留 materials、`/new` 清空 materials、materials 损坏时停止自动续接。

**完成门**：S14，以及 S15、S16、A04、A05 在存储层的变换与迁移行为有测试；完整用户命令、图片投递和页面行为仍由后续任务验收。迁移不扫描 downloads，不删除用户历史，不把新默认冒充旧材料。

### P04：四引擎执行选择接线

**前置**：P01，目标分支 G00 已核验。

**公共修改**：`src/cli/types.ts`、`src/cli/registry.ts`、`src/cli/runner.ts`、`src/app/cli-execution.ts`。

**公共动作**：

1. 先让构参/runner 接受归一化执行选择，并用定向测试验证新路径；本票不把所有应用调用方的参数立即收紧为必填。P05 迁移三个入口和其他调用方时，再同票将 RunCliOptions/executeCli 的任务选择设为必需，避免旧调用方缺参导致本票无法 typecheck。
2. 构参/buildEnv 使用本次只读选择，不往 Adapter 实例或 process.env 写可变角色状态。
3. 每次任务取得独立 Adapter，展示实例只展示；更新旧单例测试，不保留跨轮事件去重 Set。
4. 对传入的显式选择，能力校验在 ensure MCP 配置和 spawn 之前；不能在发现不支持后仍启动实际任务。
5. CLI 实际模型元数据与请求模型分开记录，缺失记未知；不得给未迁移的业务入口临时统一填 native-default 掩盖遗漏。P04 是引擎层阶段完成，不是角色模型分工已经上线。
6. 对 G00 确认支持独立 Reviewer 的引擎，扩展事件与运行结果的最小证据字段，并在 runner 中与业务 `toolCalls` 分开收集；本票只接线和落账本，不解释审查结论，也不把普通工具失败升级为业务流程失败。

**子票顺序**：

| 子票 | 文件/已有测试 | 必做事项 |
| --- | --- | --- |
| P04a Codex | `src/cli/codex-adapter.ts`、`tests/attachments.test.ts` | exec 和 exec resume 都传目标模型；强度只用 G00 验证的键；图片参数在位置参数前；如用于 Reviewer，按实际事件补最小证据 |
| P04b ZCode | `src/cli/zcode-adapter.ts`、`tests/zcode-adapter.test.ts` | 按官方已验证机制应用选择；没有机制则显式能力错误，不能伪造 `--model`；按 G00 证据补独立 Reviewer 事件采集，不能只留成败布尔 |
| P04c Claude | `src/cli/claude-adapter.ts`、新增模型参数用例 | 新建/续接一致，保留原工具权限，不照搬 Codex 参数 |
| P04d Cursor | `src/cli/cursor-adapter.ts`、`tests/cursor-adapter.test.ts` | 去除 Adapter 隐含读取全局 CURSOR_CLI_MODEL 的优先级；用户配置文件不自动改写 |

**compact**：另改 `src/cli/native-compact.ts` 的输入/校验，按当前原生绑定整理，不用 compact 偷偷应用新默认；未验证能保持模型的路径明确提示限制，不把 exec 参数直接塞进 app-server。

**测试**：新建、续接、同 CLI 两角色并发、空工具与非空工具实例隔离、显式默认、未支持项 spawn 计数为零、原有附件与权限参数不变。

**完成门**：C02、C03、C06；每子票分别记录“单元通过”和“真实验证”。unsupported 错误测试通过不代表该模型组合已打通。

### P05：三执行入口、流程快照与账本

**前置**：P03、至少一个 P04 子票。

**修改**：`src/app/execution-context.ts`（新增）、`src/app/message-handler.ts`、`src/app/clarification-runner.ts`、`src/app/product-comment-runner.ts`、两种流程类型/持久化 Schema、`src/core/task-execution.ts`、`src/app/task-lifecycle.ts`。

本票跨度较大，拆两次交付：先快照类型与测试，再接三个入口；不要一次改完后才编译。

**按顺序做**：

1. 定义统一准备函数，返回 ready（有效模型/执行戳/输入）、requires-change（目标与原因）或 blocked（原因）的纯数据，不在这里发飞书卡。
2. 普通任务解析话题/角色默认，真实流程续接优先用冻结快照；legacy 流程不套新默认。
3. 普通消息中的文字澄清续接也接线，不只改卡片回答入口；同票迁移所有 runCli/executeCli 调用方和测试 fixture，再将任务选择参数收紧为必填，不能留下靠原生默认掩盖缺参的入口。
4. 目标成员使用目标话题设置；评论 Adapter 仍为空业务工具权限。
5. 执行账本记录请求快照、contextId/version、本轮使用的交接材料摘要、图像输入计划，以及 P04 采集到的 Reviewer/截图证据引用；同步增加持久化 Schema 字段，旧记录无这些字段时标未知。
6. result.sessionId 回写和后续创建流程前校验执行戳；陈旧 completed 结果不重绑、不重跑。
7. 默认变更但原生绑定不相容时返回 requires-change，保持状态且不 spawn；本票只验证该分支的纯数据与停止行为，P07 再接确认服务，不能提前调用尚未实现的 P07 接口或创建话题覆盖。
8. 按第 4.5 节接入材料写入：用户明确目标/范围、澄清答案、产品文档状态在启动 CLI 前完成归属与版本校验后原子保存；实现结果、测试、代码指纹和交付摘要在执行收尾后按真实状态保存。执行失败或取消保留已保存的用户决定，但不把未完成结果写成权威交付。
9. 保留原生会话时不重复注入全部历史；新建原生会话但 contextId 不变时，把 materials 生成结构化交接段，明确来自上一模型且不是已读图片。材料超限按第 4.5 节保留高优先项并列出省略项，缺失/损坏则 blocked，不能让新模型猜范围。

**定向测试**：`node --import tsx --test tests/reliability-regression.test.ts tests/workflow-reliability.test.ts tests/app-tool-policy.test.ts`，并新增交接材料重建、超限截断、损坏停止、重启后继续，以及“用户缩小范围→执行失败/取消→切换模型并重建原生会话→用户只说继续”的定向用例。

**完成门**：C07–C10、S18；重启后流程仍用原快照，已执行任务不会因送达失败再执行一次；用户明确的最新范围在执行前已保存，原生重建后仅凭“继续”也能拿到该范围、文档引用和真实交付状态。

### P06：命令解析、目标校验与只读展示

**前置**：P03、P05 的读取契约。

**修改**：`src/core/command-parser.ts`、`src/app/message-handler.ts`、`src/app/command-handler.ts`、`tests/model-commands.test.ts`（新增）。

**按顺序做**：

1. 按第 6.1 节解析 show/set/effort/reset/invalid。
2. 在 pendingClarification 查找之前处理模型家族；无效命令不成为用户澄清答案。
3. 群聊按真实 bot openId 校验单目标，使用 IncomingMessage.chatType 区分私聊。
4. show 使用最新已提交状态，不占执行锁、不 spawn；显示 desired、native binding、来源及核验状态的区别。
5. 没有会话的 show 不创造有业务含义的上下文；写命令创建会话时必须一次建立 owner。

**测试**：所有命令形式、重复/缺失参数、多个 @、无 @ 的群聊修改、执行中查询、空会话查询、普通未知非 model 命令旧行为。

**完成门**：S09、S10、S17 的入口行为明确，命令测试中 execute 调用数为零。

### P07：话题修改服务与确认卡回调

**前置**：P03–P06。

**修改**：`src/app/model-command-service.ts`（新增）、`src/app/command-handler.ts`、`src/app/card-action-handler.ts`、`src/im/card.ts`、`src/app/session-guard.ts`、`src/core/product-spec.ts`、相关测试。

**按顺序做**：

1. 给产品 store 增只读占位查询，不从应用层访问私有 maps。
2. 实现 prepare/confirm/cancel，采用第 5、6 节算法和统一有效待办查询。
3. set/effort/reset 对三个角色全部可用；无 owner 旧会话拒绝修改。
4. 同值 set、reset、默认重载保留不同 intent；真正完全相同才 no-op。
5. 需要新原生上下文时先保存 pending，确认前不得修改 binding、图片或 materials；确认卡说明将保留同任务的交接材料和图片引用，只重置原生记忆，不是清空任务。
6. token、目标组合、默认指纹和影响清单只认服务端记录。
7. 确认排除自己；新任务或新修改使旧操作失效；过期/取消释放占位。

**测试**：S01–S08、S11–S14；尤其确认后先启动并完成一个任务，再点旧卡，仍必须拒绝。

**完成门**：拒绝/取消/保存失败均保持原选择；所有副作用均发生在条件提交之后。

### P08：首次确认卡、动态重绘与重启补发

**前置**：P07。

**修改**：`src/app/delivery-outbox.ts`、`src/app/result-delivery.ts`、`src/index.ts`、模型服务、`tests/workflow-reliability.test.ts`。

**按顺序做**：

1. 增首次回复卡片操作，复用 Bot.replyCard 的 uuid 参数；不要拿 updateCard 更新一条用户消息。
2. flow/reference 增会话修改类型，resolveResultCard 明确分支，不能让新增类型掉进 product 的 else 分支。
3. 补发时重新取 op/current Session，已失效只画失效状态。
4. 操作提交与通知队列之间的崩溃由启动恢复扫描修复；恢复只发通知、不调用引擎、不重复提交选择。
5. 保存卡 ID 仅作为投递元数据，不得使已失效 op 重新 pending。

**测试**：发送超时但服务器已接收、通知落盘失败、重启恢复、重复按钮、模型已换后旧卡迟到。

**完成门**：S12–S14；通知恢复没有 runCli 或模型选择写操作。

### P09：统一 `/new`、`/cd`、`/close` 与历史恢复

**前置**：P07、P08。

**修改**：`src/app/command-handler.ts`、`src/app/card-action-handler.ts`、`src/app/message-handler.ts` 中协作切目录分支、`src/im/card.ts`、Session 变换与测试。

**按顺序做**：

1. 按第 6.3 节矩阵改每个入口，不能只改 `/new`。
2. `/cd` 路径校验后、真正提交前复核状态与归属；同目录为 no-op。
3. new/cd/close 遇有效 pending 先展示失效卡片、清除图片关联、保留文件/模型偏好等影响；取消不变。
4. 关闭已有执行保留原取消语义，增新字段清理和迟到写防护。
5. 历史恢复按钮补上下文/版本绑定，校验模型相容；不新增 ZCode/Cursor 的历史恢复能力。
6. 清原生上下文时清理 runtime.contextWindows，不用旧模型上下文窗口假装新模型信息。
7. Session 提交后失效旧流程和通知，后续清理失败不回滚已经应用的模型操作。

**测试**：改写现有“new 立即使待办失效”的用例为确认前不变/取消不变/确认后失效；覆盖 S15、S16、S19、A04。

### P10：图片登记、安全落盘与物化

**前置**：P03、P09，图像校验库/API 在 G00 已冻结。

**修改**：`src/app/task-attachments.ts`（新增）、`src/im/lark.ts`、`src/app/message-handler.ts`、`src/core/task-context.ts`、`tests/task-attachments.test.ts`（新增）。

**按顺序做**：

1. 在限定任务目录生成安全文件名，原文件名只作为显示元数据。
2. 校验真实类型/静态图/大小/像素/常规文件和符号链接边界，计算摘要。
3. 在当前执行戳仍有效时原子登记到 TaskContext；校验失败不静默跳过所需图片。
4. 关联属于 contextId+owner+workspace，不属于单次 executionId。
5. 提供 `materializeSelectedImages(context, ids)`，仅读取选定项；空 ids 不触碰缺失历史图片。
6. 超出登记上限拒绝新增，保留已有材料；不批量删除历史文件。
7. 普通文件附件继续当前路径，不误当所有文件都应传给多模态入口。

**定向测试**：`node --import tsx --test tests/task-attachments.test.ts tests/attachments.test.ts`

**完成门**：A04–A07、A10–A12；路径越界和其他 owner/context 的引用不能进入 Adapter 参数。

### P11：按需图片与跨轮接续

**前置**：P05、P10，所选图片输入路径 G00 通过。

**修改**：`src/app/run-artifacts.ts`（新增）、`src/app/execution-context.ts`、`src/app/cli-execution.ts`、三个任务/续接入口、流程快照与 `tests/image-continuation.test.ts`（新增）。

**按顺序做**：

1. 把第 7 节协议写入本轮输入说明，只读取固定产物位置；没有图片相关任务时不强制产物文件存在。
2. 同轮 native-read 使用当前主 CLI；启动附图使用明确 fresh/flow/continuation IDs，不把历史清单直接转为全部附件。
3. 解析主模型图像接续请求，校验 ID 与执行戳，保存为非阻塞材料并写入当前上下文 `handoffNotes`；等待用户明确继续，不新建图像业务审批。
4. 真实澄清创建时保存必要图像快照和对应业务答案；卡片回答和普通文字回答都恢复，不按“局部”关键词猜图。
5. 文字轮不新增图片输入，保留原图；视觉回切可恢复。
6. 目标文本模型不接受原生图片历史时，走模型确认新建原生上下文，不清任务关联。
7. 当前模型不能看图只产生能力提示；若已有产品待确认，提示真实阻塞与重置影响，不诱导先确认方案。
8. 产物解析错误只影响相关材料/验证状态，不把已执行代码的账本改成可以自动重跑。

**测试**：A01、A02、A03、A08、A09、A13、S19；同时测试伪造产物、未知图片ID、context 已变、缺失无关图片、主模型未产生可靠图像接续。

**停止条件**：如果实际 CLI 无可靠读图/接续路径或产物协议无法执行，报告该分支受阻，禁止新增独立视觉服务兜底。

### P12：运行中新截图真正进入模型

**前置**：P11，G00 页面工具与图像输入证据。

**修改**：运行产物/附件/执行准备模块、必要的开发指令、`tests/image-continuation.test.ts`；不新增浏览器服务。

**按顺序做**：

1. 固定每轮截图目录，只接受该目录实际生成、校验通过的截图引用。
2. 登记 viewport、页面状态、时间和当前代码/产物指纹，不覆盖参考图。
3. 同轮输入已验证则原生读图；只能下轮附图则标待验收，用户继续后再传参考图和截图。
4. 续接复核 owner、contextId、文件摘要和版本；代码或页面变化就重新截图。
5. 无图片输入证据时不能仅因路径存在而显示通过。

**测试**：R06、R07、A03、A04；用不在文字输入中泄露答案的可见标记验证模型确实拿到图片。

**完成门**：至少一条真实同轮或下轮路径通过；不要求同时实现两条，不用 mock 宣称真实图片能力。

### P13：开发自主决策、产品职责边界与独立审查交付

**前置**：P05；真实审查依赖 G00 和 P04 的证据采集，页面结果依赖 P12。

**修改**：`src/core/team-registry.ts`、`config/bots.json` 中实际使用的 CEO/产品/开发 systemPrompt、开发工作区 Skill 接线、`workspace-template/.agents/skills/implement-ticket/SKILL.md`、实际团队工作区中的 `grill-me`/`to-spec`/`to-tickets` Skill、运行产物/账本结果 Schema、结果渲染与测试。

**按顺序做**：

1. 明确普通需求可从任务消息开始，内部技术分析不自动要求用户确认。
2. 保留只有业务/费用/权限/破坏性操作等未决事项才提问的规则。
3. 同步收敛产品侧有效提示词与实际工作区 Skill：产品负责业务目标、用户行为、规则、边界、验收和 Tickets；已有技术约束可记录为参考，不能要求产品先完成架构、模块接口、Schema/API 或测试 seam 设计，也不能默认把内部技术切入点交给用户确认。
4. 只修改当前 bot 配置真实加载的工作区 Skill；Agent OS 仓库模板与实际 `../agent-os-team-example` 都核对，不能只改其中一个就声称职责边界生效。
5. 若用户明确要求产品同时输出技术方案，才作为显式任务例外处理；默认不改变产品确认流程和开发自主实现边界。
6. Reviewer 必须在独立上下文读取需求和真实 diff；报告核对代码指纹，修复后重查。
7. 校验 P04/P05 保存的真实调用证据；缺失、只引用不存在的证据、或 turn-result.json 自述时报告未完成，不让模型宣称变成可信证明。
8. 分开机械执行状态与验证状态：账本 completed 防重复执行，用户卡片可以显示“实现阶段完成，审查/页面未完成”。
9. 对未验证阶段不用绿色“全部通过”概括；必要时复用 session notice 样式显示阶段结果，不改成引擎执行失败来诱发重跑。
10. 核对实际开发 workspace 是否加载这些指令；不能只改模板就宣布生效。

**测试**：W01–W06、R01–R05；独立调用缺失、返回无范围、审查旧 diff、主会话自检、代码完成后审查失败、证据引用不存在、产品 Skill 仍要求架构设计但用户任务未显式要求等分别覆盖。

**完成门**：真实小需求能自主推进，产品默认不再把内部技术决策推给用户，Reviewer 缺失明确受阻；不新增审查机器人或另一个自动付费 CLI。

### P14：全链路回归和交付

**前置**：对应范围内前票通过，受阻引擎有明确清单。

**动作**：

1. 跑全部自动测试与构建。
2. 按第 10 节矩阵逐项记录需求验收，不能只写“测试通过”。
3. 在授权测试群分别 @ CEO、产品、开发验证 set/effort/reset、互不污染与默认回归。
4. 验证重启、持久化失败、失效卡片、评论排队、已有待确认方案补图等组合场景。
5. 验证“视觉→文本接口修改→视觉原图恢复”和运行中新截图路径。
6. 人工复核实际模型证据、独立 Reviewer 和页面结果，不把主模型总结当独立证据。
7. 提供支持矩阵、配置示例、命令说明、已知限制；不包含真实凭据。

**命令**：

```bash
pnpm typecheck
pnpm test
pnpm build
```

**完成门**：用户所选组合通过真实验收，55 项均有通过/受阻及证据；受阻项存在时只报告部分交付，不擅自从需求删掉。

## 10. 需求验收追踪表

编号来自需求文档，作为核对锚点，不在这里改写其业务含义。

| 需求编号 | 主要任务 | 关键证据 |
| --- | --- | --- |
| C01 | P01、P04、P14 | 三角色默认配置和真实执行 |
| C02 | P04、P14 | 同 CLI 并发角色隔离 |
| C03 | G00、P04b、P14 | ZCode 官方选择机制与并发 |
| C04 | P01、P04 | 非示例有效模型不需改业务代码 |
| C05 | P01、P06 | 原生默认来源和未知回显 |
| C06 | P01、P04、P07 | 显式无效值不回退 |
| C07 | P05 | 目标角色话题选择 |
| C08 | P05 | 两种续接与空工具权限 |
| C09 | P05、P07 | 默认变更与话题覆盖 |
| C10 | P05 | 持久化流程快照 |
| S01 | P06、P07 | CEO 话题覆盖 |
| S02 | P06、P07 | 产品话题覆盖 |
| S03 | P04、P07、P11 | 开发同话题换模型 |
| S04 | P01、P07 | 同值不同 intent/source |
| S05 | P01、P07 | 新模型不继承旧强度 |
| S06 | P01、P07 | effort 与原生默认区分 |
| S07 | P02、P06、P07 | 查询不执行、收尾拒绝写 |
| S08 | P07、P09 | 所有有效待办/预占 |
| S09 | P06、P07 | owner 与单目标 mention |
| S10 | P06 | 错命令不进模型/澄清 |
| S11 | P07、P08 | 确认前不改、自身不阻塞 |
| S12 | P07、P08 | 重复/过期/并发卡片 |
| S13 | P02、P07 | 新任务后旧确认失效 |
| S14 | P02、P03、P07、P08 | 保存失败和投递失败分开 |
| S15 | P09 | new 保偏好、清任务 |
| S16 | P09 | 工作区/关闭生命周期 |
| S17 | P03、P06 | 空会话原子建归属 |
| S18 | P04、P05、P07 | 已设置与实际验证分开 |
| S19 | P09、P11 | 待确认补图与明确重置 |
| A01 | P05、P11 | 澄清不重新上传 |
| A02 | P10、P11 | 交付后同任务仍能用图 |
| A03 | P05、P07、P11、P12 | 原生重建不清任务图和交接材料 |
| A04 | P09、P10、P12 | 新任务/工作区不混图 |
| A05 | P03、P10、P11 | 重启恢复引用 |
| A06 | P10、P11 | owner/角色/话题隔离 |
| A07 | P10、P11 | 只验证本轮所需图片 |
| A08 | P04、P11 | 必需视觉不支持的真实阻塞 |
| A09 | P11 | 图像接续不造业务等待循环 |
| A10 | P10、P11 | 内嵌图首次补充边界 |
| A11 | P10、P11 | 图像文字不构成授权 |
| A12 | P04、P10、P11 | 普通文件和纯文本回归 |
| A13 | P07、P11、P14 | 视觉→文本→视觉 |
| W01 | P13 | 小任务无额外文档门槛 |
| W02 | P13 | 明确普通需求直达开发 |
| W03 | P13 | 内部去重方案自主决定 |
| W04 | P13 | 真正业务取舍才澄清 |
| W05 | P13 | 已明确事项不重复问 |
| W06 | P05、P09、P13 | 保持产品确认/评论规则 |
| R01 | G00、P04、P05、P13 | 实际独立 Reviewer 调用及账本证据 |
| R02 | P04、P05、P13 | 需求和真实 diff 检查范围及证据引用 |
| R03 | P04、P05、P13 | 缺失或不可核验证据不是全部通过 |
| R04 | P05、P13 | 新改动重新审查并更新账本证据 |
| R05 | G00、P04、P13 | 新 CLI/模型重新核验能力 |
| R06 | G00、P12、P13 | 页面与真实像素输入 |
| R07 | G00、P12、P14 | 新截图同轮/下轮接续 |

## 11. 高风险组合测试：必须先写的 fixture

优先复用 `tests/reliability-regression.test.ts` 的 fixture/restart/gate 和 `tests/workflow-reliability.test.ts` 的排队、临时目录故障方法，不引入新测试框架。

| 场景 | 最小复现 | 必须断言 |
| --- | --- | --- |
| 跨会话保存污染 | A 保存暂停后拒绝，B 同时提交 | B 磁盘不含 A 未提交值，A/B 已提交值都不回滚错位 |
| 双开始 | 两次 beginTask 同时进入 | 仅一次执行回调调用 |
| 收尾窗口 | status 已 idle，release 保存仍等待 | `/model` 仍拒绝 |
| 两次确认 | 同 op 连续或并发点击 | 只增一次 version、不重复清绑定 |
| 旧确认复活 | 等待确认期间任务开始并结束 | 旧卡仍失效，而不是因现在 idle 又可用 |
| 通知间隙 | 选择提交后、outbox 入队前中断 | 重启补通知，不再提交选择 |
| 老数据 | 旧 session/flow 无新字段 | 不丢行，不把新默认冒充旧模型 |
| 澄清原图 | 新图→澄清→仅回答卡片 | 下轮能拿原图，owner/context 未变 |
| 不用旧图 | 历史图缺失，当前只改接口 | 不读缺失图、不上传图，文本任务可执行 |
| 图像历史不相容 | 视觉原生历史→文本模型 | 明确重建原生上下文，context 图片引用仍在 |
| 重建后仅说继续 | 已确认范围和文档引用已保存，原生会话重建，服务重启 | 新模型输入包含这些材料，用户不重新贴需求 |
| 范围缩小后失败 | 用户明确“只改登录区域”，本轮执行失败/取消，随后换模型并重建原生会话，只说继续 | 最新范围在执行前已保存并注入；旧“整页修改”目标不再误导新模型，失败结果不冒充交付 |
| 交接材料超限 | 材料超过安全输入限制 | 保留高优先材料、列出省略项，不悄悄截断或猜测 |
| 产品待确认补图 | pending 产品＋不支持视觉模型＋新图 | 不诱导先 approve；重置影响明确、取消不变 |
| 截图伪成功 | 只有 png 路径没有图像输入 | UI 未验收，不被报告字段骗成通过 |
| 伪造产物 | report 引用其他 context/path | 拒绝读取/授权，正常历史不被覆盖 |
| 审查伪成功 | 主会话写 review.passed 但无独立调用 | 独立审查未完成，执行账本不自动重跑 |
| 审查证据断链 | Reviewer 实际调用但 adapter 未保留事件或账本无引用 | P13 报告证据缺失，不用 turn-result 自述补成功 |

不得用 sleep 制造并发测试；用可控 Promise gate 明确暂停在哪个 await。

## 12. 单票交付模板与停止规则

每张票完成后只需按以下格式汇报：

```text
任务票：Pxx
修改文件：逐项列出
实现内容：对应本票动作，不扩写其他功能
定向测试：命令与实际结果
类型/全量测试：命令与实际结果，未运行明确写未运行
验收编号：已覆盖、仍需真实环境验证
未完成/阻塞：具体能力、证据和需要谁决定
下一票：依赖满足才填写
```

出现下列任一情况，停止相关分支并报告：

- 需要猜测模型 ID、CLI flag、非公开配置、原生会话格式。
- 需要通过修改共享默认模型才能实现角色隔离。
- 需要读取/复制真实凭据或未经授权调用付费模型。
- 新功能只能通过删除旧测试、跳过 hook、忽略显式配置错误才能通过。
- 需要在活跃会话、待确认方案或评论排队中直接改模型。
- 无法获得原图/截图真实输入或独立 Reviewer 的证据。
- 设计无法满足事务失败隔离，准备借机重建全部存储或新增服务。
- 本计划内部产物协议与实际 CLI 文件/工具能力不相容。

停止不是失败掩盖：留下已通过部分、失败复现和精确缺口，不自作主张降级为“用默认模型就算完成”。

建议先只下发 G00、P01、P02；这三步结果清楚后再逐票推进。不要把整篇文档一次交给执行智能体并要求“不论发生什么都一次做完”。
