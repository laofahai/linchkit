/**
 * Pins the PRODUCER side of the GraphQL subscription field-name contract.
 *
 * src/graphql/naming.ts is the single source of truth for PascalCase naming
 * on the server; build-subscriptions.ts uses it to publish fields named
 * `on{Pascal}Created|Updated|Deleted`. The UI subscribes to those fields BY
 * NAME using its own copy of toPascalCase
 * (addons/adapter-ui/cap-adapter-ui/src/lib/api.ts — the UI must not import
 * server code). The UI counterpart of this pin lives in
 * addons/adapter-ui/cap-adapter-ui/__tests__/subscription-naming.test.ts and
 * uses the SAME example: "purchase_request" → "PurchaseRequest".
 */

import { describe, expect, test } from "bun:test";
import { GRAPHQL_NAME_RE, joinPascal, toCamelCase, toPascalCase } from "../src/graphql/naming";

describe("graphql naming contract (server producer side)", () => {
  test("toPascalCase pins the shared example: purchase_request → PurchaseRequest", () => {
    expect(toPascalCase("purchase_request")).toBe("PurchaseRequest");
    // Subscription field names derived from it (see build-subscriptions.ts)
    expect(`on${toPascalCase("purchase_request")}Created`).toBe("onPurchaseRequestCreated");
    expect(`on${toPascalCase("purchase_request")}Updated`).toBe("onPurchaseRequestUpdated");
    expect(`on${toPascalCase("purchase_request")}Deleted`).toBe("onPurchaseRequestDeleted");
  });

  test("toPascalCase handles kebab-case, single words, and multi-segment names", () => {
    expect(toPascalCase("purchase-order")).toBe("PurchaseOrder");
    expect(toPascalCase("task")).toBe("Task");
    expect(toPascalCase("purchase_order_line_item")).toBe("PurchaseOrderLineItem");
  });

  test("toPascalCase sanitizes illegal GraphQL name characters", () => {
    expect(toPascalCase("weird.name")).toBe("Weirdname");
    expect(toPascalCase("1task")).toBe("_1task");
    expect(GRAPHQL_NAME_RE.test(toPascalCase("1task"))).toBe(true);
  });

  test("joinPascal is the raw join without sanitization", () => {
    expect(joinPascal("purchase_request")).toBe("PurchaseRequest");
    expect(joinPascal("weird.name")).toBe("Weird.name");
  });

  test("toCamelCase derives from toPascalCase", () => {
    expect(toCamelCase("purchase_request")).toBe("purchaseRequest");
    expect(toCamelCase("task")).toBe("task");
  });
});
