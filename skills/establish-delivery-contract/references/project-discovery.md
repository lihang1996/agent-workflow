# Project discovery

## Evidence order

1. Read repository instructions such as `AGENTS.md`, `CLAUDE.md`, local policies and nested variants.
2. Read package/runtime declarations and lockfiles.
3. Read build, test, schema, migration, CI and deployment configuration.
4. Read code only far enough to confirm entry points, public surfaces and data stores.
5. Record facts separately from inferred conventions.

## Common signals

| Signal | Meaning |
|---|---|
| `package.json`, lockfile | JavaScript runtime, package manager and scripts |
| `pyproject.toml`, `requirements*.txt` | Python runtime and test tooling |
| `go.mod` | Go module and version |
| `Cargo.toml` | Rust workspace and commands |
| `pom.xml`, `build.gradle*` | JVM toolchain |
| migration/schema files | Persistent data and destructive-test risk |
| browser/E2E config | Runtime UI verification |
| CI files | Existing merge gates, not proof that they currently pass |

Ignore generated output, dependencies, VCS metadata and secret files when fingerprinting. Never
print secret values. Treat absent configuration as missing evidence, not proof that a capability is
unnecessary.

## Command classification

Classify discovered commands as lint, format-check, typecheck/compile, unit, integration, schema,
migration, build, E2E/system, security or deploy. Do not execute destructive or deploy commands
during discovery.
