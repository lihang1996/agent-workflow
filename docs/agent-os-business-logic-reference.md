# Agent OS 业务逻辑全景记录

> 基准：2026-09-27 按 `src/`（约 8,100 行 TypeScript）逐文件通读整理；对应最近提交（2026-09-25 前后）的代码状态。
> 目的：把"这个系统到底怎么运转"完整写下来——配置怎么变成团队、一条飞书消息经过哪些关卡、四个执行引擎如何被统一驱动、协作/澄清/产品方案三条人机流程的精确规则、以及所有可靠性设计的动机。
> 本文以源码为唯一事实来源；`docs/agent-os-code-deep-dive.md` 是面向初学者的讲解版，两者可互为参照。

---

## 1. 项目定位

Agent OS 是一个**个人生产系统**：以飞书话题群为唯一操作界面，把「Claude Code / Codex / Cursor / ZCode」四个 CLI 编码代理当作执行引擎，组成一个可配置的虚拟团队。

- **用户**：在飞书群里 @ 某个 bot（或直接说话），下达目标。
- **团队成员**：每个 bot 是一个"数字员工"，有角色（CEO 助理/产品/开发…）、专属工作目录、默认引擎、项目 Skill 和系统提示词。
- **系统本体**：不生成任何业务内容，只做翻译与调度——把飞书消息翻译成 prompt 交给引擎、把引擎的执行过程实时渲染成飞书卡片、把引擎请求的人机交互（提问/方案确认/任务派发）变成真正的飞书交互卡片再收回执。

一句话：**飞书是壳，CLI 引擎是手，Agent OS 是神经中枢。**

---

## 2. 总体架构（五层 + 数据）

```
飞书开放平台（长连接 WebSocket）
        │  事件：消息 / 卡片回调 / 文档评论
        ▼
src/im/          飞书集成层：lark.ts(Bot 能力)、card.ts(12 种卡片)、message-parser(@还原/附件提取)、text-limits
        ▼
src/app/         编排层：message-handler(主链路)、command-handler、card-action-handler、
                 clarification-runner、collaboration-service、product-comment-*、
                 task-lifecycle、delivery-outbox、notification-service、result-delivery、session-guard
        ▼
src/core/        域模型层：bot/team-registry、session-manager/store、task-execution/abort/progress、
                 collaboration、clarification、product-spec(±store)、app-tool-policy、
                 identity、model-selection、command-parser、topic-task、json-state、workspace
        ▼
src/cli/         引擎适配层：claude/codex/cursor/zcode 四适配器 + runner + spawn-cli +
                 native-sessions(/resume 用) + native-compact(/compact 用) + app-tools(MCP 注入)
        ▼
src/mcp/         应用工具服务器：app-tools-server、zcode-app-tools-server
                 （以 stdio MCP 形式把 request_clarification / request_spec_approval /
                   dispatch_task 三个业务工具注入引擎）

data/            六个在用 JSON 状态文件 + downloads 附件目录（详见 §19）
```

核心契约是 `CliEvent`（src/cli/types.ts）：无论引擎原生输出什么格式，适配器都归一化成 `session / tool_start / tool_end / context / tool_call / result / error` 七种事件；应用层只消费这一种口径。

---

## 3. 配置体系

### 3.1 `config/bots.json`（团队注册文件）

顶层两个字段：

| 字段 | 含义 | 默认 |
|---|---|---|
| `teamLeader` | Team Leader 的 bot id | 必填 |
| `defaultProductDeliveryMode` | 产品方案默认交付方式：`local`（本地 Markdown）/ `lark-doc`（飞书云文档） | `lark-doc` |

每个 bot 的字段（`src/core/bot-registry.ts` 用 zod 严格校验）：

| 字段 | 规则 | 说明 |
|---|---|---|
| `id` | `^[a-z0-9][a-z0-9_-]{0,31}$`，不得重复 | 团队内唯一标识 |
| `appIdEnv` / `appSecretEnv` | 环境变量**名**（不是值） | 飞书凭证只放 `.env`，配置文件可提交 |
| `defaultCli` | `claude / codex / cursor / zcode` 之一 | 该成员默认执行引擎 |
| `modelOverrides` | 按 CLI 的 `{model, reasoningEffort}` 映射 | 声明式模型偏好（见 §17） |
| `role` | 非空一句话 | 岗位职责，注入 prompt 与团队名单 |
| `skills` | kebab-case 数组，去重 | 项目 Skill 名（如 grill-me/to-spec/lark-doc） |
| `workspace` | 相对 bots.json 所在目录或绝对路径 | 该成员的专属工作目录，启动时必须已存在 |
| `systemPrompt` | 自由文本 | 角色私有行为规则 |
| `collaborationMaxRounds` | 1~32，默认 16 | 该成员发起协作的轮次上限 |
| `enabled` | 默认 true | false 则整成员禁用 |

校验失败即启动失败：凭证缺失、teamLeader 指向未启用成员、零个启用 bot 都会抛错。兜底工作目录链：`workspace → env.CLI_WORKDIR → env.CLAUDE_WORKDIR → 当前目录`。

### 3.2 当前注册的团队（config/bots.json 实况）

| id | 角色 | 默认引擎 | Skills | 模型偏好 |
|---|---|---|---|---|
| `ceo-assistant`（Leader） | CEO 助理：理解目标、组织成员、汇总结论 | codex | （无） | gpt-6-sol / low |
| `product` | 产品经理：澄清需求、形成可验收产品说明 | codex | grill-me、to-spec、to-tickets、lark-doc、lark-drive | gpt-6-astra / medium |
| `developer` | 开发工程师：实现与基础验证 | zcode | （无） | glm-5.3 / high |

`product` 的 systemPrompt 是业务核心约束的浓缩：不写代码、先 grill-me 聊清目标、按默认交付方式生成**唯一权威产物**（本地 `.scratch/<feature>/` 或飞书云文档，云文档必须含产品说明 + 实现任务 Tickets 两部分）、同一任务复用同一云文档 URL、绝不双份维护。
`developer` 的 systemPrompt：按文档实现、实质性决策缺口才 request_clarification 一次问清、完成后独立 Code Review 再交付、**不回传 CEO**。

### 3.3 `.env`（不入库）

`BOTS_CONFIG`（配置路径）、每个 bot 的飞书凭证、`TEST_CHAT_ID`、`OWNER_OPEN_ID`、`CLI_WORKDIR`、`CURSOR_CLI_COMMAND/MODEL`、`ZCODE_CLI_COMMAND` 及两条 ZCode provider 配置路径（成对设置）。模型后端由各引擎自己的用户级配置管理（可用 CC Switch 切换）。

---

## 4. 启动装配（src/index.ts）

1. 读 bots.json → `AgentOsConfig`（校验+解密钥）→ `TeamRegistry(teamLeaderId, bots)`。
2. 逐 bot `ensureWorkspaceDirectory`（不存在直接启动失败）；`findMissingSkills()` 扫 5 级 Skill 目录（工作区 `.agents/skills` > 工作区 `.claude/skills` > 用户级三处），缺失打警告。
3. `SessionManager.open(JsonSessionStore(data/sessions.json))`：恢复历史会话（creating/active 一律降级为 idle，见 §7）。
4. 装配 `AppRuntime`（src/app/runtime.ts）：sessions、teamRegistry、activeRuns、contextWindows、botRuntimes、processedCollaborationTurns、collaborationInbox（data/collaboration-inbox.json）、clarificationFlows（data/clarification-flows.json）、productSpecFlows（data/product-spec-flows.json）、taskExecutions（data/task-executions.json）、deliveries（DeliveryOutbox，data/result-deliveries.json）。
5. 每个 bot 调 `startBot()` 建飞书长连接，挂三个回调：
   - `onMessage` → message-handler（普通消息 + 协作消息）；
   - `onCardAction` → card-action-handler（澄清/审批/恢复/停止四类卡片动作）；
   - `onDocumentComment` → 仅 `skills` 含 `lark-drive` 的 bot 启用，交给 ProductCommentScheduler；并 `subscribeDocumentComments()` 订阅评论事件（失败仅降级警告）。
6. 恢复机制：启动时及**每 60 秒**执行 `collaborationService.recover()`（补发 pending 协作、通知 interrupted 协作）+ `deliveries.recover()`（补发未送达结果），互斥防重入。

---

## 5. 消息主链路（src/app/message-handler.ts，系统心脏）

一条消息进来后按以下顺序过九道关卡，任何一道拦截即终止：

**① 提及还原与任务定位**：`resolveMentions` 把 `@_user_N` 占位符还原成 `@显示名`；`topicTaskId = sha256(chatId:threadId|rootId|messageId).slice(24)` 作为话题级任务号。

**② 协作消息识别**（sender 是 bot/app 时）：必须是 post 消息 + @ 了当前 bot + 文本含 `任务编号：<12位hex>`，且 `collaborationInbox.peek(dispatchId, 当前bot)` 命中 pending 记录；再校验发送者 openId 等于记录的 fromBotId 身份、`collaborationTurnKey` 未处理过（内存去重集，上限 1000）。全部通过才按协作任务继续，否则忽略（"忽略非目标 bot 消息"）。

**③ 命令/引擎请求解析**：`parseCommand` 识别斜杠命令；`parseCliRequest` 识别 `/claude|/codex|/cursor|/zcode <任务>`。`/xxx` 后面没写任务直接提示返回。

**④ 澄清流挂起检查**：人类消息且非命令时，查该 (taskId, botId) 是否有未完成澄清流；若会话已变（closed 或 version 不匹配）则作废该流；只有原任务发起人（`isClarificationOwner`）能补充。

**⑤ 会话解析**：`sessions.resolve(msg, cliId, botId, workspaceDir)`——话题级单会话：key = `botId:chatId:threadId`，存在即复用，否则新建 `creating` 状态。协作消息会临时把会话工作目录切到协作要求的目录。

**⑥ 会话所有权门**：非协作、非命令消息必须过 `canManageSession`（§9.3），否则提示"只有原任务发起人可以继续当前会话"。

**⑦ 命令分发**：`handleSessionCommand`（§6）返回 handled 则结束；否则检查会话状态机：closed 拒绝、creating 提示稍后、active 提示等待。

**⑧ 任务开始**：`beginTask`（乐观并发：校验 version + 无 activeRun + 无 mutation 锁，置 active 并登记 owner）；协作任务还需 `collaborationInbox.acquire` 抢占（received 状态）；挂起澄清流被新消息取代时，旧卡片更新为"已被新消息取代"。

**⑨ 执行与结果处理**（异步，回调立即返回）：
- 附件先落盘 `data/downloads/`，绝对路径写进 prompt 尾部（`attachmentPromptSection`），任何能读文件的引擎都能处理；Codex 适配器另可走原生 `-i`。
- `buildBotPrompt` 组装最终 prompt：角色 → systemPrompt → 团队名单上下文（§9.4）→ 产品交付规则（仅持有相关 Skill 的成员）→ Skill 加载规则（工作区 `.agents` > 工作区 `.claude` > 用户级，顺序不可颠倒）→ 飞书输出规则（≤1200 字、先结论、不贴长代码/表格、澄清规则）→ 当前任务。
- 先回一张 running 任务卡；`TaskProgressTracker` 以 1 秒心跳把"正在理解任务/工具名+参数摘要/耗时/工具计数/上下文 token"渲染到卡片（`ThrottledCardUpdater` 节流）。
- `executeTask`（§8）调 `executeCli`→`runCli`（§15.2），事件流喂进度器。
- 完成后按优先级依次检查三类**应用工具调用**（从 toolCalls 里解析，见 §16）：
  1. `request_clarification` → 创建澄清流，卡片转澄清卡，@ 发起人（§11）；
  2. `request_spec_approval` → 校验产物（本地文件真实存在/飞书 URL 归一化）→ 创建产品方案流，卡片转审批卡（§12）。两者同时出现直接报错"不能同时提交产品方案和派发团队任务"；
  3. `dispatch_task` → 仅 Leader 可调、目标必须是注册成员且非自己、协作轮次未超上限；通过后 `collaborationService.dispatch` 发协作卡并 @ 目标（§10）。
- 都没有 → 卡片转 success（带答案与统计）；长答案（>3000 字符标记）经投递箱分段续发；@ 通知发起人"任务已完成"。协作完成的结果**直接通知用户**，不回传派发方转述。
- 失败路径区分三种：结果处理失败但执行已 completed（卡片回滚、提示勿重复执行）；用户中止（cancelled 卡，区分 stop/close 两种文案）；真失败（failed 卡 + 技术详情）。`finally` 里 releaseTask + 协作 inbox release。

---

## 6. 斜杠命令系统（src/core/command-parser.ts + app/command-handler.ts）

| 命令 | 语义 | 关键规则 |
|---|---|---|
| `/status` | 查看会话（bot、状态、引擎、CLI 会话、目录、最近执行、待补发数） | 只读 |
| `/team` | 团队卡片（成员/角色/引擎/Skills/Leader/在线状态） | 只读 |
| `/help` | 命令列表 | 只读 |
| `/new` | 清空当前话题的 CLI 会话绑定，下一条任务全新开始 | 旧会话保留可 `/resume`；active/closed 拒绝 |
| `/resume` | 列出当前工作目录的原生 CLI 会话供选择（卡片点选） | cursor/zcode 不支持；active/closed 拒绝 |
| `/compact [要求]` | 用引擎**原生**压缩整理当前 CLI 会话上下文 | 需已有 CLI 会话；claude 走 `/compact` 指令、codex 走 app-server 协议；卡片进度注明"原生默认策略"；会话 ID 不变 |
| `/cd` / `/cd <目录>` | 查看/切换话题工作目录 | 切换会清 CLI 会话绑定并 version+1（换目录=换上下文）；需发起人+版本复核 |
| `/close` | 关闭会话（终态） | 若在执行先 abort(cancelMode=close) 再关闭 |
| `/claude` `/codex` `/cursor` `/zcode` | 指定引擎执行任务 | 已有会话的**话题内不可换引擎**（提示新开话题） |

所有权规则：`new/resume/compact/close/cd<路径>` 这五个变更型命令要求 `canManageSession`；status/help/team/cd(查看) 不限。

---

## 7. 会话模型（core/session-manager.ts + session-store.ts)

**映射关系**：一个 (bot, chat, 话题) 恒对应一个 Session；Session 持有 `cliId + cliSessionId(引擎原生会话) + workspaceDir + status + version + owner`。

**状态机**：`creating → active|idle|closed`；`active → idle|closed`；`idle → active|closed`；`closed` 为终态（唯一无出边状态）。非法迁移直接抛错。

**version 乐观锁**：`/cd` 切目录、`selectCliSessionId` 切上下文、close 都会 version+1；`beginTask`、澄清续跑、评论修改都用 `expectedVersion` 复核——"会话上下文已经切换，本次修改已失效"。普通 `setCliSessionId`（执行结果回写）不加版本。

**持久化**：`JsonSessionStore` 串行写队列 + 临时文件 rename 原子落盘；加载时做三件事：老记录补 botId/workspaceDir（迁移）、schema 不合格的行剔除、**creating/active 一律降级 idle**（进程重启不可能还有真在跑的任务）。

**恢复执行**（`/resume` 与卡片选择）：`listNativeCliSessions`（cli/native-sessions.ts）直接读各引擎本地会话存储（如 `~/.claude/projects` 的 jsonl 元数据）列出 (id, title, updatedAt)；选择时再次确认该会话仍属于当前工作目录、版本未变，然后 `selectCliSessionId` 绑定并 version+1。

---

## 8. 任务执行与"恰好一次"语义（core/task-execution.ts + app/task-lifecycle.ts）

- `activeRuns: Map<sessionId, {AbortController, owner, cancelMode}>`：进程内运行锁，同会话不并发。
- `TaskExecutionStore`（data/task-executions.json）：每个执行 ID 一条记录 `running/completed/failed/interrupted`。**重启时 running → interrupted（"执行中断，结果不确定，请检查后继续"）**。`executeTask` 的规则：
  - running/interrupted 的 ID 再次执行 → 直接报错，**绝不自动重放**（防副作用重复）；
  - completed 的 ID → 直接复用已存结果（投递失败可安全重试，因为"完成与投递解耦"）；
  - 先 `store.start` 再执行，`complete` 落盘失败会保持 running——下次同样拒绝重放。
- 执行 ID 三种来源：普通任务 `botId:messageId`、澄清续跑 `clarification:<token>`、协作 `dispatch:<dispatchId>`、评论修改 `comment:<...>`（§13）——**四个入口共用同一执行/结果持久化边界**。
- 超时默认 50 分钟；abort 用 AbortSignal 贯穿（runner 里 Windows 还要 killCli 杀进程树）；`cancelMode` 区分"停止本次任务"与"停止并关闭会话"。
- 结束统一 `releaseTask`：校验 controller 还是自己的（防误删后继任务），会话 active→idle，删 activeRuns。

---

## 9. 身份、权限与角色分工

### 9.1 TaskOwner 判定（core/identity.ts）
同一自然人的 openId 在不同飞书应用里不同，**unionId 优先**：双方都有 unionId 时只比 unionId；否则要求同 bot（ownerBotId 一致）且 openId 相等。owner 三元组随任务建立（协作/澄清场景继承原始发起人，而不是中间转手的 bot）。

### 9.2 角色工具策略（core/app-tool-policy.ts）——权限最小化
| 角色 | 可用应用工具 |
|---|---|
| Team Leader | 仅 `dispatch_task`（即使误配产品 Skill 也不给） |
| 普通执行成员 | `request_clarification`（人人可问）；若持有 to-spec/lark-doc Skill 再加 `request_spec_approval` |

`validateAppToolCalls` 在**引擎进程结束前**逐个校验 tool_call：名字不在允许清单（"老板助理派发任务，产品澄清需求，开发处理技术问题"）或参数不合 schema → 整次执行判失败；失败的工具调用（tool_end failed）会从记录中剔除，但**越权调用即使后续失败也保留错误**。

### 9.3 会话管理权（app/session-guard.ts）
`canManageSession`：收集该会话当前 activeRun owner + 所有版本匹配的澄清流/产品方案流 owner（没有则用会话 owner），要求**每一个**都判定为当前操作者（防止任务中途发起人变化）。`withSessionMutation` 提供 mutation 级互斥锁。

### 9.4 团队上下文（core/team-registry.ts `contextFor`）
注入每个 prompt 的团队名单：成员/角色/Skills、强调"名单成员是真实飞书 bot，CLI 内部子 Agent 不能冒充"、"dispatch_task 只有 CEO 助理可调、target 必须来自名单且不能是自己"。Leader 版附完整分工守则（不代替产品澄清/不代替开发实现/派发后即结束/只能报告真实工具结果）；成员版守则（完成后直接向用户交付、不要自行 dispatch）。

---

## 10. 团队协作（core/collaboration.ts + app/collaboration-service.ts）

**触发**：Leader 引擎在结果 toolCalls 里调 `dispatch_task{targetBotId, objective≤200, instruction≤2000, expectedOutput≤500}`（倒序取最后一次合法调用）。四道闸：仅 Leader、目标已注册、目标≠自己、round<maxRounds。

**派发**（dispatchId = uuid 前 12 位 hex）：
1. `inbox.register` **先落盘**再发网络请求（超时/崩溃不丢任务）；
2. 由**发送方 bot** 回复协作卡片（谁派给谁、向谁汇报、目标目录名、目标/要求/期望产出、轮次 x/y），卡片 message_id 回写；
3. 发送方 `replyMention` @ 目标 bot："协作任务：<objective>（任务编号：<dispatchId>）"。
4. 目标 bot 收到这条 @ 消息 → 走 §5-② 协作分支 → `acquire(received)` → beginTask → `buildCollaborationPrompt`（目标/要求/期望产出/"完成后直接向用户交付，不再回传给派发方"）→ 执行。
5. 成员想继续转派只能再走 dispatch_task（round+1，继承 maxRounds）；到达上限拒绝。
6. 完成即 `finish(dispatchId, true)`，结果卡直接给用户；失败 `finish(false)`。协作中**不发**"任务已完成"@通知给发起消息的发送者（senderRuntime 只用于失败/取消时定位通知对象）。

**Inbox 状态机**：`pending →(acquire) received →(beginExecution) running[+consumed] → completed/failed`；received 异常释放回 pending；重启时 received→pending、running→interrupted。容量护栏：未终结消息 ≥1000 拒绝新派发；consumed/终态记录各留最近 1000/10000 条。**每分钟恢复**：pending 重新投递（卡片已发则只补 @ 提醒，attempts 计数）；interrupted 给派发方发"执行中断，结果不确定，系统不会自动重复执行"。

**协作提示词**：`任务编号` 回显 + 期望产出 + 明确"直接向用户交付"；目标 bot 的会话若目录不同会自动切到协作要求的 workspace。

---

## 11. 需求澄清流（core/clarification.ts + card-action-handler + clarification-runner）

**发起**：执行成员引擎调 `request_clarification{title, intro, questions[1..5]{id, prompt≤300, options[2..4]{id,label}, recommendedOptionId?}}`（zod 强校验：选项/问题 id 不重复、推荐项必须存在）。应用层从 toolCalls 倒序取最后一次合法调用，创建 flow（token=32hex；同 taskId+botId 的旧 flow 被替换），任务卡转**澄清卡**并 @ 发起人。

**作答**（card-action-handler `answer_clarification`）：
- 校验链：flow 属于当前 bot → 是发起人 → 会话存在且版本匹配且非 active → 当前题 id 匹配。
- 单选直接记录 label；"自定义答案"走表单 `custom_answer`；`decisionMode=current/remaining` 表示**采纳推荐项**（当前题/剩余全部，source 标记 `agent`，回放时会注明"Agent 采用推荐方案"）。
- 未答完 → 卡片前进到下一题；全部答完 → `beginTask` + `queueMicrotask` 后台续跑：prompt = `formatClarificationAnswers`（逐题"用户回答：…"+"请基于这些答案继续完成原任务，仍有实质歧义可再次 request_clarification"）。
- 续跑仍可产生新一轮澄清（递归）或产品方案（转入 §12）；续跑失败 → 卡片转"重新整理"卡 + 文字提示，**答案已持久化不丢**。

**文字取代卡片**：发起人没点卡片而是在话题里发消息 → `formatClarificationMessage`（已确认的答案 + 正在问的问题 + 新消息 + "优先理解新消息的修正"），旧卡片更新为 superseded 样式；非发起人补充则被拒绝。

---

## 12. 产品方案链路（core/product-spec.ts ± store + app/product-spec-*）

**提交**：产品成员引擎调 `request_spec_approval`，两种互斥形态（zod discriminatedUnion）：
- `local`：`{title≤80, summary≤500, deliveryMode:'local', specPath, ticketsPath}`——路径必须是**工作区内相对路径**（禁绝对路径/反斜杠/../ 空字符），提交时 `assertProductSpecDocuments` 逐个 realpath 防符号链接越狱：specPath 必须是文件、ticketsPath 必须是含 ≥1 个 .md 的目录，缺件报"产品方案尚未完整写入工作区，不能展示"。
- `lark-doc`：`{...deliveryMode:'lark-doc', documentUrl}`——URL 必须是 `https://(*.feashe?)feishu.cn|larksuite.com` 的 `/docx/<token>` 或 `/wiki/<token>`，无端口无凭据；**Wiki 链接自动归一化**：调 wiki API 换取底层 docx token（失败提示给 bot 授节点阅读权限或提交原始 Docx 链接）。

**普通对话绝不制造审批**：`ensureProductSpecSubmission` 只认真实合法的 tool_call；同时"不能只在回复里罗列 deliveryMode/documentUrl"（prompt 明文禁止）。

**确认**（card-action `approve_product_spec`）：flow 属当前 bot → 未过期且会话版本匹配 → 是发起人 → 会话非 active（还在改就别确认）→ `beginApproval` 抢占（**评论修改进行中不允许确认**）→ `approve`。**确认即终点**：只记录状态与 approvalMessageId，后续实现由用户自行 @ 开发（与 product systemPrompt 一致）。同 taskId+botId 的旧 pending 方案在新建时自动 expired；终态历史裁剪保留最近 1000 条。

**交付模式选择**：全局默认 `defaultProductDeliveryMode` 注入 prompt；用户当次明确指定可覆盖；"不要为选择交付格式单独发起澄清"。

---

## 13. 飞书文档评论修改（product-comment-scheduler/runner + document-subscription）

仅 `lark-drive` Skill 的 bot（当前=product）启用：
1. 启动时订阅文档评论事件；每条评论先过 scheduler 四道闸：`mentionedBot`（评论里明确 @ 了 bot）、能按 `fileToken` 找到**该 bot 的 pending 方案**、会话版本匹配、评论者是方案发起人。eventId 级去重（内存 1000）+ `reserveComment` 引用计数（同一方案并发评论期间禁止点确认）。
2. 按方案会话**串行排队**执行：先给评论加"处理中"表情 → `runProductDocumentComment`：
   - 复核五条件（pending/发起人/会话 idle/有 CLI 会话/版本匹配）；
   - prompt（`documentCommentPrompt`）：文档 URL/类型/评论 id/回复 id + "用 lark-drive 读取该条评论、完整回复和正文位置，再用 lark-doc 精确修改原文档；最终回答只写一段给评论者看的修改说明（会写回评论）；不要调评论解决接口、不要调 request_spec_approval（原确认卡继续有效）"；
   - 执行 ID `comment:<bot>:<fileToken>:<commentId>:<replyId>:<eventId>`（同一条评论/回复天然幂等）；
   - 结果经投递箱以 `comment` 操作回评。
3. 失败：撤表情、去重标记回滚（可重试）、给评论回"暂时没有处理完成：<原因>"。

---

## 14. 结果投递可靠性（app/delivery-outbox.ts + result-delivery.ts + notification-service.ts）

DeliveryOutbox = 持久化有序操作队列，四种操作：`card`(更新卡) / `text`(文字) / `mention`(@ 文字) / `comment`(回评)。

- **完成与投递解耦**：引擎结果先落 TaskExecutionStore；投递失败只影响队列，重试**永远不会再次调引擎**。
- 幂等：每个操作键派生 32 位 uuid，飞书端去重；`submit` 同 ID 不重复入队。
- 顺序与依赖：单队列按 cursor 顺序推进，每步 3 次重试（100ms 递增）；`dependsOn` 保证"@ 通知"排在"结果卡更新"之后；卡片更新失败有**文字回退**（"结果已保存，系统会自动补发；请勿仅因卡片未更新而重复执行任务"）。
- **卡片终态重解析**（result-delivery.ts）：投递时若带 flow 引用，按**当前**流状态重新生成卡片内容——已答完的澄清卡渲染成 continuing、已审批方案渲染成 approved、失效渲染成 expired——"超时的补发可能已被看到，绝不在重试时覆盖用户后来的作答/确认"。
- 启动+每分钟 `recover()` 并发 4 路补发；通知类（sendResultNotification）也走同一队列（content 哈希做 ID）。

---

## 15. CLI 适配层（src/cli/）

### 15.1 四引擎差异表

| | claude | codex | cursor | zcode |
|---|---|---|---|---|
| 命令 | `claude` | `codex` | `$CURSOR_CLI_COMMAND || agent` | 官方桌面自带 CLI |
| 输出协议 | stream-json + `--verbose` | app-server / jsonl（proto experiments） | stream-json | ndjson |
| 续会话 | `--resume <id>` | resume 协议 | `--resume`（不支持 /resume 列表） | `--resume`；**不支持 /resume、/compact** |
| MCP 注入 | `--mcp-config`（每次命令行注入，工具名 `mcp__agent_os__*`） | `-c mcp_servers.agent_os.*` 两条 | 写入用户级 `~/.cursor/mcp.json`（`--tools=${env:AGENT_OS_ALLOWED_TOOLS}` 环境变量展开） | 写入 `~/.zcode/cli/config.json` 的 `mcp.servers`（入口按 spawn 时环境变量读 allowlist）；工具名同为 `mcp__agent_os__*` |
| 附件 | prompt 路径 | 额外 `-i` 原生多模态 | prompt 路径 | prompt 路径 |
| /compact | 原生 `/compact` 指令 | 原生默认策略 | — | — |
| 特殊 | 工具中文名映射（Bash=运行命令…） | | 进程内 per-instance 业务调用去重状态，**不走共享单例** | 同左；usage 只认本轮、projection.totalTokenCount 是会话累计不能冒充本轮 |

### 15.2 runCli（runner.ts）
- Windows：prompt 走 stdin、spawn 前解析 .cmd shim 直连 node（JSON 不过 cmd.exe）、abort 用 taskkill 杀进程树；其他平台 prompt 直接做参数。
- 事件流解析成 CliEvent；`session` 事件捕获引擎会话 id（回写 Agent OS 会话）；`tool_call` 记录业务调用（失败 tool_end 剔除）；`result` 事件取答案+统计。
- 结束判定顺序：超时 > abort > 引擎 error > **越权工具错误** > 非零退出（带 stderr）> 无结果；最后 `validateAppToolCalls` 全量复核后 resolve。

---

## 16. MCP 应用工具服务器（src/mcp/）

`app-tools-server`（claude/codex/cursor 共用）与 `zcode-app-tools-server`：启动参数 `--tools=<allowlist>`（**缺省即零授权**），把三个工具以 MCP stdio 暴露给引擎：
- `request_clarification`：工具返回文案明确"已接收 N 个问题，Agent OS 将在本轮结束后生成交互卡片。此响应不代表卡片已发送；请结束本轮并等待用户回答"——**引擎不得自行宣称已发卡**；
- `request_spec_approval`：交付模式规则（local 必须文件真实存在 / lark-doc 只接受 lark-doc 工具返回的 document.url、文档必须含产品说明+Tickets 章节、不双份维护）；
- `dispatch_task`：目标/目标/要求/期望产出字段约束。
真实语义由应用层在**引擎结束后**解析 toolCalls 兑现（§5-⑨），工具本身只做接收确认。

---

## 17. 模型选择（core/model-selection.ts）

配置可按 CLI 声明 `modelOverrides{model, reasoningEffort}`（zod 校验、空字符拒绝）。解析优先级 `topic > role > native-default`，并提供指纹（role 配置指纹 / 选择指纹）与"原生会话模型绑定核验→ keep/recreate/blocked"决策基建（`compareExecutionSelection`：现有原生会话无可核验绑定时宁可重建）。当前运行链路上各引擎实际模型主要由其**用户级配置**生效（.env.example 明示；cursor 走 `CURSOR_CLI_MODEL`），model-selection 是校验与决策基础设施（有独立测试），为话题级覆盖预留。

---

## 18. 飞书集成层（src/im/）

- `startBot`：每 bot 一个长连接客户端；`getIdentity` 拉 bot open_id/名称（协作身份校验用）。
- Bot 能力面：reply / replyCard / replyMention（post 富文本 @）/ updateCard / subscribeToDocumentComments / replyToDocumentComment / setDocumentCommentWorking(处理中表情) / downloadResource（附件落盘，按 mime 推断扩展名）。
- 文本限额：正文 3000、@ 消息 1200、评论 1000（超长 `splitLongText` 分段、`fitFeishuText` 截断）；`answerNeedsContinuation/answerContinuation` 识别引擎标记的"续文"答案。
- 卡片（card.ts，12 个构建器）：任务卡（running/success/failed/cancelled + 进度 + 答案折叠 + 停止按钮）、澄清卡（单题选项 + 自定义输入 + 采纳推荐）、澄清进行中/重试/被取代卡、恢复会话卡、会话通知卡、协作卡、团队卡、产品审批/已确认/已失效卡；`ThrottledCardUpdater` 节流更新。
- 消息解析：@ 占位符还原；image/file/post 内嵌图片资源提取。

---

## 19. 数据存储清单（data/）

**在用（6 个，均原子写：tmp+rename；多数带回滚与容量裁剪）**：

| 文件 | 内容 | 归属 |
|---|---|---|
| sessions.json | 全部会话（含迁移/降级逻辑） | JsonSessionStore |
| task-executions.json | 执行记录（running 重启→interrupted；终态留 1000） | TaskExecutionStore |
| collaboration-inbox.json | 协作派发（pending/received/running/终态 + consumed 10000） | CollaborationInbox |
| clarification-flows.json | 澄清流（题面+已答） | ClarificationFlowStore |
| product-spec-flows.json | 产品方案流（pending/approved/expired） | JsonProductSpecFlowStore |
| result-deliveries.json | 投递队列（cursor+fallback） | DeliveryOutbox |
| downloads/ | 消息附件落盘 | — |

**已清理（2026-09-27，经用户确认后删除）**：旧"workflow 流水线"架构的全部遗留数据——workflows.json（813KB）及 3 个 .bak、specs.json（19 条旧方案全文）及 2 个 .bak、approvals.json、collab-rounds.json、topics.json、user-identities.json、questionnaires/、approval/、mcp/、.default-cli-migration.json。删除前逐项 grep 确认 src 零引用；共约 1.4MB。data/ 现仅存 sessions.json、product-spec-flows.json 与 downloads/。

---

## 20. 测试与运行

- `pnpm start`（tsx watch，含 .env 与 config/*.json 变更重启）/ `start:once`；`pnpm test`（node:test，11 个文件）：协作去重与 origin、会话事务、可靠性回归、模型选择、zcode/cursor 适配器、附件、app-tool-policy、workflow-reliability。
- 探针：`probe`（飞书连通）、`probe:cli`（引擎冒烟）、`probe:tool`（应用工具）。
- CLAUDE.md 错题本：pnpm v11 需在 pnpm-workspace.yaml `allowBuilds: {esbuild: true}` 放行构建脚本。

---

## 21. 设计原则速查（贯穿全码库）

1. **持久化先于网络**：协作先入 inbox 再发卡片；结果先落执行库再投递。
2. **完成与投递解耦、执行恰好一次**：completed 可重试投递、interrupted 绝不自动重放。
3. **权限最小化 + 双重校验**：allowlist 注入 MCP（缺省零授权）+ 引擎结束再全量复核 tool_calls。
4. **交互只认真实工具调用**：普通文字声明"已发卡/已交付"一律无效。
5. **确认即终点**：方案审批后流程结束，不做自动接力。
6. **单一权威产物**：本地与云文档二选一，禁止双份同步。
7. **会话乐观锁**：目录/上下文切换 version+1，进行中操作用 expectedVersion 失效。
8. **卡片终态重解析**：补发不覆盖用户后续操作。
9. **unionId 优先的跨应用身份**；owner 随任务继承而非随消息漂移。
10. **降级可运行**：评论订阅失败、卡片更新失败（文字回退）、通知失败（队列保留）都不阻断主流程。

---

## 附：术语对照

| 术语 | 含义 |
|---|---|
| 话题（thread） | 飞书群内一个讨论串；Agent OS 的会话/任务粒度 |
| Session | Agent OS 会话（bot×chat×话题 唯一），持有引擎原生会话 id |
| CLI 会话 | 引擎自己的会话（claude/codex 的 session id） |
| dispatchId / 任务编号 | 一次协作派发的 12 位 hex 标识 |
| flow（澄清/方案） | 一次人机交互流程实例，token 寻址 |
| App Tools | Agent OS 注入引擎的三个业务工具（澄清/方案/派发） |
| Team Leader | 唯一有权 dispatch_task 的成员 |
