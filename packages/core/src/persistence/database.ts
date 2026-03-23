/**
 * Database connection manager
 *
 * Creates and manages a Drizzle ORM instance backed by postgres.js.
 * Uses postgres.js for best Bun compatibility.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { DatabaseConfig } from "../types/database";

export type { DatabaseConfig };

/** Active connection reference for cleanup */
let activeSql: ReturnType<typeof postgres> | null = null;

/**
 * Create a Drizzle database instance from config.
 *
 * @returns A Drizzle PostgresJsDatabase instance ready for queries.
 */
export function createDatabase(config: DatabaseConfig): PostgresJsDatabase {
  if (activeSql) {
    throw new Error(
      "A database connection is already active. Call closeDatabase() before creating a new one.",
    );
  }

  const sql = postgres(config.url, {
    max: config.poolSize ?? 10,
    debug: config.debug ?? false,
  });

  activeSql = sql;

  return drizzle(sql);
}

/**
 * Close the active database connection and drain the pool.
 */
export async function closeDatabase(): Promise<void> {
  if (activeSql) {
    await activeSql.end();
    activeSql = null;
  }
}
