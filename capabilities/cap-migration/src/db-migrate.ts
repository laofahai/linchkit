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
