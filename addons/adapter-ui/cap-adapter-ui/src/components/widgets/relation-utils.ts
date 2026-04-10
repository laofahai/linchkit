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
