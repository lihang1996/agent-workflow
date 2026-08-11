# Diff scoping

1. Resolve the project root and repository instructions before reading changes.
2. Prefer the controller-provided baseline. Do not silently substitute a convenient commit.
3. Reconcile Git staged, unstaged, untracked, renamed and deleted paths with the implementation manifest.
4. Treat paths present in only one source as a blocking scope discrepancy until explained.
5. For more than 500 changed lines, group by logical module and review every group separately.
6. For mixed concerns, group by requirement or feature instead of reviewing only file order.
7. Search callers, exports, schemas, routes, configuration keys and tests for every changed public contract.
8. Record dynamic or external consumers as unverified when static search cannot prove absence.
9. Exclude controller evidence directories such as `.agent-os`, but do not exclude project source by convenience.
10. A clean Git diff is not proof of no change when the implementation manifest or project snapshot differs.
