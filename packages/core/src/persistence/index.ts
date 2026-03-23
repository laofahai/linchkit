/**
 * Persistence layer barrel export
 *
 * Re-exports all persistence-related modules: database connection,
 * Drizzle providers, system tables, table registry, and migrations.
 */

export { closeDatabase, createDatabase, type DatabaseConfig } from "./database";
export { DrizzleApprovalStore } from "./drizzle-approval-store";
export { DrizzleDataProvider, type I18nQueryOptions } from "./drizzle-data-provider";
export { DrizzleExecutionLogger } from "./drizzle-execution-logger";
export {
  approvalStatusEnum,
  approvalsTable,
  eventStatusEnum,
  eventsTable,
  executionStatusEnum,
  executionsTable,
} from "./drizzle-schema";
export { DrizzleTransactionManager } from "./drizzle-transaction-manager";
export { type MigrateOptions, runMigrations } from "./migrate";
export { TableRegistry } from "./table-registry";
