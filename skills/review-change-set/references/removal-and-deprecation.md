# Removal and deprecation

Classify every meaningful deletion as `safe-delete-now` or `defer`.

## Safe delete now

Record:

- deleted path or contract;
- static search and test evidence showing no required consumers;
- migration or compatibility impact;
- exact verification commands;
- rollback method.

## Defer

Record:

- remaining internal, dynamic or external consumers;
- compatibility or telemetry preconditions;
- migration owner and target condition;
- staged removal sequence;
- validation and rollback plan.

Do not treat absence from static search as proof that externally published APIs, persisted data,
configuration keys, events or dynamically loaded modules have no consumers.
