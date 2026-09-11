import { z } from 'zod';
import { readJsonState, writeJsonState } from './json-state.js';

export interface CollaborationMessage {
  dispatchId: string;
  taskId: string;
  ownerOpenId: string;
  ownerUnionId?: string;
  ownerBotId?: string;
  replyToMessageId?: string;
  cardMessageId?: string;
  attempts?: number;
  fromBotId: string;
  toBotId: string;
  reportToBotId: string;
  objective: string;
  instruction: string;
  expectedOutput?: string;
  round: number;
  maxRounds: number;
  workspaceDir: string;
}

const CollaborationBotIdSchema = z.string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);

export const CollaborationOriginSchema = z.object({
  taskId: z.string().trim().min(1),
  fromBotId: CollaborationBotIdSchema,
  reportToBotId: CollaborationBotIdSchema,
  round: z.number().int().min(1),
  maxRounds: z.number().int().min(1).max(32),
}).strict().superRefine((origin, ctx) => {
  if (origin.round > origin.maxRounds) {
    ctx.addIssue({
      code: 'custom',
      message: '协作轮次不能超过轮次上限',
      path: ['round'],
    });
  }
});

export type CollaborationOrigin = z.infer<typeof CollaborationOriginSchema>;

export const DispatchTaskRequestSchema = z.object({
  targetBotId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  objective: z.string().trim().min(1).max(200),
  instruction: z.string().trim().min(1).max(2_000),
  expectedOutput: z.string().trim().min(1).max(500).optional(),
});

export type DispatchTaskRequest = z.infer<typeof DispatchTaskRequestSchema>;

export function findDispatchTaskRequest(
  toolCalls: Array<{ toolName: string; input: unknown }> | undefined,
): DispatchTaskRequest | undefined {
  for (let index = (toolCalls?.length ?? 0) - 1; index >= 0; index -= 1) {
    const call = toolCalls?.[index];
    if (call?.toolName !== 'dispatch_task') continue;
    const parsed = DispatchTaskRequestSchema.safeParse(call.input);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export function collaborationOrigin(
  message: CollaborationMessage,
): CollaborationOrigin {
  return {
    taskId: message.taskId,
    fromBotId: message.fromBotId,
    reportToBotId: message.reportToBotId,
    round: message.round,
    maxRounds: message.maxRounds,
  };
}

export function buildCollaborationPrompt(
  message: CollaborationMessage,
): string {
  return [
    `协作目标：${message.objective}`,
    `执行要求：${message.instruction}`,
    message.expectedOutput
      ? `期望产出：${message.expectedOutput}`
      : '',
    `完成后，把结果交回 ${message.reportToBotId} 继续组织后续工作；已经可以交付时，明确给出最终结论。`,
  ].filter(Boolean).join('\n\n');
}

export function collaborationTurnKey(message: CollaborationMessage): string {
  // A topic can receive new dispatches whose collaboration rounds start at 1.
  return `${message.taskId}:${message.dispatchId}:${message.round}:${message.toBotId}`;
}

const PersistedCollaborationSchema = z.object({
  dispatchId: z.string().regex(/^[a-f0-9]{12}$/), taskId: z.string(),
  ownerOpenId: z.string(), ownerUnionId: z.string().optional(), ownerBotId: z.string().optional(),
  fromBotId: z.string(), toBotId: z.string(), reportToBotId: z.string(),
  objective: z.string(), instruction: z.string(), expectedOutput: z.string().optional(),
  round: z.number().int().min(1), maxRounds: z.number().int().min(1), workspaceDir: z.string(),
  replyToMessageId: z.string().optional(), cardMessageId: z.string().optional(), attempts: z.number().optional(),
});

export class CollaborationInbox {
  private readonly messages = new Map<string, CollaborationMessage>();
  private readonly consumed = new Set<string>();

  constructor(private readonly filePath?: string) {
    const state = readJsonState(filePath);
    if (state === undefined) return;
    const parsed = z.object({ pending: z.array(PersistedCollaborationSchema), consumed: z.array(z.string()) }).parse(state);
    for (const message of parsed.pending) this.messages.set(message.dispatchId, message);
    for (const id of parsed.consumed.slice(-10000)) this.consumed.add(id);
  }
  private mutate<T>(operation: () => T): T {
    const before = structuredClone([...this.messages.entries()]);
    const consumed = [...this.consumed];
    try {
      const result = operation();
      writeJsonState(this.filePath, { pending: [...this.messages.values()], consumed: [...this.consumed] });
      return result;
    } catch (error) {
      this.messages.clear(); this.consumed.clear();
      for (const [key, value] of before) this.messages.set(key, value);
      for (const key of consumed) this.consumed.add(key);
      throw error;
    }
  }
  register(message: CollaborationMessage): void {
    if (this.consumed.has(message.dispatchId) || this.messages.has(message.dispatchId)) return;
    if (this.messages.size >= 1000) throw new Error('待派发队列已满，请先恢复失败的协作任务');
    this.mutate(() => this.messages.set(message.dispatchId, structuredClone(message)));
  }
  update(message: CollaborationMessage): void {
    if (this.messages.has(message.dispatchId)) this.mutate(() => this.messages.set(message.dispatchId, structuredClone(message)));
  }
  hasConsumed(dispatchId: string): boolean { return this.consumed.has(dispatchId); }
  pending(): CollaborationMessage[] { return structuredClone([...this.messages.values()]); }
  peek(dispatchId: string, toBotId: string): CollaborationMessage | undefined {
    const message = this.messages.get(dispatchId);
    return message?.toBotId === toBotId ? structuredClone(message) : undefined;
  }
  consume(dispatchId: string, toBotId: string): CollaborationMessage | undefined {
    const message = this.peek(dispatchId, toBotId);
    if (!message) return undefined;
    return this.mutate(() => {
      this.messages.delete(dispatchId);
      this.consumed.add(dispatchId);
      if (this.consumed.size > 10000) this.consumed.delete(this.consumed.values().next().value!);
      return message;
    });
  }
}
