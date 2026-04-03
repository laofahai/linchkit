import { describe, expect, it } from "bun:test";
import {
  defineAction,
  defineCapability,
  defineRule,
  defineEntity,
  defineState,
  defineView,
} from "@linchkit/core";
import { validateCapability } from "../src/validate-capability";

describe("validateCapability", () => {
  it("should pass for a well-formed capability", () => {
    const cap = defineCapability({
      name: "purchase_management",
      label: "Purchase Management",
      type: "standard",
      category: "business",
      version: "1.0.0",
      schemas: [
        defineEntity({
          name: "purchase_request",
          fields: {
            title: { type: "string" },
            amount: { type: "number" },
            status: { type: "state", machine: "request_lifecycle" },
          },
        }),
      ],
      actions: [
        defineAction({
          name: "submit_request",
          schema: "purchase_request",
          label: "Submit",
          stateTransition: { from: "draft", to: "submitted" },
          policy: { mode: "sync", transaction: true },
        }),
      ],
      rules: [
        defineRule({
          name: "amount_check",
          label: "Amount check",
          trigger: { action: "submit_request" },
          condition: { field: "target.amount", operator: "gt", value: 10000 },
          effect: { type: "warn", message: "Large amount" },
        }),
      ],
      states: [
        defineState({
          name: "request_lifecycle",
          schema: "purchase_request",
          field: "status",
          initial: "draft",
          states: ["draft", "submitted", "approved"],
          transitions: [
            { from: "draft", to: "submitted", action: "submit_request" },
            { from: "submitted", to: "approved", action: "approve_request" },
          ],
        }),
      ],
      views: [
        defineView({
          name: "purchase_list",
          schema: "purchase_request",
          type: "list",
          fields: [{ field: "title" }, { field: "amount" }],
        }),
      ],
    });

    const result = validateCapability(cap);
    expect(result.valid).toBe(true);
    expect(result.schemas.count).toBe(1);
    expect(result.actions.count).toBe(1);
    expect(result.rules.count).toBe(1);
    expect(result.states.count).toBe(1);
    expect(result.views.count).toBe(1);
  });

  it("should warn when action references external schema", () => {
    const cap = defineCapability({
      name: "test_cap",
      label: "Test",
      type: "standard",
      category: "business",
      version: "1.0.0",
      actions: [
        defineAction({
          name: "test_action",
          schema: "nonexistent_schema",
          label: "Test",
          policy: { mode: "sync", transaction: true },
        }),
      ],
    });

    const result = validateCapability(cap);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]?.message).toContain("nonexistent_schema");
  });

  it("should warn when rule triggers on external action", () => {
    const cap = defineCapability({
      name: "test_cap",
      label: "Test",
      type: "standard",
      category: "business",
      version: "1.0.0",
      rules: [
        defineRule({
          name: "test_rule",
          label: "Test",
          trigger: { action: "nonexistent_action" },
          condition: { field: "target.x", operator: "eq", value: 1 },
          effect: { type: "warn", message: "test" },
        }),
      ],
    });

    const result = validateCapability(cap);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]?.message).toContain("nonexistent_action");
  });

  it("should handle empty capability", () => {
    const cap = defineCapability({
      name: "empty",
      label: "Empty",
      type: "standard",
      category: "business",
      version: "1.0.0",
    });

    const result = validateCapability(cap);
    expect(result.valid).toBe(true);
    expect(result.schemas.count).toBe(0);
  });
});
