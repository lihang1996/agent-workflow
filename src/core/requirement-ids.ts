// Markdown-aware scanner：只把"需求条目开头"的编号视为 canonical requirement。
// 排除 fenced code block 内的格式示例（例如"请使用 RQ-001"）。
// 支持标题、列表、复选框、表格首列、加粗前缀和反引号包裹。

/** 去掉 fenced code block（``` 和 ~~~），防止代码示例中的 ID 被误提取。 */
function stripFencedCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
}

/** 去掉行内代码（`RQ-001`），防止行内代码示例被误提取。 */
function stripInlineCode(content: string): string {
  return content.replace(/`[^`\n]+`/g, '');
}

const REQUIREMENT_ID_PATTERN = /^\s*(?:(?:#{1,6}|[-*+]|\*{1,2}|\d+[.)])\s+)?(?:\[[ xX]\]\s+)?(?:\|\s*)?((?:RQ|REQ)-[A-Z0-9][A-Z0-9._-]{0,63})\b/gim;

/** 从 canonical Spec 提取稳定需求 ID；统一大写并保持首次出现顺序。 */
export function extractRequirementIds(content: string): string[] {
  const cleaned = stripInlineCode(stripFencedCodeBlocks(content));
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const match of cleaned.matchAll(REQUIREMENT_ID_PATTERN)) {
    const id = match[1].toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
