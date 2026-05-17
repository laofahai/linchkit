/**
 * Droppable-id helpers — keep the magic prefix in a single place so the
 * grid (producer) and the board (consumer) cannot drift apart.
 */

/** Prefix applied to all calendar day droppables. */
export const DAY_DROPPABLE_PREFIX = "day:" as const;

/** Build a droppable id for a given day key (yyyy-MM-dd). */
export function dayDroppableId(dayKey: string): string {
  return `${DAY_DROPPABLE_PREFIX}${dayKey}`;
}

/**
 * Parse a droppable id back into its day-key payload. Returns `null` when
 * the id was not produced by `dayDroppableId`.
 */
export function parseDayDroppableId(droppableId: string): string | null {
  if (!droppableId.startsWith(DAY_DROPPABLE_PREFIX)) return null;
  return droppableId.slice(DAY_DROPPABLE_PREFIX.length);
}
