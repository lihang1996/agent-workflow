import type { Bot } from '../im/lark.js';

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

/** 评审结果是否判定为通过。 */
export function isReviewApproved(answer: string): boolean {
  return answer.normalize('NFKC').split(/\r?\n/).some((line) => {
    const conclusion = line
      .trim()
      .replace(/^(?:[-*+]\s+|#{1,6}\s*)/, '')
      .replace(/^(?:最终)?结论\s*[:：]\s*/i, '')
      .trim();
    return /^(?:\[APPROVED\]|LGTM)(?:\s*[。.!！])?$/i.test(conclusion)
      || /^(?:评审通过|审核通过|可以合并|无需修改)(?:\s*[。.!！])?$/.test(conclusion);
  });
}

/** 构造首轮评审 prompt。 */
export function buildInitialReviewPrompt(task: string, round: number): string {
  return [
    `【代码评审 · 第 ${round} 轮】`,
    '请审查当前话题项目目录中的代码/改动，给出：',
    '1) 问题与风险（按严重程度）',
    '2) 修改建议',
    '3) 若无明显问题，请在结论中明确写上 [APPROVED]',
    '',
    `评审目标：${task}`,
  ].join('\n');
}

/** 构造「按评审意见修复」prompt。 */
export function buildFixFromReviewPrompt(reviewer: Bot, review: string, round: number): string {
  return [
    `【协作修复 · 第 ${round} 轮】来自 ${reviewer.name}（${reviewer.id}）的评审意见`,
    '请根据以下意见修改代码，并简要说明你做了哪些改动：',
    '',
    review,
  ].join('\n');
}

/** 构造复审 prompt（带上开发修改说明）。 */
export function buildFollowUpReviewPrompt(task: string, round: number, devResult: string): string {
  return [
    `【代码复审 · 第 ${round} 轮】`,
    `原始目标：${task}`,
    '开发已根据上一轮意见完成修改，说明如下：',
    devResult,
    '',
    '请复查是否已解决。若通过请写 [APPROVED]；否则继续给出问题与修改建议。',
  ].join('\n');
}
