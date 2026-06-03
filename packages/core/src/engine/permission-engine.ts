/**
 * Permission evaluation engine
 *
 * Implements Odoo-style Permission Groups with AWS IAM merge strategy.
 * Groups are resolved from Actor.groups, then merged per capability/schema.
 *
 * Merge strategy: explicit-deny-wins
 * - If ANY group explicitly sets `false` → denied
 * - If ANY group explicitly sets `true` (and none deny) → allowed
 * - If no group mentions it → denied (default deny)
 */

import type { Actor } from "../types/action";
import type {
  DataAccessCondition,
  PermissionCheckResult,
  PermissionGroupDefinition,
  SchemaPermissions,
} from "../types/permission";

// ── System admin group name (always allowed) ─────────────

const SYSTEM_ADMIN_GROUP = "system_admin";

// ── PermissionRegistry ───────────────────────────────────

export class PermissionRegistry {
  private groups = new Map<string, PermissionGroupDefinition>();

  /** Register a permission group definition. Throws on duplicate name. */
  register(group: PermissionGroupDefinition): void {
    if (!group.name) {
      throw new Error("Permission group must have a name");
    }
    if (this.groups.has(group.name)) {
      throw new Error(`Permission group "${group.name}" is already registered`);
    }
    this.groups.set(group.name, group);
  }

  /** Get a permission group by name. */
  get(name: string): PermissionGroupDefinition | undefined {
    return this.groups.get(name);
  }

  /** Get all registered permission groups. */
  getAll(): PermissionGroupDefinition[] {
    return Array.from(this.groups.values());
  }

  /**
   * Resolve the full set of effective permission groups for an actor.
   *
   * Starts from `actor.groups` and transitively follows each group's `implies`
   * inheritance (spec 10 §2.1 + §7.1). The traversal is:
   *  - Deduped — every group appears at most once in the result.
   *  - Deterministic — direct memberships are visited in `actor.groups` order,
   *    then each group's `implies` in declaration order (depth-first).
   *  - Cycle-safe — a `visited` set terminates cycles (`a implies b implies a`);
   *    the back-edge is silently ignored rather than throwing.
   *  - Fail-safe — an unknown group name (direct or implied) is skipped, never
   *    fabricated, so it can neither throw nor grant anything.
   */
  resolveActorPermissions(actor: Actor): PermissionGroupDefinition[] {
    const result: PermissionGroupDefinition[] = [];
    const visited = new Set<string>();

    const visit = (groupName: string): void => {
      // Cycle / duplicate guard: a name is processed at most once.
      if (visited.has(groupName)) {
        return;
      }
      visited.add(groupName);

      const group = this.groups.get(groupName);
      if (!group) {
        // Unknown group name → ignore (fail-safe: no throw, no grant).
        return;
      }
      result.push(group);

      // Follow inheritance edges depth-first, in declaration order.
      const implied = group.implies;
      if (implied) {
        for (const impliedName of implied) {
          if (typeof impliedName === "string" && impliedName.length > 0) {
            visit(impliedName);
          }
        }
      }
    };

    for (const groupName of actor.groups) {
      visit(groupName);
    }

    return result;
  }
}

// ── Group permission lookup (reads `permissions` AND `grant`) ──

/**
 * Resolve the {@link SchemaPermissions} a group declares for a given
 * capability + entity, consulting BOTH sources:
 *  1. Legacy `permissions[capability][entity]` (3-level, capability-scoped).
 *  2. Canonical `grant[entity]` (capability-agnostic — applies to the entity
 *     regardless of which capability owns it).
 *
 * Returned in lookup precedence order (legacy first, then grant). Callers merge
 * the yielded entries under the engine's explicit-deny-wins contract, so the
 * relative order does not change the outcome (an explicit `false` from either
 * source still wins). Yields nothing when neither source mentions the entity.
 */
function* groupSchemaPermissions(
  group: PermissionGroupDefinition,
  capabilityName: string,
  entityName: string,
): Generator<SchemaPermissions> {
  const legacy = group.permissions?.[capabilityName]?.[entityName];
  if (legacy) {
    yield legacy;
  }
  const granted = group.grant?.[entityName];
  if (granted) {
    yield granted;
  }
}

/**
 * Whether a group confers system-admin bypass. True when either:
 *  - its declared `systemLevel` is `"admin"` (canonical, name-independent), or
 *  - its name is the legacy {@link SYSTEM_ADMIN_GROUP} sentinel (back-compat).
 */
function isAdminGroup(group: PermissionGroupDefinition): boolean {
  return group.systemLevel === "admin" || group.name === SYSTEM_ADMIN_GROUP;
}

// ── Action permission check ──────────────────────────────

/**
 * Check if actor can execute an action.
 *
 * Merge strategy: explicit-deny-wins (like AWS IAM)
 * - If ANY group explicitly sets `false` → denied
 * - If ANY group explicitly sets `true` (and none deny) → allowed
 * - If no group mentions it → denied (default deny)
 * - A system-admin group → always allowed
 *
 * Groups are the actor's `implies`-expanded set (see `resolveActorPermissions`),
 * and BOTH the legacy `permissions[capability][entity]` and the canonical
 * `grant[entity]` sources are consulted for the action (see
 * `groupSchemaPermissions`). The explicit-deny-wins floor holds across the whole
 * expanded set and both sources.
 *
 * Admin bypass semantics: a group with `systemLevel: "admin"` (or the legacy
 * `"system_admin"` name) grants the bypass. It is evaluated over the RESOLVED
 * set, so a group that `implies` an admin group inherits the bypass too —
 * consistent with `implies` meaning "inherit everything from that group". The
 * resolved set only ever contains registered groups, preserving the original
 * "admin must be registered" invariant.
 */
export function checkActionPermission(
  registry: PermissionRegistry,
  actor: Actor,
  capabilityName: string,
  actionName: string,
): PermissionCheckResult {
  const groups = registry.resolveActorPermissions(actor);

  // No matching groups → denied
  if (groups.length === 0) {
    return {
      allowed: false,
      reason: "Actor belongs to no registered permission groups",
    };
  }

  // system-admin shortcut: any resolved group conferring admin → always allowed.
  const adminGroup = groups.find(isAdminGroup);
  if (adminGroup) {
    return {
      allowed: true,
      decidedBy: adminGroup.name,
    };
  }

  let hasExplicitAllow = false;
  let allowedBy: string | undefined;

  for (const group of groups) {
    // Consult BOTH `permissions[capability][entity]` and `grant[entity]`.
    // We scan every entity the group mentions for this action; the explicit-deny
    // short-circuit makes intra-group ordering irrelevant.
    const entities = new Set<string>([
      ...Object.keys(group.permissions?.[capabilityName] ?? {}),
      ...Object.keys(group.grant ?? {}),
    ]);

    for (const entity of entities) {
      for (const perms of groupSchemaPermissions(group, capabilityName, entity)) {
        const actionPerm = perms.actions?.[actionName];

        if (actionPerm === false) {
          // Explicit deny wins immediately
          return {
            allowed: false,
            reason: `Explicitly denied by group "${group.name}"`,
            decidedBy: group.name,
          };
        }

        if (actionPerm === true) {
          hasExplicitAllow = true;
          allowedBy = group.name;
        }
      }
    }
  }

  if (hasExplicitAllow) {
    return {
      allowed: true,
      decidedBy: allowedBy,
    };
  }

  // Default deny: no group mentioned this action
  return {
    allowed: false,
    reason: "No permission group grants this action",
  };
}

// ── Data access resolution ───────────────────────────────

/**
 * Resolve data access conditions for read/write.
 *
 * Merge strategy:
 * - 'none' in any group → 'none' (explicit deny wins)
 * - 'all' in any group (and no 'none') → 'all'
 * - conditions are OR-merged (union)
 * - No matching group → 'none'
 */
export function resolveDataAccess(
  registry: PermissionRegistry,
  actor: Actor,
  capabilityName: string,
  entityName: string,
  operation: "read" | "write",
): DataAccessCondition | "all" | "none" {
  const groups = registry.resolveActorPermissions(actor);

  if (groups.length === 0) {
    return "none";
  }

  // system-admin shortcut: any resolved group conferring admin → full access.
  if (groups.some(isAdminGroup)) {
    return "all";
  }

  let hasAll = false;
  const conditions: DataAccessCondition[] = [];
  let hasAnyMatch = false;

  for (const group of groups) {
    // Consult BOTH `permissions[capability][entity]` and `grant[entity]`.
    for (const schemaPerms of groupSchemaPermissions(group, capabilityName, entityName)) {
      if (!schemaPerms.data) continue;

      const access = schemaPerms.data[operation];
      if (access === undefined) continue;

      hasAnyMatch = true;

      if (access === "none") {
        // Explicit deny wins immediately
        return "none";
      }

      if (access === "all") {
        hasAll = true;
      } else if (access.condition) {
        conditions.push(access.condition);
      }
    }
  }

  if (!hasAnyMatch) {
    return "none";
  }

  if (hasAll) {
    return "all";
  }

  // Return first condition if any exist.
  // Multiple conditions are OR-merged at the query layer;
  // for now we return the first one as a representative.
  const first = conditions[0];
  if (first) {
    return first;
  }

  return "none";
}

// ── Condition variable resolution ────────────────────────

/**
 * Resolve variable references in conditions.
 *
 * Supports: $actor.id, $actor.type, $actor.groups, $actor.metadata.xxx
 */
export function resolveConditionVariables(
  condition: DataAccessCondition,
  actor: Actor,
): DataAccessCondition {
  const value = condition.value;

  if (typeof value !== "string" || !value.startsWith("$actor.")) {
    return condition;
  }

  const path = value.slice("$actor.".length); // e.g. "id", "type", "metadata.department"
  const resolved = resolveActorPath(actor, path);

  return {
    ...condition,
    value: resolved,
  };
}

// Allowed top-level keys for actor path resolution
const ALLOWED_ACTOR_PATHS = new Set(["id", "type", "groups", "metadata"]);

// Forbidden path segments to prevent prototype pollution
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Resolve a dot-path against an Actor object.
 * Only allows whitelisted top-level paths and rejects dangerous segments.
 */
function resolveActorPath(actor: Actor, path: string): unknown {
  const parts = path.split(".");

  // Validate top-level path is whitelisted
  const firstPart = parts[0];
  if (parts.length === 0 || !firstPart || !ALLOWED_ACTOR_PATHS.has(firstPart)) {
    return undefined;
  }

  // Reject any forbidden segment anywhere in the path
  for (const part of parts) {
    if (FORBIDDEN_SEGMENTS.has(part)) {
      return undefined;
    }
  }

  let current: unknown = actor;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    // Only access own properties to prevent prototype chain leakage
    if (!Object.hasOwn(current as Record<string, unknown>, part)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
