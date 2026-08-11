#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) {
  console.error("usage: check-change-scope.mjs <scope.json>");
  process.exit(64);
}
const scope = JSON.parse(await readFile(path, "utf8"));
const allowed = scope.allowedPaths ?? [];
const forbidden = scope.forbiddenPaths ?? [];
const changed = scope.changedFiles ?? [];
const matches = (file, rule) => file === rule || file.startsWith(rule.endsWith("/") ? rule : `${rule}/`);
const violations = [];
for (const file of changed) {
  if (forbidden.some((rule) => matches(file, rule))) violations.push({ file, reason: "forbidden" });
  else if (!allowed.some((rule) => matches(file, rule))) violations.push({ file, reason: "outside-allowlist" });
  if (/(?:^|\/)(?:playwright|vitest|jest|eslint|tsconfig|package|pyproject|\.github)/i.test(file)
    && !(scope.approvedQualityConfigChanges ?? []).includes(file)) {
    violations.push({ file, reason: "unapproved-quality-config-change" });
  }
}
process.stdout.write(`${JSON.stringify({ status: violations.length ? "fail" : "pass", violations }, null, 2)}\n`);
process.exit(violations.length ? 2 : 0);
