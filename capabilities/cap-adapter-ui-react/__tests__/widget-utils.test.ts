import { describe, expect, test } from "bun:test";
import {
  formatDate,
  formatDateTime,
  formatCurrency,
  toDateInputValue,
  toDateTimeInputValue,
} from "../src/components/widgets/utils";

describe("formatDate", () => {
  test("formats a Date object", () => {
    const d = new Date("2025-06-15T00:00:00Z");
    const result = formatDate(d);
    // Locale-dependent, just verify it returns a non-empty string
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("formats a date string", () => {
    const result = formatDate("2025-01-01");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("returns string representation for invalid date input", () => {
    const result = formatDate("not-a-date");
    expect(typeof result).toBe("string");
  });
});

describe("formatDateTime", () => {
  test("formats a Date object", () => {
    const d = new Date("2025-06-15T14:30:00Z");
    const result = formatDateTime(d);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("formats a datetime string", () => {
    const result = formatDateTime("2025-06-15T14:30:00Z");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("formatCurrency", () => {
  test("formats a number as USD currency", () => {
    const result = formatCurrency(1234.56);
    expect(result).toContain("1,234.56");
    expect(result).toContain("$");
  });

  test("formats zero", () => {
    const result = formatCurrency(0);
    expect(result).toContain("0.00");
  });

  test("formats negative numbers", () => {
    const result = formatCurrency(-99.99);
    expect(result).toContain("99.99");
  });
});

describe("toDateInputValue", () => {
  test("converts Date to YYYY-MM-DD format", () => {
    const d = new Date("2025-06-15T14:30:00Z");
    expect(toDateInputValue(d)).toBe("2025-06-15");
  });

  test("converts date string to YYYY-MM-DD format", () => {
    expect(toDateInputValue("2025-01-01T00:00:00Z")).toBe("2025-01-01");
  });
});

describe("toDateTimeInputValue", () => {
  test("converts Date to datetime-local input format", () => {
    const d = new Date("2025-06-15T14:30:00Z");
    const result = toDateTimeInputValue(d);
    // Should be YYYY-MM-DDTHH:MM format (16 chars)
    expect(result).toHaveLength(16);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  test("converts datetime string to input format", () => {
    const result = toDateTimeInputValue("2025-06-15T14:30:00Z");
    expect(result).toHaveLength(16);
  });
});
