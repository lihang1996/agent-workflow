import type { Bot } from '../im/lark.js';
import { compactAgentOutput } from './agent-output.js';

/** 话题协作状态的唯一键。 */
export function collabTopicKey(chatId: string, threadId: string): string {
  return `${chatId}:${threadId}`;
}

/** 解析 COLLAB_MAX_ROUNDS，非法值回退为 2。 */
export function parseMaxRounds(value: string | undefined): number {
  const n = Number(value ?? 2);
  if (!Number.isFinite(n) || n < 1) return 2;
  return Math.min(10, Math.floor(n));
}

/** 去掉常见 Markdown 强调包裹，便于识别 **[APPROVED]** / **LGTM**。 */
function stripMarkdownEmphasis(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
    .replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '$1');
}

/** 从一行里抽出「结论」后半段；没有结论前缀则返回整行。 */
function extractConclusion(line: string): string {
  const stripped = stripMarkdownEmphasis(
    line
      .trim()
      .replace(/^(?:[-*+]\s+|#{1,6}\s*)/, ''),
  ).trim();
  const matched = stripped.match(/(?:^|.*?)(?:最终)?(?:复审|评审|审核)?结论\s*[:：]\s*(.+)$/i);
  return (matched?.[1] ?? stripped).trim();
}

type ReviewDecision = 'approved' | 'rejected';

function lastReviewDecision(answer: string, explicitMarkerOnly: boolean): ReviewDecision | undefined {
  let decision: ReviewDecision | undefined;
  for (const line of answer.normalize('NFKC').split(/\r?\n/)) {
    const conclusion = extractConclusion(line);
    if (/^(?:未通过|不通过|拒绝|不可合并|仍需修改|需要修改|\[REJECTED\])(?:$|[\s。.!！,，(（])/i.test(conclusion)) {
      decision = 'rejected';
      continue;
    }
    if (/^\[APPROVED\](?:\s*[。.!！])?$/i.test(conclusion)) {
      decision = 'approved';
      continue;
    }
    if (!explicitMarkerOnly && (
      /^LGTM(?:\s*[。.!！])?$/i.test(conclusion)
      || /^(?:评审通过|审核通过|复审通过|可以合并|无需修改|通过)(?:\s*[。.!！✅✔]?)*$/.test(conclusion)
    )) {
      decision = 'approved';
    }
  }
  return decision;
}

/** 普通独立评审支持明确自然语言，以最后一个决定为准。 */
export function isReviewApproved(answer: string): boolean {
  return lastReviewDecision(answer, false) === 'approved';
}

/** 结构化门禁只接受独立 [APPROVED] 标记，后续拒绝结论会覆盖旧标记。 */
export function isReviewExplicitlyApproved(answer: string): boolean {
  return lastReviewDecision(answer, true) === 'approved';
}

/** 构造首轮评审 prompt。 */
export function buildInitialReviewPrompt(task: string, round: number): string {
  return [
    `【代码评审 · 第 ${round} 轮】`,
    '请审查当前话题项目目录中的代码/改动，给出：',
    '1) 问题与风险（按严重程度）',
    '2) 修改建议',
    '3) 若无明显问题，请在结论中明确写上 [APPROVED]',
    '4) 完整交付流水线中必须另起一行 [RESULT:done|blocked|failed]：通过或未通过都用 [RESULT:done]；未通过时不要写 [APPROVED]，系统会回传开发。禁止把「发现需改代码」写成 [RESULT:failed]（那会停掉流水线）',
    '',
    `评审目标：${task}`,
  ].join('\n');
}

/** 构造「按评审意见修复」prompt。 */
export function buildFixFromReviewPrompt(
  reviewer: Bot,
  review: string,
  round: number,
  fixInstruction?: string,
): string {
  return [
    `【协作修复 · 第 ${round} 轮】来自 ${reviewer.name}（${reviewer.id}）的评审意见`,
    '请根据以下意见修改代码，并简要说明你做了哪些改动：',
    '',
    compactAgentOutput(review),
    ...(fixInstruction ? ['', '本轮修复的强制交付要求：', fixInstruction] : []),
  ].join('\n');
}

/** 构造复审 prompt（带上开发修改说明）。 */
export function buildFollowUpReviewPrompt(task: string, round: number, devResult: string): string {
  return [
    `【代码复审 · 第 ${round} 轮】`,
    `原始目标：${task}`,
    '开发已根据上一轮意见完成修改，说明如下：',
    compactAgentOutput(devResult),
    '',
    '请复查是否已解决。若通过请写 [APPROVED] 并输出 [RESULT:done]；否则不要写 [APPROVED]，仍输出 [RESULT:done] 让系统继续回传开发。禁止用 [RESULT:failed] 停掉流水线。',
  ].join('\n');
}
