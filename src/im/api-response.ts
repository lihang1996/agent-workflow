/** The SDK resolves HTTP 200 responses even when the API rejected the operation. */
export function assertLarkSuccess(response: { code?: number; msg?: string }, operation: string): void {
  if (response.code) throw new Error(`${operation}失败 (${response.code}): ${response.msg || '未知错误'}`);
}

export function requireMessageId(response: { code?: number; msg?: string; data?: { message_id?: string } }, operation: string): string {
  assertLarkSuccess(response, operation);
  if (!response.data?.message_id) throw new Error(`${operation}失败：飞书没有返回 message_id`);
  return response.data.message_id;
}
