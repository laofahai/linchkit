/**
 * Data masking engine
 *
 * Applies field-level masking strategies to protect sensitive data.
 * Respects actor permissions — fields with unmask permission return raw values.
 *
 * Default behavior:
 * - Fields with `sensitive: true` (no explicit masking) → partial mask
 * - Fields with `secret: true` (no explicit masking) → full mask
 * - Fields with explicit `masking` config → use that strategy
 */

import { createHash } from "node:crypto";
import type { Actor } from "../types/action";
import type {
  EntityDefinition,
  FieldDefinition,
  MaskingConfig,
  MaskingStrategy,
} from "../types/entity";
import type { PermissionGroupDefinition } from "../types/permission";

// ── Constants ────────────────────────────────────────────────

const DEFAULT_VISIBLE_CHARS = 4;
const REDACT_PLACEHOLDER = "***";
const PARTIAL_MASK_CHAR = "*";

/** Default masking config for `sensitive: true` fields without explicit masking */
const SENSITIVE_DEFAULT: MaskingConfig = {
  strategy: "partial",
  visibleChars: DEFAULT_VISIBLE_CHARS,
  position: "end",
};

/** Default masking config for `secret: true` fields without explicit masking */
const SECRET_DEFAULT: MaskingConfig = {
  strategy: "full",
};

// ── Public API ───────────────────────────────────────────────

/**
 * Apply a single masking strategy to a value.
 *
 * Returns the masked result as a string (or null for 'full').
 * Non-string values are coerced to string before masking (except 'full' which always returns null).
 */
export function maskValue(
  value: unknown,
  strategy: MaskingStrategy,
  options?: { visibleChars?: number; position?: "start" | "end" },
): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  switch (strategy) {
    case "full":
      return null;

    case "redact":
      return REDACT_PLACEHOLDER;

    case "hash": {
      const str = typeof value === "string" ? value : JSON.stringify(value);
      return createHash("sha256").update(str).digest("hex");
    }

    case "partial": {
      const str = typeof value === "string" ? value : String(value);
      const visible = options?.visibleChars ?? DEFAULT_VISIBLE_CHARS;
      const position = options?.position ?? "end";

      if (str.length <= visible) {
        // String too short to meaningfully mask — redact entirely
        return PARTIAL_MASK_CHAR.repeat(str.length);
      }

      const masked = PARTIAL_MASK_CHAR.repeat(str.length - visible);
      if (position === "start") {
        return str.slice(0, visible) + masked;
      }
      // position === 'end'
      return masked + str.slice(-visible);
    }

    default:
      return REDACT_PLACEHOLDER;
  }
}

/**
 * Resolve the effective masking config for a field.
 *
 * Priority: explicit `masking` > `secret` default > `sensitive` default > none.
 */
export function resolveFieldMasking(field: FieldDefinition): MaskingConfig | undefined {
  if (field.masking) {
    return field.masking;
  }
  if (field.secret) {
    return SECRET_DEFAULT;
  }
  if (field.sensitive) {
    return SENSITIVE_DEFAULT;
  }
  return undefined;
}

/**
 * Check if an actor has unmask permission for a specific field.
 *
 * system_admin group always has unmask permission.
 *
 * Note: All parameters (actor, groups, capabilityName) must be provided
 * for bypass to work. If `groups` is empty or missing, masking is applied
 * even for system_admin actors (fail-closed by design).
 */
export function canUnmask(
  actor: Actor,
  groups: PermissionGroupDefinition[],
  capabilityName: string,
  entityName: string,
  fieldName: string,
): boolean {
  // Callers pass the full REGISTERED group set (registry.getAll()), so resolve
  // the actor's EFFECTIVE membership here — direct groups plus everything they
  // inherit via `implies` — and scope every unmask decision to it. This keeps
  // masking consistent with the action engine (inheritance is honored) while
  // never trusting a group the actor is not a (transitive) member of.
  const effective = resolveEffectiveGroupNames(actor, groups);

  // A system-admin group (by `systemLevel` or the legacy `system_admin` name)
  // in the actor's effective set always sees raw data.
  if (groups.some((g) => isAdminGroup(g) && effective.has(g.name))) {
    return true;
  }

  for (const group of groups) {
    if (!effective.has(group.name)) continue;

    // Consult BOTH `permissions[capability][entity]` and the canonical
    // `grant[entity]` source for unmask grants.
    const candidates: Array<string[] | undefined> = [
      group.permissions?.[capabilityName]?.[entityName]?.fields?.unmask,
      group.grant?.[entityName]?.fields?.unmask,
    ];
    for (const unmask of candidates) {
      // Defensive: a misconfigured string `unmask` (e.g. from raw DB/API data)
      // would substring-match via String.prototype.includes — require an array.
      if (Array.isArray(unmask) && unmask.includes(fieldName)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Resolve an actor's effective permission-group names — direct memberships plus
 * everything reachable via `implies` — over the provided registered group set.
 *
 * Mirrors {@link PermissionRegistry.resolveActorPermissions} (fail-safe: unknown
 * names and `implies` cycles are ignored, never throws; a misconfigured
 * non-array `implies` is skipped). Returned as a name set for membership scoping.
 */
function resolveEffectiveGroupNames(
  actor: Actor,
  groups: PermissionGroupDefinition[],
): Set<string> {
  const byName = new Map(groups.map((g) => [g.name, g]));
  const effective = new Set<string>();

  const visit = (name: string): void => {
    if (effective.has(name)) return; // already resolved → cycle/dup guard
    const group = byName.get(name);
    if (!group) return; // unknown name → not a member, nothing to inherit
    effective.add(name);
    const implied = group.implies;
    if (Array.isArray(implied)) {
      for (const impliedName of implied) {
        if (typeof impliedName === "string" && impliedName.length > 0) {
          visit(impliedName);
        }
      }
    }
  };

  for (const groupName of actor.groups ?? []) {
    visit(groupName);
  }

  return effective;
}

/**
 * Whether a group confers system-admin bypass — `systemLevel: "admin"` or the
 * legacy `system_admin` name. Mirrors the engine's admin predicate so masking
 * and authorization stay consistent.
 */
function isAdminGroup(group: PermissionGroupDefinition): boolean {
  return group.systemLevel === "admin" || group.name === "system_admin";
}

/** Options for maskRecord */
export interface MaskRecordOptions {
  /** Actor requesting the data */
  actor?: Actor;
  /** Permission groups to check for unmask permissions */
  groups?: PermissionGroupDefinition[];
  /** Capability name (for permission lookup) */
  capabilityName?: string;
}

/**
 * Apply masking rules to a data record based on schema field definitions.
 *
 * For each field with masking config:
 * - If actor has unmask permission → return raw value
 * - Otherwise → apply masking strategy
 *
 * Returns a new record (does not mutate input).
 */
export function maskRecord(
  record: Record<string, unknown>,
  schema: EntityDefinition,
  options?: MaskRecordOptions,
): Record<string, unknown> {
  const result = { ...record };
  const { actor, groups, capabilityName } = options ?? {};

  for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
    const maskingConfig = resolveFieldMasking(fieldDef);
    if (!maskingConfig) continue;

    // Check unmask permission if actor context is provided
    if (actor && groups && capabilityName) {
      if (canUnmask(actor, groups, capabilityName, schema.name, fieldName)) {
        continue; // Skip masking — actor has unmask permission
      }
    }

    // Apply masking
    if (fieldName in result) {
      result[fieldName] = maskValue(result[fieldName], maskingConfig.strategy, {
        visibleChars: maskingConfig.visibleChars,
        position: maskingConfig.position,
      });
    }
  }

  return result;
}

/**
 * Apply masking to an array of records.
 *
 * Convenience wrapper around maskRecord.
 */
export function maskRecords(
  records: Record<string, unknown>[],
  schema: EntityDefinition,
  options?: MaskRecordOptions,
): Record<string, unknown>[] {
  return records.map((r) => maskRecord(r, schema, options));
}
