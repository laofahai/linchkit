import { describe, expect, test } from "bun:test";
import type { EntityDefinition } from "@linchkit/core/types";
import {
  detectTitleField,
  findDateField,
  groupRecordsByDate,
  parseDateValue,
} from "../src/components/auto-calendar/calendar-utils";

// ── parseDateValue ───────────────────────────────────

describe("parseDateValue", () => {
  test("returns null for falsy values", () => {
    expect(parseDateValue(null)).toBeNull();
    expect(parseDateValue(undefined)).toBeNull();
    expect(parseDateValue("")).toBeNull();
    expect(parseDateValue(0)).toBeNull();
  });

  test("parses ISO string", () => {
    const d = parseDateValue("2026-03-15T10:30:00Z");
    expect(d).toBeInstanceOf(Date);
    expect(d?.getUTCFullYear()).toBe(2026);
    expect(d?.getUTCMonth()).toBe(2); // March = 2
    expect(d?.getUTCDate()).toBe(15);
  });

  test("parses date-only ISO string", () => {
    const d = parseDateValue("2026-01-20");
    expect(d).toBeInstanceOf(Date);
    expect(d?.getFullYear()).toBe(2026);
  });

  test("passes through Date objects", () => {
    const original = new Date(2026, 5, 10);
    const d = parseDateValue(original);
    expect(d).toBe(original);
  });

  test("parses numeric timestamps", () => {
    const ts = new Date("2026-06-01T00:00:00Z").getTime();
    const d = parseDateValue(ts);
    expect(d).toBeInstanceOf(Date);
    expect(d?.getTime()).toBe(ts);
  });

  test("returns null for non-date values", () => {
    expect(parseDateValue({})).toBeNull();
    expect(parseDateValue([])).toBeNull();
    expect(parseDateValue(true)).toBeNull();
  });
});

// ── detectTitleField ─────────────────────────────────

describe("detectTitleField", () => {
  function makeEntity(fields: Record<string, { type: string }>): EntityDefinition {
    return { name: "test", fields } as unknown as EntityDefinition;
  }

  test("prefers 'title' field", () => {
    const schema = makeEntity({
      description: { type: "text" },
      title: { type: "string" },
      name: { type: "string" },
    });
    expect(detectTitleField(schema)).toBe("title");
  });

  test("prefers 'name' if no 'title'", () => {
    const schema = makeEntity({
      code: { type: "string" },
      name: { type: "string" },
    });
    expect(detectTitleField(schema)).toBe("name");
  });

  test("falls back to first string field", () => {
    const schema = makeEntity({
      amount: { type: "number" },
      description: { type: "string" },
    });
    expect(detectTitleField(schema)).toBe("description");
  });

  test("falls back to 'id' if no text fields", () => {
    const schema = makeEntity({
      amount: { type: "number" },
      active: { type: "boolean" },
    });
    expect(detectTitleField(schema)).toBe("id");
  });
});

// ── findDateField ────────────────────────────────────

describe("findDateField", () => {
  test("returns null when no date fields exist", () => {
    expect(findDateField({ title: { type: "string" }, amount: { type: "number" } })).toBeNull();
  });

  test("prefers 'due_date' over others", () => {
    const result = findDateField({
      created_at: { type: "datetime" },
      due_date: { type: "date" },
      updated_at: { type: "datetime" },
    });
    expect(result).toBe("due_date");
  });

  test("prefers 'submitted_at' over 'created_at'", () => {
    const result = findDateField({
      created_at: { type: "datetime" },
      submitted_at: { type: "datetime" },
    });
    expect(result).toBe("submitted_at");
  });

  test("falls back to first date field if no preferred name matches", () => {
    const result = findDateField({
      my_custom_date: { type: "date" },
      another_date: { type: "datetime" },
    });
    expect(result).toBe("my_custom_date");
  });
});

// ── groupRecordsByDate ───────────────────────────────

describe("groupRecordsByDate", () => {
  test("groups records by date field", () => {
    const records = [
      { id: "1", title: "A", due: "2026-03-15T10:00:00Z" },
      { id: "2", title: "B", due: "2026-03-15T14:00:00Z" },
      { id: "3", title: "C", due: "2026-03-16T09:00:00Z" },
    ];
    const grouped = groupRecordsByDate(records, "due");
    expect(grouped.size).toBe(2);
    expect(grouped.get("2026-03-15")).toHaveLength(2);
    expect(grouped.get("2026-03-16")).toHaveLength(1);
  });

  test("skips records with missing date field", () => {
    const records = [
      { id: "1", title: "A", due: "2026-03-15" },
      { id: "2", title: "B", due: null },
      { id: "3", title: "C" },
    ];
    const grouped = groupRecordsByDate(records, "due");
    expect(grouped.size).toBe(1);
    expect(grouped.get("2026-03-15")).toHaveLength(1);
  });

  test("returns empty map for empty records", () => {
    const grouped = groupRecordsByDate([], "due");
    expect(grouped.size).toBe(0);
  });
});
