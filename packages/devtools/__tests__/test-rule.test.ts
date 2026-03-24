import { describe, expect, it } from "bun:test";
import { defineRule } from "@linchkit/core";
import { testRule } from "../src/test-rule";

describe("testRule", () => {
  const amountCheck = defineRule({
    name: "amount_check",
    label: "Large purchase requires approval",
    trigger: { action: "submit_request" },
    condition: {
      field: "target.amount",
      operator: "gt",
      value: 10000,
    },
    effect: {
      type: "require_approval",
      level: "director",
      message: "Amount exceeds 10000, director approval required",
    },
  });

  it("should trigger when condition is met", async () => {
    const result = await testRule(amountCheck, {
      target: { amount: 15000 },
    });
    expect(result.triggered).toBe(true);
    expect(result.effect?.type).toBe("require_approval");
  });

  it("should not trigger when condition is not met", async () => {
    const result = await testRule(amountCheck, {
      target: { amount: 5000 },
    });
    expect(result.triggered).toBe(false);
    expect(result.effect).toBeNull();
  });

  it("should include rule name and duration", async () => {
    const result = await testRule(amountCheck, {
      target: { amount: 15000 },
    });
    expect(result.rule).toBe("amount_check");
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});

describe("testRule - composite conditions", () => {
  const combinedCheck = defineRule({
    name: "combined_check",
    label: "Sales dept large amount needs director",
    trigger: { action: "submit_request" },
    condition: {
      operator: "and",
      conditions: [
        { field: "target.amount", operator: "gt", value: 10000 },
        { field: "target.department", operator: "eq", value: "sales" },
      ],
    },
    effect: { type: "block", message: "Not allowed" },
  });

  it("should trigger when all AND conditions are met", async () => {
    const result = await testRule(combinedCheck, {
      target: { amount: 20000, department: "sales" },
    });
    expect(result.triggered).toBe(true);
  });

  it("should not trigger when one AND condition fails", async () => {
    const result = await testRule(combinedCheck, {
      target: { amount: 20000, department: "engineering" },
    });
    expect(result.triggered).toBe(false);
  });
});

describe("testRule - OR conditions", () => {
  const orCheck = defineRule({
    name: "or_check",
    label: "Block if high amount or restricted dept",
    trigger: { action: "submit_request" },
    condition: {
      operator: "or",
      conditions: [
        { field: "target.amount", operator: "gt", value: 50000 },
        { field: "target.department", operator: "eq", value: "restricted" },
      ],
    },
    effect: { type: "block", message: "Blocked" },
  });

  it("should trigger when any OR condition is met", async () => {
    const result = await testRule(orCheck, {
      target: { amount: 1000, department: "restricted" },
    });
    expect(result.triggered).toBe(true);
  });

  it("should not trigger when no OR condition is met", async () => {
    const result = await testRule(orCheck, {
      target: { amount: 1000, department: "normal" },
    });
    expect(result.triggered).toBe(false);
  });
});

describe("testRule - code-based condition", () => {
  const codeRule = defineRule({
    name: "code_rule",
    label: "Complex logic",
    trigger: { action: "submit_request" },
    condition: ({ target }) => (target.amount as number) > 50000,
    effect: { type: "block", message: "Over budget" },
  });

  it("should evaluate code condition", async () => {
    const result = await testRule(codeRule, {
      target: { amount: 60000 },
    });
    expect(result.triggered).toBe(true);
  });

  it("should not trigger when code condition returns false", async () => {
    const result = await testRule(codeRule, {
      target: { amount: 10000 },
    });
    expect(result.triggered).toBe(false);
  });
});

describe("testRule - operators", () => {
  it("should support 'in' operator", async () => {
    const rule = defineRule({
      name: "in_check",
      label: "Status check",
      trigger: { action: "test" },
      condition: { field: "target.status", operator: "in", value: ["draft", "submitted"] },
      effect: { type: "warn", message: "Warn" },
    });

    expect((await testRule(rule, { target: { status: "draft" } })).triggered).toBe(true);
    expect((await testRule(rule, { target: { status: "approved" } })).triggered).toBe(false);
  });

  it("should support 'is_null' operator", async () => {
    const rule = defineRule({
      name: "null_check",
      label: "Null check",
      trigger: { action: "test" },
      condition: { field: "target.notes", operator: "is_null" },
      effect: { type: "warn", message: "Missing notes" },
    });

    expect((await testRule(rule, { target: {} })).triggered).toBe(true);
    expect((await testRule(rule, { target: { notes: "hello" } })).triggered).toBe(false);
  });

  it("should support 'contains' operator", async () => {
    const rule = defineRule({
      name: "contains_check",
      label: "Contains check",
      trigger: { action: "test" },
      condition: { field: "target.tags", operator: "contains", value: "urgent" },
      effect: { type: "warn", message: "Urgent" },
    });

    expect((await testRule(rule, { target: { tags: ["urgent", "normal"] } })).triggered).toBe(true);
    expect((await testRule(rule, { target: { tags: ["normal"] } })).triggered).toBe(false);
  });
});
