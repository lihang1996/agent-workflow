import type { CliAdapter, CliEvent } from './types.js';

interface ClaudeContentBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
}

interface ClaudeEvent {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  session_id?: unknown;
  message?: {
    content?: unknown;
  };
}

function outputArgs(prompt: string): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
  ];
}

function summarizeInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input === 'string') {
    return input.length > 80 ? `${input.slice(0, 80)}…` : input;
  }
  if (typeof input !== 'object') return String(input);

  const obj = input as Record<string, unknown>;
  const preferred =
    (typeof obj.command === 'string' && obj.command)
    || (typeof obj.file_path === 'string' && obj.file_path)
    || (typeof obj.path === 'string' && obj.path)
    || (typeof obj.pattern === 'string' && obj.pattern)
    || (typeof obj.query === 'string' && obj.query);

  if (preferred) {
    return preferred.length > 80 ? `${preferred.slice(0, 80)}…` : preferred;
  }

  try {
    const json = JSON.stringify(input);
    return json.length > 80 ? `${json.slice(0, 80)}…` : json;
  } catch {
    return undefined;
  }
}

export class ClaudeAdapter implements CliAdapter {
  readonly id = 'claude' as const;
  readonly command = 'claude';
  readonly displayName = 'Claude Code';

  buildArgs(prompt: string): string[] {
    return outputArgs(prompt);
  }

  buildResumeArgs(prompt: string, sessionId: string): string[] {
    return ['--resume', sessionId, ...outputArgs(prompt)];
  }

  parseEvents(line: string): CliEvent[] {
    let event: ClaudeEvent;
    try {
      event = JSON.parse(line) as ClaudeEvent;
    } catch {
      return [];
    }

    const sessionId = typeof event.session_id === 'string'
      ? event.session_id
      : undefined;

    if (event.type === 'system' && event.subtype === 'init' && sessionId) {
      return [{ type: 'session', sessionId }];
    }

    if (event.type === 'assistant') {
      const content = Array.isArray(event.message?.content)
        ? event.message.content as ClaudeContentBlock[]
        : [];
      const events: CliEvent[] = [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          events.push({
            type: 'assistant',
            text: block.text.trim(),
            ...(sessionId ? { sessionId } : {}),
          });
        }
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          const inputSummary = summarizeInput(block.input);
          events.push({
            type: 'tool',
            name: block.name,
            ...(inputSummary ? { inputSummary } : {}),
            ...(sessionId ? { sessionId } : {}),
          });
        }
      }
      return events;
    }

    if (event.type !== 'result') return [];

    if (event.is_error) {
      return [{
        type: 'error',
        message: typeof event.result === 'string'
          ? event.result
          : 'Claude Code 执行失败',
        ...(sessionId ? { sessionId } : {}),
      }];
    }

    if (typeof event.result !== 'string') return [];
    return [{
      type: 'result',
      answer: event.result,
      ...(sessionId ? { sessionId } : {}),
    }];
  }
}
