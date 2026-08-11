# Security and reliability review

Load the applicable sections based on changed trust boundaries.

## Input and output

- Validate type, size, format, range, encoding and canonical form at the trust boundary.
- Check injection, XSS, SSRF, path traversal, unsafe redirects, deserialization and template execution.
- Verify output encoding matches its HTML, URL, SQL, shell, log or header context.

## Identity and data

- Verify authentication, authorization, tenant isolation and object-level access on every protected operation.
- Check secret, token and PII exposure in source, logs, errors, telemetry and client bundles.
- Review JWT algorithm, issuer, audience, expiry and key handling when tokens change.
- Review dependency and lockfile changes for provenance, lifecycle and privilege impact.

## State and resources

- Check transaction boundaries, idempotency, retry behavior, race windows and check-then-act updates.
- Verify uniqueness, ordering, partial failure and rollback behavior under concurrent execution.
- Bound request size, recursion, fan-out, memory, CPU, connection and queue consumption.
- Check timeouts, cancellation, backpressure, rate limits and cache partitioning.

For P0/P1 findings record reachability, exploitability, concrete impact, evidence and confidence.
