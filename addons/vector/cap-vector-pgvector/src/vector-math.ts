/**
 * Shared vector / metadata utilities.
 *
 * Kept separate from the store implementations so both the in-memory
 * brute-force search and the test suite can reuse the exact same
 * cosine-similarity definition without duplicating the math.
 */

/**
 * Cosine similarity in `[-1, 1]` rescaled to `[0, 1]`.
 *
 * The pgvector store returns `1 - (a <=> b)` which is already in
 * `[0, 1]` for non-negative inner products; the in-memory store
 * applies the same rescale so consumers see identical ranges across
 * implementations. The standard math says
 *   cosine_sim = (a · b) / (||a|| * ||b||)
 * and we rescale via `(x + 1) / 2` so a hit and a miss always live on
 * the same axis.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  const raw = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Clamp to defeat tiny FP drift before rescaling.
  const clamped = Math.max(-1, Math.min(1, raw));
  return (clamped + 1) / 2;
}

/**
 * Shallow JSONB-style containment check. Each top-level key in `filter`
 * must equal the corresponding value in `metadata` for the row to pass.
 *
 * Nested values are compared via {@link deepEqual} — a structural walk
 * that is order-independent for object keys (so `{a:1,b:2}` equals
 * `{b:2,a:1}`, unlike `JSON.stringify` which depends on insertion order).
 * This mirrors PostgreSQL's `jsonb @>` operator semantics, which the
 * pgvector backend uses on the server side.
 */
export function matchesFilter(
  metadata: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (!Object.hasOwn(metadata, key)) return false;
    if (!deepEqual(metadata[key], expected)) return false;
  }
  return true;
}

/**
 * Order-independent structural equality for plain JSON-like values.
 *
 * - Primitives are compared with `Object.is` (so `NaN === NaN`).
 * - Arrays must have matching length and element-wise equality.
 * - Plain objects must share the same key set and each key's values must
 *   themselves be `deepEqual`.
 *
 * No support for class instances, Maps, Sets, Dates, RegExps … on
 * purpose: filter payloads come from JSON / JSONB, which only contains
 * those JS shapes.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(bObj, key)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}
