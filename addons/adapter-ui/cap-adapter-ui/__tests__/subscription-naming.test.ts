/**
 * Pins the CONSUMER side of the GraphQL subscription field-name contract.
 *
 * The server generates subscription fields named `on{Pascal}Created|Updated|Deleted`
 * (addons/adapter-server/cap-adapter-server/src/graphql/build-subscriptions.ts,
 * using toPascalCase from .../graphql/naming.ts). The UI subscribes to those
 * fields BY NAME via its own toPascalCase copy in src/lib/api.ts (the UI must
 * not import server code). Both sides must produce identical output — the
 * server counterpart of this pin lives in
 * addons/adapter-server/cap-adapter-server/__tests__/graphql-naming.test.ts
 * and uses the SAME example: "purchase_request" → "PurchaseRequest".
 */

import { describe, expect, test } from "bun:test";
import { buildEntitySubscriptionQuery } from "../src/hooks/use-subscription";
import { toPascalCase } from "../src/lib/api";

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
    // Mirrors the sanitization in adapter-server src/graphql/naming.ts
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
