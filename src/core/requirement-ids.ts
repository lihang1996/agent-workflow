// 只把“需求条目开头”的编号视为 canonical requirement，避免正文中的格式示例
//（例如“请使用 RQ-001”）被误当成一条真实需求。支持标题、列表、复选框和表格首列。
const REQUIREMENT_ID_PATTERN = /^\s*(?:(?:#{1,6}|[-*+]|\d+[.)])\s+)?(?:\[[ xX]\]\s+)?(?:\|\s*)?((?:RQ|REQ)-[A-Z0-9][A-Z0-9._-]{0,63})\b/gim;

/** 从 canonical Spec 提取稳定需求 ID；统一大写并保持首次出现顺序。 */
export function extractRequirementIds(content: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const match of content.matchAll(REQUIREMENT_ID_PATTERN)) {
    const id = match[1].toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
