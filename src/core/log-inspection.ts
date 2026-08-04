import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

/** 创建日志巡检任务前确认目标是一个可读取的普通文件。 */
export async function assertLogFile(path: string): Promise<string> {
  const absolute = resolve(path);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new Error(`日志文件不存在: ${absolute}`);
  }
  if (!info.isFile()) throw new Error(`日志路径不是文件: ${absolute}`);
  return absolute;
}

/** 只读巡检 prompt，明确禁止 Agent 修改生产日志。 */
export function buildLogInspectionPrompt(logPath: string): string {
  return [
    '【定时服务端日志巡检】',
    `日志文件：${logPath}`,
    '请以只读方式检查最近 500 行日志，归纳错误、异常频率、影响等级和下一步建议。',
    '不得修改、删除、截断日志，也不要执行重启、部署或任何高权限操作。',
    '若发现 P0/P1 风险，先明确说明风险和建议，再等待人工审批。',
  ].join('\n');
}
