/**
 * Tests for the shared relation display-label helpers.
 *
 * `resolveDisplayLabel` is the chokepoint that prevents the entity list from
 * rendering "[object Object]" for relation-resolver columns (e.g.
 * `department { id name }`): it applies the same title-field resolution the
 * detail-view relation widgets use (getRecordLabel / ref-widget).
 */

import { describe, expect, test } from "bun:test";
import { getRecordLabel, resolveDisplayLabel } from "../src/components/widgets/relation-utils";

describe("getRecordLabel", () => {
  test("uses the explicit title field when present", () => {
    expect(getRecordLabel({ id: "d1", code: "ENG", name: "Engineering" }, "code")).toBe("ENG");
  });

  test("guesses a common title field when none is given", () => {
    expect(getRecordLabel({ id: "d1", name: "Engineering" }, undefined)).toBe("Engineering");
  });

  test("falls back to the record id when no title candidate exists", () => {
    expect(getRecordLabel({ id: "d1", budget: 100 }, undefined)).toBe("d1");
  });
});

describe("resolveDisplayLabel", () => {
  test("resolves a relation envelope to its name (the live list-view bug)", () => {
    // The list query fetches `department { id name }` → the cell value is
    // this object; the detail view shows "Engineering" for the same field.
    expect(resolveDisplayLabel({ id: "d1", name: "Engineering" })).toBe("Engineering");
  });

  test("prefers the configured titleField over guessed candidates", () => {
    const value = { id: "d1", code: "ENG", name: "Engineering" };
    expect(resolveDisplayLabel(value, { titleField: "code" })).toBe("ENG");
  });

  test("ignores a titleField that is absent from the record", () => {
    const value = { id: "d1", name: "Engineering" };
    expect(resolveDisplayLabel(value, { titleField: "code" })).toBe("Engineering");
  });

  test("resolves a translatable title field by locale", () => {
    const value = { id: "d1", name: { en: "Engineering", "zh-CN": "工程部" } };
    expect(resolveDisplayLabel(value, { locale: "zh-CN" })).toBe("工程部");
    expect(resolveDisplayLabel(value, { locale: "en" })).toBe("Engineering");
  });

  test("resolves a bare translatable locale map", () => {
    const value = { en: "Hello", "zh-CN": "你好" };
    expect(resolveDisplayLabel(value, { locale: "zh-CN" })).toBe("你好");
    // Base-language fallback: "zh" matches "zh-CN".
    expect(resolveDisplayLabel(value, { locale: "zh" })).toBe("你好");
    // Unknown locale falls back to English.
    expect(resolveDisplayLabel(value, { locale: "fr" })).toBe("Hello");
  });

  test("falls back to the first locale entry when no en value exists", () => {
    expect(resolveDisplayLabel({ "zh-CN": "你好" }, { locale: "fr" })).toBe("你好");
  });

  test("joins labels for arrays of related records", () => {
    const value = [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ];
    expect(resolveDisplayLabel(value)).toBe("Alpha, Beta");
  });

  test("falls back to the record id when no title candidate resolves", () => {
    expect(resolveDisplayLabel({ id: "d1", budget: 100 })).toBe("d1");
    expect(resolveDisplayLabel({ id: "d1", name: null })).toBe("d1");
  });

  test("returns null for unresolvable values instead of String(object)", () => {
    expect(resolveDisplayLabel(null)).toBeNull();
    expect(resolveDisplayLabel(undefined)).toBeNull();
    expect(resolveDisplayLabel({ nested: { deep: 1 } })).toBeNull();
    expect(resolveDisplayLabel([])).toBeNull();
    expect(resolveDisplayLabel({})).toBeNull();
  });

  test("stringifies primitives", () => {
    expect(resolveDisplayLabel("plain")).toBe("plain");
    expect(resolveDisplayLabel(42)).toBe("42");
    expect(resolveDisplayLabel(false)).toBe("false");
  });

  test('never produces "[object Object]" for any object-shaped input', () => {
    const inputs: unknown[] = [
      { id: "d1", name: "Engineering" },
      { id: "d1" },
      { nested: { deep: 1 } },
      [{ id: "a" }, { foo: "bar" }],
      { en: "Hi" },
      {},
    ];
    for (const input of inputs) {
      const label = resolveDisplayLabel(input);
      expect(label ?? "").not.toContain("[object Object]");
    }
  });
});
