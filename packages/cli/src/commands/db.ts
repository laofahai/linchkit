/**
 * linch db — Database schema management commands
 *
 * Wraps drizzle-kit with LinchKit's capability-aware schema generation.
 * Reads linchkit.config.ts, collects all EntityDefinitions from capabilities,
 * generates a Drizzle schema barrel file, then delegates to drizzle-kit.
 */

import { runMigrations } from "@linchkit/cap-migration";
import type {
  CapabilityDefinition,
  EntityDefinition,
  LinchKitConfig,
  RelationDefinition,
} from "@linchkit/core";
import { closeDatabase, createDatabase, generateDrizzleSchemaFile } from "@linchkit/core/server";
import { defineCommand } from "citty";
import { loadConfig } from "../utils/load-config";

/** Load entities and relations from linchkit.config.ts */
async function loadEntitiesAndRelations(): Promise<{
  entities: EntityDefinition[];
  relations: RelationDefinition[];
}> {
  let config: LinchKitConfig = {};
  try {
    const result = await loadConfig();
    config = result.config;
  } catch {
    // Config file missing or invalid — cannot proceed without database configuration
    console.error("[linch] Failed to load config. Run from project root with linchkit.config.ts.");
    process.exit(1);
  }

  const capabilities = (config.capabilities ?? []) as CapabilityDefinition[];
  const entities: EntityDefinition[] = [];
  const relations: RelationDefinition[] = [];
  for (const cap of capabilities) {
    if (cap.entities) entities.push(...cap.entities);
    if (cap.relations) relations.push(...cap.relations);
  }

  return { entities, relations };
}

/** Generate the schema barrel file and return its path */
async function generateSchema(): Promise<string> {
  const { entities, relations } = await loadEntitiesAndRelations();
  const schemaFile = generateDrizzleSchemaFile(entities, undefined, undefined, relations);
  console.log(`[linch] Generated Drizzle schema: ${schemaFile}`);
  console.log(
    `[linch] ${entities.length} capability table(s) + system tables, ${relations.length} link(s)`,
  );
  return schemaFile;
}

export const dbGenerateCommand = defineCommand({
  meta: {
    name: "generate",
    description: "Generate migration SQL from schema changes",
  },
  async run() {
    await generateSchema();

    console.log("[linch] Running drizzle-kit generate...");
    const result = Bun.spawnSync(["bun", "./node_modules/.bin/drizzle-kit", "generate"], {
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exit(result.exitCode ?? 0);
  },
});

export const dbMigrateCommand = defineCommand({
  meta: {
    name: "migrate",
    description: "Apply pending migrations to database",
  },
  async run() {
    // Use drizzle-orm migrate() API directly — no drizzle-kit CLI needed.
    // Reads SQL files from drizzle/migrations/, applies any not yet applied.
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      console.error("[linch] DATABASE_URL is required for migrations");
      process.exit(1);
    }

    console.log("[linch] Applying pending migrations...");
    const db = createDatabase({ url: dbUrl });
    try {
      await runMigrations(db);
      console.log("[linch] Migrations applied successfully");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[linch] Migration failed: ${msg}`);
      process.exit(1);
    } finally {
      await closeDatabase();
    }
  },
});

export const dbPushCommand = defineCommand({
  meta: {
    name: "push",
    description: "Push schema directly to database (dev mode)",
  },
  async run() {
    await generateSchema();

    console.log("[linch] Running drizzle-kit push...");
    const result = Bun.spawnSync(["bun", "./node_modules/.bin/drizzle-kit", "push", "--force"], {
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exit(result.exitCode ?? 0);
  },
});

export const dbStudioCommand = defineCommand({
  meta: {
    name: "studio",
    description: "Open Drizzle Studio (database GUI)",
  },
  async run() {
    // Studio needs the schema file to display table structures
    await generateSchema();

    console.log("[linch] Opening Drizzle Studio...");
    const result = Bun.spawnSync(["bun", "./node_modules/.bin/drizzle-kit", "studio"], {
      cwd: process.cwd(),
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exit(result.exitCode ?? 0);
  },
});

export const dbCommand = defineCommand({
  meta: {
    name: "db",
    description: "Database schema management",
  },
  subCommands: {
    generate: dbGenerateCommand,
    migrate: dbMigrateCommand,
    push: dbPushCommand,
    studio: dbStudioCommand,
  },
});
