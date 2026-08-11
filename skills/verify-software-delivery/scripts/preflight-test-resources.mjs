#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) {
  console.error("usage: preflight-test-resources.mjs <resource-policy.json>");
  process.exit(64);
}
const policy = JSON.parse(await readFile(path, "utf8"));
if (!policy.destructive) {
  process.stdout.write(`${JSON.stringify({ status: "pass", destructive: false }, null, 2)}\n`);
  process.exit(0);
}

const errors = [];
const envName = policy.connectionEnv;
const raw = typeof envName === "string" ? process.env[envName] : undefined;
if (!envName || !raw) errors.push("destructive checks require a populated connectionEnv");
let resourceName;
let normalized;
if (raw) {
  try {
    const url = new URL(raw);
    resourceName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    url.password = "";
    url.username = "";
    normalized = url.toString();
    const pattern = new RegExp(policy.databaseNamePattern ?? "(?:^|[_-])(test|ci|e2e|tmp)(?:$|[_-])", "i");
    if (!resourceName || !pattern.test(resourceName)) errors.push("resource name does not match the test naming policy");
  } catch {
    errors.push("connectionEnv is not a valid URL");
  }
}
for (const otherName of policy.runtimeConnectionEnvs ?? []) {
  const other = process.env[otherName];
  if (!other || !normalized) continue;
  try {
    const url = new URL(other);
    url.password = "";
    url.username = "";
    if (url.toString() === normalized) errors.push(`test resource equals ${otherName}`);
  } catch {
    errors.push(`${otherName} is not a valid URL`);
  }
}
const sentinelOkay = policy.sentinelEnv
  && process.env[policy.sentinelEnv] === String(policy.requiredSentinelValue ?? "true");
if (!sentinelOkay && !policy.disposableResourceId) {
  errors.push("destructive checks require a matching sentinel or disposableResourceId");
}

process.stdout.write(`${JSON.stringify({
  status: errors.length ? "fail" : "pass",
  destructive: true,
  connectionEnv: envName,
  resourceName,
  disposableResourceId: policy.disposableResourceId,
  errors,
}, null, 2)}\n`);
process.exit(errors.length ? 3 : 0);
