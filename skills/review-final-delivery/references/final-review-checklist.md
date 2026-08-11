# Final review checklist

1. Verify the canonical contract and requirement IDs.
2. Inspect staged, unstaged and untracked changes against the baseline.
3. Confirm gate ordering, latest attempts and artifact hashes.
4. Confirm the current project fingerprint equals the verified fingerprint.
5. Independently inspect authentication, input, data writes, concurrency, cache and secrets.
6. Inspect failure handling, boundary values, compatibility and public contracts.
7. Confirm tests exercise real behavior and no quality configuration was weakened.
8. Confirm deployment, migration, rollback and residual risks are explicit.
9. Reject unsupported claims, distinguish facts from inference, and state unreviewed areas and residual risks.
10. Emit approval only after the machine validator accepts the final-review artifact.
