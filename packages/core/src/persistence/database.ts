/**
 * Database connection manager
 *
 * Creates and manages a Drizzle ORM instance backed by postgres.js.
 * Uses postgres.js for best Bun compatibility.
 */

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { DatabaseConfig } from "../types/database";

export type { DatabaseConfig };

/** Active connection reference for cleanup */
let activeSql: ReturnType<typeof postgres> | null = null;

/** Stored callbacks for lifecycle events */
let activeCallbacks: { onConnect?: () => void; onClose?: () => void } | null = null;

/**
 * Parse host and port from a PostgreSQL connection URL for error messages.
 * Deliberately omits credentials.
 */
function safeConnectionInfo(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname || "localhost";
    const port = parsed.port || "5432";
    const db = parsed.pathname?.replace(/^\//, "") || "(unknown)";
    return `${host}:${port}/${db}`;
  } catch {
    // URL constructor threw — return safe fallback instead of leaking the raw URL
    return "(unparseable URL)";
  }
}

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

  const connectTimeout = config.connectTimeout ?? 5000;
  const idleTimeout = config.idleTimeout ?? 30000;

  let sqlInstance: ReturnType<typeof postgres>;
  try {
    sqlInstance = postgres(config.url, {
      max: config.poolSize ?? 10,
      debug: config.debug ?? false,
      connect_timeout: Math.ceil(connectTimeout / 1000),
      idle_timeout: Math.ceil(idleTimeout / 1000),
    });
  } catch (err) {
    const info = safeConnectionInfo(config.url);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create database connection to ${info}: ${msg}`);
  }

  activeSql = sqlInstance;
  activeCallbacks = { onConnect: config.onConnect, onClose: config.onClose };

  config.onConnect?.();

  return drizzle(sqlInstance);
}

/**
 * Check if the database connection is alive by running `SELECT 1`.
 *
 * @param db - A Drizzle database instance created by `createDatabase()`.
 * @returns `true` if the connection is healthy.
 * @throws Error with connection details (no password) if the check fails.
 */
export async function checkConnection(db: PostgresJsDatabase): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Database health check failed: ${msg}`);
  }
}

/**
 * Close the active database connection and drain the pool.
 */
export async function closeDatabase(): Promise<void> {
  if (activeSql) {
    const callbacks = activeCallbacks;
    await activeSql.end({ timeout: 5 });
    activeSql = null;
    activeCallbacks = null;
    callbacks?.onClose?.();
  }
}
