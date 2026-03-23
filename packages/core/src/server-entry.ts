/**
 * @linchkit/core/server — Server-only modules
 *
 * Database connection, Drizzle ORM, table registry, persistent event bus.
 * NOT safe for browser — requires Node/Bun runtime (postgres, Buffer).
 *
 * Usage: import { createDatabase, DrizzleDataProvider } from "@linchkit/core/server"
 */

// Database connection
export { closeDatabase, createDatabase, type DatabaseConfig } from "./engine/database";
// Drizzle approval store (requires database)
export { DrizzleApprovalStore } from "./engine/drizzle-approval-store";
// Drizzle data provider
export { DrizzleDataProvider, type I18nQueryOptions } from "./engine/drizzle-data-provider";
// Drizzle execution logger (requires database)
export { DrizzleExecutionLogger } from "./engine/drizzle-execution-logger";
// Drizzle schema (system tables for drizzle-kit migrations)
export * as drizzleSchema from "./engine/drizzle-schema";
// Drizzle schema file generator (bridge: SchemaDefinition[] → .ts file for drizzle-kit)
export { generateDrizzleSchemaFile } from "./engine/generate-drizzle-schema";
// Programmatic migration runner
export { type MigrateOptions, runMigrations } from "./engine/migrate";
// Outbox worker — reliable event retry with exponential backoff
export {
  createOutboxWorker,
  type OutboxWorker,
  type OutboxWorkerOptions,
} from "./engine/outbox-worker";
// Persistent event bus (requires database)
export { createPersistentEventBus, PersistentEventBus } from "./engine/persistent-event-bus";
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
} from "./engine/system-tables";
// Table registry
export { TableRegistry } from "./engine/table-registry";
