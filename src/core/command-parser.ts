export type CommandName = "close" | "status" | "help" | "engine";

export interface SlashCommand {
  name: CommandName;
  arg?: string;
}

const COMMAND_RE = /^(?:@.+\s+)?\/(close|status|help|engine)(?:\s+(\S+))?\s*$/;

export function parseCommand(text: string): SlashCommand | undefined {
  const match = COMMAND_RE.exec(text.trim());
  if (!match) return undefined;
  return {
    name: match[1] as CommandName,
    ...(match[2] ? { arg: match[2] } : {}),
  };
}
