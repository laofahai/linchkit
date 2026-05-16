/**
 * Pure-logic tests for the calendar data pipeline. No DOM is required —
 * we exercise date bucketing, week boundaries, and multi-day spans.
 */

import { describe, expect, it } from "bun:test";
import { DAY_DROPPABLE_PREFIX, dayDroppableId, parseDayDroppableId } from "../src/droppable-ids";
import {
  bucketChipsIntoCells,
  getCalendarRange,
  parseCalendarDate,
  toDayKey,
  toEventChips,
} from "../src/use-calendar-data";

describe("parseCalendarDate", () => {
  it("returns null for empty input", () => {
    expect(parseCalendarDate(null)).toBeNull();
    expect(parseCalendarDate(undefined)).toBeNull();
    expect(parseCalendarDate("")).toBeNull();
  });

  it("parses ISO strings via parseISO", () => {
    const dateOnly = parseCalendarDate("2026-05-16");
    expect(dateOnly).toBeInstanceOf(Date);
    expect(dateOnly?.getFullYear()).toBe(2026);

    const withTime = parseCalendarDate("2026-05-16T09:30:00Z");
    expect(withTime).toBeInstanceOf(Date);
    expect(withTime?.getUTCHours()).toBe(9);
  });

  it("passes Date inputs through (when valid)", () => {
    const input = new Date("2026-05-16T12:00:00Z");
    const out = parseCalendarDate(input);
    expect(out).toBe(input);
    expect(out?.getUTCDate()).toBe(16);
  });

  it("returns null for an Invalid Date input", () => {
    expect(parseCalendarDate(new Date("not-a-date"))).toBeNull();
  });

  it("parses epoch ms numbers", () => {
    const ms = parseCalendarDate(1747353600000);
    expect(ms).toBeInstanceOf(Date);
  });

  it("returns null for non-ISO strings (no native Date fallback)", () => {
    expect(parseCalendarDate("not-a-date")).toBeNull();
    // Legacy human-readable form parsed by `new Date(string)` must NOT slip through.
    expect(parseCalendarDate("May 16 2026")).toBeNull();
  });
});

describe("toDayKey", () => {
  it("formats a date as local yyyy-MM-dd without UTC drift", () => {
    const date = new Date(2026, 4, 16); // May 16 2026 local
    expect(toDayKey(date)).toBe("2026-05-16");
  });

  it("zero-pads single-digit month and day", () => {
    const date = new Date(2026, 0, 7);
    expect(toDayKey(date)).toBe("2026-01-07");
  });
});

describe("getCalendarRange", () => {
  const anchor = new Date(2026, 4, 16); // Saturday May 16 2026

  it("expands month view to full weeks", () => {
    const { start, end } = getCalendarRange(anchor, "month");
    // May 2026 starts on a Friday, so week-aligned (Sunday start) ⇒ Apr 26.
    expect(toDayKey(start)).toBe("2026-04-26");
    // May 2026 ends on Sunday May 31; week-aligned end is Sat Jun 6.
    expect(toDayKey(end)).toBe("2026-06-06");
  });

  it("aligns week view to Sunday→Saturday around the anchor", () => {
    const { start, end } = getCalendarRange(anchor, "week");
    expect(toDayKey(start)).toBe("2026-05-10");
    expect(toDayKey(end)).toBe("2026-05-16");
  });

  it("collapses day view to the anchor date", () => {
    const { start, end } = getCalendarRange(anchor, "day");
    expect(toDayKey(start)).toBe(toDayKey(end));
    expect(toDayKey(start)).toBe("2026-05-16");
  });
});

describe("toEventChips", () => {
  it("drops records without a parseable start date", () => {
    const chips = toEventChips({
      records: [{ id: 1, due_date: "2026-05-16" }, { id: 2, due_date: null }, { id: 3 }],
      dateField: "due_date",
      titleField: "title",
    });
    expect(chips.length).toBe(1);
    expect(chips[0]?.id).toBe("1");
  });

  it("falls back to id when title is missing", () => {
    const chips = toEventChips({
      records: [{ id: "abc", due_date: "2026-05-16" }],
      dateField: "due_date",
      titleField: "title",
    });
    expect(chips[0]?.title).toBe("abc");
  });

  it("uses endDateField when later than start", () => {
    const chips = toEventChips({
      records: [{ id: 1, start: "2026-05-16", finish: "2026-05-18" }],
      dateField: "start",
      endDateField: "finish",
      titleField: "title",
    });
    expect(chips[0]?.start.getDate()).toBe(16);
    expect(chips[0]?.end.getDate()).toBe(18);
  });

  it("collapses end back to start when end < start", () => {
    const chips = toEventChips({
      records: [{ id: 1, start: "2026-05-20", finish: "2026-05-18" }],
      dateField: "start",
      endDateField: "finish",
      titleField: "title",
    });
    // Bad end is ignored.
    expect(chips[0]?.end.getDate()).toBe(chips[0]?.start.getDate());
  });

  it("throws when a record is missing its id field", () => {
    expect(() =>
      toEventChips({
        records: [{ due_date: "2026-05-16", title: "Standalone" }],
        dateField: "due_date",
        titleField: "title",
      }),
    ).toThrow(/must have an `id` field/);
  });

  it("throws when id is null or empty", () => {
    expect(() =>
      toEventChips({
        records: [{ id: null, due_date: "2026-05-16", title: "Null" }],
        dateField: "due_date",
        titleField: "title",
      }),
    ).toThrow(/must have an `id` field/);
    expect(() =>
      toEventChips({
        records: [{ id: "", due_date: "2026-05-16", title: "Empty" }],
        dateField: "due_date",
        titleField: "title",
      }),
    ).toThrow(/must have an `id` field/);
  });
});

describe("dayDroppableId", () => {
  it("prefixes the day key with the shared constant", () => {
    expect(dayDroppableId("2026-05-16")).toBe(`${DAY_DROPPABLE_PREFIX}2026-05-16`);
  });

  it("round-trips through parseDayDroppableId", () => {
    const id = dayDroppableId("2026-05-16");
    expect(parseDayDroppableId(id)).toBe("2026-05-16");
  });

  it("returns null for unrelated droppable ids", () => {
    expect(parseDayDroppableId("chip:abc")).toBeNull();
    expect(parseDayDroppableId("2026-05-16")).toBeNull();
  });
});

describe("bucketChipsIntoCells", () => {
  const range = getCalendarRange(new Date(2026, 4, 16), "week");

  it("places single-day events on their start day only", () => {
    const chips = toEventChips({
      records: [{ id: 1, due_date: "2026-05-12", title: "T" }],
      dateField: "due_date",
      titleField: "title",
    });
    const cells = bucketChipsIntoCells({ chips, range, focalMonth: new Date(2026, 4, 16) });
    const counts = cells.map((cell) => cell.events.length);
    expect(counts).toEqual([0, 0, 1, 0, 0, 0, 0]);
  });

  it("spans multi-day events across every overlapping cell", () => {
    const chips = toEventChips({
      records: [{ id: 1, start: "2026-05-11", finish: "2026-05-14", title: "Span" }],
      dateField: "start",
      endDateField: "finish",
      titleField: "title",
    });
    const cells = bucketChipsIntoCells({ chips, range, focalMonth: new Date(2026, 4, 16) });
    const days = cells.filter((cell) => cell.events.length > 0).map((cell) => cell.key);
    expect(days).toEqual(["2026-05-11", "2026-05-12", "2026-05-13", "2026-05-14"]);
  });

  it("flags cells outside the focal month for month view styling", () => {
    const monthRange = getCalendarRange(new Date(2026, 4, 16), "month");
    const cells = bucketChipsIntoCells({
      chips: [],
      range: monthRange,
      focalMonth: new Date(2026, 4, 16),
    });
    const firstInFocal = cells.find((cell) => cell.date.getMonth() === 4);
    const lastBefore = cells.find((cell) => cell.date.getMonth() === 3);
    expect(firstInFocal?.inFocalMonth).toBe(true);
    expect(lastBefore?.inFocalMonth).toBe(false);
  });

  it("sorts overlapping events by start ascending", () => {
    const chips = toEventChips({
      records: [
        { id: "later", due_date: "2026-05-12T15:00:00Z", title: "later" },
        { id: "earlier", due_date: "2026-05-12T09:00:00Z", title: "earlier" },
      ],
      dateField: "due_date",
      titleField: "title",
    });
    const cells = bucketChipsIntoCells({ chips, range, focalMonth: new Date(2026, 4, 16) });
    const targetCell = cells.find((cell) => cell.events.length === 2);
    expect(targetCell?.events.map((event) => event.id)).toEqual(["earlier", "later"]);
  });
});
