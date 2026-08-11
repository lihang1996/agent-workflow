# Risk taxonomy

Use signals to require analysis; a signal is not itself a failure.

| Risk | Typical signals | Required design response |
|---|---|---|
| authorization | admin, owner, role, session, tenant | server-side decision and negative tests |
| input safety | user text, URL, path, template, query | validation, encoding and size limits |
| concurrency | read then write, counters, state transitions | atomic predicate, lock or version check |
| idempotency | retries, double click, webhook, job | stable key and replay behavior |
| transactions | multiple writes, relations, outbox | boundary, isolation and partial-failure rule |
| cache | revalidate, invalidate, TTL, shared response | key scope, failure policy and freshness proof |
| compatibility | runtime, browser, module, DB, API version | supported matrix and downgrade behavior |
| migration | schema/data transformation | preflight, rollback and recovery |
| external I/O | network, queue, filesystem | timeout, retry, cancellation and observability |
| secrets/PII | credentials, tokens, contact data | storage, redaction, access and retention |

For every applicable risk, record impact, likelihood, control, evidence and residual risk. A
`not-applicable` disposition needs a concrete source or architecture reason.
