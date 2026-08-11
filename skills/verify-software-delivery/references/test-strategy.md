# Test strategy

Build the smallest complete evidence pyramid for the change:

- static: formatting, lint, types or compile;
- unit: pure policy and boundary functions;
- integration: real persistence, framework and API behavior;
- migration/schema: forward application and compatibility;
- build: production artifact creation;
- E2E/system: user-visible or process-visible critical paths;
- adversarial: permission, malformed input, retries, races and partial failures.

Map tests to requirement and risk IDs. A high test count is not evidence of coverage. Confirm that
the test reaches the real boundary it claims to verify and asserts business outcomes, not only
implementation details.

Treat missing tooling or environment as unverified. Send product fixes back to implementation; QA
must not edit tests or code to obtain a pass.
