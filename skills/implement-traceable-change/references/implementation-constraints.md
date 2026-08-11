# Implementation constraints

## Preserve scope

- Compare changed files with the plan allowlist.
- Preserve unrelated staged, unstaged and untracked user work.
- Treat changes to compiler, lint, test, CI, security and coverage configuration as high risk.
- Rebaseline instead of quietly expanding scope.

## Preserve failure semantics

Propagate or map failures at explicit boundaries. Do not catch and continue after critical writes,
cache invalidation requirements or verification failures unless the plan defines recovery.

## Traceability

Map each changed file to requirement IDs and risk-control IDs. Map each P0/P1 requirement to at
least one behavior test or runtime check. Comments and function names are not proof.

## Gate integrity

Reject added skips, exclusive tests, empty assertions, reduced test projects, relaxed types,
disabled lint rules and ignored command failures unless the contract explicitly approves them.
