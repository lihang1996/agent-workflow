#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) {
  console.error("usage: probe-http-contract.mjs <http-probes.json>");
  process.exit(64);
}
const config = JSON.parse(await readFile(path, "utf8"));
const probes = config.probes ?? [];
if (!Array.isArray(probes) || probes.length === 0) {
  process.stdout.write(`${JSON.stringify({ status: "unverified", results: [], errors: ["no probes configured"] }, null, 2)}\n`);
  process.exit(3);
}

const safeHeaders = (headers) => {
  const output = {};
  for (const name of [
    "cache-control", "content-security-policy", "content-type", "location",
    "referrer-policy", "strict-transport-security", "x-content-type-options",
    "x-frame-options", "permissions-policy", "vary",
  ]) {
    const value = headers.get(name);
    if (value) output[name] = value;
  }
  if (headers.has("set-cookie")) output["set-cookie"] = "[PRESENT_REDACTED]";
  return output;
};

const results = [];
for (const probe of probes) {
  const startedAt = Date.now();
  try {
    const response = await fetch(probe.url, {
      method: probe.method ?? "GET",
      redirect: probe.followRedirects ? "follow" : "manual",
      signal: AbortSignal.timeout(Number(probe.timeoutMs ?? 15000)),
      headers: probe.headers ?? {},
    });
    const headers = safeHeaders(response.headers);
    const missingHeaders = (probe.requiredHeaders ?? [])
      .map((name) => String(name).toLowerCase())
      .filter((name) => !response.headers.has(name));
    const errors = [];
    if (probe.expectedStatus !== undefined && response.status !== probe.expectedStatus) {
      errors.push(`expected status ${probe.expectedStatus}, got ${response.status}`);
    }
    if (missingHeaders.length) errors.push(`missing headers: ${missingHeaders.join(", ")}`);
    results.push({
      id: probe.id,
      url: probe.url,
      status: response.status,
      headers,
      missingHeaders,
      durationMs: Date.now() - startedAt,
      errors,
    });
  } catch (error) {
    results.push({ id: probe.id, url: probe.url, durationMs: Date.now() - startedAt, errors: [error.message] });
  }
}
const failed = results.filter((item) => item.errors.length);
process.stdout.write(`${JSON.stringify({ status: failed.length ? "fail" : "pass", results }, null, 2)}\n`);
process.exit(failed.length ? 2 : 0);
