/**
 * use-calendar-data — pure-logic hook (+ helpers) that buckets records into
 * day cells based on a reference date and view mode. No React rendering
 * dependencies so the helpers stay test-friendly under bun:test.
 */

import {
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  isBefore,
  isSameDay,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { useMemo } from "react";
import type { CalendarDayCell, CalendarEventChip, CalendarRecord, CalendarViewMode } from "./types";

/** Default week start — Sunday. Kept hard-coded to match auto-calendar.tsx. */
const WEEK_STARTS_ON = 0 as const;

/**
 * Parse a date-ish field. Accepts Date, ISO string, epoch ms.
 * Returns null when the value is unset or unparseable so callers can skip the record.
 */
export function parseCalendarDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  if (typeof value === "string") {
    try {
      const parsed = parseISO(value);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    } catch {
      // fall through
    }
    const native = new Date(value);
    return Number.isNaN(native.getTime()) ? null : native;
  }
  return null;
}

/**
 * Return the inclusive [start, end] range of days that should be rendered
 * for the given mode anchored on `currentDate`. Month mode pads to full weeks.
 */
export function getCalendarRange(
  currentDate: Date,
  mode: CalendarViewMode,
): {
  start: Date;
  end: Date;
} {
  if (mode === "day") {
    const day = startOfDay(currentDate);
    return { start: day, end: day };
  }
  if (mode === "week") {
    return {
      start: startOfWeek(currentDate, { weekStartsOn: WEEK_STARTS_ON }),
      end: endOfWeek(currentDate, { weekStartsOn: WEEK_STARTS_ON }),
    };
  }
  // month: pad to full weeks so the grid stays rectangular.
  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  return {
    start: startOfWeek(monthStart, { weekStartsOn: WEEK_STARTS_ON }),
    end: endOfWeek(monthEnd, { weekStartsOn: WEEK_STARTS_ON }),
  };
}

/** Format a Date as a local yyyy-MM-dd key. Avoids UTC drift around midnight. */
export function toDayKey(date: Date): string {
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Project records into CalendarEventChips. Records without a parseable start
 * date are dropped. Multi-day events normalize end >= start.
 */
export function toEventChips({
  records,
  dateField,
  endDateField,
  titleField,
}: {
  records: CalendarRecord[];
  dateField: string;
  endDateField?: string;
  titleField: string;
}): CalendarEventChip[] {
  const chips: CalendarEventChip[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    const start = parseCalendarDate(record[dateField]);
    if (!start) continue;

    let end = start;
    if (endDateField) {
      const parsedEnd = parseCalendarDate(record[endDateField]);
      if (parsedEnd && !isBefore(parsedEnd, start)) {
        end = parsedEnd;
      }
    }

    const titleRaw = record[titleField];
    const id = record.id !== undefined && record.id !== null ? String(record.id) : `chip-${i}`;
    chips.push({
      id,
      record,
      start,
      end,
      title: titleRaw === undefined || titleRaw === null || titleRaw === "" ? id : String(titleRaw),
    });
  }
  return chips;
}

/**
 * Bucket chips into day cells. An event spanning multiple days appears in
 * every cell whose date is between start and end inclusive (local time).
 */
export function bucketChipsIntoCells({
  chips,
  range,
  focalMonth,
}: {
  chips: CalendarEventChip[];
  range: { start: Date; end: Date };
  /** Month used to flag the `inFocalMonth` cell flag. */
  focalMonth: Date;
}): CalendarDayCell[] {
  const days = eachDayOfInterval({ start: range.start, end: range.end });
  const focalMonthIndex = focalMonth.getMonth();
  const focalYear = focalMonth.getFullYear();

  return days.map((day) => {
    const dayStart = startOfDay(day);
    const events = chips
      .filter((chip) => {
        const chipStart = startOfDay(chip.start);
        const chipEnd = startOfDay(chip.end);
        // chipStart <= day <= chipEnd
        const startsOnOrBefore = isSameDay(chipStart, dayStart) || isBefore(chipStart, dayStart);
        const endsOnOrAfter = isSameDay(chipEnd, dayStart) || !isBefore(chipEnd, dayStart);
        return startsOnOrBefore && endsOnOrAfter;
      })
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    return {
      key: toDayKey(dayStart),
      date: dayStart,
      events,
      inFocalMonth: dayStart.getMonth() === focalMonthIndex && dayStart.getFullYear() === focalYear,
    };
  });
}

/**
 * React hook: memoized projection of records into calendar cells. Pure with
 * respect to its inputs — safe to call from CalendarBoard.
 */
export function useCalendarData({
  records,
  dateField,
  endDateField,
  titleField,
  currentDate,
  mode,
}: {
  records: CalendarRecord[];
  dateField: string;
  endDateField?: string;
  titleField: string;
  currentDate: Date;
  mode: CalendarViewMode;
}): {
  cells: CalendarDayCell[];
  range: { start: Date; end: Date };
  chips: CalendarEventChip[];
} {
  return useMemo(() => {
    const range = getCalendarRange(currentDate, mode);
    const chips = toEventChips({ records, dateField, endDateField, titleField });
    const cells = bucketChipsIntoCells({ chips, range, focalMonth: currentDate });
    return { cells, range, chips };
  }, [records, dateField, endDateField, titleField, currentDate, mode]);
}
