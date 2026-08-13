#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) {
  console.error("usage: validate-implementation-manifest.mjs <implementation-manifest.json>");
  process.exit(64);
}
const manifest = JSON.parse(await readFile(path, "utf8"));
const errors = [];
const allowedManifestStatuses = new Set(["pass"]);
const allowedCheckStatuses = new Set(["pass", "fail", "blocked", "unverified", "skipped"]);
for (const field of ["contractHash", "planHash", "fingerprintBefore", "fingerprintAfter"]) {
  if (typeof manifest[field] !== "string" || !/^[a-f0-9]{64}$/.test(manifest[field])) {
    errors.push(`${field} must be a 64-character SHA-256`);
  }
}
if (!allowedManifestStatuses.has(manifest.status)) {
  errors.push("status must be pass");
}
if (!Array.isArray(manifest.changedFiles) || manifest.changedFiles.length === 0) {
  errors.push("changedFiles must be a non-empty array");
}
if (!Array.isArray(manifest.requirementImplementations)
  || manifest.requirementImplementations.length === 0) {
  errors.push("requirementImplementations must be a non-empty array");
}
for (const [index, item] of (manifest.requirementImplementations ?? []).entries()) {
  if (!item?.requirementId || !Array.isArray(item?.files) || item.files.length === 0) {
    errors.push(`requirementImplementations[${index}] needs requirementId and files`);
  }
}
for (const [index, risk] of (manifest.riskControls ?? []).entries()) {
  if (["P0", "P1"].includes(risk?.priority)
    && (!Array.isArray(risk?.files) || !risk.files.length || !Array.isArray(risk?.tests) || !risk.tests.length)) {
    errors.push(`riskControls[${index}] P0/P1 needs files and tests`);
  }
}
if (!Array.isArray(manifest.targetedCheckResults) || manifest.targetedCheckResults.length === 0) {
  errors.push("targetedCheckResults must be non-empty");
}
let requiredPassCount = 0;
let requiredBlockerCount = 0;
for (const [index, check] of (manifest.targetedCheckResults ?? []).entries()) {
  if (!Array.isArray(check?.command) || check.command.length === 0) {
    errors.push(`targetedCheckResults[${index}] needs reproducible command argv`);
  }
  if (!allowedCheckStatuses.has(check?.status) || typeof check?.required !== "boolean") {
    errors.push(`targetedCheckResults[${index}] needs status and required`);
  }
  if (check?.delegatedTo !== undefined
    && (check.delegatedTo !== "verification"
      || check.required !== false
      || !["blocked", "unverified"].includes(check.status))) {
    errors.push(`targetedCheckResults[${index}] delegatedTo requires verification + optional blocked/unverified`);
  }
  if (!check?.cwd || !check?.startedAt || !check?.finishedAt) {
    errors.push(`targetedCheckResults[${index}] needs cwd, startedAt and finishedAt`);
  }
  if (check?.status === "pass" && check?.exitCode !== 0) {
    errors.push(`targetedCheckResults[${index}] pass conflicts with exitCode`);
  }
  if (check?.status === "fail"
    && (check?.exitCode === undefined || check?.exitCode === null || check?.exitCode === 0)) {
    errors.push(`targetedCheckResults[${index}] fail needs a non-zero exitCode`);
  }
  if (!["pass", "fail"].includes(check?.status) && check?.exitCode === 0) {
    errors.push(`targetedCheckResults[${index}] ${check?.status} conflicts with exitCode=0`);
  }
  if (check?.required === true && check?.status === "pass" && check?.exitCode === 0) {
    requiredPassCount += 1;
  }
  if (check?.required === true && ["fail", "blocked", "unverified"].includes(check?.status)) {
    requiredBlockerCount += 1;
  }
}
if (manifest.status === "pass") {
  if (requiredPassCount === 0) {
    errors.push("pass manifest needs at least one required passing check");
  }
  if (requiredBlockerCount > 0
    || (manifest.targetedCheckResults ?? []).some((check) => check?.required === true
      && (check?.status !== "pass" || check?.exitCode !== 0))) {
    errors.push("pass manifest conflicts with an incomplete required check");
  }
}
process.stdout.write(`${JSON.stringify({ status: errors.length ? "fail" : "pass", errors }, null, 2)}\n`);
process.exit(errors.length ? 2 : 0);
