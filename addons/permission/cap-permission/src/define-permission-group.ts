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
  PermissionConstraints,
  PermissionValue,
  SchemaPermissions,
} from "@linchkit/core";

// ── Re-exports (kept thin so callers can `import type` from one place) ──

export type { DataAccessCondition, PermissionConstraints, PermissionValue, SchemaPermissions };

// ── Grant access primitives ─────────────────────────────────

/**
 * Per-entity grant: action permissions, row-level data access, and field-level
 * visibility. Mirrors `SchemaPermissions` from core but is keyed directly by
 * entity name (no capability-name nesting — capability is resolved from the
 * action registry at evaluation time).
 */
export interface EntityGrant {
  /** Action-level: which actions can be executed on this entity */
  actions?: Record<string, PermissionValue>;

  /** Row-level access: 'all' | 'none' | condition-based */
  data?: {
    read?: "all" | "none" | { condition: DataAccessCondition };
    write?: "all" | "none" | { condition: DataAccessCondition };
  };

  /** Field-level visibility/masking */
  fields?: {
    visible?: string[];
    hidden?: string[];
    unmask?: string[];
  };
}

/** Map of entity name → grant. Replaces legacy `permissions[capability][entity]`. */
export type GrantMap = Record<string, EntityGrant>;

// ── Permission group definition ─────────────────────────────

/**
 * Phase 1 PermissionGroupDefinition.
 *
 * - `grant` is the canonical, JSONB-friendly access map (spec 10 §2.1)
 * - `category` drives admin-UI grouping (spec 10 §2.1)
 * - `implies` enables inheritance, resolved recursively (spec 10 §2.1 + §7.1)
 * - `permissions` is kept optional for backward compatibility while existing
 *   `@linchkit/core` engines still read the legacy 3-level structure
 */
export interface PermissionGroupDefinition {
  /** Unique identifier (snake_case, e.g. `purchase_manager`) */
  name: string;

  /** Human-readable label shown in admin UI */
  label?: string;

  /** Long-form description (markdown allowed) */
  description?: string;

  /** UI grouping bucket — typically a capability name */
  category?: string;

  /** Names of permission groups this one inherits from */
  implies?: string[];

  /** Canonical access map (entity → grant) */
  grant?: GrantMap;

  /**
   * Legacy 3-level permissions structure: `permissions[capability][entity]`.
   * Retained for compatibility with `@linchkit/core` PermissionRegistry.
   * Removal is tracked outside Phase 1.
   */
  permissions?: Record<string, Record<string, SchemaPermissions>>;

  /** Shorthand for the special system_admin level (spec 10 §7.4) */
  systemLevel?: "admin";

  /** Optional actor constraints (rate limits, approval requirements) */
  constraints?: PermissionConstraints;
}

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
