/**
 * @linchkit/core/server — Server-only modules
 *
 * Database connection, Drizzle ORM, table registry, persistent event bus.
 * NOT safe for browser — requires Node/Bun runtime (postgres, Buffer).
 *
 * Usage: import { createDatabase, DrizzleDataProvider } from "@linchkit/core/server"
 */

// Database connection
export { closeDatabase, createDatabase, type DatabaseConfig } from "./persistence/database";
// Drizzle approval store (requires database)
export { DrizzleApprovalStore } from "./persistence/drizzle-approval-store";
// Drizzle data provider
export { DrizzleDataProvider, type I18nQueryOptions } from "./persistence/drizzle-data-provider";
// Drizzle execution logger (requires database)
export { DrizzleExecutionLogger } from "./persistence/drizzle-execution-logger";
// Drizzle schema (system tables for drizzle-kit migrations)
export * as drizzleSchema from "./persistence/drizzle-schema";
// Drizzle transaction manager (Transactional Outbox pattern)
export { DrizzleTransactionManager } from "./persistence/drizzle-transaction-manager";
// Drizzle schema file generator (bridge: SchemaDefinition[] → .ts file for drizzle-kit)
export { generateDrizzleSchemaFile } from "./schema/generate-drizzle-schema";
// Programmatic migration runner
export { type MigrateOptions, runMigrations } from "./persistence/migrate";
// Outbox worker — reliable event retry with exponential backoff
export {
  createOutboxWorker,
  type OutboxWorker,
  type OutboxWorkerOptions,
} from "./event/outbox-worker";
// Persistent event bus (requires database)
export { createPersistentEventBus, PersistentEventBus } from "./event/persistent-event-bus";
// Schema-to-Drizzle generator
export { type DrizzleGeneratorOptions, generateDrizzleTable } from "./schema/schema-to-drizzle";
// System tables (Drizzle schema definitions)
export {
  approvalStatusEnum,
  approvalsTable,
  eventStatusEnum,
  eventsTable,
  executionStatusEnum,
  executionsTable,
} from "./persistence/system-tables";
// Table registry
export { TableRegistry } from "./persistence/table-registry";
