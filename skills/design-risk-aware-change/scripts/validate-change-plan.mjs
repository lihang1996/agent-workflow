#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  validateFindingsArray,
  validateRiskDisposition,
} from "../../_shared/finding-fields.mjs";

const path = process.argv[2];
if (!path) {
  console.error("usage: validate-change-plan.mjs <change-plan.json>");
  process.exit(64);
}
const plan = JSON.parse(await readFile(path, "utf8"));
const errors = [];
for (const field of ["contractHash", "projectFingerprint"]) {
  if (typeof plan[field] !== "string" || !/^[a-f0-9]{64}$/.test(plan[field])) {
    errors.push(`${field} must be a 64-character SHA-256`);
  }
}
if (plan.status !== "pass") errors.push("status must be pass");
if (!Array.isArray(plan.requirementTrace) || plan.requirementTrace.length === 0) {
  errors.push("requirementTrace must be a non-empty array");
}
for (const [index, item] of (plan.requirementTrace ?? []).entries()) {
  if (!item?.requirementId) errors.push(`requirementTrace[${index}].requirementId is required`);
  if (!Array.isArray(item?.implementationPoints) || item.implementationPoints.length === 0) {
    errors.push(`requirementTrace[${index}] needs implementationPoints`);
  }
  if (!Array.isArray(item?.verificationPoints) || item.verificationPoints.length === 0) {
    errors.push(`requirementTrace[${index}] needs verificationPoints`);
  }
}
if (!Array.isArray(plan.riskAssessments)) errors.push("riskAssessments must be an array");
for (const [index, risk] of (plan.riskAssessments ?? []).entries()) {
  if (!risk?.id || !risk?.disposition || !risk?.evidence) {
    errors.push(`riskAssessments[${index}] needs id, disposition and evidence`);
  }
  errors.push(...validateRiskDisposition(risk?.disposition, index));
  if (String(risk?.disposition ?? "").trim().toLowerCase() === "applicable"
    && (!risk?.control || !risk?.verification)) {
    errors.push(`riskAssessments[${index}] applicable risk needs control and verification`);
  }
}
if (plan.findings !== undefined) {
  errors.push(...validateFindingsArray(plan.findings, { allowPlanned: true }));
}
if (!Array.isArray(plan.allowedPaths) || plan.allowedPaths.length === 0) errors.push("allowedPaths is required");
if (!Array.isArray(plan.testPlan) || plan.testPlan.length === 0) errors.push("testPlan is required");
if (!Array.isArray(plan.checks) || plan.checks.length === 0) {
  errors.push("checks must be non-empty");
}
const checkIds = new Set();
for (const [index, check] of (plan.checks ?? []).entries()) {
  if (!check?.id || checkIds.has(check.id)) errors.push(`checks[${index}] needs a unique id`);
  else checkIds.add(check.id);
  if (!Array.isArray(check?.command) || check.command.length === 0) {
    errors.push(`checks[${index}] needs reproducible command argv`);
  }
  if (!check?.status || typeof check?.required !== "boolean") {
    errors.push(`checks[${index}] needs status and required`);
  }
  if (!check?.cwd || !check?.startedAt || !check?.finishedAt) {
    errors.push(`checks[${index}] needs cwd, startedAt and finishedAt`);
  }
  if (check?.status === "pass" && check?.exitCode !== 0) {
    errors.push(`checks[${index}] pass conflicts with exitCode`);
  }
  if (check?.required !== false && (check?.status !== "pass" || check?.exitCode !== 0)) {
    errors.push(`checks[${index}] required check did not pass`);
  }
}
if (Array.isArray(plan.checks)
  && !plan.checks.some((check) => check?.required === true && check?.status === "pass" && check?.exitCode === 0)) {
  errors.push("checks needs at least one required passing check");
}
process.stdout.write(`${JSON.stringify({ status: errors.length ? "fail" : "pass", errors }, null, 2)}\n`);
process.exit(errors.length ? 2 : 0);
