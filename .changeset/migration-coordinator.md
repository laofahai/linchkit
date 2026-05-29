---
"@linchkit/core": patch
"@linchkit/cap-migration": patch
---

Add `MigrationCoordinator` core engine (Spec 12 §5 "DB Migration"). Coordinates forward/reverse DB migrations around a release: `preFlight()` discovers pending migrations, detects committed sibling `down.sql` artifacts, classifies the release (safe/expand = ok, contract = warning, breaking or any missing `down.sql` = blocker unless `allowIrreversible` confirms manually); `migrateForward()` applies pending migrations and best-effort reverses on failure (returns `aborted`, never throws); `migrateReverse(targetId?)` executes committed `down.sql` artifacts in reverse id order, refusing partial execution when a `down.sql` is missing. All I/O (drizzle-kit subprocess, forward apply, reverse SQL execution, dir reads) is injectable; migration ids/paths are validated against flag/path-traversal injection. Drizzle has no native `down`, so reverse migrations are realized via committed `NNNN_name.down.sql` siblings — the coordinator executes them and never generates DDL.

cap-migration adds `runReverseMigration(db, { sqlPath })`, which reads a committed `down.sql` and executes it inside a transaction via `db.execute(sql.raw(...))`; it is the default reverse SQL executor the coordinator delegates to.
