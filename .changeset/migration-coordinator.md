---
"@linchkit/core": minor
"@linchkit/cap-migration": minor
---

Add `MigrationCoordinator` core engine (Spec 12 §5 "DB Migration"). Coordinates forward/reverse DB migrations around a release.

Applied-vs-pending discovery is **DB-driven, not journal-driven**. The coordinator consumes a REQUIRED injected `appliedMigrationsReader: () => Promise<ReadonlySet<string>>` that reports the migration tags ACTUALLY APPLIED to the target database (sourced from drizzle's `__drizzle_migrations` table). Drizzle's on-disk `meta/_journal.json` is the registry of every GENERATED migration and is deliberately NOT used to decide applied state. From this, `preFlight()` computes `pending = on-disk listing − DB-applied` (and `applied = on-disk listing ∩ DB-applied`), detects committed sibling `down.sql` artifacts, and classifies the release (safe/expand = ok, contract = warning, breaking or any missing `down.sql` = blocker unless `allowIrreversible` confirms manually). Because already-applied migrations are never in the pending set, a forward failure can never reverse a migration the DB already holds.

`migrateForward()` applies pending migrations and best-effort reverses ONLY this run's pending migrations on failure (returns `aborted`, never throws); `migrateReverse(targetId?)` executes committed `down.sql` artifacts in reverse id order (exclusive `targetId` floor), refusing partial execution when a `down.sql` is missing. All I/O (the applied-migrations reader, forward apply, reverse SQL execution, dir listing) is injectable so the engine is unit-testable without a DB or disk; the reader has no journal-based default — omitting it throws a clear error. Migration ids/paths are validated against flag/path-traversal injection. Drizzle has no native `down`, so reverse migrations are realized via committed `NNNN_name.down.sql` siblings — the coordinator executes them and never generates DDL.

cap-migration adds `runReverseMigration(db, { sqlPath })`, which reads a committed `down.sql` and executes it inside a transaction via `db.execute(sql.raw(...))`; it is the default reverse SQL executor the coordinator delegates to.
