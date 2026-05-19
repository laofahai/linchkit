/**
 * Persistence runtime — Drizzle stores, ORM schema, system tables, overlays
 * (server-only).
 */

export type { OverlayChangeListener, OverlayRegistry } from "../../overlay/overlay-registry";
export { DefaultOverlayRegistry } from "../../overlay/overlay-registry";
export type { PromotionPlan } from "../../overlay/promote";
export {
  generateFieldCode,
  generateMigrationSql,
  generatePromotionPlan,
} from "../../overlay/promote";
export {
  checkConnection,
  closeDatabase,
  createDatabase,
  type DatabaseConfig,
} from "../../persistence/database";
export { DrizzleApprovalStore } from "../../persistence/drizzle-approval-store";
export { DrizzleConfigStore } from "../../persistence/drizzle-config-store";
export {
  DrizzleDataProvider,
  type I18nQueryOptions,
} from "../../persistence/drizzle-data-provider";
export { DrizzleExecutionLogger } from "../../persistence/drizzle-execution-logger";
export { DrizzleOverlayStore } from "../../persistence/drizzle-overlay-store";
export * as drizzleSchema from "../../persistence/drizzle-schema";
export { DrizzleTransactionManager } from "../../persistence/drizzle-transaction-manager";
export { InMemoryOverlayStore } from "../../persistence/in-memory-overlay-store";
export { type FindManyOptions, InMemoryStore } from "../../persistence/in-memory-store";
export { OverlayAwareDataProvider } from "../../persistence/overlay-aware-data-provider";
export {
  fieldOverlaysTable,
  overlayStatusEnum,
} from "../../persistence/overlay-table";
export {
  approvalStatusEnum,
  approvalsTable,
  configScopeEnum,
  configTable,
  configVersionsTable,
  eventStatusEnum,
  eventsTable,
  executionStatusEnum,
  executionsTable,
  linchkitSchema,
  overrideTargetTypeEnum,
  tenantOverridesTable,
} from "../../persistence/system-tables";
export { TableRegistry } from "../../persistence/table-registry";
export {
  type OverrideTargetType,
  type TenantOverride,
  TenantOverrideStore,
} from "../../persistence/tenant-override-store";
