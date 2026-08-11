# Requirement reconciliation

## Source record

For every source record: stable ID, absolute or project-relative path, status, owner if known,
updated time if available, SHA-256 and scope summary.

## Authority rules

- Prefer explicit owner confirmation over naming conventions.
- An approved newer document does not silently supersede another approved document.
- Record `supersedes` explicitly and keep the old source addressable.
- Permit one canonical source set per project baseline.
- Stop when two P0/P1 sources conflict and no authority rule resolves them.

## Requirement record

Each requirement needs:

- stable ID such as `RQ-001`;
- priority and source location;
- observable behavior;
- negative or boundary case;
- evidence type;
- status: planned, implemented, verified, waived or out-of-scope.

Avoid vague acceptance such as “works correctly”, “responsive” or “secure”. Express what is
observed, under which environment, and what result blocks delivery.

## Conflict examples

- A route is required by one approved spec and forbidden by another.
- A database field is mutable in the PRD but immutable in architecture.
- A task plan declares E2E mandatory while the package default excludes it.
- A deployment target uses an older runtime than the package engine.

Resolve conflicts before architecture. Do not defer them into implementation prompts.
