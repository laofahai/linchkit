/**
 * use-timeline-data — pure data-layer helpers for cap-view-timeline.
 *
 * All functions are side-effect-free so they are trivially unit-testable
 * without React or a DOM environment.
 */

import type { TimelineBar, TimelineColumn, TimelineRecord, TimelineViewMode } from "./types";

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

/** Parse any date-like value into a Date, or return null on failure. */
export function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Return midnight (00:00:00.000 local) of the given date. */
export function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/** Return the Monday of the week containing `d`. */
export function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  const day = out.getDay(); // 0=Sun … 6=Sat
  const delta = day === 0 ? -6 : 1 - day; // shift to Monday
  out.setDate(out.getDate() + delta);
  return out;
}

/** Return the first day of the month containing `d`. */
export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Add `n` days to a date (mutates a copy). */
export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/** Difference in whole days (positive when b > a). */
export function diffDays(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Column generation
// ---------------------------------------------------------------------------

const VISIBLE_DAYS: Record<TimelineViewMode, number> = {
  day: 14,
  week: 12, // 12 weeks
  month: 12,
};

/**
 * Build the array of column descriptors for the visible window.
 *
 * - day: one column per day (14 days centred on anchor)
 * - week: one column per Monday (12 weeks centred on anchor's week)
 * - month: one column per month (12 months)
 */
export function buildColumns(anchor: Date, mode: TimelineViewMode): TimelineColumn[] {
  const today = startOfDay(new Date());
  const todayKey = today.toISOString().slice(0, 10);
  const cols: TimelineColumn[] = [];

  if (mode === "day") {
    const origin = startOfDay(addDays(anchor, -7)); // start 7 days before anchor
    for (let i = 0; i < VISIBLE_DAYS.day; i++) {
      const date = addDays(origin, i);
      const key = date.toISOString().slice(0, 10);
      cols.push({
        key,
        date,
        label: date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }),
        isToday: key === todayKey,
      });
    }
  } else if (mode === "week") {
    const origin = startOfWeek(addDays(anchor, -6 * 7)); // start 6 weeks before anchor's week
    for (let i = 0; i < VISIBLE_DAYS.week; i++) {
      const date = addDays(origin, i * 7);
      const key = date.toISOString().slice(0, 10);
      // ISO week number
      const tmp = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
      tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
      const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
      const weekNum = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
      cols.push({ key, date, label: `W${weekNum}`, isToday: key === todayKey });
    }
  } else {
    // month
    const anchorMonth = startOfMonth(anchor);
    const origin = new Date(anchorMonth.getFullYear(), anchorMonth.getMonth() - 6, 1);
    for (let i = 0; i < VISIBLE_DAYS.month; i++) {
      const date = new Date(origin.getFullYear(), origin.getMonth() + i, 1);
      const key = date.toISOString().slice(0, 10);
      cols.push({
        key,
        date,
        label: date.toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
        isToday: key === todayKey,
      });
    }
  }

  return cols;
}

/** Return the first date in the columns array. */
export function windowStart(cols: TimelineColumn[]): Date {
  return cols[0]?.date ?? new Date();
}

/** Return the day after the last column's end. */
export function windowEnd(cols: TimelineColumn[], mode: TimelineViewMode): Date {
  const last = cols[cols.length - 1];
  if (!last) return new Date();
  if (mode === "day") return addDays(last.date, 1);
  if (mode === "week") return addDays(last.date, 7);
  // month — advance to first of next month
  return new Date(last.date.getFullYear(), last.date.getMonth() + 1, 1);
}

// ---------------------------------------------------------------------------
// Bar resolution
// ---------------------------------------------------------------------------

/**
 * Resolve all records into TimelineBar objects, filtering out records with
 * unparseable or missing start dates. Records whose [start, end] range falls
 * entirely outside [winStart, winEnd] are still included — the caller clips
 * rendering position but preserving them simplifies filtering UX.
 */
export function buildBars(
  records: TimelineRecord[],
  startField: string,
  endField: string,
  labelField: string,
  groupByField?: string,
): TimelineBar[] {
  const bars: TimelineBar[] = [];
  for (const rec of records) {
    const start = parseDate(rec[startField]);
    if (!start) continue;
    const rawEnd = parseDate(rec[endField]);
    const end = rawEnd && rawEnd >= start ? rawEnd : start;
    bars.push({
      id: String(rec.id ?? bars.length),
      record: rec,
      start: startOfDay(start),
      end: startOfDay(end),
      label: String(rec[labelField] ?? ""),
      group: groupByField ? String(rec[groupByField] ?? "") : undefined,
    });
  }
  return bars;
}

// ---------------------------------------------------------------------------
// Layout calculation
// ---------------------------------------------------------------------------

export interface BarLayout {
  bar: TimelineBar;
  /** Left offset as a fraction of total column width (0–1). */
  leftFrac: number;
  /** Width as a fraction of total column width (0–1). */
  widthFrac: number;
  /** Whether the bar extends beyond the right edge. */
  overflowsRight: boolean;
  /** Whether the bar starts before the left edge. */
  overflowsLeft: boolean;
}

/**
 * Compute the CSS left/width fractions for each bar relative to the visible
 * window. Bars that are entirely out-of-window get fraction 0/0 so they can
 * be hidden without re-filtering the array.
 */
export function layoutBars(
  bars: TimelineBar[],
  cols: TimelineColumn[],
  mode: TimelineViewMode,
): BarLayout[] {
  const winStart = windowStart(cols);
  const winEnd = windowEnd(cols, mode);
  const totalDays = diffDays(winStart, winEnd);
  if (totalDays <= 0) return [];

  return bars.map((bar) => {
    const barStartDay = diffDays(winStart, bar.start);
    // end is inclusive → add 1 day to make it exclusive
    const barEndDay = diffDays(winStart, addDays(bar.end, 1));

    const clampedStart = Math.max(0, barStartDay);
    const clampedEnd = Math.min(totalDays, barEndDay);

    if (clampedEnd <= clampedStart) {
      return { bar, leftFrac: 0, widthFrac: 0, overflowsRight: false, overflowsLeft: false };
    }

    return {
      bar,
      leftFrac: clampedStart / totalDays,
      widthFrac: (clampedEnd - clampedStart) / totalDays,
      overflowsLeft: barStartDay < 0,
      overflowsRight: barEndDay > totalDays,
    };
  });
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Group an array of BarLayout objects by `bar.group`.
 * Returns an ordered list of `{ group, layouts }` preserving insertion order.
 * When `group` is undefined (groupByField not set) returns a single entry
 * with key "".
 */
export function groupLayouts(layouts: BarLayout[]): Array<{ group: string; layouts: BarLayout[] }> {
  const map = new Map<string, BarLayout[]>();
  for (const layout of layouts) {
    const key = layout.bar.group ?? "";
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
    }
    bucket.push(layout);
  }
  return Array.from(map.entries()).map(([group, lays]) => ({ group, layouts: lays }));
}
