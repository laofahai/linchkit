---
"@linchkit/core": minor
---

Close the residual record-state guard TOCTOU window with a row-level lock (#470).

#469 moved `block` / `require_approval` guard-rule evaluation inside the write
transaction, but under PostgreSQL READ COMMITTED a plain `SELECT` guard read +
the write were still not atomic — a concurrent commit could land between them.

`DataQueryOptions` gains an opt-in `forUpdate` flag. The Drizzle provider honors
it with `SELECT … FOR UPDATE`, and the in-transaction guard re-check now sets it
so the guarded row is pinned from the read until commit: a concurrent writer
blocks instead of slipping a state change past the guard. The InMemoryStore is
single-threaded and already serialized, so it no-ops the flag. No behavior change
for existing callers — `forUpdate` defaults to off.
