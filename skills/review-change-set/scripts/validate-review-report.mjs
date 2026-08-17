#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { validateFindingsArray } from "../../_shared/finding-fields.mjs";

const path = process.argv[2];
if (!path) {
  console.error("usage: validate-review-report.mjs <change-review.json>");
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
for (const field of ["implementationFingerprint", "reviewFingerprint", "baseline", "decision", "status"]) {
  if (!report[field]) errors.push(`${field} is required`);
}
for (const field of ["implementationFingerprint", "reviewFingerprint"]) {
  if (typeof report[field] !== "string" || !/^[a-f0-9]{64}$/.test(report[field])) {
    errors.push(`${field} must be a 64-character SHA-256`);
  }
}
if (!report.reviewScope || !Array.isArray(report.reviewScope.changedFiles) || report.reviewScope.changedFiles.length === 0) {
  errors.push("reviewScope.changedFiles must be a non-empty array");
}
for (const field of ["staged", "unstaged", "untracked", "deleted"]) {
  if (!Array.isArray(report.reviewScope?.[field])) errors.push(`reviewScope.${field} must be an array`);
}
if (!Array.isArray(report.reviewScope?.discrepancies?.statusNotInManifest)
  || !Array.isArray(report.reviewScope?.discrepancies?.manifestNotInStatus)) {
  errors.push("reviewScope.discrepancies must contain both scope arrays");
}
for (const field of ["requirementCoverage", "relatedContracts", "findings", "removalPlans", "notReviewed", "residualRisks"]) {
  if (!Array.isArray(report[field])) errors.push(`${field} must be an array`);
}
if (Array.isArray(report.requirementCoverage) && report.requirementCoverage.length === 0) {
  errors.push("requirementCoverage must be non-empty");
}
if ((report.reviewScope?.discrepancies?.statusNotInManifest ?? []).length > 0
  || (report.reviewScope?.discrepancies?.manifestNotInStatus ?? []).length > 0) {
  errors.push("review scope has unresolved manifest/status discrepancies");
}
if ((report.requirementCoverage ?? []).some((item) =>
  ["P0", "P1"].includes(item?.priority) && item?.status !== "pass" && item?.status !== "waived")) {
  errors.push("P0/P1 requirement coverage is incomplete");
}
errors.push(...validateFindingsArray(report.findings ?? [], { allowPlanned: false }));
for (const [index, finding] of (report.findings ?? []).entries()) {
  if (["P0", "P1"].includes(finding?.severity)) {
    if (!Array.isArray(finding?.evidence) || finding.evidence.length === 0) {
      errors.push(`findings[${index}] P0/P1 needs evidence`);
    }
    if (!finding?.impact) errors.push(`findings[${index}] P0/P1 needs impact`);
    if (!finding?.confidence) errors.push(`findings[${index}] P0/P1 needs confidence`);
  }
  if (finding?.status === "waived") {
    if (!waiverForFinding(finding)) errors.push(`findings[${index}] waiver is incomplete, ambiguous or expired`);
  }
}
const openBlocking = (report.findings ?? []).filter((finding) =>
  ["P0", "P1"].includes(finding?.severity) && ["open", "planned"].includes(finding?.status));
if (openBlocking.length > 0) errors.push(`unclosed P0/P1 findings: ${openBlocking.map((item) => item.id).join(",")}`);
const planned = (report.findings ?? []).filter((finding) => finding?.status === "planned");
if (planned.length > 0) errors.push(`review findings cannot remain planned: ${planned.map((item) => item.id).join(",")}`);

const hasWaivers = (report.findings ?? []).some((finding) => finding?.status === "waived")
  || (Array.isArray(report.waivers) && report.waivers.length > 0);
const expectedDecision = hasWaivers ? "approved-with-waiver" : "approved";
const approved = report.decision === "approved" || report.decision === "approved-with-waiver" || report.status === "pass";
if (approved && (report.decision !== expectedDecision || report.status !== "pass")) {
  errors.push(`approved report must use decision=${expectedDecision} and status=pass`);
}
if (approved && report.implementationFingerprint !== report.reviewFingerprint) {
  errors.push("review fingerprint differs from implementation fingerprint");
}
if (approved && errors.length > 0) errors.push("report cannot be approved while validation errors exist");

process.stdout.write(`${JSON.stringify({ status: errors.length ? "fail" : "pass", errors }, null, 2)}\n`);
process.exit(errors.length ? 2 : 0);
