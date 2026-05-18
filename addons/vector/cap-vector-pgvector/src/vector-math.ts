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
 * Nested objects are compared via `JSON.stringify` — cheap, deterministic,
 * and good enough for the equality filters Spec 68 §2.1 sketches.
 */
export function matchesFilter(
  metadata: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (!Object.hasOwn(metadata, key)) return false;
    const actual = metadata[key];
    if (actual === expected) continue;
    if (
      typeof actual === "object" &&
      actual !== null &&
      typeof expected === "object" &&
      expected !== null
    ) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
      continue;
    }
    return false;
  }
  return true;
}
