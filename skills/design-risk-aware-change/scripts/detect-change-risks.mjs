#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const explicit = process.argv.slice(3);
const ignored = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", "data"]);
const allowedExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".sql", ".prisma"]);

async function walk(directory, output = []) {
  if (output.length >= 500) return output;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(path, output);
    else if (allowedExtensions.has(extname(entry.name))) output.push(path);
    if (output.length >= 500) break;
  }
  return output;
}

const paths = explicit.length ? explicit.map((item) => resolve(root, item)) : await walk(root);
const patterns = {
  authorization: /auth|session|permission|role|owner|tenant|admin/i,
  inputSafety: /request|input|query|param|body|url|path|markdown|html/i,
  concurrency: /find(?:First|One|ById)|select|exists|status|balance|inventory|counter/i,
  dataWrite: /create|insert|update|delete|upsert|transaction|executeRaw/i,
  cache: /cache|revalidate|invalidate|redis|etag/i,
  externalIo: /fetch\(|axios|http|queue|publish|filesystem|writeFile/i,
  secrets: /secret|token|password|credential|cookie|authorization/i,
  compatibility: /runtime|browser|module|engine|migration|schema|version/i,
};
const matches = Object.fromEntries(Object.keys(patterns).map((key) => [key, []]));
for (const path of paths) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch {
    continue;
  }
  for (const [risk, pattern] of Object.entries(patterns)) {
    if (pattern.test(content)) matches[risk].push(path.slice(root.length + 1));
  }
}
const risks = Object.entries(matches)
  .filter(([, files]) => files.length)
  .map(([id, files]) => ({ id, files: files.slice(0, 20), disposition: "analysis-required" }));
process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0", projectRoot: root, scannedFiles: paths.length, risks }, null, 2)}\n`);
