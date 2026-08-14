/**
 * 清理过期的 Cursor MCP overlay 临时目录。
 * 每条消息创建独立 overlay 后，需要定期清理避免磁盘占用。
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cursorRuntimeRoot } from './config.js';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

/**
 * 清理超过 7 天未访问的 Cursor overlay 目录。
 * 启动时自动调用，非阻塞。
 */
export function cleanupStaleOverlays(): void {
  try {
    const root = cursorRuntimeRoot();
    const entries = readdirSync(root, { withFileTypes: true });
    const now = Date.now();
    let removed = 0;

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('mcp-')) continue;
      const path = join(root, entry.name);
      try {
        const stats = statSync(path);
        const age = now - stats.atimeMs;
        if (age > MAX_AGE_MS) {
          rmSync(path, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // 目录已被删除或无权限，跳过
      }
    }

    if (removed > 0) {
      console.log(`[MCP] 已清理 ${removed} 个过期 Cursor overlay 目录（超过 7 天未访问）`);
    }
  } catch (error) {
    // 清理失败不影响主流程
    console.warn(`[MCP] Cursor overlay 清理失败: ${(error as Error).message}`);
  }
}
