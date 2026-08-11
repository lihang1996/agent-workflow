# Framework command routing

Discover commands from the repository before choosing defaults.

| Project signal | Candidate checks |
|---|---|
| package.json | named lint/typecheck/test/build/integration/e2e scripts |
| pyproject.toml | configured ruff/mypy/pytest/build tools |
| go.mod | go test ./..., go vet ./... when project policy permits |
| Cargo.toml | cargo fmt --check, clippy/test/build when configured |
| pom.xml | Maven verify/test profiles |
| build.gradle | Gradle check/test/build tasks |
| Makefile/justfile | inspect targets; do not run deploy or destructive targets |

Project commands and CI definitions outrank generic defaults. Do not infer that a default `test`
script includes integration or E2E; inspect its configuration and include/exclude patterns.
