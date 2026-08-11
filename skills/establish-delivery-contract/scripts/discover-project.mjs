#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const candidates = [
  "AGENTS.md", "CLAUDE.md", "package.json", "pnpm-lock.yaml", "yarn.lock",
  "package-lock.json", "bun.lock", "pyproject.toml", "requirements.txt",
  "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts",
  "Makefile", "docker-compose.yml", "compose.yaml", "tsconfig.json",
  "playwright.config.ts", "playwright.config.js", "vitest.config.ts",
];

const files = [];
for (const relativePath of candidates) {
  const path = resolve(root, relativePath);
  try {
    if (!(await stat(path)).isFile()) continue;
    const content = await readFile(path);
    files.push({
      path: relativePath,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

let packageInfo;
try {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  packageInfo = {
    name: packageJson.name,
    type: packageJson.type,
    engines: packageJson.engines ?? {},
    packageManager: packageJson.packageManager,
    scripts: packageJson.scripts ?? {},
  };
} catch (error) {
  if (error?.code !== "ENOENT") throw new Error(`package.json is invalid: ${error.message}`);
}

const has = async (relativePath) => {
  try {
    await access(resolve(root, relativePath));
    return true;
  } catch {
    return false;
  }
};

const output = {
  schemaVersion: "1.0",
  projectRoot: root,
  detectedAt: new Date().toISOString(),
  files,
  package: packageInfo,
  signals: {
    node: Boolean(packageInfo),
    python: await has("pyproject.toml") || await has("requirements.txt"),
    go: await has("go.mod"),
    rust: await has("Cargo.toml"),
    jvm: await has("pom.xml") || await has("build.gradle") || await has("build.gradle.kts"),
    database: await has("prisma") || await has("migrations") || await has("db"),
    ci: await has(".github/workflows") || await has(".gitlab-ci.yml"),
    e2e: await has("playwright.config.ts") || await has("playwright.config.js") || await has("cypress.config.ts"),
  },
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
