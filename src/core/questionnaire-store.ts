import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export const QuestionKindSchema = z.enum(['single_choice', 'multi_choice', 'text']);
export type QuestionKind = z.infer<typeof QuestionKindSchema>;

export const QuestionSchema = z.object({
  id: z.string()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/, '问题 ID 必须以字母开头，且只包含字母、数字、下划线或连字符')
    .refine((id) => !['constructor', 'prototype'].includes(id), '问题 ID 使用了保留名称'),
  prompt: z.string().trim().min(1).max(300),
  kind: QuestionKindSchema,
  options: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  required: z.boolean().optional(),
}).superRefine((question, ctx) => {
  if (question.kind === 'text' && question.options?.length) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: '文本题不能配置 options' });
  }
  if (question.kind !== 'text') {
    if (!question.options || question.options.length < 2) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: '选择题至少需要 2 个 options' });
      return;
    }
    if (new Set(question.options).size !== question.options.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: '选择题 options 不能重复' });
    }
  }
});
export type Question = z.infer<typeof QuestionSchema>;

// 兼容早期 randomUUID().slice(0, 8) 生成的问卷 ID；新问卷仍使用完整 UUID。
const QuestionnaireIdSchema = z.string().regex(
  /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  '问卷 ID 格式无效',
);

const QuestionsSchema = z.array(QuestionSchema).min(1).max(20).superRefine((questions, ctx) => {
  const seen = new Set<string>();
  questions.forEach((question, index) => {
    if (seen.has(question.id)) {
      ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `问题 ID 重复: ${question.id}` });
    }
    seen.add(question.id);
  });
});

export const QuestionnaireSchema = z.object({
  id: QuestionnaireIdSchema,
  title: z.string().trim().min(1).max(100),
  goal: z.string().trim().max(2_000).optional(),
  questions: QuestionsSchema,
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  status: z.enum(['awaiting_answers', 'answered']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  chatId: z.string().min(1).optional(),
  topicId: z.string().min(1).optional(),
  ownerOpenId: z.string().min(1).optional(),
  botId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  workflowId: z.string().uuid().optional(),
});
export type Questionnaire = z.infer<typeof QuestionnaireSchema>;

/** MCP 与飞书表单共用的问卷文件仓库。 */
export class JsonQuestionnaireStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly directory = resolve('data', 'questionnaires')) {}

  async create(input: {
    title: string;
    goal?: string;
    questions: Question[];
    chatId?: string;
    topicId?: string;
    ownerOpenId?: string;
    botId?: string;
    messageId?: string;
    workflowId?: string;
  }): Promise<Questionnaire> {
    const now = new Date().toISOString();
    const questionnaire = QuestionnaireSchema.parse({
      ...input,
      id: randomUUID(),
      status: 'awaiting_answers',
      createdAt: now,
      updatedAt: now,
    });
    await this.enqueueMutation(() => this.write(questionnaire));
    return questionnaire;
  }

  async get(id: string): Promise<Questionnaire | undefined> {
    QuestionnaireIdSchema.parse(id);
    try {
      const raw = await readFile(join(this.directory, `${id}.json`), 'utf8');
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch (error) {
        throw new Error(`问卷文件不是有效 JSON: ${id}`, { cause: error });
      }
      const parsed = QuestionnaireSchema.safeParse(value);
      if (!parsed.success) throw new Error(`问卷文件格式错误: ${id}（${parsed.error.issues[0]?.message ?? '未知错误'}）`);
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async latestAwaitingForWorkflow(workflowId: string): Promise<Questionnaire | undefined> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const rows = await Promise.all(names
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.get(name.slice(0, -5))));
    return rows
      .filter((row): row is Questionnaire =>
        row?.workflowId === workflowId && row.status === 'awaiting_answers')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  async recordAnswers(
    id: string,
    answers: Record<string, string | string[]>,
    expectedUpdatedAt?: string,
  ): Promise<{ questionnaire: Questionnaire; missingRequired: string[] }> {
    return this.enqueueMutation(async () => {
      const current = await this.get(id);
      if (!current) throw new Error(`问卷不存在: ${id}`);
      if (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt) {
        throw new Error(`这张问卷卡片已过期，请发送 /form ${id} 获取最新版。`);
      }
      const normalized = normalizeAnswers(current, answers);
      const merged = { ...(current.answers ?? {}), ...normalized };
      const missingRequired = current.questions
        .filter((question) => question.required !== false)
        .filter((question) => {
          const value = Object.hasOwn(merged, question.id) ? merged[question.id] : undefined;
          return value == null
            || (typeof value === 'string' ? value.trim().length === 0 : value.length === 0);
        })
        .map((question) => question.id);
      if (current.status === 'answered') {
        if (answersEqual(current.answers ?? {}, merged)) {
          return { questionnaire: current, missingRequired: [] };
        }
        throw new Error('问卷已经完成，不能再修改答案。');
      }
      const questionnaire = QuestionnaireSchema.parse({
        ...current,
        answers: merged,
        status: missingRequired.length === 0 ? 'answered' : 'awaiting_answers',
        updatedAt: nextUpdatedAt(current.updatedAt),
      });
      await this.write(questionnaire);
      return { questionnaire, missingRequired };
    });
  }

  async save(questionnaire: Questionnaire): Promise<void> {
    const parsed = QuestionnaireSchema.parse(questionnaire);
    await this.enqueueMutation(() => this.write(parsed));
  }

  private async write(questionnaire: Questionnaire): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const destination = join(this.directory, `${questionnaire.id}.json`);
    const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(questionnaire, null, 2)}\n`, 'utf8');
    await rename(temp, destination);
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

function nextUpdatedAt(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

function answersEqual(
  left: Record<string, string | string[]>,
  right: Record<string, string | string[]>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) {
    return false;
  }
  return leftKeys.every((key) => {
    const leftValue = left[key];
    const rightValue = right[key];
    return Array.isArray(leftValue) && Array.isArray(rightValue)
      ? leftValue.length === rightValue.length && leftValue.every((value, index) => value === rightValue[index])
      : leftValue === rightValue;
  });
}

function normalizeAnswers(
  questionnaire: Questionnaire,
  answers: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const questions = new Map(questionnaire.questions.map((question) => [question.id, question]));
  for (const id of Object.keys(answers)) {
    if (!questions.has(id)) throw new Error(`问卷不包含问题: ${id}`);
  }

  const normalized: Record<string, string | string[]> = {};
  for (const [id, raw] of Object.entries(answers)) {
    const question = questions.get(id)!;
    if (question.kind === 'text') {
      if (typeof raw !== 'string') throw new Error(`问题 ${id} 必须填写文本`);
      if (raw.length > 4_000) throw new Error(`问题 ${id} 的回答不能超过 4000 字`);
      normalized[id] = raw.trim();
      continue;
    }

    if (question.kind === 'single_choice') {
      if (Array.isArray(raw) && raw.length > 1) {
        throw new Error(`问题 ${id} 只能选择一个选项`);
      }
      const value = typeof raw === 'string'
        ? raw.trim()
        : raw.length === 1 ? raw[0]?.trim() ?? '' : '';
      if (!value) {
        normalized[id] = '';
        continue;
      }
      if (!question.options?.includes(value)) throw new Error(`问题 ${id} 的选项无效: ${value}`);
      normalized[id] = value;
      continue;
    }

    const values = (Array.isArray(raw) ? raw : raw ? [raw] : [])
      .map((value) => value.trim())
      .filter(Boolean);
    if (new Set(values).size !== values.length) throw new Error(`问题 ${id} 的多选答案不能重复`);
    const invalid = values.find((value) => !question.options?.includes(value));
    if (invalid) throw new Error(`问题 ${id} 的选项无效: ${invalid}`);
    normalized[id] = values;
  }
  return normalized;
}

export interface QuestionnaireAccessContext {
  workflowId?: string;
  ownerOpenId?: string;
  chatId?: string;
  topicId?: string;
  botId?: string;
  messageId?: string;
}

/** MCP 只能读取当前任务自身创建的问卷，不能凭 ID 跨话题访问。 */
export function questionnaireMatchesContext(
  questionnaire: Questionnaire,
  context: QuestionnaireAccessContext,
): boolean {
  const scoped: Array<[string | undefined, string | undefined]> = [
    [questionnaire.workflowId, context.workflowId],
    [questionnaire.ownerOpenId, context.ownerOpenId],
    [questionnaire.chatId, context.chatId],
    [questionnaire.topicId, context.topicId],
    [questionnaire.botId, context.botId],
    [questionnaire.messageId, context.messageId],
  ];
  return scoped.every(([expected, actual]) => !expected || expected === actual);
}
