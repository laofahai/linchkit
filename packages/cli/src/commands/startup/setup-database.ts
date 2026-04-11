/**
 * Database setup — connection, schema generation, migration,
 * TableRegistry construction, and InMemoryStore fallback.
 */

import { runMigrations } from "@linchkit/cap-migration";
import type {
  ConfigRegistry,
  DataProvider,
  EntityDefinition,
  RelationDefinition,
} from "@linchkit/core";
import { databaseConfig } from "@linchkit/core";
import {
  buildTableColumns,
  closeDatabase,
  consoleLogger,
  createDatabase,
  DrizzleDataProvider,
  generateDrizzleSchemaFile,
  generateDrizzleTable,
  generateRelationColumns,
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
  schemas: EntityDefinition[];
  links: RelationDefinition[];
}): Promise<DatabaseSetupResult> {
  const { registry, schemas, links } = opts;

  const dbConf = databaseConfig.from({ config: registry });

  if (!dbConf.url) {
    consoleLogger.info("Using InMemoryStore (no DATABASE_URL configured)");
    return {
      dataProvider: new InMemoryStore(),
      usingDatabase: false,
      dbInstance: undefined,
    };
  }

  try {
    consoleLogger.info("Connecting to PostgreSQL...");
    const dbInstance = createDatabase({
      url: dbConf.url,
      poolSize: dbConf.poolSize,
      debug: dbConf.debug,
    });

    // Generate schema barrel file (still needed for drizzle-kit generate/studio)
    const schemaFile = generateDrizzleSchemaFile(schemas, undefined, undefined, links);
    consoleLogger.info(`Generated Drizzle schema: ${schemaFile}`);

    // Apply any pending migrations
    consoleLogger.info("Applying database migrations...");
    try {
      await runMigrations(dbInstance);
      consoleLogger.info("Migrations applied successfully");
    } catch (migrationErr) {
      const migrationMsg =
        migrationErr instanceof Error ? migrationErr.message : String(migrationErr);
      if (migrationMsg.includes("No migrations found") || migrationMsg.includes("no such file")) {
        consoleLogger.info(
          "No migrations found — run 'bun run db:generate' to create initial migration",
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

    for (const entity of schemas) {
      baseTableMap[entity.name] = generateDrizzleTable(entity);
    }

    // Collect FK columns that need to be added to existing tables from links
    if (links.length > 0) {
      const { fkColumns, junctionTables } = generateRelationColumns(links, baseTableMap);

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

    for (const entity of schemas) {
      const tableName = entity.name;
      const columns = buildTableColumns(entity);

      // Merge extra FK columns from links
      const extraCols = extraFkColumns[tableName];
      if (extraCols) Object.assign(columns, extraCols);

      finalTableMap[tableName] = pgTable(tableName, columns);
    }

    for (const [name, table] of Object.entries(finalTableMap)) {
      tableRegistry.register(name, table);
    }

    const dataProvider = new DrizzleDataProvider(dbInstance, tableRegistry);
    consoleLogger.info("Using PostgreSQL data provider");

    return {
      dataProvider,
      usingDatabase: true,
      dbInstance,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    consoleLogger.error(`Failed to connect to PostgreSQL: ${msg}`, {
      error: err instanceof Error ? err.stack : undefined,
    });
    // Clean up the database connection pool before falling back
    await closeDatabase();
    consoleLogger.info("Falling back to InMemoryStore");

    return {
      dataProvider: new InMemoryStore(),
      usingDatabase: false,
      dbInstance: undefined,
    };
  }
}
