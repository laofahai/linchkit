/**
 * Permission model type definitions
 *
 * Permission Groups replace traditional RBAC roles.
 * Organized by Capability, covering 4 levels:
 *   1. Action execution — can you call this Action?
 *   2. Read access — can you query this Schema's data?
 *   3. Row-level (data access) — which records can you see/modify?
 *   4. Field-level — which fields can you see?
 *
 * Merge strategy: explicit deny wins (AWS IAM model).
 * See spec 10_actor_permission.md and 33_error_handling.md.
 */

import type { ComparisonOperator } from "./rule";

// ── Permission values ──────────────────────────────────

/** Tri-state permission: allow, deny, or inherit (not set) */
export type PermissionValue = true | false | undefined;

// ── Data access condition ──────────────────────────────

/**
 * Row-level filter condition.
 * Supports `$actor.id`, `$actor.metadata.xxx` variable references.
 */
export interface DataAccessCondition {
  field: string;
  operator: ComparisonOperator;
  value: unknown;
}

// ── Per-schema permissions ─────────────────────────────

export interface SchemaPermissions {
  /** Action-level: which actions can be executed */
  actions?: Record<string, PermissionValue>;

  /** Read access: 'all' | 'none' | condition-based */
  data?: {
    read?: "all" | "none" | { condition: DataAccessCondition };
    write?: "all" | "none" | { condition: DataAccessCondition };
  };

  /** Field-level: which fields are visible */
  fields?: {
    /** Fields explicitly visible (whitelist) */
    visible?: string[];
    /** Fields explicitly hidden (blacklist) */
    hidden?: string[];
    /** Fields whose masking should be bypassed (actor sees raw values) */
    unmask?: string[];
  };
}

// ── Grant access map (capability-agnostic, entity-keyed) ─

/**
 * Canonical access map: entity name → permissions. Produced by cap-permission's
 * `definePermissionGroup`/`permissionGroup` builder (spec 10 §2.1).
 *
 * Unlike `permissions[capability][entity]`, `grant` is NOT nested under a
 * capability name — capability is resolved from the action registry at
 * evaluation time, so a `grant[entity]` applies regardless of the capability
 * the entity currently belongs to. The inner shape is identical to
 * {@link SchemaPermissions}.
 */
export type GrantMap = Record<string, SchemaPermissions>;

// ── Permission group definition ────────────────────────

export interface PermissionGroupDefinition {
  name: string;

  /**
   * Human-readable label shown in admin UI. Optional so that groups authored via
   * cap-permission's `grant`-only builder (which has no label requirement) remain
   * structurally assignable to this canonical type.
   */
  label?: string;
  description?: string;

  /**
   * Permissions organized by Capability name.
   * Each capability maps schema names to their permissions.
   *
   * Optional: a group authored entirely via the canonical `grant` map omits this
   * legacy 3-level structure. When absent, the engine consults `grant` instead.
   * Always access via a guarded lookup (it may be `undefined`).
   *
   * Example:
   * ```ts
   * permissions: {
   *   purchase_management: {
   *     purchase_request: {
   *       actions: { approve_request: true, create_request: false },
   *       data: { read: 'all', write: { condition: { field: 'created_by', operator: 'eq', value: '$actor.id' } } },
   *       fields: { hidden: ['internal_notes'] },
   *     },
   *   },
   * }
   * ```
   */
  permissions?: Record<string, Record<string, SchemaPermissions>>;

  /**
   * Canonical, capability-agnostic access map (entity → permissions), authored
   * via cap-permission's `.grant(...)` / `grant: {...}` API (spec 10 §2.1).
   * Consulted by the engine ALONGSIDE `permissions`; both sources participate in
   * the explicit-deny-wins merge. Optional — legacy groups only use `permissions`.
   */
  grant?: GrantMap;

  /**
   * Names of permission groups this one inherits from. Resolved transitively
   * (with cycle detection) by the engine, so an actor in this group effectively
   * belongs to all (recursively) implied groups too (spec 10 §2.1 + §7.1).
   * Optional — legacy groups have no inheritance.
   */
  implies?: string[];

  /** UI grouping bucket — typically a capability name (spec 10 §2.1). */
  category?: string;

  /** Shorthand for system_admin level */
  systemLevel?: "admin";

  /** AI agent constraints (optional) */
  constraints?: PermissionConstraints;
}

// ── Permission group extension (for Bridge) ──────────────

export interface PermissionGroupExtension {
  permissions: Record<string, Record<string, Partial<SchemaPermissions>>>;
}

// ── AI / special actor constraints ─────────────────────

export interface PermissionConstraints {
  /** Actions that require human approval even if permission allows */
  requireHumanApproval?: string[];
  /** Rate limiting */
  rateLimit?: {
    maxActionsPerMinute?: number;
    maxActionsPerHour?: number;
  };
  /** Audit level override */
  auditLevel?: "minimal" | "standard" | "full";
}

// ── Permission check result ────────────────────────────

export interface PermissionCheckResult {
  allowed: boolean;
  /** Why it was denied (for diagnostics) */
  reason?: string;
  /** Which group granted or denied the permission */
  decidedBy?: string;
}

// ── Permission merge strategy ──────────────────────────

/**
 * When a user belongs to multiple groups:
 * - 'explicit-deny-wins': any explicit `false` overrides all `true` (safest, default)
 * - 'union': any `true` grants access, only `false` from ALL groups denies
 */
export type PermissionMergeStrategy = "explicit-deny-wins" | "union";

// ── Data access definition (for defineDataAccess) ──────

export interface DataAccessDefinition {
  group: string;
  schema: string;
  read?: DataAccessCondition | "all" | "none";
  write?: DataAccessCondition | "all" | "none";
}
