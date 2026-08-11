#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = process.argv[2];
if (!path) {
  console.error("usage: run-quality-gates.mjs <gate-config.json>");
  process.exit(64);
}
const config = JSON.parse(await readFile(path, "utf8"));
const root = resolve(config.projectRoot ?? process.cwd());
const checks = config.checks ?? [];
if (!Array.isArray(checks) || checks.length === 0) {
  process.stdout.write(`${JSON.stringify({ status: "unverified", checks: [], errors: ["no checks configured"] }, null, 2)}\n`);
  process.exit(3);
}

const redact = (value) => String(value)
  .replace(/(password|secret|token|cookie|authorization)=([^\s&]+)/gi, "$1=[REDACTED]")
  .slice(-65536);

const results = [];
for (const check of checks) {
  if (!Array.isArray(check.command) || !check.command.length || check.command.some((item) => typeof item !== "string")) {
    const now = new Date().toISOString();
    results.push({
      id: check.id,
      command: [],
      status: "unverified",
      required: check.required !== false,
      exitCode: null,
      cwd: root,
      startedAt: now,
      finishedAt: now,
      error: "command must be a non-empty string array",
    });
    continue;
  }
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const result = await new Promise((resolveResult) => {
    const child = spawn(check.command[0], check.command.slice(1), {
      cwd: root,
      shell: false,
      env: { ...process.env, ...(config.env ?? {}), ...(check.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeoutMs = Number(check.timeoutMs ?? config.timeoutMs ?? 600000);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-65536); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65536); });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolveResult({ exitCode: null, error: error.message, stdout, stderr });
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveResult({ exitCode, signal, stdout, stderr });
    });
  });
  const finishedAt = new Date().toISOString();
  const stdout = redact(result.stdout);
  const stderr = redact(result.stderr);
  const status = result.exitCode === 0 ? "pass" : result.exitCode === null ? "blocked" : "fail";
  results.push({
    id: check.id,
    kind: check.kind,
    command: check.command,
    status,
    required: check.required !== false,
    cwd: root,
    startedAt,
    finishedAt,
    durationMs: Date.now() - startedAtMs,
    exitCode: result.exitCode,
    signal: result.signal,
    error: result.error,
    stdout,
    stderr,
    logSha256: createHash("sha256").update(`${stdout}\n${stderr}`).digest("hex"),
  });
}
const failed = results.filter((item) => item.required && item.status !== "pass");
const unverified = results
  .filter((item) => item.required && ["blocked", "unverified", "skipped"].includes(item.status))
  .map((item) => ({ id: item.id, status: item.status, error: item.error }));
process.stdout.write(`${JSON.stringify({
  schemaVersion: "2.0",
  runner: "agent-os/run-quality-gates",
  status: failed.length ? "fail" : "pass",
  projectRoot: root,
  checks: results,
  unverified,
}, null, 2)}\n`);
process.exit(failed.length ? 2 : 0);
