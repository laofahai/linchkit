---
"@linchkit/cap-migration": minor
---

Add the DB-querying `appliedMigrationsReader` so the core `MigrationCoordinator`
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
