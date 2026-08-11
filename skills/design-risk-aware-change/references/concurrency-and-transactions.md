# Concurrency and transactions

## Check-then-act

Flag reads that authorize or validate a later write: state checks, balance/inventory checks,
existence checks, uniqueness checks and permission checks. Prefer:

- conditional update/delete with the invariant in the predicate;
- optimistic version or updated-at comparison;
- row/advisory lock when contention and database support justify it;
- unique constraint as the final authority with stable error mapping.

Do not treat a transaction alone as sufficient when the initial read happens outside it or the
isolation level still permits the race.

## Idempotency

Define the stable key, storage duration, concurrent duplicate behavior, replay response and side
effects. UI disabling improves experience but is not a server-side idempotency mechanism.

## Tests

Run at least two overlapping operations against the real persistence boundary. Assert both final
state and caller-visible responses. Avoid a serial loop disguised as a concurrency test.

## Partial failure

List every durable write and external side effect in order. Define which are atomic, which retry,
and how reconciliation observes incomplete work.
