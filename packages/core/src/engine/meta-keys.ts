/**
 * Behavior-affecting meta keys (Spec 65 §5).
 *
 * Some `ctx.meta` keys change *what an action does* (e.g. `dry_run`,
 * `skip_notifications`, `bulk`, caller-supplied `default.*` values).
 * Others are purely observational (locale, view source, audit context).
 * Idempotency caching must distinguish these: two requests with the same
 * idempotency key but different behavior-affecting meta are different
 * operations and must NOT short-circuit to the same cached result.
 *
 * This module is a pure utility — no engine or runtime imports.
 */

import { createHash } from "node:crypto";

/**
 * Well-known meta keys that affect action behavior.
 *
 * Keys with the `default.` prefix are also behavior-affecting (caller-supplied
 * defaults that influence handler outputs); they're matched dynamically in
 * {@link isBehaviorAffectingMetaKey} rather than enumerated here.
 *
 * NOT included (view / transport / audit only): `lang`, `tz`, `source_view`,
 * `triggered_by`, `trace_context`, all `_`-prefixed system keys.
 */
export const BEHAVIOR_AFFECTING_META_KEYS: readonly string[] = [
  "dry_run",
  "skip_notifications",
  "bulk",
];

/** Returns true when the key is well-known behavior-affecting OR a `default.*` override. */
export function isBehaviorAffectingMetaKey(key: string): boolean {
  if (key.startsWith("_")) return false;
  if (key.startsWith("default.")) return true;
  return BEHAVIOR_AFFECTING_META_KEYS.includes(key);
}

/**
 * Returns a new object containing only behavior-affecting keys, sorted by key
 * for stable downstream serialization.
 */
export function extractBehaviorAffectingMeta(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  const keys = Object.keys(meta).filter(isBehaviorAffectingMetaKey).sort();
  for (const k of keys) {
    out[k] = meta[k];
  }
  return out;
}

/**
 * Returns a short stable hex hash (16 chars of sha256) of the behavior-affecting
 * subset of `meta`. Returns `""` when no behavior-affecting keys are present so
 * callers can short-circuit and avoid mutating the cache key in the common case.
 */
export function hashBehaviorAffectingMeta(meta: Record<string, unknown> | undefined): string {
  const subset = extractBehaviorAffectingMeta(meta);
  if (Object.keys(subset).length === 0) return "";
  // Stable JSON: keys are already sorted by extractBehaviorAffectingMeta.
  const serialized = JSON.stringify(subset);
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}
