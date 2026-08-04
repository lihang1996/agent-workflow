export type CommandName =
  | "close"
  | "status"
  | "help"
  | "engine"
  | "workdir"
  | "reset"
  | "reopen"
  | "clean"
  | "handoff"
  | "review"
  | "pipeline"
  | "form"
  | "spec"
  | "squad"
  | "schedule";

export interface SlashCommand {
  name: CommandName;
  arg?: string;
}

// workdir / handoff / review / pipeline 参数可能含空格，因此吃到行尾。
const COMMAND_RE =
  /^(?:@.+\s+)?\/(close|status|help|engine|workdir|reset|reopen|clean|handoff|review|pipeline|form|spec|squad|schedule)(?:\s+(.+))?$/;

/** 从消息文本解析斜杠命令。 */
export function parseCommand(text: string): SlashCommand | undefined {
  const match = COMMAND_RE.exec(text.trim());
  if (!match) return undefined;
  const arg = match[2]?.trim();
  return {
    name: match[1] as CommandName,
    ...(arg ? { arg } : {}),
  };
}
