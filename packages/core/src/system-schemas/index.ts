/**
 * System Schemas — SchemaDefinition + ViewDefinition for internal admin resources.
 *
 * These schemas are READ-ONLY virtual schemas backed by API endpoints / in-memory
 * registries, NOT by Drizzle-managed database tables. They enable the schema-driven
 * view system (AutoList) to display admin resources (executions, proposals, approvals,
 * rules, flows, state machines) without hand-coded column definitions.
 *
 * Convention: system schema names are prefixed with `_` to avoid collision with
 * user-defined business schemas.
 */

export {
  executionLogSchema,
  executionLogListView,
} from "./execution-log";

export {
  proposalSchema,
  proposalListView,
} from "./proposal";

export {
  approvalSchema,
  approvalListView,
} from "./approval";

export {
  ruleSchema,
  ruleListView,
} from "./rule";

export {
  flowSchema,
  flowListView,
} from "./flow";

export {
  stateMachineSchema,
  stateMachineListView,
} from "./state-machine";

/**
 * All system schema definitions — convenience array for bulk registration.
 */
export { SYSTEM_SCHEMAS, SYSTEM_VIEWS, isSystemSchema } from "./registry";
