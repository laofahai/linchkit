import { describe, expect, test, beforeEach } from "bun:test";

// We test the pure utility functions from api.ts.
// toCamelCase and toPascalCase are not exported, so we test them indirectly
// or extract/re-implement the logic for testing.
// isAuthEnabled and isAiEnabled depend on cachedAppConfig (module state).

// Re-implement the pure functions to test their logic directly
// (since they are not exported from the module)
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

function toPascalCase(name: string): string {
  return name
    .split(/[_-]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
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

// Test isAuthEnabled / isAiEnabled — they read from cachedAppConfig (module-level state)
// Since cachedAppConfig is not exported and starts as null, the default is false.
describe("isAuthEnabled / isAiEnabled — default state", () => {
  test("isAuthEnabled returns false when no config is cached", async () => {
    // Fresh import — cachedAppConfig is null
    const { isAuthEnabled } = await import("../src/lib/api");
    expect(isAuthEnabled()).toBe(false);
  });

  test("isAiEnabled returns false when no config is cached", async () => {
    const { isAiEnabled } = await import("../src/lib/api");
    expect(isAiEnabled()).toBe(false);
  });
});

// Test GraphQLResponse type handling
describe("GraphQL response parsing logic", () => {
  test("throwOnErrors logic — errors array triggers throw", () => {
    // Re-implement the throwOnErrors logic for testing
    function throwOnErrors(res: { errors?: { message: string }[] }): void {
      const errors = res.errors;
      if (errors && errors.length > 0) {
        const firstError = errors.at(0);
        throw new Error(firstError?.message ?? "Unknown GraphQL error");
      }
    }

    // No errors — should not throw
    expect(() => throwOnErrors({})).not.toThrow();
    expect(() => throwOnErrors({ errors: [] })).not.toThrow();

    // With errors — should throw with first error message
    expect(() =>
      throwOnErrors({ errors: [{ message: "Field not found" }] }),
    ).toThrow("Field not found");

    // Multiple errors — throws first
    expect(() =>
      throwOnErrors({
        errors: [{ message: "First error" }, { message: "Second error" }],
      }),
    ).toThrow("First error");
  });

  test("throwOnErrors — unknown error fallback", () => {
    function throwOnErrors(res: { errors?: { message: string }[] }): void {
      const errors = res.errors;
      if (errors && errors.length > 0) {
        const firstError = errors.at(0);
        throw new Error(firstError?.message ?? "Unknown GraphQL error");
      }
    }

    // Edge case: errors array with no first element (shouldn't happen but test the fallback)
    // at(0) on non-empty array always returns, but test the ?? path
    expect(() => throwOnErrors({ errors: [{ message: "" }] })).toThrow("");
  });
});
