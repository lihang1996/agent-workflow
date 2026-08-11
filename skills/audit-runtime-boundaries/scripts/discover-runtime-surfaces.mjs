#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) {
  console.error("usage: discover-runtime-surfaces.mjs <delivery-contract.json>");
  process.exit(64);
}
const contract = JSON.parse(await readFile(path, "utf8"));
const explicit = contract.runtimeSurfaces ?? [];
const fromRequirements = (contract.requirements ?? [])
  .filter((item) => ["runtime", "browser", "http", "e2e"].includes(item?.evidenceType))
  .map((item) => ({
    id: item.id,
    type: item.surfaceType ?? "unspecified",
    target: item.target ?? item.acceptance,
    priority: item.priority,
  }));
const surfaces = [...explicit, ...fromRequirements];
const defaultStates = ["normal", "empty", "loading", "error", "not-found", "permission-denied"];
process.stdout.write(`${JSON.stringify({
  schemaVersion: "1.0",
  surfaces: surfaces.map((surface) => ({
    ...surface,
    requiredStates: surface.requiredStates ?? defaultStates,
  })),
  browsers: contract.environmentMatrix?.browsers ?? [],
  viewports: contract.environmentMatrix?.viewports ?? [],
  warning: surfaces.length ? undefined : "No runtime surfaces declared in the delivery contract.",
}, null, 2)}\n`);
