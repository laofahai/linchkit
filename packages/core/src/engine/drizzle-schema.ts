/**
 * Drizzle schema definition for system tables
 *
 * This file exports all static system table definitions managed by drizzle-kit.
 * Dynamic user-defined schema tables are generated at runtime via schema-to-drizzle.ts
 * and are NOT part of this file.
 *
 * Used by:
 * - drizzle.config.ts for migration generation
 * - TableRegistry for system table registration
 */

export {
  // Enums
  approvalStatusEnum,
  approvalsTable,
  eventStatusEnum,
  eventsTable,
  executionStatusEnum,
  executionsTable,
  // Tables
  schemaDefinitionsTable,
} from "./system-tables";
