const DEFAULT_CONTEXT_LIMIT = 6_000;

/**
 * Agent 的原始回答同时承载人类说明和流水线机器协议。
 * 机器协议只供控制器解析，绝不能原样进入飞书卡片或后续 Agent 上下文。
 */
export function humanReadableAgentOutput(answer: string): string {
  let visible = answer.replace(/\r\n?/g, '\n');

  // GATE_RESULT 按协议必须位于正文末尾。发现真实 JSON 标记后，后续内容全部视为机器区，
  // 这也一并隔离模型偶发追加的 DSML / tool_calls 垃圾。
  // P1 修复：与 GATE parser 的允许装饰对齐，接受 ** 加粗前缀和冒号。
  const gateMarker = visible.search(
    /(?:^|\n)\s*(?:\*{0,2}|`{1,3})?\[GATE_RESULT\]\s*[:\s]*(?=\{)/,
  );
  if (gateMarker >= 0) visible = visible.slice(0, gateMarker);

  const dsmlMarker = visible.search(/(?:^|\n)\s*<\/?[^\n>]*(?:DSML|tool_calls)[^\n>]*>/i);
  if (dsmlMarker >= 0) visible = visible.slice(0, dsmlMarker);

  visible = visible
    .split('\n')
    .filter((line) => {
      const normalized = line
        .trim()
        .replace(/^\*\*(.+)\*\*$/, '$1')
        .trim();
      return !/^\[RESULT:\s*(?:done|blocked|failed)(?:[^\]]*)\]/i.test(normalized)
        && !/^\[APPROVED\][。.!！✅✔]*$/i.test(normalized);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return visible;
}

/** 为持久化/跨角色提示词生成有界的人类上下文，避免全量历史指数膨胀。 */
export function compactAgentOutput(
  answer: string,
  maxLength = DEFAULT_CONTEXT_LIMIT,
): string {
  const visible = humanReadableAgentOutput(answer);
  if (visible.length <= maxLength) return visible;
  if (maxLength < 200) return `${visible.slice(0, Math.max(0, maxLength - 1))}…`;

  const marker = '\n\n…（中间内容已省略；完整结构化证据请读取 evidenceRoot）…\n\n';
  const available = Math.max(0, maxLength - marker.length);
  const headLength = Math.ceil(available * 0.7);
  const tailLength = Math.floor(available * 0.3);
  return `${visible.slice(0, headLength).trimEnd()}${marker}${visible.slice(-tailLength).trimStart()}`;
}

/** 卡片使用有界正文；无可见内容时不回退显示机器 JSON。 */
export function displayAgentOutput(answer: string, maxLength = DEFAULT_CONTEXT_LIMIT): string {
  return compactAgentOutput(answer, maxLength) || '本步骤已完成，结构化结果已保存到门禁证据。';
}
