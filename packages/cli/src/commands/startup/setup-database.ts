/**
 * Database setup — connection, schema generation, migration,
 * TableRegistry construction, and InMemoryStore fallback.
 */

import { runMigrations } from "@linchkit/cap-migration";
import type {
  ConfigRegistry,
  DataProvider,
  LinkDefinition,
  SchemaDefinition,
} from "@linchkit/core";
import { databaseConfig } from "@linchkit/core";
import {
  buildTableColumns,
  closeDatabase,
  createDatabase,
  DrizzleDataProvider,
  generateDrizzleSchemaFile,
  generateDrizzleTable,
  generateLinkColumns,
  InMemoryStore,
  TableRegistry,
} from "@linchkit/core/server";
import { getTableConfig, pgTable } from "drizzle-orm/pg-core";

export interface DatabaseSetupResult {
  dataProvider: DataProvider;
  usingDatabase: boolean;
  dbInstance: ReturnType<typeof createDatabase> | undefined;
}

/**
 * Set up the database connection, run migrations, build the TableRegistry,
 * and return a DataProvider. Falls back to InMemoryStore when no DATABASE_URL
 * is configured or when the connection fails.
 */
export async function setupDatabase(opts: {
  registry: ConfigRegistry;
  schemas: SchemaDefinition[];
  links: LinkDefinition[];
}): Promise<DatabaseSetupResult> {
  const { registry, schemas, links } = opts;

  const dbConf = databaseConfig.from({ config: registry });

  if (!dbConf.url) {
    console.log("[linch] Using InMemoryStore (no DATABASE_URL configured)");
    return {
      dataProvider: new InMemoryStore(),
      usingDatabase: false,
      dbInstance: undefined,
    };
  }

  try {
    console.log("[linch] Connecting to PostgreSQL...");
    const dbInstance = createDatabase({
      url: dbConf.url,
      poolSize: dbConf.poolSize,
      debug: dbConf.debug,
    });

    // Generate schema barrel file (still needed for drizzle-kit generate/studio)
    const schemaFile = generateDrizzleSchemaFile(schemas, undefined, undefined, links);
    console.log(`[linch] Generated Drizzle schema: ${schemaFile}`);

    // Apply any pending migrations
    console.log("[linch] Applying database migrations...");
    try {
      await runMigrations(dbInstance);
      console.log("[linch] Migrations applied successfully");
    } catch (migrationErr) {
      const migrationMsg =
        migrationErr instanceof Error ? migrationErr.message : String(migrationErr);
      if (migrationMsg.includes("No migrations found") || migrationMsg.includes("no such file")) {
        console.log(
          "[linch] No migrations found — run 'bun run db:generate' to create initial migration",
        );
      } else {
        throw migrationErr;
      }
    }

    // Build runtime TableRegistry for DrizzleDataProvider query routing.
    // Phase 1: Generate base tables from schema fields to get table references for .references()
    // Phase 2: Collect all extra FK columns needed for each table
    // Phase 3: Re-generate complete tables with all FK columns included
    // Phase 4: Register junction tables (many_to_many)
    const tableRegistry = new TableRegistry();

    const baseTableMap: Record<string, ReturnType<typeof pgTable>> = {};
    const extraFkColumns: Record<string, Record<string, unknown>> = {};

    for (const schema of schemas) {
      baseTableMap[schema.name] = generateDrizzleTable(schema);
    }

    // Collect FK columns that need to be added to existing tables from links
    if (links.length > 0) {
      const { fkColumns, junctionTables } = generateLinkColumns(links, baseTableMap);

      // Merge collected FK columns into extraFkColumns map
      for (const [tableName, cols] of Object.entries(fkColumns)) {
        if (!extraFkColumns[tableName]) {
          extraFkColumns[tableName] = {};
        }
        Object.assign(extraFkColumns[tableName], cols);
      }

      // Register junction tables (many_to_many links)
      for (const jt of junctionTables) {
        const jtName = getTableConfig(jt).name;
        tableRegistry.register(jtName, jt);
      }
    }

    // Re-generate complete tables with all extra FK columns included.
    // buildTableColumns() creates fresh Drizzle column builder instances
    // (built columns can't have .setName() called again by pgTable).
    const finalTableMap: Record<string, ReturnType<typeof pgTable>> = {};

    for (const schema of schemas) {
      const tableName = schema.name;
      const columns = buildTableColumns(schema);

      // Merge extra FK columns from links
      const extraCols = extraFkColumns[tableName];
      if (extraCols) Object.assign(columns, extraCols);

      finalTableMap[tableName] = pgTable(tableName, columns);
    }

    for (const [name, table] of Object.entries(finalTableMap)) {
      tableRegistry.register(name, table);
    }

    const dataProvider = new DrizzleDataProvider(dbInstance, tableRegistry);
    console.log("[linch] Using PostgreSQL data provider");

    return {
      dataProvider,
      usingDatabase: true,
      dbInstance,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[linch] Failed to connect to PostgreSQL: ${msg}`);
    // Clean up the database connection pool before falling back
    await closeDatabase();
    console.log("[linch] Falling back to InMemoryStore");

    return {
      dataProvider: new InMemoryStore(),
      usingDatabase: false,
      dbInstance: undefined,
    };
  }
}
