# Final review checklist

1. Verify the canonical contract and requirement IDs.
2. Inspect staged, unstaged and untracked changes against the baseline.
3. Confirm gate ordering, latest attempts and artifact hashes.
4. Confirm the current project fingerprint equals the verified fingerprint.
5. Spot-check the highest-risk path's source and tests against evidence; this is not a full second code review.
6. Spot-check failure handling and public contracts only where evidence claims they were verified.
7. Confirm tests cited by QA/runtime actually exist and were not weakened.
8. Confirm deployment, migration, rollback and residual risks are explicit.
9. Reject unsupported claims, distinguish facts from inference, and state unreviewed areas and residual risks.
10. Emit approval only after the machine validator accepts the final-review artifact.
