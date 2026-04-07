/**
 * Persistence layer barrel export
 *
 * Re-exports all persistence-related modules: database connection,
 * Drizzle providers, system tables, table registry, and migrations.
 */

export { checkConnection, closeDatabase, createDatabase, type DatabaseConfig } from "./database";
export { DrizzleApprovalStore } from "./drizzle-approval-store";
export { DrizzleDataProvider, type I18nQueryOptions } from "./drizzle-data-provider";
export { DrizzleExecutionLogger } from "./drizzle-execution-logger";
export { DrizzleOverlayStore } from "./drizzle-overlay-store";
export {
  approvalStatusEnum,
  approvalsTable,
  eventStatusEnum,
  eventsTable,
  executionStatusEnum,
  executionsTable,
} from "./drizzle-schema";
export { DrizzleTransactionManager } from "./drizzle-transaction-manager";
export { type FindManyOptions, InMemoryStore } from "./in-memory-store";
export { OverlayAwareDataProvider } from "./overlay-aware-data-provider";
export { TableRegistry } from "./table-registry";
