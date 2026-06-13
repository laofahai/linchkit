/**
 * Pins the CONSUMER side of the GraphQL subscription field-name contract.
 */
import { describe, expect, test } from "bun:test";
import { buildEntitySubscriptionQuery } from "../src/hooks/use-subscription";
import { toPascalCase } from "../src/lib/entity-api";

describe("subscription naming contract (UI consumer side)", () => {
  test("toPascalCase pins the shared example: purchase_request → PurchaseRequest", () => {
    expect(toPascalCase("purchase_request")).toBe("PurchaseRequest");
  });
  test("toPascalCase matches server behavior for kebab-case and single words", () => {
    expect(toPascalCase("purchase-order")).toBe("PurchaseOrder");
    expect(toPascalCase("task")).toBe("Task");
    expect(toPascalCase("purchase_order_line_item")).toBe("PurchaseOrderLineItem");
  });
  test("toPascalCase sanitizes illegal GraphQL name characters like the server", () => {
    expect(toPascalCase("weird.name")).toBe("Weirdname");
    expect(toPascalCase("1task")).toBe("_1task");
  });
  test("buildEntitySubscriptionQuery subscribes to the server-generated field names", () => {
    const query = buildEntitySubscriptionQuery("purchase_request");
    expect(query).toContain("onPurchaseRequestCreated");
    expect(query).toContain("onPurchaseRequestUpdated");
    expect(query).toContain("onPurchaseRequestDeleted");
  });
});
