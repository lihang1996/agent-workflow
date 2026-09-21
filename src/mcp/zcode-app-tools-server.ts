/**
 * ZCode 专用 MCP 入口。ZCode 的共享用户配置（`~/.zcode/cli/config.json` 的
 * `mcp.servers`）不支持 Cursor 的 `${env:…}` 插值，而角色权限必须按每次
 * spawn 注入，因此共享配置只指向此入口：读取 Runner 注入的
 * AGENT_OS_ALLOWED_TOOLS（空权限为显式空字符串），转成旧 server 已有的
 * `--tools=` 参数后加载同一实现；不另建业务 MCP 实现。
 */
process.argv.push(`--tools=${process.env.AGENT_OS_ALLOWED_TOOLS ?? ''}`);

await import('./app-tools-server.js');

export {};
