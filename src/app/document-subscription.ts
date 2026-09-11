import type { Bot } from '../im/lark.js';
export async function subscribeDocumentComments(bot: Bot, botId: string): Promise<boolean> {
  try { await bot.subscribeToDocumentComments(); return true; }
  catch (error) {
    console.warn(`[Bot ${botId}] 评论订阅不可用，聊天和方案确认仍可使用。请检查此 Bot 应用的评论事件权限、订阅身份与文档访问权限：`, (error as Error).message);
    return false;
  }
}
