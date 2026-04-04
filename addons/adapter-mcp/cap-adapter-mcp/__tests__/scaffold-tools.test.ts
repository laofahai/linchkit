import { describe, expect, it } from "bun:test";
import {
  generateActionTemplate,
  generateCapabilityTemplate,
  generateRuleTemplate,
} from "../src/scaffold-tools";

describe("scaffold_capability", () => {
  it("generates a valid capability template with defaults", () => {
    const code = generateCapabilityTemplate({ name: "inventory" });

    expect(code).toContain('import type { CapabilityDefinition } from "@linchkit/core"');
    expect(code).toContain('name: "inventory"');
    expect(code).toContain('label: "Inventory"');
    expect(code).toContain('type: "standard"');
    expect(code).toContain('category: "business"');
    expect(code).toContain("inventory_capability");
    expect(code).toContain("entities:");
    expect(code).toContain("actions:");
    expect(code).toContain("rules:");
  });

  it("respects type and description params", () => {
    const code = generateCapabilityTemplate({
      name: "mcp_bridge",
      type: "bridge",
      description: "Bridge to external MCP servers",
    });

    expect(code).toContain('type: "bridge"');
    expect(code).toContain("Bridge to external MCP servers");
    expect(code).toContain("mcp_bridge_capability");
  });

  it("converts snake_case name to PascalCase label", () => {
    const code = generateCapabilityTemplate({ name: "order_management" });

    expect(code).toContain('label: "OrderManagement"');
  });
});

describe("scaffold_action", () => {
  it("generates a valid action template with defaults", () => {
    const code = generateActionTemplate({
      name: "create_order",
      entity: "orders",
    });

    expect(code).toContain('import type { ActionDefinition } from "@linchkit/core"');
    expect(code).toContain('name: "create_order"');
    expect(code).toContain('entity: "orders"');
    expect(code).toContain('label: "CreateOrder"');
    expect(code).toContain("policy:");
    expect(code).toContain('mode: "sync"');
    expect(code).toContain("async handler(ctx)");
    expect(code).toContain("create_order_action");
  });

  it("includes specified input fields with correct types", () => {
    const code = generateActionTemplate({
      name: "create_order",
      entity: "orders",
      inputFields: {
        customer_name: "string",
        quantity: "number",
        is_urgent: "boolean",
      },
    });

    expect(code).toContain('customer_name: { type: "string"');
    expect(code).toContain('quantity: { type: "number"');
    expect(code).toContain('is_urgent: { type: "boolean"');
  });

  it("falls back to string for unknown field types", () => {
    const code = generateActionTemplate({
      name: "test_action",
      entity: "test",
      inputFields: { weird_field: "unknown_type" },
    });

    expect(code).toContain('weird_field: { type: "string"');
  });

  it("includes custom description", () => {
    const code = generateActionTemplate({
      name: "approve_order",
      entity: "orders",
      description: "Approve a pending order",
    });

    expect(code).toContain("Approve a pending order");
  });
});

describe("scaffold_rule", () => {
  it("generates an action-triggered rule", () => {
    const code = generateRuleTemplate({
      name: "validate_order",
      triggerType: "action",
    });

    expect(code).toContain('import type { RuleDefinition } from "@linchkit/core"');
    expect(code).toContain('name: "validate_order"');
    expect(code).toContain('label: "ValidateOrder"');
    expect(code).toContain("action:");
    expect(code).toContain("condition:");
    expect(code).toContain("effect:");
    expect(code).toContain("validate_order_rule");
  });

  it("generates a stateChange-triggered rule", () => {
    const code = generateRuleTemplate({
      name: "on_publish",
      triggerType: "stateChange",
    });

    expect(code).toContain("stateChange:");
    expect(code).toContain("schema:");
    expect(code).toContain('from: "draft"');
    expect(code).toContain('to: "published"');
  });

  it("generates a schedule-triggered rule", () => {
    const code = generateRuleTemplate({
      name: "daily_cleanup",
      triggerType: "schedule",
    });

    expect(code).toContain("schedule:");
    expect(code).toContain("0 0 * * *");
  });

  it("includes custom description", () => {
    const code = generateRuleTemplate({
      name: "check_stock",
      triggerType: "action",
      description: "Check stock levels before order creation",
    });

    expect(code).toContain("Check stock levels before order creation");
  });

  it("includes priority field", () => {
    const code = generateRuleTemplate({
      name: "some_rule",
      triggerType: "action",
    });

    expect(code).toContain("priority: 10");
  });
});
