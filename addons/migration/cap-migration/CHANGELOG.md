# @linchkit/cap-migration

## 2.0.0

### Minor Changes

- 38b61c5: Add the DB-querying `appliedMigrationsReader` so the core `MigrationCoordinator`
  (Spec 12 §5) is usable end-to-end.

  `createAppliedMigrationsReader({ db, migrationsDir? })` returns a
  `() => Promise<ReadonlySet<string>>` of the migration tags actually applied to a
  target database. It queries drizzle-orm's default migrations table
  (`drizzle.__drizzle_migrations`, parameterized via `sql.identifier` — no
  string-built SQL), maps each row's `created_at` (epoch ms == journal `when`) back
  to its tag via `<migrationsDir>/meta/_journal.json`, returns an empty set on a
  fresh DB / missing table, and skips rows with no matching journal entry.

  Also adds `createDbMigrationCoordinator({ db, repoDir, ... })`, a convenience that
  wires a `MigrationCoordinator` with this reader plus `runMigrations` (forward) and
  `runReverseMigration` (reverse) so callers get a ready-to-use coordinator.

- d844445: Add `MigrationCoordinator` core engine (Spec 12 §5 "DB Migration"). Coordinates forward/reverse DB migrations around a release.

  Applied-vs-pending discovery is **DB-driven, not journal-driven**. The coordinator consumes a REQUIRED injected `appliedMigrationsReader: () => Promise<ReadonlySet<string>>` that reports the migration tags ACTUALLY APPLIED to the target database (sourced from drizzle's `__drizzle_migrations` table). Drizzle's on-disk `meta/_journal.json` is the registry of every GENERATED migration and is deliberately NOT used to decide applied state. From this, `preFlight()` computes `pending = on-disk listing − DB-applied` (and `applied = on-disk listing ∩ DB-applied`), detects committed sibling `down.sql` artifacts, and classifies the release (safe/expand = ok, contract = warning, breaking or any missing `down.sql` = blocker unless `allowIrreversible` confirms manually). Because already-applied migrations are never in the pending set, a forward failure can never reverse a migration the DB already holds.

  `migrateForward()` applies pending migrations and best-effort reverses ONLY this run's pending migrations on failure (returns `aborted`, never throws); `migrateReverse(targetId?)` executes committed `down.sql` artifacts in reverse id order (exclusive `targetId` floor), refusing partial execution when a `down.sql` is missing. All I/O (the applied-migrations reader, forward apply, reverse SQL execution, dir listing) is injectable so the engine is unit-testable without a DB or disk; the reader has no journal-based default — omitting it throws a clear error. Migration ids/paths are validated against flag/path-traversal injection. Drizzle has no native `down`, so reverse migrations are realized via committed `NNNN_name.down.sql` siblings — the coordinator executes them and never generates DDL.

  cap-migration adds `runReverseMigration(db, { sqlPath })`, which reads a committed `down.sql` and executes it inside a transaction via `db.execute(sql.raw(...))`; it is the default reverse SQL executor the coordinator delegates to.

### Patch Changes

- Updated dependencies [aa4fe90]
- Updated dependencies [74ea5ba]
- Updated dependencies [f0aa51c]
- Updated dependencies [0357153]
- Updated dependencies [3b59ddd]
- Updated dependencies [a41b02f]
- Updated dependencies [7bc18f3]
- Updated dependencies [833e1ad]
- Updated dependencies [ee51432]
- Updated dependencies [64ad4c0]
- Updated dependencies [738d9e9]
- Updated dependencies [4c19796]
- Updated dependencies [eae84e7]
- Updated dependencies [efdfe74]
- Updated dependencies [30f08e7]
- Updated dependencies [f191193]
- Updated dependencies [51ecca1]
- Updated dependencies [e91e3f2]
- Updated dependencies [745debd]
- Updated dependencies [4b4f259]
- Updated dependencies [ca5417e]
- Updated dependencies [bb2ec5e]
- Updated dependencies [587f2c9]
- Updated dependencies [13696ca]
- Updated dependencies [d844445]
- Updated dependencies [4475a69]
- Updated dependencies [13696ca]
- Updated dependencies [59aea2e]
- Updated dependencies [e969502]
- Updated dependencies [e13e172]
- Updated dependencies [7929b5b]
- Updated dependencies [d817334]
- Updated dependencies [13696ca]
- Updated dependencies [7ab2986]
- Updated dependencies [e4e6a18]
- Updated dependencies [94d6962]
- Updated dependencies [90bd84b]
- Updated dependencies [0802b40]
- Updated dependencies [5108a65]
- Updated dependencies [106e926]
- Updated dependencies [ebac7d6]
- Updated dependencies [d6b250d]
- Updated dependencies [9f00487]
- Updated dependencies [5f9ff43]
- Updated dependencies [5d8d2d5]
- Updated dependencies [e1f16e8]
- Updated dependencies [9626920]
- Updated dependencies [a1f2bba]
- Updated dependencies [685ccc1]
- Updated dependencies [76511f7]
- Updated dependencies [db10790]
  - @linchkit/core@0.3.0

## 1.0.0

### Minor Changes

- b117c2c: Initial public release — M3 milestone

  - Runtime Entity Overlay (Spec 59): JSONB \_extensions, overlay registry, GraphQL hot-reload
  - AI Workspace (Spec 60): linch doctor, linch info, linch agents-md, linch mcp-dev
  - Core i18n: capability-owned translations, resolveLabel for CLI/MCP
  - Publishing infrastructure: tsup builds, OCA source addons, changesets

### Patch Changes

- Updated dependencies [b117c2c]
  - @linchkit/core@0.2.0
