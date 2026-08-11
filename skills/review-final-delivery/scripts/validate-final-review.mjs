#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const path = process.argv[2];
if (!path) {
  console.error("usage: validate-final-review.mjs <final-review.json>");
  process.exit(64);
}
const review = JSON.parse(await readFile(path, "utf8"));
const errors = [];
const hasExplicitZone = (value) => typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
const waiverFieldsComplete = (waiver) => waiver
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
const waiverComplete = (waiver) => waiver?.findingId && waiverFieldsComplete(waiver);
const waiverIndex = new Map();
for (const waiver of review.waivers ?? []) {
  for (const key of [waiver?.findingId, waiver?.waiverId, waiver?.id]) {
    if (typeof key === "string" && key) waiverIndex.set(key, waiver);
  }
}
const waiverForFinding = (finding) => {
  if (waiverFieldsComplete(finding?.waiver)) return finding.waiver;
  for (const key of [finding?.waiverId, finding?.id, String(finding?.id ?? "").replace(/^FIND-/i, "WAIVER-")]) {
    if (waiverFieldsComplete(waiverIndex.get(key))) return waiverIndex.get(key);
  }
  return undefined;
};
for (const field of ["finalFingerprint", "reviewedDiff", "decision", "status"]) {
  if (!review[field]) errors.push(`${field} is required`);
}
if (typeof review.finalFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(review.finalFingerprint)) {
  errors.push("finalFingerprint must be a 64-character SHA-256");
}
if (!review.reviewScope || !Array.isArray(review.reviewScope.changedFiles)) {
  errors.push("reviewScope.changedFiles must be an array");
}
const chainReference = review.evidenceChain;
if (!chainReference
  || typeof chainReference !== "object"
  || typeof chainReference.path !== "string"
  || !isAbsolute(chainReference.path)
  || typeof chainReference.sha256 !== "string"
  || !/^[a-f0-9]{64}$/.test(chainReference.sha256)) {
  errors.push("evidenceChain must contain an absolute path and valid sha256");
} else {
  const expectedPath = resolve(dirname(resolve(path)), "evidence-chain.json");
  if (resolve(chainReference.path) !== expectedPath) {
    errors.push("evidenceChain must reference the controller file beside final-review.json");
  } else {
    try {
      const stats = await lstat(expectedPath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        errors.push("evidenceChain must be a regular non-symlink file");
      } else {
        const canonical = await realpath(expectedPath);
        const content = await readFile(canonical);
        const hash = createHash("sha256").update(content).digest("hex");
        if (hash !== chainReference.sha256) errors.push("evidenceChain sha256 does not match file content");
        const chain = JSON.parse(content.toString("utf8"));
        if (chain.schemaVersion !== "2.0"
          || chain.generatedBy !== "agent-os-controller"
          || chain.controllerOwned !== true) {
          errors.push("evidenceChain is not a controller-owned v2 manifest");
        }
      }
    } catch (error) {
      errors.push(`evidenceChain cannot be verified: ${error.message}`);
    }
  }
}
for (const field of ["findings", "waivers", "notReviewed", "residualRisks"]) {
  if (!Array.isArray(review[field])) errors.push(`${field} must be an array`);
}
if (!Array.isArray(review.requirementCoverage) || !review.requirementCoverage.length) {
  errors.push("requirementCoverage must be non-empty");
}
if ((review.requirementCoverage ?? []).some((item) =>
  ["P0", "P1"].includes(item?.priority) && item?.status !== "pass" && !item?.waiverId)) {
  errors.push("P0/P1 requirements are not fully passed");
}
if ((review.findings ?? []).some((item) =>
  ["P0", "P1"].includes(item?.severity)
  && item?.status !== "resolved"
  && item?.status !== "waived")) {
  errors.push("unresolved P0/P1 findings remain");
}
if ((review.findings ?? []).some((item) => item?.status === "planned")) {
  errors.push("final review findings cannot remain planned");
}
for (const [index, finding] of (review.findings ?? []).entries()) {
  if (!finding?.id || !finding?.severity || !finding?.status || !finding?.summary) {
    errors.push(`findings[${index}] needs id, severity, status and summary`);
  }
  if (finding?.status === "waived" && !waiverForFinding(finding)) {
    errors.push(`findings[${index}] waiver is incomplete, ambiguous or expired`);
  }
}
for (const [index, waiver] of (review.waivers ?? []).entries()) {
  if (!waiverComplete(waiver)) errors.push(`waivers[${index}] is incomplete, ambiguous or expired`);
}
if ((review.notReviewed ?? []).length > 0) errors.push("final review still has unreviewed scope");
const blockingResidual = (review.residualRisks ?? []).filter((item) =>
  item?.required !== false && ["blocked", "unverified", "fail"].includes(item?.status));
if (blockingResidual.length > 0) errors.push("final review has blocked or unverified required residual risks");
const hasWaivers = (review.waivers ?? []).length > 0
  || (review.findings ?? []).some((item) => item?.status === "waived");
const expectedDecision = hasWaivers ? "approved-with-waiver" : "approved";
if ((review.decision === "approved" || review.decision === "approved-with-waiver" || review.status === "pass")
  && (review.decision !== expectedDecision || review.status !== "pass")) {
  errors.push(`approved final review must use decision=${expectedDecision} and status=pass`);
}
if ((review.decision === "approved" || review.decision === "approved-with-waiver") && errors.length) {
  errors.push("approved decision conflicts with blocking evidence");
}
process.stdout.write(`${JSON.stringify({ status: errors.length ? "fail" : "pass", errors }, null, 2)}\n`);
process.exit(errors.length ? 2 : 0);
