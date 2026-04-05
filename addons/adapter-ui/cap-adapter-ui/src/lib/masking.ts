/**
 * Data masking detection utilities.
 *
 * Detects masked field values returned by the backend MaskingEngine.
 * Common patterns: full mask "***", partial mask "J***n", email mask "j***@example.com".
 *
 * Detection is intentionally strict to avoid false positives on normal text
 * containing asterisks (e.g. Markdown bold `**text**`, math `2 * 3 * 4`).
 */

/** Fully masked value — entire value is only asterisks, at least 3 */
const FULL_MASK_RE = /^\*{3,}$/;

/**
 * Partial mask pattern produced by backend MaskingEngine.
 *
 * Structural rule: the value must contain exactly ONE contiguous run of 3+
 * asterisks. The parts before and after the run (prefix / suffix) must be
 * short non-whitespace tokens — they represent the preserved portion of
 * the original value (e.g. first/last chars of a name, email domain).
 *
 * Matches:
 *  - suffix preserved:  "****5678"
 *  - prefix preserved:  "user****", "1234****"
 *  - both ends:         "J***n", "1234****5678"
 *  - email-style:       "j***@example.com", "***@email.com"
 *
 * Rejects:
 *  - Markdown bold:     "**bold**"   (only 2 asterisks per run)
 *  - Normal text:       "foo *** bar" (whitespace in prefix/suffix)
 *  - Passwords:         "p**sword"   (only 2 asterisks)
 *  - Math expressions:  "2 * 3 * 4"  (single asterisks)
 *  - Multiple runs:     "a***b***c"  (two runs — not a standard mask)
 */
const PARTIAL_MASK_RE = /^[^\s*]{0,20}\*{3,}[^\s*]{0,20}$/;

/**
 * Check if a value appears to be masked by the backend MaskingEngine.
 * Returns true for full masks ("***") and partial masks ("J***n").
 *
 * False-positive resistance: normal text like "**bold**", "p**sword",
 * "a ** b", "2 * 3 * 4" will NOT be detected as masked.
 */
export function isMaskedValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;

  // Full mask: entire string is asterisks (≥3)
  if (FULL_MASK_RE.test(value)) return true;

  // Partial mask: single run of 3+ asterisks with optional short
  // non-whitespace prefix/suffix (no spaces, no extra asterisks).
  return PARTIAL_MASK_RE.test(value);
}

/**
 * Check if a value is fully masked (all asterisks).
 */
export function isFullyMasked(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return FULL_MASK_RE.test(value);
}
