# 飞书 lark-cli 与 ZCode CLI

Agent OS 通过飞书收发消息，并可用 Claude Code、Codex、Cursor 或官方 ZCode CLI 执行任务。下面两节互相独立：只做云文档时配置 lark-cli；要用 `/zcode` 时再配官方 ZCode。

## ZCode CLI（可选）

首版只按 macOS 验收。使用官方桌面应用自带的 CLI（当前验证过 `0.16.9`），不要装社区 npm 包 `zcode-app-cli`。

```bash
zcode --version
zcode login
```

在官方 TUI 里选好默认模型后再跑 headless。桌面能聊天不代表 CLI 新会话已经带上模型。

把下面两项写进 `.env`（必须成对出现，路径按本机安装调整）。使用展开后的绝对路径，将示例中的用户名 `leon` 替换为自己的用户名；dotenv 不会展开 `$HOME` 或 `~`：

```bash
ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json
ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=/Users/leon/.zcode/v2/provider_config.json
```

不复制密钥到仓库，也不改个人 Provider 配置。`bots.json` 的 `defaultCli` 可填 `zcode`；新话题也可以发 `/zcode <任务>`。`/resume` 列历史和 `/compact` 暂不支持，同话题会用保存的 `sessionId` 自动续接。

最小验证：

```bash
export ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json
export ZCODE_PERSONAL_PROVIDER_CONFIG_FILE="$HOME/.zcode/v2/provider_config.json"
zcode --prompt "Reply with exactly: pong" --mode yolo --output-format stream-json
```

成功时应出现 `session.created` 和顶层 `type=result`。再用返回的 `sessionId` 加 `--resume` 跑第二条。失败时看 `turn.failed` 的 `payload.error.message`；常见原因是未选模型（`Select a model before continuing`）。

## lark-cli 初始化

第 24 节使用飞书官方 `lark-cli` 与 `lark-doc` Skill 直接创建云文档。

## 安装 CLI 与官方 Skills

```bash
node --version
npx @larksuite/cli@latest install
lark-cli --version
npx skills add larksuite/cli -g -y
lark-cli skills read lark-doc
```

## 配置与用户授权

```bash
lark-cli config init --new
lark-cli auth login --domain docs
lark-cli auth status --json --verify
```

配置和登录命令会打开浏览器，请按页面提示完成飞书应用配置与用户授权。文档操作默认使用 `--as user`，凭证由 lark-cli 管理，不要写入项目 `.env`。

## 最小验证

```bash
lark-cli docs +create --as user --content '<title>Agent OS 测试文档</title><p>如果你能打开这份文档，说明 lark-doc 已经可以工作。</p>'
```

成功结果应满足 `ok: true`，并在 `data.document.url` 返回可打开的飞书文档链接。

后续更新 CLI 与官方 Skills 使用：

```bash
lark-cli update
```
