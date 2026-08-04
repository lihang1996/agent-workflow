import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export const QuestionKindSchema = z.enum(['single_choice', 'multi_choice', 'text']);
export type QuestionKind = z.infer<typeof QuestionKindSchema>;

export const QuestionSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  kind: QuestionKindSchema,
  options: z.array(z.string().min(1)).optional(),
  required: z.boolean().optional(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionnaireSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().optional(),
  questions: z.array(QuestionSchema).min(1),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  status: z.enum(['awaiting_answers', 'answered']),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  chatId: z.string().min(1).optional(),
  topicId: z.string().min(1).optional(),
  ownerOpenId: z.string().min(1).optional(),
  botId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  workflowId: z.string().uuid().optional(),
});
export type Questionnaire = z.infer<typeof QuestionnaireSchema>;

const QuestionnaireIdSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);

/** MCP 与飞书表单共用的问卷文件仓库。 */
export class JsonQuestionnaireStore {
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
    await this.save(questionnaire);
    return questionnaire;
  }

  async get(id: string): Promise<Questionnaire | undefined> {
    QuestionnaireIdSchema.parse(id);
    try {
      const raw = await readFile(join(this.directory, `${id}.json`), 'utf8');
      const parsed = QuestionnaireSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error(`问卷文件格式错误: ${id}`);
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
  ): Promise<{ questionnaire: Questionnaire; missingRequired: string[] }> {
    const current = await this.get(id);
    if (!current) throw new Error(`问卷不存在: ${id}`);

    const merged = { ...(current.answers ?? {}), ...answers };
    const missingRequired = current.questions
      .filter((question) => question.required !== false)
      .filter((question) => {
        const value = merged[question.id];
        return value == null
          || (typeof value === 'string' ? value.trim().length === 0 : value.length === 0);
      })
      .map((question) => question.id);
    const questionnaire: Questionnaire = {
      ...current,
      answers: merged,
      status: missingRequired.length === 0 ? 'answered' : 'awaiting_answers',
      updatedAt: new Date().toISOString(),
    };
    await this.save(questionnaire);
    return { questionnaire, missingRequired };
  }

  async save(questionnaire: Questionnaire): Promise<void> {
    const parsed = QuestionnaireSchema.parse(questionnaire);
    await mkdir(this.directory, { recursive: true });
    const destination = join(this.directory, `${parsed.id}.json`);
    const temp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    await rename(temp, destination);
  }
}
