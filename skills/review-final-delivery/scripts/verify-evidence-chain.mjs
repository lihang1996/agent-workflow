#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

const path = process.argv[2];
if (!path) {
  console.error("usage: verify-evidence-chain.mjs <evidence-chain.json>");
  process.exit(64);
}
const chain = JSON.parse(await readFile(path, "utf8"));
const errors = [];
if (chain.schemaVersion !== "2.0"
  || chain.generatedBy !== "agent-os-controller"
  || chain.controllerOwned !== true) {
  errors.push("evidence chain is not a controller-owned v2 manifest");
}
if (!chain.workflowId || !chain.generatedAt) errors.push("evidence chain lacks workflow provenance");
const latest = new Map();
for (const run of chain.gateRuns ?? []) {
  const current = latest.get(run.gateId);
  if (!current || run.attempt > current.attempt) latest.set(run.gateId, run);
}
for (const gateId of chain.requiredGateIds ?? []) {
  if (gateId === "final-review") errors.push("pre-final evidence chain must not include final-review");
  const run = latest.get(gateId);
  if (!run) errors.push(`required gate missing: ${gateId}`);
  else if (run.status !== "pass" && !(gateId === "runtime-audit" && run.status === "not-applicable")) {
    errors.push(`required gate is not pass: ${gateId}`);
  }
  if (typeof run?.projectFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(run.projectFingerprint)) {
    errors.push(`required gate lacks valid project fingerprint: ${gateId}`);
  }
}
if (!chain.currentFingerprint || chain.currentFingerprint !== chain.verifiedFingerprint) {
  errors.push("current fingerprint does not match verified fingerprint");
}
const implementation = latest.get("implementation");
const changeReview = latest.get("change-review");
const verification = latest.get("verification");
const runtime = latest.get("runtime-audit");
if (implementation?.projectFingerprint !== changeReview?.projectFingerprint) {
  errors.push("change-review fingerprint does not match implementation");
}
if (changeReview?.projectFingerprint !== verification?.projectFingerprint) {
  errors.push("verification fingerprint does not match change-review");
}
if (runtime?.projectFingerprint !== verification?.projectFingerprint) {
  errors.push("runtime fingerprint does not match verification");
}
const chainRoot = await realpath(dirname(resolve(path)));
const artifactKeys = new Set();
const artifactGateIds = new Set();
const verifiedArtifacts = new Map();
for (const artifact of chain.artifacts ?? []) {
  try {
    const artifactPath = await realpath(resolve(artifact.path));
    const rel = relative(chainRoot, artifactPath);
    if (rel === "" || rel.startsWith("..") || resolve(chainRoot, rel) !== artifactPath) {
      errors.push(`artifact outside evidence root: ${artifact.path}`);
      continue;
    }
    const key = `${artifact.gateId}:${artifact.attempt}:${artifactPath}`;
    if (artifactKeys.has(key)) errors.push(`duplicate artifact: ${artifact.path}`);
    artifactKeys.add(key);
    artifactGateIds.add(artifact.gateId);
    const content = await readFile(artifactPath);
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== artifact.sha256) errors.push(`artifact hash mismatch: ${artifact.path}`);
    verifiedArtifacts.set(`${artifact.gateId}:${basename(artifactPath)}`, {
      artifact,
      content,
    });
  } catch (error) {
    errors.push(`artifact unreadable: ${artifact.path}: ${error.message}`);
  }
}
for (const gateId of chain.requiredGateIds ?? []) {
  if (!artifactGateIds.has(gateId)) errors.push(`required gate lacks artifact: ${gateId}`);
}
const verificationArtifact = verifiedArtifacts.get("verification:verification-report.json");
const runtimeArtifact = verifiedArtifacts.get("runtime-audit:runtime-audit.json");
if (!verificationArtifact || !runtimeArtifact) {
  errors.push("verification/runtime primary artifact is missing");
} else {
  try {
    const verificationReport = JSON.parse(verificationArtifact.content.toString("utf8"));
    const runtimeReport = JSON.parse(runtimeArtifact.content.toString("utf8"));
    if (runtimeReport.verificationHash !== verificationArtifact.artifact.sha256) {
      errors.push("runtime verificationHash does not match verification artifact");
    }
    if (runtimeReport.buildHash !== verificationReport.buildHash) {
      errors.push("runtime buildHash does not match QA-verified build");
    }
  } catch (error) {
    errors.push(`verification/runtime primary artifact is not valid JSON: ${error.message}`);
  }
}
process.stdout.write(`${JSON.stringify({ status: errors.length ? "fail" : "pass", errors }, null, 2)}\n`);
process.exit(errors.length ? 2 : 0);
