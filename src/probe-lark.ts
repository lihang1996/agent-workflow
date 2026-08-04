/**
 * 飞书连接探针：只校验已配置 Bot 的凭证与机器人身份，不发送任何消息。
 */
import 'dotenv/config';
import * as Lark from '@larksuiteoapi/node-sdk';
import { loadBotConfigs } from './core/bot-config.js';

interface BotInfoResponse {
  code?: number;
  msg?: string;
  bot?: { open_id?: string; app_name?: string };
  data?: { bot?: { open_id?: string; app_name?: string } };
}

const configs = loadBotConfigs();
if (configs.length === 0) {
  console.error('未找到 Bot 凭证。请先复制 .env.example 为 .env，并配置至少一组 BOT_* 凭证。');
  process.exitCode = 1;
} else {
  let failures = 0;
  for (const config of configs) {
    try {
      const client = new Lark.Client({ appId: config.appId, appSecret: config.appSecret });
      const response = await client.request({
        url: '/open-apis/bot/v3/info',
        method: 'GET',
      }) as BotInfoResponse;
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(`飞书返回 ${response.code}：${response.msg ?? '未知错误'}`);
      }
      const info = response.bot ?? response.data?.bot;
      if (!info?.open_id) throw new Error('响应缺少 open_id，请确认应用已启用机器人能力');
      console.log(`✅ ${config.id}（${config.name}）凭证有效，open_id=${info.open_id}`);
    } catch (error) {
      failures += 1;
      console.error(`❌ ${config.id}（${config.name}）连接检查失败：${(error as Error).message}`);
    }
  }
  if (failures > 0) process.exitCode = 1;
  else console.log(`飞书连接检查通过：${configs.length} 个 Bot 均可读取机器人身份。`);
}
