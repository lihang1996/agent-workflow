#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) {
  console.error("usage: validate-runtime-matrix.mjs <runtime-audit.json>");
  process.exit(64);
}
const audit = JSON.parse(await readFile(path, "utf8"));
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
for (const waiver of audit.waivers ?? []) {
  const keys = [waiver?.findingId, waiver?.waiverId, waiver?.id];
  for (const key of keys) {
    if (typeof key === "string" && key) waiverIndex.set(key, waiver);
  }
  if (!keys.some((key) => typeof key === "string" && key) || !waiverComplete(waiver)) {
    errors.push("waiver registry contains an unlinked, incomplete, ambiguous or expired entry");
  }
}
const waiverForFinding = (finding) => {
  if (waiverComplete(finding?.waiver)) return finding.waiver;
  for (const key of [finding?.waiverId, finding?.id, String(finding?.id ?? "").replace(/^FIND-/i, "WAIVER-")]) {
    if (waiverComplete(waiverIndex.get(key))) return waiverIndex.get(key);
  }
  return undefined;
};
if (audit.status === "not-applicable") {
  for (const field of ["buildHash", "projectFingerprint", "verificationHash"]) {
    if (typeof audit[field] !== "string" || !/^[a-f0-9]{64}$/.test(audit[field])) {
      errors.push(`${field} must be a 64-character SHA-256`);
    }
  }
  if (!audit.applicability
    || typeof audit.applicability.reason !== "string"
    || !audit.applicability.reason.trim()
    || !Array.isArray(audit.applicability.evidence)
    || audit.applicability.evidence.length === 0) {
    errors.push("not-applicable audit needs applicability.reason and non-empty applicability.evidence");
  }
  if (!Array.isArray(audit.findings)) errors.push("findings must be an array");
  process.stdout.write(`${JSON.stringify({ status: errors.length ? "fail" : "pass", errors }, null, 2)}\n`);
  process.exit(errors.length ? 2 : 0);
}
for (const field of ["environment", "buildHash", "projectFingerprint", "verificationHash"]) {
  if (!audit[field]) errors.push(`${field} is required`);
}
for (const field of ["buildHash", "projectFingerprint", "verificationHash"]) {
  if (typeof audit[field] !== "string" || !/^[a-f0-9]{64}$/.test(audit[field])) {
    errors.push(`${field} must be a 64-character SHA-256`);
  }
}
if (!Array.isArray(audit.surfaceMatrix) || !audit.surfaceMatrix.length) {
  errors.push("surfaceMatrix must be non-empty");
}
for (const [index, surface] of (audit.surfaceMatrix ?? []).entries()) {
  const missing = (surface.requiredStates ?? []).filter((state) =>
    !(surface.results ?? []).some((result) => result.state === state && result.status === "pass"));
  if (missing.length && ["P0", "P1"].includes(surface.priority)) {
    errors.push(`surfaceMatrix[${index}] missing states: ${missing.join(", ")}`);
  }
}
const requiredBrowsers = audit.requiredBrowsers ?? [];
const executedBrowsers = new Set((audit.browserAndViewportResults ?? []).map((item) => item.browser));
for (const browser of requiredBrowsers) {
  if (!executedBrowsers.has(browser)) errors.push(`required browser not verified: ${browser}`);
}
if ((audit.findings ?? []).some((item) =>
  ["P0", "P1"].includes(item?.severity)
  && item?.status !== "resolved"
  && !(item?.status === "waived" && waiverForFinding(item)))) {
  errors.push("unwaived P0/P1 runtime findings remain");
}
for (const [index, finding] of (audit.findings ?? []).entries()) {
  if (finding?.status === "planned") errors.push(`findings[${index}] cannot remain planned at runtime audit`);
  if (finding?.status === "waived" && !waiverForFinding(finding)) {
    errors.push(`findings[${index}] waiver is incomplete, ambiguous or expired`);
  }
}
if ((audit.unverified ?? []).length > 0) errors.push("runtime evidence remains unverified");
process.stdout.write(`${JSON.stringify({ status: errors.length ? "fail" : "pass", errors }, null, 2)}\n`);
process.exit(errors.length ? 2 : 0);
