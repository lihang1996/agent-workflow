#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { validateFindingsArray } from "../../_shared/finding-fields.mjs";

const path = process.argv[2];
if (!path) {
  console.error("usage: validate-verification-report.mjs <verification-report.json>");
  process.exit(64);
}
const report = JSON.parse(await readFile(path, "utf8"));
const errors = [];
const hasExplicitZone = (value) => typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
const waiverComplete = (waiver) => waiver
  && waiver.owner
  && waiver.reason
  && waiver.scope
  && waiver.compensatingControl
  && waiver.approvedAt
  && waiver.approvalEvidence
  && waiver.expiresAt
  && hasExplicitZone(waiver.approvedAt)
  && hasExplicitZone(waiver.expiresAt)
  && Date.parse(waiver.approvedAt) <= Date.now()
  && Date.parse(waiver.expiresAt) > Date.parse(waiver.approvedAt)
  && Date.parse(waiver.expiresAt) > Date.now();
const waiverIndex = new Map();
for (const waiver of report.waivers ?? []) {
  for (const key of [waiver?.findingId, waiver?.waiverId, waiver?.id]) {
    if (typeof key === "string" && key) waiverIndex.set(key, waiver);
  }
}
const waiverForFinding = (finding) => {
  if (waiverComplete(finding?.waiver)) return finding.waiver;
  for (const key of [finding?.waiverId, finding?.id, String(finding?.id ?? "").replace(/^FIND-/i, "WAIVER-")]) {
    if (waiverComplete(waiverIndex.get(key))) return waiverIndex.get(key);
  }
  return undefined;
};
for (const field of ["implementationHash", "changeReviewHash", "projectFingerprint", "buildHash"]) {
  if (typeof report[field] !== "string" || !/^[a-f0-9]{64}$/.test(report[field])) {
    errors.push(`${field} must be a 64-character SHA-256`);
  }
}
if (report.buildHash !== report.projectFingerprint) {
  if (!report.buildArtifact
    || typeof report.buildArtifact.path !== "string"
    || !isAbsolute(report.buildArtifact.path)
    || report.buildArtifact.sha256 !== report.buildHash) {
    errors.push("independent buildHash needs buildArtifact with absolute path and matching sha256");
  }
}
if (report.status !== "pass") errors.push("status must be pass");
if (!Array.isArray(report.discoveredGates) || !report.discoveredGates.length) {
  errors.push("discoveredGates must be non-empty");
}
if (!Array.isArray(report.executedChecks) || !report.executedChecks.length) {
  errors.push("executedChecks must be non-empty");
}
const checksById = new Map();
for (const [index, check] of (report.executedChecks ?? []).entries()) {
  if (!check?.id || checksById.has(check.id)) errors.push(`executedChecks[${index}] needs a unique id`);
  else checksById.set(check.id, check);
  if (!Array.isArray(check?.command) || !check.command.length) {
    errors.push(`executedChecks[${index}] needs a reproducible command argv`);
  }
  if (!check?.status || typeof check?.required !== "boolean") {
    errors.push(`executedChecks[${index}] needs status and required`);
  }
  if (!check?.cwd || !check?.startedAt || !check?.finishedAt) {
    errors.push(`executedChecks[${index}] needs cwd, startedAt and finishedAt`);
  }
  if (check?.status === "pass" && check?.exitCode !== 0) {
    errors.push(`executedChecks[${index}] pass conflicts with exitCode`);
  }
  if (check?.required !== false && (check?.status !== "pass" || check?.exitCode !== 0)) {
    errors.push(`executedChecks[${index}] required check did not pass`);
  }
}
const discoveredIds = new Set();
for (const [index, item] of (report.discoveredGates ?? []).entries()) {
  const gate = typeof item === "string" ? { id: item, required: true } : item;
  if (!gate?.id || discoveredIds.has(gate.id)) {
    errors.push(`discoveredGates[${index}] needs a unique id`);
    continue;
  }
  discoveredIds.add(gate.id);
  const required = gate.required !== false;
  if (!required && !gate.reason && !gate.applicabilityEvidence) {
    errors.push(`optional discovered gate needs reason/evidence: ${gate.id}`);
  }
  const executed = checksById.get(gate.id);
  if (!executed) errors.push(`discovered gate was not executed: ${gate.id}`);
  else if (required && (executed.required === false || executed.status !== "pass" || executed.exitCode !== 0)) {
    errors.push(`required discovered gate did not pass: ${gate.id}`);
  }
}
if ((report.unverified ?? []).length) errors.push("required evidence remains unverified");
if (!Array.isArray(report.unverified)) errors.push("unverified must be an array");
if (!Array.isArray(report.requirementResults) || !report.requirementResults.length) {
  errors.push("requirementResults must be non-empty");
}
if (!Array.isArray(report.findings)) errors.push("findings must be an array");
else errors.push(...validateFindingsArray(report.findings, { allowPlanned: false }));
const waivedFindingIds = new Set((report.findings ?? [])
  .filter((finding) => finding?.status === "waived" && waiverForFinding(finding))
  .map((finding) => finding.id));
for (const [index, finding] of (report.findings ?? []).entries()) {
  if (["P0", "P1"].includes(finding?.severity) && finding?.status === "open") {
    errors.push(`findings[${index}] leaves P0/P1 open`);
  }
  if (finding?.status === "waived" && !waiverForFinding(finding)) {
    errors.push(`findings[${index}] waiver is incomplete, ambiguous or expired`);
  }
}
for (const [index, item] of (report.requirementResults ?? []).entries()) {
  if (!item?.id || !item?.status || !Array.isArray(item?.evidence) || !item.evidence.length) {
    errors.push(`requirementResults[${index}] needs id, status and evidence`);
  }
  if (!["pass", "waived"].includes(item?.status)) {
    errors.push(`requirementResults[${index}] did not pass`);
  }
  if (item?.status === "waived" && (!item.findingId || !waivedFindingIds.has(item.findingId))) {
    errors.push(`requirementResults[${index}] waived status lacks a matching waived finding`);
  }
}
if (!report.resourcePreflight || !["pass", "not-applicable"].includes(report.resourcePreflight.status)) {
  errors.push("resourcePreflight must be pass or not-applicable");
} else if (report.resourcePreflight.status === "not-applicable" && !report.resourcePreflight.reason) {
  errors.push("not-applicable resourcePreflight needs a reason");
}
process.stdout.write(`${JSON.stringify({ status: errors.length ? "fail" : "pass", errors }, null, 2)}\n`);
process.exit(errors.length ? 2 : 0);
