#!/usr/bin/env node
import { readFile } from "node:fs/promises";

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
  if (risk?.disposition === "applicable" && (!risk?.control || !risk?.verification)) {
    errors.push(`riskAssessments[${index}] applicable risk needs control and verification`);
  }
}
if (!Array.isArray(plan.allowedPaths) || plan.allowedPaths.length === 0) errors.push("allowedPaths is required");
if (!Array.isArray(plan.testPlan) || plan.testPlan.length === 0) errors.push("testPlan is required");
process.stdout.write(`${JSON.stringify({ status: errors.length ? "fail" : "pass", errors }, null, 2)}\n`);
process.exit(errors.length ? 2 : 0);
