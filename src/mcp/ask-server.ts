/**
 * 结构化提问 MCP Server（stdio）。
 * 大纲 6.3：让 Agent 学会结构化提问；6.4 通过 /form 把问卷落成飞书表单。
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  JsonQuestionnaireStore,
  QuestionSchema,
  questionnaireMatchesContext,
  type Question,
  type Questionnaire,
} from '../core/questionnaire-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.AGENT_OS_ROOT ?? join(here, '../..'));
loadEnv({ path: join(root, '.env') });

const storeDir = join(root, 'data', 'questionnaires');
const store = await JsonQuestionnaireStore.open(storeDir);

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

/** 生成给人看的澄清稿；同一问卷可用 /form <id> 渲染为飞书表单。 */
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
  lines.push('', `请发送 /form ${doc.id} 打开飞书表单并提交。`);
  return lines.join('\n');
}

function context(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function canAccess(doc: Questionnaire): boolean {
  return questionnaireMatchesContext(doc, {
    workflowId: context('AGENT_OS_WORKFLOW_ID'),
    ownerOpenId: context('AGENT_OS_OWNER_OPEN_ID'),
    chatId: context('AGENT_OS_CHAT_ID'),
    topicId: context('AGENT_OS_TOPIC_ID'),
    botId: context('AGENT_OS_BOT_ID'),
    messageId: context('AGENT_OS_MESSAGE_ID'),
  });
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
      '把需求澄清整理成结构化问卷（单选/多选/文本）。问卷会落盘并返回飞书可读预览；让用户发送 /form <questionnaireId> 可点选提交。澄清未完成前不要写最终 Spec。',
    inputSchema: {
      title: z.string().min(1).describe('问卷标题，如「登录需求澄清」'),
      goal: z.string().optional().describe('用户原始目标摘要'),
      questions: z.array(QuestionSchema).min(1).describe('结构化问题列表'),
    },
  },
  async ({ title, goal, questions }) => {
    const doc = await store.create({
      title,
      ...(goal ? { goal } : {}),
      questions,
      chatId: context('AGENT_OS_CHAT_ID'),
      topicId: context('AGENT_OS_TOPIC_ID'),
      ownerOpenId: context('AGENT_OS_OWNER_OPEN_ID'),
      botId: context('AGENT_OS_BOT_ID'),
      messageId: context('AGENT_OS_MESSAGE_ID'),
      workflowId: context('AGENT_OS_WORKFLOW_ID'),
    });
    const preview = buildFeishuPreview(doc);
    return textResult({
      ok: true,
      questionnaireId: doc.id,
      status: doc.status,
      path: join('data', 'questionnaires', `${doc.id}.json`),
      feishuPreview: preview,
      next: `把 feishuPreview 发给用户，让用户发送 /form ${doc.id} 点选提交；现在停止并等待用户作答。`,
    });
  },
);

server.registerTool(
  'record_answers',
  {
    title: '记录澄清答案',
    description: '仅把用户明确给出的问卷回答写入本地，不得猜测、补全或替用户选择；全部必答题答完后 status 变为 answered。',
    inputSchema: {
      questionnaireId: z.string().min(1).describe('propose_questions 返回的 ID'),
      answers: z
        .record(z.string(), z.union([z.string(), z.array(z.string())]))
        .describe('questionId → 答案；多选可用字符串数组'),
    },
  },
  async ({ questionnaireId, answers }) => {
    const doc = await store.get(questionnaireId);
    if (!doc) {
      return textResult({ ok: false, error: `问卷不存在: ${questionnaireId}` });
    }
    if (!canAccess(doc)) return textResult({ ok: false, error: '问卷不属于当前工作流。' });
    const { questionnaire: next, missingRequired: missing } = await store.recordAnswers(questionnaireId, answers);

    return textResult({
      ok: true,
      questionnaireId: next.id,
      status: next.status,
      missingRequired: missing,
      answers: next.answers,
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
    const doc = await store.get(questionnaireId);
    if (!doc) {
      return textResult({ ok: false, error: `问卷不存在: ${questionnaireId}` });
    }
    if (!canAccess(doc)) return textResult({ ok: false, error: '问卷不属于当前工作流。' });
    return textResult({
      ok: true,
      questionnaire: doc,
      feishuPreview: buildFeishuPreview(doc),
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
