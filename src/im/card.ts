/**
 * 飞书任务卡片：把 CLI 事件整理成稳定、低噪音的任务进度。
 */
import { FEISHU_TEXT_LIMIT } from './text-limits.js';
import type { CliRunStats, CliSessionSummary } from '../cli/types.js';
import type { ClarificationFlow } from '../core/clarification.js';
import type { CodingAuthorizationRecord } from '../core/coding-authorization.js';
import type { ProductSpecFlow } from '../core/product-spec.js';
import type { TaskActivity, TaskProgressSnapshot } from '../core/task-progress.js';

export type CardJson = Record<string, unknown>;
export type TaskStatus = 'running' | 'success' | 'failed' | 'cancelled';

export interface TaskCardOptions {
  title: string;
  status: TaskStatus;
  detail: string;
  progress?: TaskProgressSnapshot;
  answer?: string;
  stats?: CliRunStats;
  technicalDetail?: string;
  abortSessionId?: string;
}

export interface ResumeCardOptions {
  agentSessionId: string;
  cliName: string;
  currentCliSessionId?: string;
  sessions: CliSessionSummary[];
}

export interface SessionNoticeCardOptions {
  title: string;
  detail: string;
  template?: 'blue' | 'green' | 'grey';
}

export interface TeamCardMember {
  id: string;
  displayName: string;
  role: string;
  cliName: string;
  skills: string[];
  isLeader: boolean;
  ready: boolean;
}

export interface TeamCardOptions {
  members: TeamCardMember[];
}

export interface CollaborationCardOptions {
  senderName: string;
  targetName: string;
  reportToName: string;
  workspaceName: string;
  objective: string;
  instruction: string;
  expectedOutput?: string;
  round: number;
  maxRounds: number;
}

export interface ClarificationCardOptions {
  flow: ClarificationFlow;
}

const STATUS_STYLE = {
  running: { template: 'blue', label: '执行中' },
  success: { template: 'green', label: '已完成' },
  failed: { template: 'red', label: '执行失败' },
  cancelled: { template: 'grey', label: '已取消' },
} as const;

const COMPACT_ANSWER_LENGTH = 900;
const MAX_CARD_ANSWER_LENGTH = 6_000;
const RUNNING_ACTIVITY_LIMIT = 3;
const FINISHED_ACTIVITY_LIMIT = 8;

const TOOL_ICONS: Record<string, string> = {
  Agent: '🧩',
  Bash: '⌘',
  Edit: '✏️',
  Glob: '📁',
  Grep: '🔎',
  Read: '📄',
  Task: '🧩',
  TaskOutput: '⏳',
  WebFetch: '🌐',
  WebSearch: '🔍',
  Write: '📝',
};

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) return `${minutes} 分钟`;
  return `${minutes} 分 ${seconds} 秒`;
}

function formatCount(value: number): string {
  return value >= 1_000 ? `${Math.round(value / 100) / 10}k` : String(value);
}

function escapeInlineCode(value: string): string {
  return value.replaceAll('`', 'ˋ');
}

function escapeFeishuMarkdown(value: string): string {
  return value.replace(/<(?=\/?[A-Za-z][^>]*>)/g, '<&zwj;');
}

function activityLine(activity: TaskActivity): string {
  const icon = activity.failed ? '⚠️' : (TOOL_ICONS[activity.toolName] ?? '⚙️');
  const detail = activity.detail
    ? ` · \`${escapeInlineCode(activity.detail)}\``
    : '';
  const duration = activity.durationMs >= 1_000
    ? ` · ${formatDuration(activity.durationMs)}`
    : '';
  return `${icon} ${activity.label}${detail}${duration}`;
}

function markdownSplitIndex(text: string, maxLength: number): number {
  if (text.length <= maxLength) return text.length;
  const paragraph = text.lastIndexOf('\n\n', maxLength);
  if (paragraph >= maxLength * 0.55) return paragraph;
  const line = text.lastIndexOf('\n', maxLength);
  return line >= maxLength * 0.55 ? line : maxLength;
}

function closeOpenFence(markdown: string): string {
  const fences = markdown.match(/^```/gm)?.length ?? 0;
  return fences % 2 === 1 ? `${markdown}\n\n\`\`\`` : markdown;
}

function markdownPreview(text: string, maxLength: number): string {
  return closeOpenFence(text.slice(0, markdownSplitIndex(text, maxLength)).trim());
}

function compactAnswerPreview(answer: string): string {
  const fenceIndex = answer.search(/\n```/);
  const prose = fenceIndex > 0 ? answer.slice(0, fenceIndex) : answer;
  const preview = markdownPreview(prose, COMPACT_ANSWER_LENGTH)
    .replace(/\n(?:---|#{1,6}\s+[^\n]+)\s*$/, '')
    .trim();
  return preview.length >= 40
    ? preview
    : '回答包含较多代码与细节，展开后可以查看完整内容。';
}

function usageTotal(stats: CliRunStats | undefined): number | undefined {
  if (!stats) return undefined;
  if (stats.totalTokens !== undefined) return stats.totalTokens;
  const values = [
    stats.inputTokens,
    stats.outputTokens,
    stats.cacheReadTokens,
    stats.cacheCreationTokens,
  ].filter((value): value is number => value !== undefined);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function formatContextUsage(
  usedTokens: number | undefined,
  windowTokens: number | undefined,
): string | undefined {
  if (usedTokens === undefined) return undefined;
  if (windowTokens === undefined || windowTokens <= 0) {
    return `当前上下文约 ${formatCount(usedTokens)} tokens`;
  }
  if (usedTokens > windowTokens) return undefined;
  const percentage = Math.round((usedTokens / windowTokens) * 100);
  return `当前上下文 ${formatCount(usedTokens)} / ${formatCount(windowTokens)}（${percentage}%）`;
}

function formatContextGrowth(
  usedTokens: number | undefined,
  startTokens: number | undefined,
  startedNewSession = false,
): string | undefined {
  if (usedTokens === undefined || startTokens === undefined) return undefined;
  const delta = usedTokens - startTokens;
  const change = delta >= 0
    ? `新增 ${formatCount(delta)}`
    : `减少 ${formatCount(Math.abs(delta))}`;
  const startLabel = startedNewSession ? '新会话基础' : '本轮开始';
  return `${startLabel} ${formatCount(startTokens)} · ${change}`;
}

function buildRunningElements(options: TaskCardOptions): Record<string, unknown>[] {
  const progress = options.progress;
  const currentIcon = progress?.currentToolName
    ? `${TOOL_ICONS[progress.currentToolName] ?? '⚙️'} `
    : '';
  const currentDetail = progress?.currentDetail
    ? `\n\`${escapeInlineCode(progress.currentDetail)}\``
    : '';
  const meta = progress
    ? `${formatDuration(progress.elapsedMs)} · ${progress.toolCount} 次工具调用`
    : '刚刚开始';
  const context = formatContextUsage(
    progress?.contextUsedTokens,
    progress?.contextWindowTokens,
  );
  const contextGrowth = formatContextGrowth(
    progress?.contextUsedTokens,
    progress?.contextStartTokens,
    progress?.startedNewSession,
  );
  const elements: Record<string, unknown>[] = [{
    tag: 'markdown',
    content: `**${currentIcon}${progress?.current ?? options.detail}**${currentDetail}\n\n${meta}${context ? `\n_${context}_` : ''}${contextGrowth ? `\n_${contextGrowth}_` : ''}`,
  }];
  if (progress?.activities.length) {
    const visible = progress.activities.slice(0, RUNNING_ACTIVITY_LIMIT);
    elements.push({
      tag: 'markdown',
      content: `**最近完成（${visible.length} / ${progress.completedCount}）**\n${visible.map(activityLine).join('\n')}`,
    });
  }
  if (options.abortSessionId) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '停止任务' },
      type: 'danger',
      width: 'default',
      size: 'medium',
      behaviors: [{
        type: 'callback',
        value: {
          action: 'abort_task',
          sessionId: options.abortSessionId,
        },
      }],
    });
  }
  return elements;
}

function buildFinishedElements(options: TaskCardOptions): Record<string, unknown>[] {
  const progress = options.progress;
  const durationMs = options.stats?.durationMs ?? progress?.elapsedMs;
  const totalTokens = usageTotal(options.stats);
  const context = formatContextUsage(
    progress?.contextUsedTokens ?? options.stats?.contextUsedTokens,
    options.stats?.contextWindowTokens ?? progress?.contextWindowTokens,
  );
  const contextGrowth = formatContextGrowth(
    progress?.contextUsedTokens ?? options.stats?.contextUsedTokens,
    progress?.contextStartTokens,
    progress?.startedNewSession,
  );
  const executionMeta = [
    durationMs !== undefined ? `**耗时** ${formatDuration(durationMs)}` : undefined,
    progress ? `**工具调用** ${progress.toolCount} 次` : undefined,
  ].filter(Boolean).join(' · ');
  const usageMeta = [
    totalTokens !== undefined
      ? `**累计消耗** ${formatCount(totalTokens)} tokens`
      : undefined,
    context
      ? `**当前上下文** ${context.replace(/^当前上下文(?:约)?\s+/, '')}`
      : undefined,
    contextGrowth ? `**本轮变化** ${contextGrowth}` : undefined,
  ].filter(Boolean).join('\n');
  const meta = [executionMeta, usageMeta].filter(Boolean).join('\n\n');
  const elements: Record<string, unknown>[] = [];

  if (options.status === 'success') {
    const answer = options.answer || options.detail;
    if (answer.length <= COMPACT_ANSWER_LENGTH) {
      elements.push({ tag: 'markdown', content: escapeFeishuMarkdown(answer) });
    } else {
      elements.push({
        tag: 'markdown',
        content: `${escapeFeishuMarkdown(compactAnswerPreview(answer))}\n\n_完整回答已收起_`,
      });
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: collapsibleHeader('查看完整回答'),
        vertical_spacing: '8px',
        padding: '8px 8px 8px 8px',
        elements: [{
          tag: 'markdown',
          content: escapeFeishuMarkdown(markdownPreview(answer, MAX_CARD_ANSWER_LENGTH)),
        }],
      });
    }
    if (answerNeedsContinuation(answer)) {
      elements.push({
        tag: 'markdown',
        content: '_回答较长，剩余内容已继续发送。_',
      });
    }
  } else {
    elements.push({ tag: 'markdown', content: `**${options.detail}**` });
    if (options.technicalDetail) {
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: collapsibleHeader('查看错误详情'),
        vertical_spacing: '8px',
        padding: '8px 8px 8px 8px',
        elements: [{
          tag: 'markdown',
          content: `\`${escapeInlineCode(options.technicalDetail)}\``,
        }],
      });
    }
  }

  if (meta || progress?.activities.length) {
    const visible = progress?.activities.slice(0, FINISHED_ACTIVITY_LIMIT) ?? [];
    const activityText = visible.length
      ? `\n\n**最近执行轨迹**\n${visible.map(activityLine).join('\n')}`
      : '';
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: collapsibleHeader('执行详情'),
      vertical_spacing: '8px',
      padding: '8px 8px 8px 8px',
      elements: [{
        tag: 'markdown',
        content: `${meta || options.detail}${activityText}`,
      }],
    });
  }
  return elements;
}

function collapsibleHeader(content: string): Record<string, unknown> {
  return {
    title: { tag: 'plain_text', content },
    vertical_align: 'center',
    icon: {
      tag: 'standard_icon',
      token: 'down-small-ccm_outlined',
      size: '16px 16px',
    },
    icon_position: 'right',
    icon_expanded_angle: -180,
  };
}

export function buildTaskCard(options: TaskCardOptions): CardJson {
  const style = STATUS_STYLE[options.status];
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${options.title}：${style.label}` },
    },
    header: {
      template: style.template,
      title: { tag: 'plain_text', content: `${options.title} · ${style.label}` },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: options.status === 'running'
        ? buildRunningElements(options)
        : buildFinishedElements(options),
    },
  };
}

function clarificationButton(
  flow: ClarificationFlow,
  option: { id: string; label: string },
): Record<string, unknown> {
  const question = flow.request.questions[flow.currentIndex];
  const recommendedOptionId = question.recommendedOptionId
    ?? question.options[0]?.id;
  return {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: option.id === recommendedOptionId
        ? option.label.includes('推荐') ? option.label : `${option.label}（推荐）`
        : option.label,
    },
    type: 'default',
    width: 'fill',
    size: 'medium',
    behaviors: [{
      type: 'callback',
      value: {
        action: 'answer_clarification',
        flowToken: flow.token,
        questionId: question.id,
        optionId: option.id,
      },
    }],
  };
}

function clarificationAnswerSummary(flow: ClarificationFlow): string {
  return flow.answers.map((answer, index) => [
    `${index + 1}. **${escapeFeishuMarkdown(answer.prompt)}**`,
    `${answer.source === 'agent' ? 'Agent 推荐' : '你的选择'}：${escapeFeishuMarkdown(answer.answer)}`,
  ].join('\n')).join('\n\n');
}

function clarificationDecisionButton(
  flow: ClarificationFlow,
  decisionMode: 'current' | 'remaining',
): Record<string, unknown> {
  const question = flow.request.questions[flow.currentIndex];
  return {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: decisionMode === 'current'
        ? '这一题交给 Agent 决定'
        : '按推荐方案继续',
    },
    type: decisionMode === 'remaining' ? 'primary' : 'default',
    width: 'fill',
    size: 'medium',
    behaviors: [{
      type: 'callback',
      value: {
        action: 'answer_clarification',
        flowToken: flow.token,
        questionId: question.id,
        decisionMode,
      },
    }],
  };
}

export function buildClarificationCard(
  options: ClarificationCardOptions,
): CardJson {
  const { flow } = options;
  const question = flow.request.questions[flow.currentIndex];
  const current = flow.currentIndex + 1;
  const total = flow.request.questions.length;

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}（${current}/${total}）` },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: flow.request.title },
      subtitle: { tag: 'plain_text', content: `${current} / ${total}` },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        ...(flow.request.intro && flow.currentIndex === 0
          ? [{
            tag: 'markdown',
            content: escapeFeishuMarkdown(flow.request.intro),
          }]
          : []),
        ...(flow.answers.length
          ? [
            {
              tag: 'markdown',
              content: `**已确认 ${flow.answers.length} 项**\n\n${clarificationAnswerSummary(flow)}`,
            },
            { tag: 'hr' },
          ]
          : []),
        {
          tag: 'markdown',
          content: `**${escapeFeishuMarkdown(question.prompt)}**\n\n选择最符合预期的一项：`,
        },
        ...question.options.map((option) => clarificationButton(flow, option)),
        clarificationDecisionButton(flow, 'current'),
        { tag: 'hr' },
        {
          tag: 'form',
          name: `clarify_${flow.token.slice(0, 8)}`,
          vertical_spacing: '8px',
          elements: [
            {
              tag: 'input',
              name: 'custom_answer',
              placeholder: {
                tag: 'plain_text',
                content: '都不合适？在这里写下你的答案',
              },
              max_length: 500,
            },
            {
              tag: 'button',
              name: 'submit_custom',
              action_type: 'form_submit',
              text: { tag: 'plain_text', content: '提交自定义答案' },
              type: 'primary',
              width: 'default',
              size: 'medium',
              value: {
                action: 'answer_clarification',
                flowToken: flow.token,
                questionId: question.id,
                custom: true,
              },
            },
          ],
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: '不想逐项选择？Agent 会保留你已经确认的答案，并为剩余问题采用推荐方案。',
        },
        clarificationDecisionButton(flow, 'remaining'),
      ],
    },
  };
}

export function buildClarificationContinuingCard(
  flow: ClarificationFlow,
): CardJson {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：正在整理` },
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: `${flow.request.title} · 正在整理`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [{
        tag: 'markdown',
        content: [
          '**答案已收到**',
          '正在基于这些选择继续处理，无需重复点击。',
          `**已确认 ${flow.answers.length} 项**\n\n${clarificationAnswerSummary(flow)}`,
        ].join('\n\n'),
      }],
    },
  };
}

export function buildClarificationRetryCard(flow: ClarificationFlow): CardJson {
  return {
    schema: '2.0', config: { update_multi: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: '答案已保存，整理可重试' } },
    body: { elements: [
      { tag: 'markdown', content: '上次整理未完成。已确认的答案会继续保留，也可以在话题中补充信息。' },
      { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '重新整理' }, behaviors: [{ type: 'callback', value: {
        action: 'answer_clarification', flowToken: flow.token,
        questionId: flow.request.questions[flow.request.questions.length - 1].id,
        decisionMode: 'remaining',
      } }] },
    ] },
  };
}

export function buildClarificationSupersededCard(
  flow: ClarificationFlow,
): CardJson {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：已收到新的补充` },
    },
    header: {
      template: 'grey',
      title: {
        tag: 'plain_text',
        content: `${flow.request.title} · 已更新`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [{
        tag: 'markdown',
        content: [
          '**已收到你在话题里的新消息**',
          '这张卡片已经失效，Agent OS 正在沿用同一个任务上下文处理新的补充。',
          flow.answers.length
            ? `此前已确认 ${flow.answers.length} 项，相关答案会一并带入。`
            : '',
        ].filter(Boolean).join('\n\n'),
      }],
    },
  };
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function buildResumeCard(options: ResumeCardOptions): CardJson {
  const elements: Record<string, unknown>[] = options.sessions.length
    ? options.sessions.flatMap((session, index) => {
      const current = session.id === options.currentCliSessionId;
      const row: Record<string, unknown> = {
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: '12px',
        columns: [
          {
            tag: 'column',
            width: 'weighted',
            weight: 4,
            elements: [{
              tag: 'markdown',
              content: `**${escapeFeishuMarkdown(session.title)}**\n_${formatSessionTime(session.updatedAt)} · ${session.id.slice(0, 8)}_`,
            }],
          },
          {
            tag: 'column',
            width: 'auto',
            vertical_align: 'center',
            elements: current
              ? [{ tag: 'markdown', content: '**当前会话**' }]
              : [{
                tag: 'button',
                text: { tag: 'plain_text', content: '恢复' },
                type: 'primary_filled',
                size: 'medium',
                behaviors: [{
                  type: 'callback',
                  value: {
                    action: 'resume_cli_session',
                    agentSessionId: options.agentSessionId,
                    cliSessionId: session.id,
                  },
                }],
              }],
          },
        ],
      };
      return index === options.sessions.length - 1 ? [row] : [row, { tag: 'hr' }];
    })
    : [{
      tag: 'markdown',
      content: '当前工作目录里还没有可以恢复的 CLI 会话。先完成一次任务，再用 `/new` 开启新会话。',
    }];

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${options.cliName}：选择历史会话` },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '恢复历史会话' },
      subtitle: { tag: 'plain_text', content: options.cliName },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        { tag: 'markdown', content: '选择后，当前话题会继续使用对应的 CLI 上下文。' },
        ...elements,
      ],
    },
  };
}

export function buildSessionNoticeCard(
  options: SessionNoticeCardOptions,
): CardJson {
  return {
    schema: '2.0',
    config: { summary: { content: options.title } },
    header: {
      template: options.template ?? 'blue',
      title: { tag: 'plain_text', content: options.title },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [{ tag: 'markdown', content: options.detail }],
    },
  };
}

export function buildCollaborationCard(
  options: CollaborationCardOptions,
): CardJson {
  const isLastRound = options.round >= options.maxRounds;
  const title = '协作任务已派发';
  const footer = isLastRound
    ? `这是当前任务允许的最后一次交接；结果会通知 ${options.reportToName}，由他决定下一步。`
    : `完成后，结果会自动交回 ${options.reportToName} 继续组织后续工作。`;

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${title}：${options.objective}` },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: title },
      subtitle: {
        tag: 'plain_text',
        content: `${options.senderName} → ${options.targetName}`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: `**${options.targetName}，请接手：${escapeFeishuMarkdown(options.objective)}**`,
        },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_spacing: '16px',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 3,
              elements: [{
                tag: 'markdown',
                content: `**项目**\n${escapeFeishuMarkdown(options.workspaceName)}`,
              }],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 2,
              elements: [{
                tag: 'markdown',
                content: `**结果交给**\n${escapeFeishuMarkdown(options.reportToName)}`,
              }],
            },
          ],
        },
        {
          tag: 'collapsible_panel',
          expanded: false,
          header: collapsibleHeader('查看任务说明'),
          vertical_spacing: '8px',
          padding: '8px 8px 8px 8px',
          elements: [{
            tag: 'markdown',
            content: escapeFeishuMarkdown(
              markdownPreview(options.instruction, MAX_CARD_ANSWER_LENGTH),
            ),
          }],
        },
        ...(options.expectedOutput
          ? [
              { tag: 'hr' },
              {
                tag: 'markdown',
                content: `**期望产出**\n${escapeFeishuMarkdown(options.expectedOutput)}`,
              },
            ]
          : []),
        { tag: 'hr' },
        { tag: 'markdown', content: `_${footer}_` },
      ],
    },
  };
}

export function buildTeamCard(options: TeamCardOptions): CardJson {
  const leader = options.members.find((member) => member.isLeader);
  const memberElements = options.members.map((member) => {
    const badges = [
      member.isLeader ? 'Team Leader' : '',
      member.ready ? '已连接' : '未连接',
    ].filter(Boolean).join(' · ');
    const skills = member.skills.length > 0
      ? member.skills.map((skill) => `$${skill}`).join('、')
      : '无';
    return {
      tag: 'markdown',
      content: [
        `**${escapeFeishuMarkdown(member.displayName)}**  _${badges}_`,
        `${escapeFeishuMarkdown(member.role)}`,
        `引擎：${escapeFeishuMarkdown(member.cliName)}　Skill：${escapeFeishuMarkdown(skills)}`,
      ].join('\n'),
    };
  });

  return {
    schema: '2.0',
    config: {
      summary: { content: `Agent 团队：${options.members.length} 位成员` },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'Agent 团队' },
      subtitle: {
        tag: 'plain_text',
        content: leader
          ? `${options.members.length} 位成员 · ${leader.displayName} 负责统筹`
          : `${options.members.length} 位成员`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: '每位成员使用自己的飞书身份、执行引擎和项目 Skill，工作目录与会话彼此独立。',
        },
        { tag: 'hr' },
        ...memberElements,
      ],
    },
  };
}


function productDocumentList(flow: ProductSpecFlow): string {
  const request = flow.request;
  if (request.deliveryMode === 'lark-doc') {
    return `☁️ **飞书云文档** · [打开文档](${request.documentUrl})`;
  }
  if ('designPath' in request) {
    return `📐 **架构设计** · \`${escapeFeishuMarkdown(request.designPath)}\``;
  }
  return [
    `📘 **Spec** · \`${escapeFeishuMarkdown(request.specPath)}\``,
    `🎫 **Tickets** · \`${escapeFeishuMarkdown(request.ticketsPath)}\``,
  ].join('\n');
}

export function buildProductSpecApprovalCard(
  flow: ProductSpecFlow,
): CardJson {
  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: [
        `**${escapeFeishuMarkdown(flow.request.title)}**`,
        escapeFeishuMarkdown(flow.request.summary),
      ].join('\n\n'),
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content: `**共享产物**\n${productDocumentList(flow)}`,
    },
  ];

  // W5 返修（work/44-5 / work/45-6）：无法确认的 flow 展示准确的 blocked 原因，
  // 不放误导性的可点确认按钮——飞书模式（U-3，digest 恒 null）、本地未绑定摘要
  // 的旧记录、以及知识基准 degraded（G1 必拒且例外通道未开放）都必然被拒。
  const blockedReason = flow.request.deliveryMode === 'lark-doc'
    ? '飞书文档完整回读能力尚未核验（U-3）：这份方案的确认与编码暂时 blocked，需要改用本地交付或等待能力核验。'
    : flow.content_digest == null
      ? '这份方案没有绑定内容摘要（旧记录或绑定未完成）：不能确认，请让产品成员重新生成方案。'
      : flow.knowledge_state === 'degraded'
        ? '知识基准不可用（degraded）：兼容性分析 incomplete，需要用户明确确认例外；例外确认通道尚未开放，暂时无法确认。'
        : flow.knowledge_state === 'no_current_objects'
          ? '知识库没有任何可作为现行事实的对象（no_current_objects）：PRD 不得引用现行事实；例外确认通道尚未开放，暂时无法确认。'
          : null;

  if (blockedReason) {
    elements.push({
      tag: 'markdown',
      content: `**确认暂不可用（blocked）**\n${blockedReason}`,
    });
    elements.push({
      tag: 'markdown',
      content: '_确认后本轮流程结束，不会自动派发。需要实现时，请在确认后的卡片上通过「授权开发」按钮显式发起编码授权（需提供允许路径并二次确认）。_',
    });
    return {
      schema: '2.0',
      config: {
        update_multi: true,
        summary: { content: `${flow.request.title}：确认暂不可用` },
      },
      header: {
        template: 'grey',
        title: { tag: 'plain_text', content: '产品文档已生成' },
        subtitle: {
          tag: 'plain_text',
          content: '确认暂不可用（blocked）',
        },
      },
      body: {
        direction: 'vertical',
        vertical_spacing: '12px',
        elements,
      },
    };
  }

  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '确认产品方案' },
    type: 'primary_filled',
    width: 'fill',
    size: 'medium',
    behaviors: [{
      type: 'callback',
      value: {
        action: 'approve_product_spec',
        flowToken: flow.token,
      },
    }],
  });

  elements.push({
    tag: 'markdown',
    content: '_确认后本轮流程结束，不会自动派发。需要实现时，请 @ 开发并附上这份文档。_',
  });

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：待确认` },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '产品文档已生成' },
      subtitle: {
        tag: 'plain_text',
        content: flow.request.deliveryMode === 'lark-doc'
          ? '飞书云文档待确认'
          : '本地 Spec · Tickets 待确认',
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements,
    },
  };
}

export function buildProductSpecApprovedCard(
  flow: ProductSpecFlow,
): CardJson {
  const isPrd = (flow.artifact_kind ?? 'prd') === 'prd';
  const actionButtons = [
    ...(isPrd
      ? [{
          tag: 'button',
          text: { tag: 'plain_text', content: '转架构设计（交开发）' },
          type: 'default',
          width: 'fill',
          size: 'medium',
          behaviors: [{
            type: 'callback',
            value: {
              action: 'handoff_architecture',
              flowToken: flow.token,
            },
          }],
        } satisfies Record<string, unknown>]
      : []),
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '授权开发' },
      type: 'default',
      width: 'fill',
      size: 'medium',
      behaviors: [{
        type: 'callback',
        value: {
          action: 'authorize_coding',
          flowToken: flow.token,
        },
      }],
    } satisfies Record<string, unknown>,
  ];
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：已确认` },
    },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: isPrd ? '产品方案已确认' : '架构设计已确认' },
      subtitle: { tag: 'plain_text', content: isPrd ? '产品阶段已就绪' : '架构阶段已就绪' },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [{
        tag: 'markdown',
        content: [
          `**${escapeFeishuMarkdown(flow.request.title)}**`,
          escapeFeishuMarkdown(flow.request.summary),
          `**已确认${isPrd ? '文档' : '产物'}**\n${productDocumentList(flow)}`,
          flow.approvedAt
            ? `确认时间：${escapeFeishuMarkdown(flow.approvedAt)}`
            : '',
          isPrd
            ? '_确认记录已保存，本轮流程到此结束，没有自动派发后续任务。需要实现时，请通过下方或本卡的「授权开发」按钮显式发起编码授权（需提供允许路径并二次确认）。_'
            : '_确认记录已保存。架构确认不等于允许开发：需要编码时，请通过下方「授权开发」按钮显式发起编码授权（需提供允许路径并二次确认）。_',
        ].filter(Boolean).join('\n\n'),
      }, ...actionButtons],
    },
  };
}

/**
 * 编码授权草稿卡（T-021）：展示**完整**授权内容后，必须第二次明确确认才
 * active。草稿只在有效期内可确认；不确认不产生任何效力。
 */
export function buildCodingAuthorizationDraftCard(record: CodingAuthorizationRecord): CardJson {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `编码授权草稿：${record.id}` },
    },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '编码授权草稿（待二次确认）' },
      subtitle: { tag: 'plain_text', content: '确认前不产生任何效力' },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            '**授权内容（请逐项核对）**',
            `授权对象（PRD）：\`${record.prdFlowToken}\` · 摘要 \`${record.prdDigest.slice(0, 16)}…\``,
            record.architectureFlowToken
              ? `架构设计：\`${record.architectureFlowToken}\` · 摘要 \`${record.architectureDigest?.slice(0, 16)}…\``
              : '架构设计：无（仅 PRD 授权）',
            `工作区真实路径：\`${escapeFeishuMarkdown(record.workspaceRealpath)}\``,
            `允许路径：${record.allowedPaths.map((path) => `\`${escapeFeishuMarkdown(path)}\``).join('、')}${record.pendingPathRecheck ? '（含尚未存在的路径，使用前会复核）' : ''}`,
            `有效期至：${escapeFeishuMarkdown(record.expiresAt)}`,
            `授权发起人：\`${escapeFeishuMarkdown(record.requesterOpenId)}\``,
            record.statusReason ? `备注：${escapeFeishuMarkdown(record.statusReason)}` : '',
          ].filter(Boolean).join('\n'),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '确认授权（第二次确认）' },
          type: 'primary_filled',
          width: 'fill',
          size: 'medium',
          behaviors: [{
            type: 'callback',
            value: {
              action: 'confirm_coding_authorization',
              authorizationId: record.id,
            },
          }],
        },
        {
          tag: 'markdown',
          content: '_确认后授权进入 active 并可随时撤销；执行层读写隔离（每引擎 canary）通过前，授权只作为数据模型，不会启动真实编码任务。_',
        },
      ],
    },
  };
}

/** active 授权卡：可查询、可撤销。主状态明确「记录已确认、编码仍阻断」（84 号 P2）。 */
export function buildCodingAuthorizationActiveCard(record: CodingAuthorizationRecord): CardJson {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `编码授权记录已确认：${record.id}` },
    },
    header: {
      template: 'yellow',
      title: { tag: 'plain_text', content: '授权记录已确认（启动前复核）' },
      subtitle: { tag: 'plain_text', content: `有效期至 ${record.expiresAt}` },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            '⚠️ **授权只是数据记录：执行层读写隔离（T-022 每引擎 canary）未通过前，不会启动任何真实编码任务。**',
            `授权 ID：\`${record.id}\``,
            `PRD：\`${record.prdFlowToken}\` · 摘要 \`${record.prdDigest.slice(0, 16)}…\``,
            record.architectureFlowToken
              ? `架构设计：\`${record.architectureFlowToken}\` · 摘要 \`${record.architectureDigest?.slice(0, 16)}…\``
              : '',
            `工作区：\`${escapeFeishuMarkdown(record.workspaceRealpath)}\` · 允许路径：${record.allowedPaths.map((path) => `\`${escapeFeishuMarkdown(path)}\``).join('、')}`,
            `授权人：\`${escapeFeishuMarkdown(record.grantedBy ?? '')}\` · 确认时间：${escapeFeishuMarkdown(record.grantedAt ?? '')}`,
            `有效期至：${escapeFeishuMarkdown(record.expiresAt)}${record.pendingPathRecheck ? '（含待复核路径，使用前复核）' : ''}`,
          ].filter(Boolean).join('\n'),
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '开始开发' },
          type: 'primary',
          behaviors: [{ type: 'callback', value: { action: 'start_coding', authorizationId: record.id } }],
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '撤销授权' },
          type: 'danger',
          width: 'fill',
          size: 'medium',
          behaviors: [{
            type: 'callback',
            value: {
              action: 'revoke_coding_authorization',
              authorizationId: record.id,
            },
          }],
        },
        {
          tag: 'markdown',
          content: '_上游方案失效、超期或撤销都会使授权立即不可用。_',
        },
      ],
    },
  };
}

/** 终态授权卡（expired/revoked/invalidated）：不可用展示。 */
export function buildCodingAuthorizationInactiveCard(record: CodingAuthorizationRecord): CardJson {
  const label = record.status === 'expired' ? '已过期'
    : record.status === 'revoked' ? '已撤销'
      : record.status === 'invalidated' ? '已失效（级联）'
        : '不可用';
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `编码授权${label}：${record.id}` },
    },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: `编码授权${label}` },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [{
        tag: 'markdown',
        content: [
          `授权 ID：\`${record.id}\``,
          `PRD：\`${record.prdFlowToken}\` · 摘要 \`${record.prdDigest.slice(0, 16)}…\``,
          record.statusReason ? `原因：${escapeFeishuMarkdown(record.statusReason)}` : '',
          `有效期至：${escapeFeishuMarkdown(record.expiresAt)}`,
          '该授权不再可用；需要继续开发时请在当前有效的已确认制品卡片上重新发起授权。',
        ].filter(Boolean).join('\n'),
      }],
    },
  };
}

/**
 * 架构交接卡（T-020）：已确认 PRD 的 owner 点击「转架构设计」后展示。
 * 交接码由服务端签发（唯一、单次使用、绑定创建者）；用户把它带给开发 Bot，
 * 开发提交架构设计时由服务端核验——CLI/正文自报的上游一律不被采信。
 * 交接只是发起架构阶段：不构成架构批准，也不构成编码授权。
 */
export function buildArchitectureHandoffCard(options: {
  handoffToken: string;
  flow: ProductSpecFlow;
}): CardJson {
  const { flow } = options;
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：架构交接已创建` },
    },
    header: {
      template: 'turquoise',
      title: { tag: 'plain_text', content: '架构交接已创建' },
      subtitle: { tag: 'plain_text', content: '待开发 Bot 提交架构设计' },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            `**${escapeFeishuMarkdown(flow.request.title)}**`,
            `上游确认版本：\`${flow.content_digest?.slice(0, 16) ?? ''}…\`（${escapeFeishuMarkdown(flow.approvedAt ?? '')}）`,
          ].filter(Boolean).join('\n\n'),
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: [
            '**架构交接码（单次有效，仅任务发起人可用）**',
            `\`${options.handoffToken}\``,
            '在新话题 @ 开发成员，并把这段交接码原样带给它。开发成员完成架构设计后会用 `request_architecture_review` 提交设计与这段交接码，由 Agent OS 校验绑定关系。',
            '这次交接不等于批准架构，也不等于允许编码：架构设计完成后仍需你在架构卡片上单独确认；编码授权是另一个独立步骤（尚未开放）。',
          ].join('\n\n'),
        },
      ],
    },
  };
}

/** 架构设计的待确认卡：独立的确认动作（approve_architecture），不复用 PRD 确认。 */
export function buildArchitectureApprovalCard(flow: ProductSpecFlow): CardJson {
  const upstream = flow.upstream;
  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: [
        `**${escapeFeishuMarkdown(flow.request.title)}**`,
        escapeFeishuMarkdown(flow.request.summary),
      ].join('\n\n'),
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content: `**架构产物**\n${productDocumentList(flow)}`,
    },
    {
      tag: 'markdown',
      content: `**上游产品方案**\n确认版本 \`${upstream ? `${upstream.prdDigest.slice(0, 16)}…` : '（缺失）'}\`${
        upstream?.approvedAt ? ` · ${escapeFeishuMarkdown(upstream.approvedAt)}` : ''}${
        (upstream?.knowledgeRefs?.length ?? 0) > 0 ? ` · 继承 ${upstream!.knowledgeRefs.length} 条知识引用` : ''
      }`,
    },
  ];

  const blockedReason = flow.request.deliveryMode === 'lark-doc'
    ? '飞书文档完整回读能力尚未核验（U-3）：这份架构设计的确认与编码暂时 blocked。'
    : flow.upstream == null
      ? '这份架构设计没有绑定上游产品方案（服务端交接缺失），不能确认。'
      : flow.content_digest == null
        ? '这份架构设计没有绑定内容摘要（旧记录或绑定未完成）：不能确认，请让开发成员重新提交。'
        : flow.knowledge_state === 'degraded'
          ? '上游方案生成时知识基准不可用（degraded）：需要用户明确确认例外；例外确认通道尚未开放。'
          : flow.knowledge_state === 'no_current_objects'
            ? '上游方案生成时知识库没有可作为现行事实的对象（no_current_objects）：例外确认通道尚未开放。'
            : null;

  if (blockedReason) {
    elements.push({
      tag: 'markdown',
      content: `**确认暂不可用（blocked）**\n${blockedReason}`,
    });
    elements.push({
      tag: 'markdown',
      content: '_架构确认与编码授权是分开的状态；确认通道 blocked 时不会自动放行任何实现。_',
    });
    return {
      schema: '2.0',
      config: {
        update_multi: true,
        summary: { content: `${flow.request.title}：确认暂不可用` },
      },
      header: {
        template: 'grey',
        title: { tag: 'plain_text', content: '架构设计已生成' },
        subtitle: { tag: 'plain_text', content: '确认暂不可用（blocked）' },
      },
      body: { direction: 'vertical', vertical_spacing: '12px', elements },
    };
  }

  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '确认架构设计' },
    type: 'primary_filled',
    width: 'fill',
    size: 'medium',
    behaviors: [{
      type: 'callback',
      value: {
        action: 'approve_architecture',
        flowToken: flow.token,
      },
    }],
  });
  elements.push({
    tag: 'markdown',
    content: '_确认架构设计只结束架构阶段，不会自动开始编码；编码授权需要你单独发起（尚未开放）。上游 PRD 失效时这份架构确认会级联失效。_',
  });

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：待确认` },
    },
    header: {
      template: 'purple',
      title: { tag: 'plain_text', content: '架构设计已生成' },
      subtitle: { tag: 'plain_text', content: '本地架构设计待确认' },
    },
    body: { direction: 'vertical', vertical_spacing: '12px', elements },
  };
}

export function buildProductSpecExpiredCard(
  flow: ProductSpecFlow,
  reason?: string,
): CardJson {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：已失效` },
    },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: '产品方案确认已失效' },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [{
        tag: 'markdown',
        content: [
          `**${escapeFeishuMarkdown(flow.request.title)}**`,
          reason
            ? `方案已失效：${escapeFeishuMarkdown(reason)}。请查看话题中最新的确认卡或重新生成方案。`
            : '同一任务已经提交了更新的产品方案，请查看话题中最新的确认卡。',
        ].join('\n\n'),
      }],
    },
  };
}

/**
 * 旧 approved 未绑定摘要 / 已失效的 flow：确认记录不可用，不得让用户误认
 * 已绑定有效版本（W5 返修：展示与处理都标不可用）。
 */
export function buildProductSpecUnusableApprovalCard(flow: ProductSpecFlow): CardJson {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：确认记录不可用` },
    },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: '产品方案确认记录不可用' },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [{
        tag: 'markdown',
        content: [
          `**${escapeFeishuMarkdown(flow.request.title)}**`,
          flow.invalidation_reason
            ? `这份方案的确认已失效：${escapeFeishuMarkdown(flow.invalidation_reason)}。`
            : '这份确认记录没有绑定内容摘要（旧记录或未完成绑定），不能作为有效版本使用。',
          '需要实现时，请让产品成员重新生成方案并重新确认；旧的确认不能再用于授权编码。',
        ].filter(Boolean).join('\n\n'),
      }],
    },
  };
}

export function answerNeedsContinuation(answer: string): boolean {
  return answer.length > MAX_CARD_ANSWER_LENGTH;
}

export function answerContinuation(answer: string): string {
  return answer.slice(markdownSplitIndex(answer, MAX_CARD_ANSWER_LENGTH));
}

export function splitLongText(text: string, maxLength = FEISHU_TEXT_LIMIT): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 1) throw new Error('分段长度必须为正整数');
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += maxLength) {
    chunks.push(characters.slice(offset, offset + maxLength).join(''));
  }
  return chunks;
}

type UpdateCard = (card: CardJson) => Promise<void>;

/** 一秒窗口内无论 push 多少次，只提交最新的一张卡片。 */
export class ThrottledCardUpdater {
  private pendingCard: CardJson | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private updateChain: Promise<void> = Promise.resolve();
  private closed = false;
  private finalUpdate: Promise<void> | undefined;

  constructor(
    private readonly updateCard: UpdateCard,
    private readonly intervalMs = 1_000,
  ) {}

  push(card: CardJson): void {
    if (this.closed) return;
    this.pendingCard = card;
    this.schedule();
  }

  async finish(finalCard: CardJson): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingCard = undefined;
    if (this.finalUpdate) return this.finalUpdate;
    this.finalUpdate = (async () => {
      await this.updateChain;
      await this.updateCard(finalCard);
    })();
    try { await this.finalUpdate; }
    catch (error) { this.finalUpdate = undefined; throw error; }
  }

  async cancel(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingCard = undefined;
    await this.updateChain.catch(() => undefined);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushPending();
    }, this.intervalMs);
  }

  private flushPending(): void {
    const card = this.pendingCard;
    this.pendingCard = undefined;
    if (!card || this.closed) return;

    this.updateChain = this.updateChain
      .then(() => this.updateCard(card))
      .catch((error) => {
        console.warn('[卡片] 进度更新失败，后续更新继续:', (error as Error).message);
      })
      .finally(() => {
        if (this.pendingCard && !this.closed) this.schedule();
      });
  }
}
