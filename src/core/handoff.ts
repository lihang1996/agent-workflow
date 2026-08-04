import type { Bot } from '../im/lark.js';

const ROLE_ALIASES: Record<string, string[]> = {
  ceo: ['ceo', 'ceo助手', '总助', '老板'],
  pm: ['pm', '产品', '产品经理'],
  architect: ['architect', 'arch', '架构', '架构师'],
  dev: ['dev', 'developer', '开发', '开发工程师'],
  qa: ['qa', 'test', '测试', '测试工程师'],
  reviewer: ['reviewer', 'review', '评审', '代码评审'],
};

/** 解析 `/handoff <角色> <任务>` 参数。 */
export function parseHandoffArg(arg: string | undefined): { target: string; task: string } | undefined {
  if (!arg) return undefined;
  const match = /^(\S+)\s+(.+)$/s.exec(arg.trim());
  if (!match) return undefined;
  return { target: match[1], task: match[2].trim() };
}

/** 按 id / role / 显示名解析目标 Bot。 */
export function resolveHandoffTarget(query: string, bots: Iterable<Bot>): Bot | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;

  const list = [...bots];
  const byId = list.find((bot) => bot.id.toLowerCase() === q);
  if (byId) return byId;

  for (const [id, aliases] of Object.entries(ROLE_ALIASES)) {
    if (aliases.some((alias) => alias === q || q.includes(alias))) {
      const bot = list.find((item) => item.id === id);
      if (bot) return bot;
    }
  }

  return list.find((bot) => {
    const name = bot.name.trim().toLowerCase();
    return name === q || name.includes(q) || q.includes(name);
  });
}

/** 列出可交接的角色清单（用于帮助文案）。 */
export function listHandoffTargets(bots: Iterable<Bot>): string {
  return [...bots].map((bot) => `${bot.id}(${bot.name})`).join('，');
}

/** 构造交给目标 Bot 的任务 prompt。 */
export function buildHandoffPrompt(from: Bot, task: string): string {
  return [
    `【任务交接】来自 ${from.name}（${from.id}）`,
    '请在当前话题的项目工作目录中完成以下任务，完成后给出简洁结论：',
    task,
  ].join('\n');
}
