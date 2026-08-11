#!/usr/bin/env node
import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const configPath = process.argv[2];
if (!configPath) {
  console.error("usage: discover-review-scope.mjs <review-scope-config.json>");
  process.exit(64);
}

const config = JSON.parse(await readFile(configPath, "utf8"));
if (!config.projectRoot) {
  console.error("projectRoot is required");
  process.exit(64);
}

const projectRoot = await realpath(resolve(config.projectRoot));
const baseline = String(config.baselineRef ?? "HEAD");
if (!baseline || baseline.length > 500 || baseline.startsWith("-") || /[\0\r\n]/.test(baseline)) {
  console.error("baselineRef is invalid");
  process.exit(64);
}
const maxChangedLines = Number.isInteger(config.maxChangedLines) && config.maxChangedLines > 0
  ? config.maxChangedLines
  : 500;
const ignoredPaths = new Set([".agent-os", ...(config.ignoredPaths ?? [])].map(toPortablePath));
const isIgnored = (path) => [...ignoredPaths].some((rule) => path === rule || path.startsWith(`${rule}/`));

let manifest;
if (config.implementationManifestPath) {
  const manifestPath = await realpath(resolve(config.implementationManifestPath));
  assertWithinProject(projectRoot, manifestPath, "implementation manifest");
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
}
const manifestFiles = unique((manifest?.changedFiles ?? []).map(toPortablePath).filter((path) => !isIgnored(path)));

const gitProbe = runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
const gitAvailable = gitProbe.status === 0 && gitProbe.stdout.trim() === "true";
const entries = [];
const lineStats = new Map();
let baselineVerified = false;

if (gitAvailable) {
  const status = runGit(projectRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.status !== 0) fail(`git status failed: ${status.stderr.trim()}`);
  entries.push(...parseStatus(status.stdout).filter((entry) => !isIgnored(entry.path)));

  const diff = runGit(projectRoot, ["diff", "--numstat", "--no-renames", "-z", baseline, "--"]);
  if (diff.status !== 0) fail(`cannot verify baseline ${baseline}: ${diff.stderr.trim()}`);
  baselineVerified = true;
  for (const stat of parseNumstat(diff.stdout)) {
    if (!isIgnored(stat.path)) lineStats.set(stat.path, stat);
  }
  for (const entry of entries.filter((item) => item.untracked)) {
    lineStats.set(entry.path, await countUntrackedLines(projectRoot, entry.path));
  }
}

const statusFiles = unique(entries.flatMap((entry) => [entry.path, entry.originalPath].filter(Boolean)));
const changedFiles = unique([...statusFiles, ...manifestFiles]);
const statusNotInManifest = manifest ? statusFiles.filter((path) => !manifestFiles.includes(path)) : [];
const manifestNotInStatus = manifest ? manifestFiles.filter((path) => !statusFiles.includes(path)) : [];
const stats = changedFiles.map((path) => lineStats.get(path) ?? { path, added: null, deleted: null, binaryOrLarge: true });
const knownChangedLines = stats.reduce((total, item) => total + (item.added ?? 0) + (item.deleted ?? 0), 0);
const unknownLineCountFiles = stats.filter((item) => item.added === null || item.deleted === null).map((item) => item.path);
const groups = Object.entries(Object.groupBy(changedFiles, (path) => path.split("/")[0] || "(root)"))
  .map(([name, files]) => ({ name, files }))
  .sort((left, right) => left.name.localeCompare(right.name));

const output = {
  status: changedFiles.length > 0 && (baselineVerified || manifestFiles.length > 0) ? "pass" : "blocked",
  projectRoot,
  baseline: gitAvailable ? baseline : "implementation-manifest",
  baselineVerified,
  gitAvailable,
  implementationFingerprint: manifest?.fingerprintAfter ?? null,
  changedFiles,
  staged: entries.filter((entry) => entry.staged).map((entry) => entry.path),
  unstaged: entries.filter((entry) => entry.unstaged).map((entry) => entry.path),
  untracked: entries.filter((entry) => entry.untracked).map((entry) => entry.path),
  deleted: entries.filter((entry) => entry.deleted).map((entry) => entry.path),
  renamed: entries.filter((entry) => entry.renamed).map((entry) => entry.path),
  stats,
  knownChangedLines,
  unknownLineCountFiles,
  largeDiff: knownChangedLines > maxChangedLines || unknownLineCountFiles.length > 0,
  maxChangedLines,
  groups,
  discrepancies: { statusNotInManifest, manifestNotInStatus },
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
process.exit(output.status === "pass" ? 0 : 2);

function runGit(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function parseStatus(raw) {
  const tokens = raw.split("\0").filter(Boolean);
  const parsed = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const code = token.slice(0, 2);
    const path = toPortablePath(token.slice(3));
    const renamed = /[RC]/.test(code);
    const originalPath = renamed ? toPortablePath(tokens[++index] ?? "") : undefined;
    parsed.push({
      path,
      code,
      staged: code !== "??" && code[0] !== " ",
      unstaged: code !== "??" && code[1] !== " ",
      untracked: code === "??",
      deleted: code.includes("D"),
      renamed,
      ...(originalPath ? { originalPath } : {}),
    });
  }
  return parsed;
}

function parseNumstat(raw) {
  return raw.split("\0").filter(Boolean).map((token) => {
    const [addedRaw, deletedRaw, ...pathParts] = token.split("\t");
    return {
      path: toPortablePath(pathParts.join("\t")),
      added: addedRaw === "-" ? null : Number(addedRaw),
      deleted: deletedRaw === "-" ? null : Number(deletedRaw),
      binaryOrLarge: addedRaw === "-" || deletedRaw === "-",
    };
  });
}

async function countUntrackedLines(root, portablePath) {
  const absolute = resolve(root, portablePath);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) fail(`untracked path escapes project root: ${portablePath}`);
  const stats = await lstat(absolute);
  if (!stats.isFile() || stats.size > 2_000_000) {
    return { path: portablePath, added: null, deleted: 0, binaryOrLarge: true };
  }
  const content = await readFile(absolute);
  if (content.includes(0)) return { path: portablePath, added: null, deleted: 0, binaryOrLarge: true };
  const text = content.toString("utf8");
  const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
  return { path: portablePath, added: lines, deleted: 0, binaryOrLarge: false };
}

function toPortablePath(path) {
  const value = String(path).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!value || value.includes("\0") || value.startsWith("/") || value.split("/").includes("..")) {
    fail(`path must stay within project root: ${value || "(empty)"}`);
  }
  return value;
}

function unique(values) {
  return [...new Set(values)].sort();
}

function assertWithinProject(root, candidate, label) {
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith("..") || rel.split(sep).includes("..")) {
    fail(`${label} must be inside project root`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
