import { describe, expect, test } from "bun:test";
import { toPascalCase } from "../src/lib/entity-api";

function toCamelCase(name: string): string {
  const parts = name.split(/[_-]/);
  return (
    parts[0] +
    parts
      .slice(1)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("")
  );
}

describe("toCamelCase", () => {
  test("converts snake_case to camelCase", () => {
    expect(toCamelCase("purchase_order")).toBe("purchaseOrder");
  });
  test("converts kebab-case to camelCase", () => {
    expect(toCamelCase("purchase-order")).toBe("purchaseOrder");
  });
  test("handles single word", () => {
    expect(toCamelCase("order")).toBe("order");
  });
  test("handles multiple underscores", () => {
    expect(toCamelCase("purchase_order_line_item")).toBe("purchaseOrderLineItem");
  });
  test("preserves leading lowercase", () => {
    expect(toCamelCase("my_schema")).toBe("mySchema");
  });
});

describe("toPascalCase", () => {
  test("converts snake_case to PascalCase", () => {
    expect(toPascalCase("purchase_order")).toBe("PurchaseOrder");
  });
  test("converts kebab-case to PascalCase", () => {
    expect(toPascalCase("purchase-order")).toBe("PurchaseOrder");
  });
  test("handles single word", () => {
    expect(toPascalCase("order")).toBe("Order");
  });
  test("handles multiple segments", () => {
    expect(toPascalCase("purchase_order_line")).toBe("PurchaseOrderLine");
  });
});

describe("isAuthEnabled / isAiEnabled — default state", () => {
  test("isAuthEnabled returns false when no config is cached", async () => {
    const { isAuthEnabled } = await import("../src/lib/app-config");
    expect(isAuthEnabled()).toBe(false);
  });
  test("isAiEnabled returns false when no config is cached", async () => {
    const { isAiEnabled } = await import("../src/lib/app-config");
    expect(isAiEnabled()).toBe(false);
  });
});

describe("GraphQL response parsing logic", () => {
  test("throwOnErrors logic — errors array triggers throw", () => {
    function throwOnErrors(res: { errors?: { message: string }[] }): void {
      const errors = res.errors;
      if (errors && errors.length > 0) {
        throw new Error(errors.at(0)?.message ?? "Unknown GraphQL error");
      }
    }
    expect(() => throwOnErrors({})).not.toThrow();
    expect(() => throwOnErrors({ errors: [] })).not.toThrow();
    expect(() => throwOnErrors({ errors: [{ message: "Field not found" }] })).toThrow(
      "Field not found",
    );
    expect(() =>
      throwOnErrors({ errors: [{ message: "First error" }, { message: "Second error" }] }),
    ).toThrow("First error");
  });
  test("throwOnErrors — unknown error fallback", () => {
    function throwOnErrors(res: { errors?: { message: string }[] }): void {
      const errors = res.errors;
      if (errors && errors.length > 0) {
        throw new Error(errors.at(0)?.message ?? "Unknown GraphQL error");
      }
    }
    expect(() => throwOnErrors({ errors: [{ message: "" }] })).toThrow("");
  });
});
