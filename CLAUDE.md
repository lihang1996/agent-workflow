# agent-os

把飞书变成 AI 编程 CLI（Claude Code / Codex / Cursor Agent）的指挥台。
一个话题 = 一个任务；bot 之间可互相 @ 协作；cron 定时巡检。

## 运行

pnpm dev（tsx watch）/ pnpm start / pnpm build / pnpm test

## 约定

- ESM only，Node 22+，pnpm
- 凭证只放 .env（已 gitignore），绝不硬编码、绝不提交
- `config/bots.json` 不被 TypeScript/运行时读取；Bot 只认 `.env` 的 `BOT_*`。不要把其中的 `developer` / `systemPrompt` / `reviewBy` 当配置源。独立 `BOT_RUNTIME_AUDITOR_*` / `BOT_FINAL_REVIEWER_*` 可选，缺了不阻断流水线。`pm_accept` 是另开需求，不要插入 `PIPELINE_STEPS`。

## 错题本

> 踩坑后追加一行：现象 → 原因 → 正确做法。给未来的 AI 和人看。

- Codex 双引擎依赖本机 `codex` CLI（不是 ChatGPT 桌面 App）；`command not found` → `npm i -g @openai/codex` 并保证跑 `pnpm start` 的终端能 `which codex`，再用 `/engine codex`。
- Cursor 第三引擎依赖本机 `agent` CLI（`curl https://cursor.com/install -fsS | bash`，不是桌面 App 的 `cursor` 打开文件命令）；`command not found` → 安装后保证跑 `pnpm start` 的终端能 `which agent`，配置 `CURSOR_API_KEY` 或先 `agent login`。默认引擎是 cursor，所有角色固定 `--model cursor-grok-4.6-high`；`CURSOR_MODEL=auto` 以及非 cursor-grok-4.6-high 的值会被忽略。`--force` 才能无头落盘，但它是 YOLO，没有 Claude PreToolUse；高风险动作只靠提示词和飞书 `/approval`。不传 `--auto-review`。`DEFAULT_CLI` 变更时启动会把空闲话题/会话对齐到新默认；之后 `/engine` 的选择会保留。工具调用上限默认 500（`CLI_MAX_TOOL_COUNT`）；循环检测对齐 super-agent：连续同目标（默认 15，`CLI_TOOL_LOOP_STREAK`）、窗口同参重复、同工具乒乓（警告 10 / 熔断 20）。Read↔Edit 交错不算乒乓。空闲 20 分钟无输出也会当卡住杀掉。
- Cursor 无头改文件必须 `--force`，否则只提案不落盘；只读用 `--mode ask` + `--sandbox enabled`。仅输入分析必须同时改 spawn cwd 和 `--workspace` 到仓库外空隔离目录，只改 `--workspace` 拦不住相对路径 Bash。独立 `/review` 必须 `executionPolicy: 'read-only'`，否则会走 `--force`。流水线质检是 `evidence-write` 不是整步 `read-only`：Claude 用路径级 `Write/Edit(evidenceRoot/**)`；Cursor 无头没有路径级写权限，`--force` 仍能改 `src/`，生产质检优先 Claude。不要开 `--stream-partial-output`。官方终态 `result` 会把多段 assistant 文本无换行粘在一起，适配器必须自行缓存各段消息再拼，否则行首 `[RESULT:done]` / `[APPROVED]` 会失效。普通/已审批任务默认 `--sandbox disabled` 以便本机网络。
- PM Spec 校验与控制器对 `[RISK_WAIVER]` 处理不一致：本地脚本 `validate-spec-markdown.mjs` 原先在遇到无 JSON 的字面量时报错（Claude/Codex/Cursor 都受影响），而控制器 `parseCanonicalSpecWaivers` 会静默忽略（认为是 Skill 示例/说明被抄进正文）。现已对齐：本地脚本也传 `allowBareMentions: true`，让三引擎 PM 步骤都能容忍提及该标记但不构成真实授权条款。真条款仍必须是紧跟标记的完整 JSON（6 个必需字段、带时区 ISO 到期时间），且只能引用人工确认前已存在于 canonical Spec 的同 ID waiver。Claude/Codex/Cursor 各步骤都是 CLI 退出后才校验 RESULT/GATE_RESULT/Spec：格式问题会在同一会话纠偏一次（`CLI_FORMAT_REPAIR_ATTEMPTS`，默认 1），不要 `/workflow retry` 重做探索。开放 P0、测试失败、fingerprint 漂移仍失败或退回，不会自动续写。
- Codex `exec` 无审批弹窗：未预授权 MCP 会被记成「问卷被取消」。`propose_questions`/`get_questionnaire` 必须走 `mcp_servers.agent-os-ask.tools.*.approval_mode=approve`；`record_answers` 保持 prompt，答案只认飞书卡片。
- Codex 问卷 MCP 成功但仍报「未创建结构化问卷」：Codex 用 `-c mcp_servers.*.env` 覆盖 MCP 子进程环境，只写 `AGENT_OS_ROOT` 时 `AGENT_OS_WORKFLOW_ID` 到不了 ask-server，问卷落成无作用域记录，`latestAwaitingForWorkflow` 看不见。必须把任务上下文一并注入 `-c`；PM 输出 `/form <id>` 时控制器按 ID 找回并绑定，不能只靠 workflowId 精确匹配。
- Codex 流式里 `item.started`/`item.completed` 成对出现 → 工具进度只在 started 上报；最终答案等 `turn.completed`，避免中间旁白当结果、工具事件翻倍。
- `codex exec resume` 报 `unexpected argument '--sandbox'` → `--sandbox` 只能挂在 `exec` 上；普通/已审批任务现在默认不传 `--sandbox`，改用 permission profile。
- Codex 本机 listen/Postgres/浏览器 EPERM，而 Claude 同任务能跑：传了 `--sandbox workspace-write` 会走旧沙箱，`allow_local_binding` 不会生效。对齐 Claude dontAsk：去掉 `--sandbox`，用 `default_permissions=":danger-full-access"`，问卷上下文仍要写入 `mcp_servers.agent-os-ask.env`。
- 多 Bot 群聊必须 @ 到对应机器人才会响应；每个飞书应用都要单独开「长连接」收事件，并拉进同一个群。
- 一个话题一个项目：用 `/workdir <路径>` 绑定话题目录（全角色共享）；优先级为 话题目录 > `BOT_*_WORKDIR` > `CLAUDE_WORKDIR`/`CODEX_WORKDIR`/`CURSOR_WORKDIR` > cwd。
- 会话管理：`/reset` 清 CLI 上下文，`/close` 关闭，`/reopen` 恢复，`/clean` 删除已关闭记录；换目录会清话题下各角色上下文。
- 同话题交接：`/handoff <角色> <任务>` 进程内交给目标 Bot 执行（不依赖飞书 bot 互 @），目标忙时拒绝。
- 协作轮次：完整交付流水线内可走 reviewer→dev 自动回传；独立 `/review <任务>` 只读、不自动改代码。评审只有独立一行 `[APPROVED]` 才算通过；上限由 `COLLAB_MAX_ROUNDS`（默认 2）控制。
- `tsx watch` 热重启会掐断进行中的 CLI → 卡片停在「运行中」；需 SIGTERM 收尾 + `data/active-runs.json` 启动时把遗留卡片标失败。长任务可用 `pnpm start:once`。
- 停机收尾：成功态不可被盖红；发卡后同步落盘；停机前尚未启动的 onSuccess 不再启动，已经开始的工作流续跑纳入宽限等待；协作轮次落 `data/collab-rounds.json`；CLI 用进程组杀掉孙子进程。
- CEO 团队流水线：`/pipeline <目标>` 仅 CEO 可启；固定为 PM→架构→开发→评审→QA→运行时审计→最终审查→汇总，`PIPELINE_STEPS` 不能裁剪或重排。
- CEO 统一入口：`@CEO助手` 发自然语言目标（非斜杠命令）会直接启动流水线；专家 Bot 的 `/help` 引导先找 CEO。
- 运行主线在 `src/runtime/`（消息路由 / CLI 任务 / 协作 / 流水线）；`src/index.ts` 只做启动与信号。
- 结构化提问 MCP：`propose_questions` → `record_answers`；Claude 用 `--mcp-config`，Codex 用 `-c mcp_servers.*`，Cursor 用隔离 overlay + `--add-dir` / `--approve-mcps`；server 用绝对路径 `--import …/tsx/dist/loader.mjs` + `AGENT_OS_ROOT`。
- 产品闭环：PM 提问卡 → Spec 确认 → 同一份飞书云文档评审/修订 → 架构、开发、代码评审、QA；人工等待节点和云文档评论均可跨重启恢复。
- 主动式 Agent：`/schedule` 持久化普通任务、团队流水线和只读日志巡检；高风险动作必须通过绑定原卡片和负责人的审批门，真实终态再回写定时任务。
- 飞书卡片 form input `max_length` 默认上限 1000，设 4000 会 400（230099/11310）。
- 飞书创建云文档 title 不能含换行；流水线用多行 goal 当 Spec 标题时会 1770001 invalid param，需 `sanitizeDocumentTitle`。
- 飞书 `client_token` 必须是 UUID 形态；`sha256().digest('hex')` 的 64 位会在写入云文档块时 1770001。
- 飞书 Markdown→块后写入嵌套块前，必须删掉 `table.property.merge_info`（只读）；清错成 `table.merge_info` 顶层时，带表格 Spec 会 1770001，文档空壳已建、状态停在 confirmed，旧卡因 updatedAt 变化报「已过期」→ 死循环。失败时要刷新卡片带新 specVersion。
- Claude 普通任务用 `--permission-mode dontAsk`：未在 `permissions.allow` 的 Write/Bash 会被直接拒绝（不会弹窗），开发步骤会误报「只读阻塞」。runtime settings 需预授权工作区读写与常规构建；高风险仍走 PreToolUse + `/approval`。已审批 Claude 也必须加载同一 hook，并只放行原请求命中的风险类别。Codex 要对齐同一能力：不要传 `--sandbox`（会强制旧沙箱、丢掉本机 bind），默认 `default_permissions=":danger-full-access"`；高风险仍靠 `--ask-for-approval untrusted`。`CODEX_SANDBOX`/`CODEX_APPROVED_SANDBOX` 只在需要收紧时才设 `workspace-write`/`read-only`。
- 流水线 `[RESULT:blocked]` 发卡成功后不要再发同文案文本，否则飞书会出现「阻塞卡 + 文本」双提示；文本只做发卡失败兜底。
- 单次 CLI 不要只靠短墙钟超时：持续编码可能数小时。现用「绝对上限（默认 6h，`CLI_TIMEOUT_MS`）+ 空闲超时（默认 20 分钟无输出，`CLI_IDLE_TIMEOUT_MS`，有活动续命）」。更长交付应拆多轮（做完一阶段输出 [RESULT:done]，再 @Bot 继续），并注意上下文压缩。Cursor 开发步骤曾因 301 次工具调用被 `CLI_MAX_TOOL_COUNT=300` 杀掉：那是在换文件/跑测试，不是死循环。上限默认 500。循环检测对齐 super-agent：连续同目标 15 次熔断；窗口同参重复 / 同工具乒乓警告 10、熔断 20；Read↔Edit 不算乒乓。
- 流水线步骤语义结果：非 PM 步骤必须显式输出 `[RESULT:done|blocked|failed]`，缺标记也 fail closed；CLI 退出码成功≠业务完成。blocked 暂停为 `awaiting_step_unblock`，勿继续评审。目标路径需在 `AGENT_OS_ALLOWED_ROOTS`；流水线不再自动绑定目录，用户须显式 `/workdir <绝对路径>`。
- 飞书卡片 JSON 2.0 form 提交按钮：`form_action_type: "submit"` 放在按钮顶层（实战验证必须如此）。官方文档写的 `behaviors` 数组加 `form_action` 方式实际 API 报 "unknown behavior type" 400；`action_type: "form_submit"` 是 deprecated 且单独使用会 300123。
- 问卷卡 `select_static` 不能写 `label`（飞书 230099/200621 unknown property）；题干用独立 markdown，`label` 只给 `input`。发卡失败时文本兜底 `/form <id>`，不要把已暂停的 `awaiting_questions` 工作流打成失败。
- 业务控制（停任务 / Spec / 问卷 / 定时任务）用 `canControlOwnedResource`（发起人 ∪ OWNER ∪ ALLOWED）；高风险审批仍用 `assertOwnedBy`（只认当前 OWNER）。停任务若只比 `operator === owner`，白名单用户会看到「只有任务发起人可以停止它」。
- 阻塞卡必须带 `blockVersion`（= workflow.updatedAt），handler 校验 stepId + blockVersion，缺字段直接拒绝（不放行旧卡）。终止按钮也要带相同版本信息。
- RESULT 标记只在流水线非 PM 步骤解析（`startCliTask` 的 `resultProtocol` 参数）；PM 产出 Spec 正文，普通聊天/handoff/定时/巡检也不解析。正则要求标记在行首。
- 流水线目标不自动绑定目录——完全交给用户显式 `/workdir <绝对路径>`，避免从自然语言误猜路径。
- 阻塞卡发送失败时发文本兜底，提示用 `/workflow retry <id>` 重新发送阻塞卡。
- 卡片重试按钮（retry_blocked_step）用 fire-and-forget，toast 用 info 级别；异步失败通过 `onError` 回调回复飞书消息通知用户。
- `resumeBlockedWorkflowStep` 先原子认领（updateIfStatus）再切目录，防止并发重试两个按钮都通过前置检查再改目录。
- 多 Bot 场景下同一用户的 Open ID 在不同飞书应用中不同；`assertOwnedBy` 用全局 `OWNER_OPEN_ID`，跨 Bot 审批会拒绝同一真实用户。本地单 Bot 场景无此问题；多 Bot 需用 union_id 或 per-Bot 负责人配置。
- 设计门禁（架构师）只设计不实现：发现 P0/P1 并给出实现点+验证点后，GATE_RESULT finding 标记 `status: "planned"` 可随 design pass 通过；`"open"` 才阻断。开发门禁必须用相同 id 闭环为 `"resolved"`/`"waived"`，未闭环报「实现门禁必须闭环设计门禁登记的 P0/P1」。
- 架构师把 planned FIND 写成 `[RESULT:failed]` → 流水线停在技术方案而不是进入开发。原因：通用 RESULT 说明把「发现需改代码」一律标 failed，且门禁提示曾写「pass 不得含 planned P0/P1」。正确做法：架构师 planned 必须 `[RESULT:done]`；控制器在设计门禁已通过时把误标的 failed 纠偏为 done。
- 评审未通过写成 `[RESULT:failed]` → 协作 `onSuccess` 被跳过，流水线直接停而不是回传开发。未通过必须 `[RESULT:done]` 且不要 `[APPROVED]`；控制器对评审/汇总误标的 failed 按完成继续。
- CEO 汇总把残余 P2 写成 `[RESULT:failed]` → 前面门禁已过仍整条失败。汇总只允许 `[RESULT:done]`（缺上下文才 blocked）。
- findings 的状态字段名必须是 `status`（open/planned/resolved/waived），agent 别用 change-plan 里的 `disposition`；已闭环的旧问题标 `resolved`，不要当开放 P1。`GateFindingSchema` 有 disposition→status 兼容层，但未命中的值默认 open 会阻断（不静默放行）。
- findings 的 `category`/`confidence`/`exploitability` 必须使用控制器枚举；Skill 本地校验（`skills/_shared/finding-fields.mjs`）与控制器共用同一套合法值与常见近义别名。未知自造标签必须在本地脚本就 fail，不能等控制器再拒。
- 普通产品 Spec 不再强制走飞书云文档：确认卡提供「确认并直接开始技术交付」（`confirm_spec_start`）直接批准+标记 canonical+启动流水线；「确认方案」仍走云文档评审路径（confirm→publish→approve）。含 `[RISK_WAIVER]` 的 Spec 必须发布完整云文档，直接开始入口与后端调用都会被阻断，最终批准只认当前 `OWNER_OPEN_ID`（未配置时认需求发起人）。按钮回调里 `confirmSpecAndStartDelivery` 与 `approveSpecReview` 一样会回滚 canonical 与工作流状态。
- 同一真实用户跨 Bot 直聊被「当前用户没有操作权限」拒：把每个飞书应用里该用户的 open_id 都加进 `AGENT_OS_ALLOWED_OPEN_IDS`；只加 CEO 应用的白名单拦不住架构师/dev/qa 应用。
- 门禁 GATE_RESULT：不要用「单行且 `}` 后必须结束」的死正则——模型常在 JSON 后粘上 DSML/工具调用垃圾，或把超长 findings 塞进同一行导致截断，看起来像「缺少 GATE_RESULT」。应括号平衡提取 JSON；sha256 以证据目录文件重算；review-report 的 findings 以落盘 artifact 为准；答案完全缺标记时可从 `change-review.json` 等主 artifact 恢复。
- 评审/QA 报「与 implementation/change-review 快照不一致」是正确阻断：代码树在上游门禁之后又改过（如 review 轮次里修 bug、写了 round2 manifest）。应退回 `dev`/`review` 重建证据，不要卡在同一步死重试；`/workflow retry` 对这类失败文案会自动 rewind。
- 运行时审计/QA 发现 P0/P1 要改代码时，不要用 `[RESULT:blocked]`（那是目录/环境卡）；用 `[RESULT:failed]` + FIND 摘要。系统记入 `quality_fix_request` 并退回 **开发**（方案级才退回架构）；`/workflow retry` 对已误进 `awaiting_step_unblock` 的代码缺陷也会自动移交。
- waived finding 常只写 `waiverId`、完整条款在顶层 `waivers[]`：归一化仍按 waiverId/FIND-xxx→WAIVER-xxx 补全并保持 artifact 两侧一致；但它只有在人工确认前已作为同 ID `[RISK_WAIVER]` 写入 canonical Spec 时才有效。`approvedAt`/`approvalEvidence` 由控制器按 Spec ID/version/hash 重建，Agent 自填字段或 URL 一律不能构成人工授权。
- 流水线收尾校验证据时只认各 gate **最新一次** pass：同路径证据（如 `implementation-manifest-round2.json`）会被后续修复轮次改写，拿历史 attempt 的旧 sha256 对当前磁盘会误报 hash 不匹配。
- canonical Spec 必须有以需求条目开头的稳定 ID（如 `### RQ-001 登录`）；设计、实现、QA、review 和 final artifact 的 `requirementIds` 必须与 canonical 集合精确一致，不能靠正文里顺带提到 `RQ-001` 冒充覆盖。控制器在 workflow evidence root 固化完整 `canonical-spec.md`，每步提示只传路径/hash，执行前后都重验文件内容。
- `canonical-spec.md` 与 `evidence-chain.json` 是 controller-owned artifact，Agent 不能在 GATE_RESULT 中声明。终审必须提交 `evidenceChain: { path, sha256 }` 且精确绑定当前工作流的 v2 chain；伪造 hash、跨工作流路径、symlink 或修改控制器文件都阻断。
- QA 的 `buildHash` 若不同于源码 `projectFingerprint`，必须同时提交项目内 `buildArtifact: { path, sha256 }`；控制器使用与 `scripts/hash-path.mjs` 相同的目录/文件哈希算法，在每个下游 gate 和最终完成时重新校验，避免源码没变但 dist 被替换。
- gate check 时间必须属于当前步骤 attempt，命令必须是实际执行的非占位命令，必需检查不能为空；同 ID finding 不得在后续门禁偷偷降级，planned P0/P1 必须以证据闭环，单 gate 最多 8 次 attempt，避免自动返工死循环。
- CLI 成功生命周期顺序固定为：语义校验 → 原子提交工作流状态 → 终态卡 → 持久化终态快照 → 释放当前会话 → 启动下一步。返工、复审和正常推进都不得在 `onSuccess` 内直接启动同一/下一 CLI，否则旧任务 finally 可能覆盖新会话的 active 状态。
- 启动恢复逐工作流隔离：坏 Spec、关联损坏或缺稳定 ID 的旧数据只将对应工作流置 failed，不能抛出并阻断其他 ready 工作流。Node 22 test runner 偶发 IPC clone 错误时用 `--experimental-test-isolation=none` 单进程执行；项目 `pnpm test` 已固定该模式。
- 同一 `projectRoot` 同时只允许一条进入技术阶段的 gated workflow；Spec canonical 切换与技术租约激活必须原子化。跨话题并发确认时只允许一个成功，另一条保留在人工节点并明确报告占用工作流 ID，防止代码树和证据链交叉污染。
- Codex 长任务时 API 可能临时断线并自动重连（"Reconnecting... N/5"）；CodexAdapter 必须过滤可恢复的重连消息（返回空事件数组），让 Codex CLI 内置重连机制完成其工作，不能误当成终态失败。
- `GateCheckSchema.command` 每个数组元素原限制 2000 字符，Codex/Claude 常用 `/bin/zsh -lc "CHECK_START=... node -e '...'"` 内联脚本动辄 3000-5000 字符导致流水线中断。现提至 10000 并在 `normalizeCheckInput` 自动截断兜底；Skill 提示词已引导 agent 把长脚本写入临时文件。`evidence`/`impact` 等字段同步从 2000 提至 10000。
- Ctrl+C / 关终端后 `data/.agent-os.lock` 残留、飞书长连接还在：`process.on('exit')` 里调了异步 `rm()` 等于没删，且没关 `WSClient`、没处理 SIGHUP。正确做法：同步 unlink 锁、启动时回收死 PID、SIGINT/SIGTERM/SIGHUP 先 `wsClient.close({ force: true })` 再收尾任务。不要监听 TTY `stdin` 的 `end`，部分 IDE 终端误发 EOF 会把整站掐掉。
- 飞书点「停止任务」卡片变已取消，但 `/workflow retry` 报 executing：取消只停了 CLI，工作流故意留在 executing（避免当质量失败），retry 却只认 failed/阻塞。正确做法：停止后标 `paused`，不进自动恢复；卡片写明需 `/workflow retry <id>` 才从当前步骤继续。重启 crash 的 executing 仍自动续跑。同项目新工作流激活时会自动终止旧的 `paused` 工作流并释放租约，无需手动 `/workflow abort`。
- Spec 待确认卡出现后看起来像「已经继续」：PM 交卷会自动发卡并把 Spec 正文拆成多条消息，架构并不会启动。点「确认并直接开始技术交付」若报「已有技术交付工作流」，是同一 `projectRoot` 上还有 `paused`/`executing` 流水线占租约（停止任务不会释放占用）。`failWorkflow` 必须包含 `paused`；用 `/workflow abort <占用ID>` 终止后再点确认。不要在同一话题再 @CEO 发自然语言（会再开一条流水线）。
- Cursor 模型验证只接受精确的 `cursor-grok-4.6-high`；配置 `CURSOR_MODEL=auto` 或其它模型名（如 `cursor-grok-4.6-medium`）会被忽略并回退到默认，避免各角色悄悄换成非预期模型。
- Cursor MCP overlay 目录身份不含 `MESSAGE_ID`（只含 `WORKFLOW_ID` 等），同一 workflow 的不同消息会复用同一 overlay 目录并覆盖 `mcp.json` 的 env。虽然 env 会在启动时传入子进程，但若 Cursor `--resume` 会重新读取 overlay 配置（类似 MCP 热重载），可能造成上下文串线。实测验证：Cursor 启动后不会重新扫描 `--add-dir` 的 MCP 配置，同一 workflow 并发消息暂无问题。
- Cursor 权限策略与 Codex P0 修复不一致：Codex standard 模式默认 `workspace-write`（fail-closed），而 Cursor 仍是 `--force --sandbox disabled`（fail-open，最宽松）。Cursor 没有 PreToolUse hook 拦截高风险动作，完全依赖提示词中的执行边界说明与飞书 `/approval` 事后兜底。质检 `evidence-write` 同样如此：Claude 能按证据目录放行写入，Cursor 做不到 OS 级禁写产品代码。生产环境与生产质检优先使用 Claude 引擎。
