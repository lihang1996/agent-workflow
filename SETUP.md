# lark-cli 初始化

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
