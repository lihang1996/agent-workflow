#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) {
  console.error("usage: validate-delivery-contract.mjs <delivery-contract.json>");
  process.exit(64);
}

const contract = JSON.parse(await readFile(path, "utf8"));
const errors = [];
if (typeof contract.projectRoot !== "string" || !contract.projectRoot.startsWith("/")) {
  errors.push("projectRoot must be an absolute path");
}
if (!contract.canonicalSpec || typeof contract.canonicalSpec.id !== "string"
  || typeof contract.canonicalSpec.sha256 !== "string") {
  errors.push("canonicalSpec.id and canonicalSpec.sha256 are required");
}
if (!Array.isArray(contract.requirements) || contract.requirements.length === 0) {
  errors.push("requirements must be a non-empty array");
}
const ids = new Set();
for (const [index, requirement] of (contract.requirements ?? []).entries()) {
  const prefix = `requirements[${index}]`;
  if (!requirement?.id || ids.has(requirement.id)) errors.push(`${prefix}.id is missing or duplicated`);
  ids.add(requirement?.id);
  if (!requirement?.source) errors.push(`${prefix}.source is required`);
  if (!requirement?.acceptance || !String(requirement.acceptance).trim()) {
    errors.push(`${prefix}.acceptance is required`);
  }
  if (["P0", "P1"].includes(requirement?.priority) && !requirement?.evidenceType) {
    errors.push(`${prefix}.evidenceType is required for P0/P1`);
  }
}
if (!Array.isArray(contract.requiredGateIds) || contract.requiredGateIds.length === 0) {
  errors.push("requiredGateIds must be a non-empty array");
}
if (!Array.isArray(contract.qualityCommands)) errors.push("qualityCommands must be an array");
if ((contract.openDecisions ?? []).some((item) => ["P0", "P1"].includes(item?.priority))) {
  errors.push("P0/P1 open decisions must be resolved before architecture");
}

const result = { status: errors.length ? "fail" : "pass", errors };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(errors.length ? 2 : 0);
