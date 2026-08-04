/**
 * 结构化提问 MCP Server（stdio）。
 * 大纲 6.3：让 Agent 学会结构化提问；6.4 再把问卷落成飞书表单。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.AGENT_OS_ROOT ?? join(here, '../..'));
loadEnv({ path: join(root, '.env') });

const storeDir = join(root, 'data', 'questionnaires');

const QuestionKind = z.enum(['single_choice', 'multi_choice', 'text']);

const QuestionSchema = z.object({
  id: z.string().min(1).describe('问题稳定 ID，如 scope / deadline'),
  prompt: z.string().min(1).describe('问题正文'),
  kind: QuestionKind.describe('single_choice | multi_choice | text'),
  options: z
    .array(z.string().min(1))
    .optional()
    .describe('单选/多选的选项列表；文本题可省略'),
  required: z.boolean().optional().describe('是否必答，默认 true'),
});

type Question = z.infer<typeof QuestionSchema>;

interface Questionnaire {
  id: string;
  title: string;
  goal?: string;
  questions: Question[];
  answers?: Record<string, string | string[]>;
  status: 'awaiting_answers' | 'answered';
  createdAt: string;
  updatedAt: string;
}

function textResult(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function kindLabel(kind: Question['kind']): string {
  if (kind === 'single_choice') return '单选';
  if (kind === 'multi_choice') return '多选';
  return '文本';
}

/** 生成给人看的澄清稿（后续可直接映射成飞书表单）。 */
function buildFeishuPreview(doc: Questionnaire): string {
  const lines = [
    `【需求澄清】${doc.title}`,
    ...(doc.goal ? [`目标：${doc.goal}`] : []),
    `问卷 ID：${doc.id}`,
    '',
  ];
  doc.questions.forEach((question, index) => {
    const req = question.required === false ? '可选' : '必答';
    lines.push(`${index + 1}. [${kindLabel(question.kind)}/${req}] ${question.prompt}`);
    if (question.options?.length) {
      for (const option of question.options) {
        lines.push(`   - ${option}`);
      }
    }
  });
  lines.push('', '请按编号回复，例如：1=选项A；2=选项B,选项C；3=自由文本');
  lines.push('Agent 收到回复后应调用 record_answers 写入结论。');
  return lines.join('\n');
}

async function loadQuestionnaire(id: string): Promise<Questionnaire | undefined> {
  try {
    const raw = await readFile(join(storeDir, `${id}.json`), 'utf8');
    return JSON.parse(raw) as Questionnaire;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function saveQuestionnaire(doc: Questionnaire): Promise<void> {
  await mkdir(storeDir, { recursive: true });
  await writeFile(join(storeDir, `${doc.id}.json`), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

const server = new McpServer({
  name: 'agent-os-ask',
  version: '0.1.0',
});

server.registerTool(
  'propose_questions',
  {
    title: '发起结构化提问',
    description:
      '把需求澄清整理成结构化问卷（单选/多选/文本）。会落盘并返回飞书可读预览；下一节可再变成飞书表单。澄清未完成前不要写最终 Spec。',
    inputSchema: {
      title: z.string().min(1).describe('问卷标题，如「登录需求澄清」'),
      goal: z.string().optional().describe('用户原始目标摘要'),
      questions: z.array(QuestionSchema).min(1).describe('结构化问题列表'),
    },
  },
  async ({ title, goal, questions }) => {
    for (const question of questions) {
      if (
        (question.kind === 'single_choice' || question.kind === 'multi_choice')
        && (!question.options || question.options.length < 2)
      ) {
        return textResult({
          ok: false,
          error: `问题 ${question.id} 是选择题，至少需要 2 个 options`,
        });
      }
    }

    const now = new Date().toISOString();
    const doc: Questionnaire = {
      id: randomUUID().slice(0, 8),
      title,
      ...(goal ? { goal } : {}),
      questions,
      status: 'awaiting_answers',
      createdAt: now,
      updatedAt: now,
    };
    await saveQuestionnaire(doc);
    const preview = buildFeishuPreview(doc);
    return textResult({
      ok: true,
      questionnaireId: doc.id,
      status: doc.status,
      path: join('data', 'questionnaires', `${doc.id}.json`),
      feishuPreview: preview,
      next: '把 feishuPreview 发给用户；收到答案后调用 record_answers',
    });
  },
);

server.registerTool(
  'record_answers',
  {
    title: '记录澄清答案',
    description: '把用户对问卷的回答写入本地；全部必答题答完后 status 变为 answered。',
    inputSchema: {
      questionnaireId: z.string().min(1).describe('propose_questions 返回的 ID'),
      answers: z
        .record(z.string(), z.union([z.string(), z.array(z.string())]))
        .describe('questionId → 答案；多选可用字符串数组'),
    },
  },
  async ({ questionnaireId, answers }) => {
    const doc = await loadQuestionnaire(questionnaireId);
    if (!doc) {
      return textResult({ ok: false, error: `问卷不存在: ${questionnaireId}` });
    }

    const merged = { ...(doc.answers ?? {}), ...answers };
    const missing = doc.questions
      .filter((question) => question.required !== false)
      .filter((question) => {
        const value = merged[question.id];
        if (value == null) return true;
        if (typeof value === 'string') return value.trim().length === 0;
        return value.length === 0;
      })
      .map((question) => question.id);

    const now = new Date().toISOString();
    const next: Questionnaire = {
      ...doc,
      answers: merged,
      status: missing.length === 0 ? 'answered' : 'awaiting_answers',
      updatedAt: now,
    };
    await saveQuestionnaire(next);

    return textResult({
      ok: true,
      questionnaireId: next.id,
      status: next.status,
      missingRequired: missing,
      answers: merged,
      summary: missing.length === 0
        ? '澄清已完成，可以据此写 Spec。'
        : `仍缺必答：${missing.join(', ')}`,
    });
  },
);

server.registerTool(
  'get_questionnaire',
  {
    title: '读取问卷',
    description: '按 ID 读取结构化问卷与已记录答案。',
    inputSchema: {
      questionnaireId: z.string().min(1),
    },
  },
  async ({ questionnaireId }) => {
    const doc = await loadQuestionnaire(questionnaireId);
    if (!doc) {
      return textResult({ ok: false, error: `问卷不存在: ${questionnaireId}` });
    }
    return textResult({
      ok: true,
      questionnaire: doc,
      feishuPreview: buildFeishuPreview(doc),
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
