# 知识消费与开发启动契约

2026-10-01。实现范围：本地 source/dev 消费、受保护启动身份、持久开发授权、真实消息与卡片入口、实际 OS fixture 复验。

## 当前可用性

本地 Node 引擎 fixture 已走通真实消息与“开始开发”卡片入口。正式 CLI 仍需可信 host 配置和有效证明，缺失时拒绝执行。本轮未把 fixture 证明注册到生产，也未发送真实飞书消息。

真实 Codex canary 在隔离 CODEX_HOME 中因缺少登录凭据返回 401，未完成模型工具动作。官方 ZCode 的付费模型请求遇到 429，CLI 列表未提供 Start Plan 模型。不能用本地 OS 成功替代真实模型、认证与三种会话模式验收。

## 产品上下文

可信 host 在调用模型前预取知识，绑定任务、会话及版本、Bot、操作者、角色、系统与 workspace。上下文只是只读事实，不能授予执行权限。每个对象引用包含 revision 与 snapshot；PRD 批准和开发启动前重新验证证明及当前角色。旧会话、漂移、撤权、超时或 host 重启后的旧 grant 都会拒绝。

单 grant 上限 128 KiB，多系统合计 512 KiB；限量、时效与身份绑定同时生效。配置了 kbSystems 但没有可信知识 host 时拒绝生成缺乏依据的 PRD。新项目可以使用空系统列表。

正式知识 worker 的配置、Node、入口及依赖树必须位于固定受保护控制目录，归 root 且不可由普通用户写入；入口另有内容摘要核验。启动环境只传必要配置，不复制个人认证或项目 `.env`。依赖树归属检查不等于每个依赖文件都有 SHA 校验。

## 启动描述与能力证明

execution-descriptor/1 绑定实际二进制与 payload 摘要、命令及模式、目的、读写根、OS/sandbox-exec、配置摘要、模型和推理强度、认证组装约定、受众。prepare 和 launch 两次检查当前身份。模式包括 fresh/resume/compact/probe/session-list。

正式能力键由当前描述、二进制与根身份共同派生。登记器验证签名控制器收据、原始事件独立重放、固定探测动作、时效、nonce、CAS 和撤销。普通可写目录里的 unsigned/passed 标记不能解锁生产。

local-test 控制器只运行固定合成 OS 命令，证明读取、写入、后代边界和进程退出；它不会生成 production 能力。

## “开始开发”协议

卡片入口核对操作者、Bot、任务、当前会话、workspace、PRD/架构批准状态、最新知识、授权期限和文件摘要。传给开发引擎的是重新读取且校验的 PRD、tickets 与架构正文，输入总量有限制。

开发授权先持久化，再占用任务。状态为 issued → reserved → launching → running → terminal。确定未启动的失败可以在同一授权下重试，最多 3 次；可能已经启动、重启时 launching/running 或结果不明时转 launch_unknown，不自动再次执行。重复卡片操作不会重复启动。

启动前再次核对角色、知识和文件。onSpawn/onNotSpawned 区分实际启动；异常清理等待进程组退出。完成结果写入任务并由持久 outbox 通知原线程。撤销会取消活动执行，未完成清理的执行保持结果不明。

状态仍按单个 host 写入设计；当前固定描述配置对应一个身份，多引擎部署需要分别配置可信身份。

## ZCode 模型绑定

已实现非敏感运行元数据的模型、provider、会话、run、配置、payload、cwd、模式与时效校验。仅有收据不解锁正式执行：fresh/resume/recreate 的真实 bootstrap 尚未验收，显式 ZCode 模型选择保持 blocked，不能声称完成 A04 的真实运行闭环。

## 验收命令

```sh
pnpm typecheck
pnpm typecheck:probe
pnpm build
pnpm test
AO_DIRECT_OS=1 node --import tsx --test tests/coding-start-entry.test.ts
node --import tsx --test --test-name-pattern 'preflight fixture probe|real sandbox-exec boundary smoke' tests/isolation.test.ts
```

完整测试中的 OS 嵌套沙箱用例单独运行，报告分别记账。真实模型 canary 的失败日志保留，不算通过；正式信任根、认证 bootstrap、真实飞书投递及部署仍需各自验收。
