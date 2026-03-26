import { describe, expect, test } from "bun:test";
import { resolveSchemaLabel } from "../src/i18n/use-schema-label";

describe("resolveSchemaLabel", () => {
  // Mock i18n instance
  const mockI18n = {
    t: (key: string, options?: Record<string, unknown>) => {
      // Simulate i18next: return translated value or defaultValue
      const translations: Record<string, string> = {
        "schema.purchase_order": "Purchase Order",
        "schema.product": "Product",
        "common.yes": "Yes",
        "common.no": "No",
      };
      return translations[key] ?? (options?.defaultValue as string) ?? key;
    },
  };

  test("returns fallback when label is undefined", () => {
    expect(resolveSchemaLabel(mockI18n, undefined, "my_field")).toBe("my_field");
  });

  test("returns literal label when no t: prefix", () => {
    expect(resolveSchemaLabel(mockI18n, "Purchase Order", "fallback")).toBe("Purchase Order");
  });

  test("returns literal label for Chinese text", () => {
    expect(resolveSchemaLabel(mockI18n, "采购订单", "fallback")).toBe("采购订单");
  });

  test("resolves t: prefix to i18n translation", () => {
    expect(resolveSchemaLabel(mockI18n, "t:schema.purchase_order", "fallback")).toBe("Purchase Order");
  });

  test("resolves t: prefix for another key", () => {
    expect(resolveSchemaLabel(mockI18n, "t:schema.product", "fallback")).toBe("Product");
  });

  test("falls back to defaultValue when t: key is not found", () => {
    expect(resolveSchemaLabel(mockI18n, "t:schema.nonexistent", "Fallback Name")).toBe("Fallback Name");
  });

  test("returns fallback for empty string label", () => {
    // Empty string is falsy, so `if (!label)` returns true → fallback is used
    expect(resolveSchemaLabel(mockI18n, "", "fallback")).toBe("fallback");
  });

  test("handles t: prefix with no key after it", () => {
    // Edge case: "t:" with empty key
    const result = resolveSchemaLabel(mockI18n, "t:", "fallback");
    // key would be "", i18n.t("") returns "" or the key itself
    expect(typeof result).toBe("string");
  });

  test("does not treat 't:' in the middle of a string as i18n prefix", () => {
    expect(resolveSchemaLabel(mockI18n, "some t:key text", "fallback")).toBe("some t:key text");
  });

  test("preserves exact label string when not using t: prefix", () => {
    const label = "  Spaces Around  ";
    expect(resolveSchemaLabel(mockI18n, label, "fallback")).toBe(label);
  });
});
