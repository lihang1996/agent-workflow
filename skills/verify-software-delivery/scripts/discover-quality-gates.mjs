#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const exists = async (relativePath) => {
  try {
    await access(resolve(root, relativePath));
    return true;
  } catch {
    return false;
  }
};

const gates = [];
try {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const packageManager = await exists("pnpm-lock.yaml") ? "pnpm"
    : await exists("yarn.lock") ? "yarn"
      : await exists("bun.lock") ? "bun" : "npm";
  const kinds = [
    ["format", /^(?:format:check|check:format)$/],
    ["lint", /^lint$/],
    ["typecheck", /^(?:typecheck|check:types)$/],
    ["unit", /^(?:test:unit|unit)$/],
    ["integration", /^(?:test:integration|integration)$/],
    ["schema", /^(?:prisma:validate|schema:validate|test:migrations)$/],
    ["build", /^build$/],
    ["e2e", /^(?:test:e2e|e2e|test:system)$/],
    ["test", /^test$/],
  ];
  for (const [kind, pattern] of kinds) {
    for (const name of Object.keys(pkg.scripts ?? {}).filter((item) => pattern.test(item))) {
      gates.push({ id: name, kind, command: [packageManager, "run", name], source: "package.json" });
    }
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw new Error(`package.json is invalid: ${error.message}`);
}

if (await exists("go.mod")) gates.push({ id: "go-test", kind: "test", command: ["go", "test", "./..."], source: "go.mod", candidate: true });
if (await exists("Cargo.toml")) gates.push({ id: "cargo-test", kind: "test", command: ["cargo", "test"], source: "Cargo.toml", candidate: true });
if (await exists("pyproject.toml")) gates.push({ id: "pytest", kind: "test", command: ["python", "-m", "pytest"], source: "pyproject.toml", candidate: true });

process.stdout.write(`${JSON.stringify({
  schemaVersion: "1.0",
  projectRoot: root,
  gates,
  warnings: gates.length ? [] : ["No quality gates discovered; define project-level commands."],
}, null, 2)}\n`);
