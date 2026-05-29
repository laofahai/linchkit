/**
 * Programmatic migration runner
 *
 * Runs drizzle-kit generated migrations against a PostgreSQL database.
 * Used in production mode (linch db:migrate).
 *
 * Usage:
 *   import { runMigrations } from "@linchkit/cap-migration";
 *   import { createDatabase } from "@linchkit/core/server";
 *   const db = createDatabase({ url: process.env.DATABASE_URL! });
 *   await runMigrations(db, { migrationsFolder: "./drizzle/migrations" });
 */

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

export interface MigrateOptions {
  /** Path to the migrations folder (default: "./drizzle/migrations") */
  migrationsFolder?: string;
}

/**
 * Run all pending migrations from the specified folder.
 * Creates the drizzle migrations tracking table automatically.
 */
export async function runMigrations(
  db: PostgresJsDatabase,
  options?: MigrateOptions,
): Promise<void> {
  const folder = options?.migrationsFolder ?? "./drizzle/migrations";
  await migrate(db, { migrationsFolder: folder });
}

export interface ReverseMigrateOptions {
  /** Absolute path to the committed `NNNN_name.down.sql` artifact to execute. */
  sqlPath: string;
}

/**
 * Execute a single committed reverse migration (`down.sql`).
 *
 * Drizzle has no native `down` step (Spec 12 §5.1 — reverse migrations are
 * realized via committed `NNNN_name.down.sql` artifacts that sit beside the
 * drizzle-kit generated `NNNN_name.sql`). This reads that artifact and runs it
 * inside a transaction so a partially-applied reverse never lands. DDL is never
 * hand-generated here — it is read verbatim from the committed file.
 *
 * @throws when the file is missing/empty or the SQL execution fails (the
 *   transaction rolls back). Callers decide how to surface the failure.
 */
export async function runReverseMigration(
  db: PostgresJsDatabase,
  options: ReverseMigrateOptions,
): Promise<void> {
  const file = Bun.file(options.sqlPath);
  if (!(await file.exists())) {
    throw new Error(`runReverseMigration: reverse SQL not found at "${options.sqlPath}"`);
  }
  const ddl = (await file.text()).trim();
  if (ddl.length === 0) {
    throw new Error(`runReverseMigration: reverse SQL is empty at "${options.sqlPath}"`);
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(ddl));
  });
}
