# Test resource safety

Run this preflight before migrate, seed, truncate, drop, delete-all or destructive fixtures.

Require:

1. An explicit test connection or disposable resource ID.
2. A parsed resource name that matches the project test naming policy.
3. Inequality with development, preview and production connections after normalization.
4. A sentinel, disposable lease or CI-provided resource identity.
5. Logs that omit credentials.

Localhost alone is not proof of safety. A variable named `TEST_DATABASE_URL` is not proof of
safety. Refuse destructive work when identity cannot be established.

Clean up only resources created by the current test run. Prefer unique namespaces/databases and
record the identifier in evidence.
