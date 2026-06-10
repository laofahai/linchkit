/**
 * Shared utilities for relationship widgets (many_to_one, one_to_one, one_to_many, many_to_many).
 */

export interface RelatedRecord {
  id: string;
  [key: string]: unknown;
}

/** Heuristic fallback: guess the title field from common naming patterns */
const TITLE_FIELD_CANDIDATES = ["name", "title", "label", "displayName", "display_name"];

function guessTitleField(record: RelatedRecord): string {
  for (const candidate of TITLE_FIELD_CANDIDATES) {
    if (candidate in record) return candidate;
  }
  return "id";
}

/** Get a human-readable label from a related record */
export function getRecordLabel(record: RelatedRecord, titleField: string | undefined): string {
  if (titleField && titleField in record) {
    return String(record[titleField] ?? record.id);
  }
  const guessed = guessTitleField(record);
  return String(record[guessed] ?? record.id);
}

/** Options for `resolveDisplayLabel`. */
export interface ResolveDisplayLabelOptions {
  /** Preferred title field (e.g. schema `presentation.titleField`). */
  titleField?: string;
  /** Active UI locale, used to resolve translatable locale maps. */
  locale?: string;
}

/**
 * Resolve a translatable locale map (e.g. `{ en: "...", "zh-CN": "..." }`)
 * to a single string for the given locale. Returns null when the object is
 * not a pure string-valued locale map.
 */
function resolveTranslatableMap(map: Record<string, unknown>, locale?: string): string | null {
  const keys = Object.keys(map);
  if (keys.length === 0) return null;
  if (!keys.every((key) => typeof map[key] === "string")) return null;
  const values = map as Record<string, string>;
  if (locale) {
    const exact = values[locale];
    if (exact !== undefined) return exact;
    // Fall back to a base-language match (e.g. "zh" matches "zh-CN").
    const base = locale.split("-")[0];
    if (base) {
      const baseMatch = keys.find((key) => key === base || key.startsWith(`${base}-`));
      if (baseMatch !== undefined) return values[baseMatch] ?? null;
    }
  }
  if (values.en !== undefined) return values.en;
  const first = keys[0];
  return first !== undefined ? (values[first] ?? null) : null;
}

/**
 * Resolve a human-readable label for an arbitrary field value.
 *
 * Handles, in order:
 * - primitives → `String(value)`
 * - arrays → comma-joined labels of resolvable items
 * - related-record envelopes (`{ id, name/title/... }`) → same title-field
 *   resolution the detail-view relation widgets use (`getRecordLabel`)
 * - translatable locale maps (`{ en, "zh-CN", ... }`) → locale-aware pick
 *
 * Returns null when no meaningful label can be derived — never the
 * `String(object)` form "[object Object]" — so callers can render their own
 * placeholder.
 */
export function resolveDisplayLabel(
  value: unknown,
  opts: ResolveDisplayLabelOptions = {},
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) {
    const labels = value
      .map((item) => resolveDisplayLabel(item, opts))
      .filter((label): label is string => label !== null && label !== "");
    return labels.length > 0 ? labels.join(", ") : null;
  }
  const record = value as Record<string, unknown>;
  if ("id" in record) {
    const related = record as RelatedRecord;
    const titleField =
      opts.titleField && opts.titleField in related ? opts.titleField : guessTitleField(related);
    // The title value may itself be a translatable map — resolve recursively.
    const label = resolveDisplayLabel(related[titleField], { locale: opts.locale });
    if (label !== null && label !== "") return label;
    return related.id !== null && related.id !== undefined ? String(related.id) : null;
  }
  return resolveTranslatableMap(record, opts.locale);
}
