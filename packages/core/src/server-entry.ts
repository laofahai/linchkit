/**
 * @linchkit/core/server — Server-only modules
 *
 * Database connection, Drizzle ORM, table registry, schema sync, persistent event bus.
 * NOT safe for browser — requires Node/Bun runtime (postgres, Buffer).
 *
 * Usage: import { createDatabase, DrizzleDataProvider } from "@linchkit/core/server"
 */

// Database connection
export { closeDatabase, createDatabase, type DatabaseConfig } from "./engine/database";
// Drizzle data provider
export { DrizzleDataProvider } from "./engine/drizzle-data-provider";
// Drizzle schema (system tables for drizzle-kit migrations)
export * as drizzleSchema from "./engine/drizzle-schema";
// Programmatic migration runner
export { type MigrateOptions, runMigrations } from "./engine/migrate";
// Persistent event bus (requires database)
export { createPersistentEventBus, PersistentEventBus } from "./engine/persistent-event-bus";
// Schema sync (dev mode)
export { type SyncOptions, syncTables } from "./engine/schema-sync";
// Schema-to-Drizzle generator
export { type DrizzleGeneratorOptions, generateDrizzleTable } from "./engine/schema-to-drizzle";
// System tables (Drizzle schema definitions)
export {
  approvalStatusEnum,
  approvalsTable,
  eventStatusEnum,
  eventsTable,
  executionStatusEnum,
  executionsTable,
  schemaDefinitionsTable,
} from "./engine/system-tables";
// Table registry
export { TableRegistry } from "./engine/table-registry";
