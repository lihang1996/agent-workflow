# Data-write patterns

- Put authorization and invariants as close as possible to the authoritative write.
- Use conditional writes for state transitions and verify affected row count.
- Use constraints for uniqueness and map constraint errors to stable business errors.
- Keep related writes in one transaction or document reconciliation.
- Make retryable commands idempotent.
- Return enough old/new state to drive cache and event invalidation.
- Use byte-aware validation when the contract specifies bytes.
- Normalize once at the write boundary and reuse the same function for lookup.

Tests must cover invalid transitions, concurrent calls, duplicate retries, constraint collisions,
transaction rollback and observable error mapping.
