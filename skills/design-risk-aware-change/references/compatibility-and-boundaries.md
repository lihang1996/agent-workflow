# Compatibility and boundaries

Check each changed boundary:

- client/server and SSR/CSR execution;
- sync/async and process/thread ownership;
- public API request/response and error contracts;
- runtime, module system and package-manager versions;
- browser engine, viewport and accessibility input;
- database engine, extension, collation and transaction semantics;
- local, CI, preview and production configuration.

For dependencies, record the exact configured range and lockfile result. Read local framework
documentation when repository instructions require it; never substitute remembered defaults.

For a breaking change, name consumers, migration order, compatibility window, rollback and the
observable signal that rollback is needed.
