/**
 * 普通文本授权指令的**识别与拒绝**（work/76：普通文本「可以开发了」没有可靠
 * 的 flow 定位——IncomingMessage 不含被回复卡片 ID，不能猜测制品，更不能自动
 * 授权）。识别结果只用于提示用户走显式卡片入口；绝不据此创建/激活授权。
 *
 * 匹配刻意保守：只匹配整句的授权口令（去首尾空白与标点后全等），不做子串
 * 匹配——正常任务文本（如「评估什么时候可以开发了」）不会被拦截。
 */
const CODING_AUTHORIZATION_PHRASES = new Set([
  '可以开发了',
  '可以开发',
  '同意开发',
  '批准开发',
  '允许开发',
  '开始开发',
  '可以编码',
  '开始编码',
  '允许编码',
  '可以实现了',
  '开始实现',
]);

export function looksLikeCodingAuthorizationText(text: string): boolean {
  const normalized = text.trim().replace(/[。！!，,？?\s]+$/u, '').trim();
  return CODING_AUTHORIZATION_PHRASES.has(normalized);
}

export const CODING_AUTHORIZATION_TEXT_HINT = [
  '检测到你可能想授权开发，但普通文本没有可靠的制品定位，不能自动创建授权。',
  '请在已确认的产品方案或架构设计卡片上点击「授权开发」，核对授权草稿（工作区、允许路径、有效期）后二次确认才会生效。',
  '授权只是数据模型：执行层读写隔离（每引擎 canary）通过前，不会启动真实编码任务。',
].join('\n');
