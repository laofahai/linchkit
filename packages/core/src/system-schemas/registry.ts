/**
 * System schema & view registry — convenience arrays for bulk registration.
 *
 * System schemas are read-only virtual schemas. They must NOT generate DB tables
 * or CRUD actions. The server registration code should skip Drizzle table generation
 * for schemas whose name starts with `_`.
 */

import type { SchemaDefinition } from "../types/schema";
import type { ViewDefinition } from "../types/view";

import { executionLogSchema, executionLogListView } from "./execution-log";
import { proposalSchema, proposalListView } from "./proposal";
import { approvalSchema, approvalListView } from "./approval";
import { ruleSchema, ruleListView } from "./rule";
import { flowSchema, flowListView } from "./flow";
import { stateMachineSchema, stateMachineListView } from "./state-machine";

/** All system schema definitions */
export const SYSTEM_SCHEMAS: SchemaDefinition[] = [
  executionLogSchema,
  proposalSchema,
  approvalSchema,
  ruleSchema,
  flowSchema,
  stateMachineSchema,
];

/** All system view definitions */
export const SYSTEM_VIEWS: ViewDefinition[] = [
  executionLogListView,
  proposalListView,
  approvalListView,
  ruleListView,
  flowListView,
  stateMachineListView,
];

/**
 * Check if a schema name is a system schema (prefixed with `_`).
 * System schemas should not have DB tables or CRUD actions generated.
 */
export function isSystemSchema(name: string): boolean {
  return name.startsWith("_");
}
