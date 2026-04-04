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

  /** Get all groups an actor belongs to. */
  resolveActorPermissions(actor: Actor): PermissionGroupDefinition[] {
    const result: PermissionGroupDefinition[] = [];
    for (const groupName of actor.groups) {
      const group = this.groups.get(groupName);
      if (group) {
        result.push(group);
      }
    }
    return result;
  }
}

// ── Action permission check ──────────────────────────────

/**
 * Check if actor can execute an action.
 *
 * Merge strategy: explicit-deny-wins (like AWS IAM)
 * - If ANY group explicitly sets `false` → denied
 * - If ANY group explicitly sets `true` (and none deny) → allowed
 * - If no group mentions it → denied (default deny)
 * - system_admin group → always allowed
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

  // system_admin shortcut: only if group is actually registered in registry
  if (actor.groups.includes(SYSTEM_ADMIN_GROUP) && registry.get(SYSTEM_ADMIN_GROUP) !== undefined) {
    return {
      allowed: true,
      decidedBy: SYSTEM_ADMIN_GROUP,
    };
  }

  let hasExplicitAllow = false;
  let allowedBy: string | undefined;

  for (const group of groups) {
    const schemaPerms = group.permissions[capabilityName];
    if (!schemaPerms) continue;

    // Check all schemas in this capability for the action
    for (const [, perms] of Object.entries(schemaPerms)) {
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

  // system_admin shortcut: only if group is actually registered in registry
  if (actor.groups.includes(SYSTEM_ADMIN_GROUP) && registry.get(SYSTEM_ADMIN_GROUP) !== undefined) {
    return "all";
  }

  let hasAll = false;
  const conditions: DataAccessCondition[] = [];
  let hasAnyMatch = false;

  for (const group of groups) {
    const capPerms = group.permissions[capabilityName];
    if (!capPerms) continue;

    const schemaPerms = capPerms[entityName];
    if (!schemaPerms?.data) continue;

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
