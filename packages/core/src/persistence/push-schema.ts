/**
 * Programmatic schema push utility
 *
 * Uses drizzle-kit's generateDrizzleJson() + generateMigration() API to
 * compute DDL from pgTable definitions and execute it directly.
 *
 * This avoids drizzle-kit's pushSchema() which hangs in Bun due to
 * TTY/interactive prompt issues during introspection (known bug).
 *
 * The approach: generate a migration from empty → target schema,
 * then execute the resulting SQL statements. Idempotent via
 * IF NOT EXISTS / try-catch for already-exists errors.
 *
 * @see https://github.com/drizzle-team/drizzle-orm/discussions/1901
 * @see https://github.com/drizzle-team/drizzle-orm/discussions/4373
 */

import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

export interface PushSchemaOptions {
  /** If true, return statements without applying */
  dryRun?: boolean;
}

export interface PushSchemaResult {
  /** Whether changes were applied */
  applied: boolean;
  /** Number of DDL statements executed */
  statementsCount: number;
  /** The actual SQL statements */
  statements: string[];
}

/**
 * Push Drizzle schema to the database programmatically.
 *
 * Generates CREATE TABLE/TYPE/INDEX SQL from pgTable definitions
 * using drizzle-kit's migration generation API, then executes directly.
 *
 * Safe to call multiple times — uses IF NOT EXISTS semantics.
 */
export async function pushDrizzleSchema(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle db instance type varies
  db: PgDatabase<any>,
  schemaExports: Record<string, unknown>,
  options?: PushSchemaOptions,
): Promise<PushSchemaResult> {
  const exec = db as { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

  // Ensure the _linchkit PostgreSQL schema exists
  await exec.execute(sql`CREATE SCHEMA IF NOT EXISTS _linchkit`);

  // Generate migration SQL from empty → target schema
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  const emptySnapshot = generateDrizzleJson({});
  const targetSnapshot = generateDrizzleJson(schemaExports);
  const migrationStatements = await generateMigration(emptySnapshot, targetSnapshot);

  if (options?.dryRun) {
    return {
      applied: false,
      statementsCount: migrationStatements.length,
      statements: migrationStatements,
    };
  }

  // Execute each migration statement
  let executedCount = 0;
  for (const migration of migrationStatements) {
    // Split by drizzle's statement breakpoint marker
    const parts = migration.split("--> statement-breakpoint");
    for (const part of parts) {
      let stmt = part.trim();
      if (!stmt) continue;

      // Make CREATE SCHEMA idempotent (drizzle generates without IF NOT EXISTS)
      stmt = stmt.replace(
        /^CREATE SCHEMA "([^"]+)";$/,
        'CREATE SCHEMA IF NOT EXISTS "$1";',
      );

      try {
        await exec.execute(sql.raw(stmt));
        executedCount++;
      } catch (err) {
        // Skip "already exists" errors for idempotent behavior.
        // DrizzleQueryError wraps PostgresError in .cause — check both levels.
        const msg = err instanceof Error ? err.message : "";
        const causeMsg =
          err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
        if (msg.includes("already exists") || causeMsg.includes("already exists")) {
          continue;
        }
        throw err;
      }
    }
  }

  return {
    applied: true,
    statementsCount: executedCount,
    statements: migrationStatements,
  };
}
