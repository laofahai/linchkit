/**
 * definePermissionGroup — Object-style entry for Phase 1 of spec 10 §2.1
 *
 * Produces a plain `PermissionGroupDefinition` that is fully JSONB-serializable
 * (the database row in `_linchkit.permission_groups` is the single source of truth,
 * see spec 10 §8).
 *
 * This module introduces the new `grant` shape (entity → access map) alongside
 * `category` and `implies` fields. The legacy `permissions[capability][entity]`
 * structure from `@linchkit/core` is intentionally NOT removed here — Phase 1
 * only ADDS the new canonical shape. Migration of the engine/registry to read
 * `grant` is tracked in a follow-up phase.
 */

import type {
  DataAccessCondition,
  GrantMap,
  PermissionConstraints,
  PermissionGroupDefinition,
  PermissionValue,
  SchemaPermissions,
} from "@linchkit/core";

// ── Re-exports (kept thin so callers can `import type` from one place) ──
//
// The canonical `PermissionGroupDefinition` and `GrantMap` now live in
// `@linchkit/core` (the engine and registry consume them, and a capability's
// `extensions.permissionGroups` is typed by them). cap-permission re-exports
// the core types so authoring (`definePermissionGroup` / `permissionGroup`) and
// runtime evaluation share ONE shape — no drift between the two layers.

export type {
  DataAccessCondition,
  GrantMap,
  PermissionConstraints,
  PermissionGroupDefinition,
  PermissionValue,
  SchemaPermissions,
};

/**
 * Per-entity grant: action permissions, row-level data access, and field-level
 * visibility. Structurally identical to core's `SchemaPermissions` (entity-keyed
 * within a `GrantMap`, no capability nesting — capability is resolved from the
 * action registry at evaluation time). Kept as a named alias for ergonomic
 * authoring imports.
 */
export type EntityGrant = SchemaPermissions;

// ── Object-style entry ──────────────────────────────────────

/**
 * Define a permission group with an object literal.
 *
 * Identical output to `permissionGroup(name).....build()` for equivalent input.
 *
 * @example
 * ```ts
 * export const purchaseManager = definePermissionGroup({
 *   name: 'purchase_manager',
 *   category: 'purchase_management',
 *   implies: ['purchase_user'],
 *   grant: {
 *     purchase_request: {
 *       actions: { approve_request: true },
 *       data: { read: 'all' },
 *     },
 *   },
 * });
 * ```
 */
export function definePermissionGroup(
  definition: PermissionGroupDefinition,
): PermissionGroupDefinition {
  if (!definition.name || typeof definition.name !== "string") {
    throw new Error("definePermissionGroup: `name` is required and must be a string");
  }
  return definition;
}
