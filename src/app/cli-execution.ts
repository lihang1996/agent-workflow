import { runCli } from "../cli/runner.js";
import type { CliAdapter, CliAttachment } from "../cli/types.js";

export function executeCli(
  adapter: CliAdapter,
  prompt: string,
  workspaceDir: string,
  sessionId: string | undefined,
  signal: AbortSignal,
  onEvent: Parameters<typeof runCli>[0]["onEvent"],
  attachments?: readonly CliAttachment[],
) {
  return runCli({
    adapter,
    prompt,
    cwd: workspaceDir,
    sessionId,
    signal,
    onEvent,
    attachments,
  });
}

/**
 * 附件说明段落。写进 prompt 后，任何能读本地文件的 CLI 都知道去哪里找，
 * 不依赖某个 CLI 是否有专门的附件参数。
 */
export function attachmentPromptSection(attachments: readonly CliAttachment[]): string {
  if (attachments.length === 0) return "";
  const lines = attachments.map((attachment) => {
    const kind = attachment.type === "image" ? "图片" : "文件";
    const originalName = attachment.fileName ? `（原文件名：${attachment.fileName}）` : "";
    return `- ${kind}：${attachment.path}${originalName}`;
  });
  return [
    "",
    "",
    "用户随这条消息附带了以下内容，已保存到本机。请先读取这些文件，再结合上面的任务处理：",
    ...lines,
  ].join("\n");
}
