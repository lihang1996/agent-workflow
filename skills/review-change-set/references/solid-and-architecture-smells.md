# SOLID and architecture smells

Use these prompts only when the changed code affects module responsibilities or public contracts.

- **Single responsibility:** identify unrelated reasons for one module to change; split by responsibility, not file length.
- **Open/closed:** prefer a stable extension point when a known variation axis exists; avoid speculative abstractions.
- **Substitutability:** verify implementations preserve documented input, output, error and state guarantees.
- **Interface segregation:** prevent consumers from depending on methods, fields or events they do not use.
- **Dependency inversion:** keep policy independent from framework, storage and transport details where replacement is expected.
- Inspect dependency direction, ownership, cycles, duplicated policy and leaking infrastructure types.
- Preserve behavior during refactoring and require focused tests before structural cleanup.
- Prefer composition and explicit state models; make invalid states difficult to represent.
- Classify optional cleanup as P2/P3 unless current correctness, security or operability is affected.
