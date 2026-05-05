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

/** Length of the hex hash appended to idempotency keys. 32 bits is enough for the
 *  behavior-affecting-meta subset within a single (action, tenant, rawKey) bucket. */
export const META_HASH_HEX_LEN = 8;

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
 * Recursively canonicalize a value so two semantically-equal inputs serialize
 * identically. Plain-object property order becomes alphabetical; arrays and
 * primitives pass through unchanged.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = canonicalize(obj[k]);
  }
  return sorted;
}

/**
 * Returns a short stable hex hash of the behavior-affecting subset of `meta`.
 * Keys are top-level-sorted by {@link extractBehaviorAffectingMeta}, then values
 * are canonicalized so object-valued payloads (e.g. `default.config`) hash
 * identically regardless of property insertion order. Returns `""` when no
 * behavior-affecting keys are present so callers can short-circuit and avoid
 * mutating the cache key in the common case.
 */
export function hashBehaviorAffectingMeta(meta: Record<string, unknown> | undefined): string {
  const subset = extractBehaviorAffectingMeta(meta);
  if (Object.keys(subset).length === 0) return "";
  const serialized = JSON.stringify(canonicalize(subset));
  return createHash("sha256").update(serialized).digest("hex").slice(0, META_HASH_HEX_LEN);
}
