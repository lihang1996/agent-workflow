#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { validateSpecMarkdown } from '../../_shared/canonical-spec.mjs';

const path = process.argv[2];
if (!path) {
  console.error('usage: validate-spec-markdown.mjs <spec.md>');
  process.exit(64);
}

const content = await readFile(path, 'utf8');
// 对齐控制器行为：允许 Spec 中出现 [RISK_WAIVER] 字面量（如示例、说明），
// 只要后面没有完整 JSON 就静默忽略，不构成校验失败。
// 控制器 parseCanonicalSpecWaivers 也采用相同逻辑（continue 而非 throw）。
const result = validateSpecMarkdown(content, { allowBareMentions: true });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.errors.length ? 2 : 0);
