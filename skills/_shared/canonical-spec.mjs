/**
 * 流水线 Spec markdown 的本地校验，与控制器 parseCanonicalSpecWaivers /
 * extractRequirementIds 对齐：RQ 条目开头、waiver 必须是紧跟标记的完整 JSON。
 * 本地脚本对「只有字面量、没有 JSON」fail closed，逼 Agent 在同一轮删掉示例后再交卷。
 */

const WAIVER_MARKER = '[RISK_WAIVER]';
const REQUIREMENT_ID_PATTERN = /^\s*(?:(?:#{1,6}|[-*+]|\*{1,2}|\d+[.)])\s+)?(?:\[[ xX]\]\s+)?(?:\|\s*)?((?:RQ|REQ)-[A-Z0-9][A-Z0-9._-]{0,63})\b/gim;
const WAIVER_KEYS = ['findingId', 'owner', 'reason', 'scope', 'compensatingControl', 'expiresAt'];
const PLACEHOLDER = /\.{3}|…|^FIND-\.+$/;

export function stripFencedCodeBlocks(content) {
  return String(content ?? '').replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
}

export function extractRequirementIds(content) {
  const cleaned = stripFencedCodeBlocks(content).replace(/`[^`\n]+`/g, '');
  const seen = new Set();
  const ids = [];
  for (const match of cleaned.matchAll(REQUIREMENT_ID_PATTERN)) {
    const id = match[1].toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function extractBalancedJsonObject(text, startBrace) {
  if (startBrace < 0 || startBrace >= text.length || text[startBrace] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startBrace; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(startBrace, i + 1);
    }
  }
  return null;
}

function looksLikePlaceholder(value) {
  return typeof value === 'string' && PLACEHOLDER.test(value.trim());
}

function isTimezoneIso(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(trimmed)) return false;
  return !Number.isNaN(Date.parse(trimmed));
}

/**
 * @param {string} content
 * @param {{ allowBareMentions?: boolean }} [options]
 */
export function validateSpecMarkdown(content, options = {}) {
  const errors = [];
  const ids = extractRequirementIds(content);
  if (ids.length === 0) {
    errors.push('缺少以条目开头声明的稳定需求 ID（例如 `### RQ-001 登录`）');
  }

  const cleaned = stripFencedCodeBlocks(content);
  const idsSeen = new Set();
  let from = 0;
  let waiverCount = 0;
  while (from < cleaned.length) {
    const markerIndex = cleaned.indexOf(WAIVER_MARKER, from);
    if (markerIndex < 0) break;
    if (waiverCount >= 100) {
      errors.push('RISK_WAIVER 不能超过 100 条');
      break;
    }
    const afterMarker = markerIndex + WAIVER_MARKER.length;
    const remainder = cleaned.slice(afterMarker);
    const braceOffset = remainder.search(/\{/);
    const bare = braceOffset < 0 || braceOffset > 120
      || /[^\s`*'":-]/.test(remainder.slice(0, Math.max(0, braceOffset)));
    if (bare) {
      if (!options.allowBareMentions) {
        errors.push('[RISK_WAIVER] 后必须紧跟完整 JSON 对象；没有已接受风险时不要出现该字面量');
      }
      from = afterMarker;
      continue;
    }
    const json = extractBalancedJsonObject(cleaned, afterMarker + braceOffset);
    if (!json) {
      errors.push('[RISK_WAIVER] JSON 未闭合');
      break;
    }
    let raw;
    try {
      raw = JSON.parse(json);
    } catch (error) {
      errors.push('[RISK_WAIVER] 不是有效 JSON：' + error.message);
      from = afterMarker + braceOffset + json.length;
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push('[RISK_WAIVER] 必须是 JSON 对象');
      from = afterMarker + braceOffset + json.length;
      continue;
    }
    for (const key of WAIVER_KEYS) {
      if (typeof raw[key] !== 'string' || !raw[key].trim()) {
        errors.push(`[RISK_WAIVER] 缺少字段 ${key}`);
      } else if (looksLikePlaceholder(raw[key])) {
        errors.push(`[RISK_WAIVER] ${key} 不能使用占位值`);
      }
    }
    if (raw.expiresAt && !isTimezoneIso(raw.expiresAt)) {
      errors.push('[RISK_WAIVER] expiresAt 必须是带时区的 ISO 时间');
    }
    if (typeof raw.findingId === 'string') {
      if (idsSeen.has(raw.findingId)) errors.push('重复 RISK_WAIVER findingId：' + raw.findingId);
      idsSeen.add(raw.findingId);
    }
    waiverCount += 1;
    from = afterMarker + braceOffset + json.length;
  }

  return {
    status: errors.length ? 'fail' : 'pass',
    requirementIds: ids,
    waiverCount,
    errors,
  };
}
