/**
 * Tests for AI-friendly ErrorContext (Spec 60 §3.4)
 *
 * Validates that errors from key engines include structured context
 * for AI agents to understand and fix issues autonomously.
 */

import { describe, expect, it } from "bun:test";
import type { DataProvider } from "../src/engine/action-engine";
import { createActionExecutor } from "../src/engine/action-engine";
import { evaluateRules } from "../src/engine/rule-engine";
import { createStateMachine, transition } from "../src/engine/state-machine";
import {
  BusinessRuleError,
  ConflictError,
  LinchKitError,
  NotFoundError,
  ValidationError,
} from "../src/errors";
import type { ErrorContext } from "../src/types/error";
import type { RuleDefinition } from "../src/types/rule";

// ── ErrorContext on LinchKitError ──────────────────────────

describe("ErrorContext on LinchKitError", () => {
  it("should accept context in constructor options", () => {
    const ctx: ErrorContext = {
      entity: "purchase_request",
      action: "submit_request",
      field: "amount",
      constraint: "budget_check",
      expected: "amount <= 50000",
      actual: "amount = 75000",
      suggestion: "Reduce amount to 50000 or less",
    };
    const err = new LinchKitError({
      code: "rule.business.budget",
      message: "Budget exceeded",
      context: ctx,
    });

    expect(err.context).toEqual(ctx);
  });

  it("should include context in toResponse()", () => {
    const err = new LinchKitError({
      code: "app.general.fail",
      message: "Failure",
      context: { entity: "order", suggestion: "Check order status" },
    });
    const res = err.toResponse();

    expect(res.error.context).toEqual({
      entity: "order",
      suggestion: "Check order status",
    });
  });

  it("should omit context from toResponse() when not provided", () => {
    const err = new LinchKitError({
      code: "app.general.fail",
      message: "Failure",
    });
    const res = err.toResponse();

    expect(res.error).not.toHaveProperty("context");
  });

  it("should carry context on ValidationError", () => {
    const err = new ValidationError({
      code: "order.validation.invalid",
      message: "Invalid input",
      fields: [{ field: "amount", message: "Must be positive" }],
      context: {
        entity: "order",
        field: "amount",
        constraint: "input_validation",
        expected: "Positive number",
        actual: "-5",
      },
    });

    expect(err.context?.entity).toBe("order");
    expect(err.context?.field).toBe("amount");
  });

  it("should carry context on BusinessRuleError", () => {
    const err = new BusinessRuleError({
      code: "order.rule.limit",
      message: "Rule violated",
      context: {
        action: "submit_order",
        constraint: "max_amount",
        suggestion: "Reduce order amount",
      },
    });

    expect(err.context?.action).toBe("submit_order");
    expect(err.context?.constraint).toBe("max_amount");
  });

  it("should carry context on ConflictError", () => {
    const err = new ConflictError({
      code: "order.conflict.state",
      message: "State conflict",
      currentState: "approved",
      context: {
        entity: "order",
        field: "status",
        expected: "draft",
        actual: "approved",
      },
    });

    expect(err.context?.expected).toBe("draft");
    expect(err.context?.actual).toBe("approved");
  });

  it("should carry context on NotFoundError", () => {
    const err = new NotFoundError({
      code: "record.not_found.order",
      message: "Order not found",
      resource: "order",
      context: {
        entity: "order",
        suggestion: "Verify the record ID exists before calling this action",
      },
    });

    expect(err.context?.entity).toBe("order");
    expect(err.context?.suggestion).toContain("Verify");
  });
});

// ── ActionEngine error context ─────────────────────────────

describe("ActionEngine error context", () => {
  const mockDataProvider: DataProvider = {
    get: async () => ({}),
    query: async () => [],
    create: async () => ({}),
    update: async () => ({}),
    delete: async () => {},
    count: async () => 0,
  };

  it("should include context when action is not found", async () => {
    const executor = createActionExecutor({ dataProvider: mockDataProvider });
    const result = await executor.execute(
      "nonexistent_action",
      {},
      { type: "user", id: "u1", groups: [] },
    );

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.error).toContain("not found");
    const ctx = data.context as ErrorContext;
    expect(ctx).toBeDefined();
    expect(ctx.action).toBe("nonexistent_action");
    expect(ctx.suggestion).toContain("defineAction");
  });

  it("should include context for input validation failures", async () => {
    const executor = createActionExecutor({ dataProvider: mockDataProvider });
    executor.registry.register({
      name: "create_order",
      entity: "order",
      label: "Create Order",
      input: {
        amount: { type: "number", required: true },
      },
      policy: { type: "sync" },
      handler: async () => ({}),
    });

    const result = await executor.execute(
      "create_order",
      {},
      { type: "user", id: "u1", groups: [] },
      { channel: "internal" },
    );

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    const ctx = data.context as ErrorContext;
    expect(ctx).toBeDefined();
    expect(ctx.action).toBe("create_order");
    expect(ctx.entity).toBe("order");
    expect(ctx.constraint).toBe("input_validation");
    expect(ctx.field).toBe("amount");
  });

  it("should include context for state transition failures", async () => {
    const sm = createStateMachine({
      name: "order_lifecycle",
      entity: "order",
      field: "status",
      initial: "draft",
      states: ["draft", "submitted", "approved"],
      transitions: [
        { from: "draft", to: "submitted", action: "submit_order" },
        { from: "submitted", to: "approved", action: "approve_order" },
      ],
    });

    const executor = createActionExecutor({
      dataProvider: {
        ...mockDataProvider,
        get: async () => ({ id: "ord_1", status: "approved" }),
      },
      stateMachine: sm,
    });

    executor.registry.register({
      name: "submit_order",
      entity: "order",
      label: "Submit Order",
      stateTransition: { from: "draft", to: "submitted" },
      policy: { type: "sync" },
      handler: async () => ({}),
    });

    const result = await executor.execute(
      "submit_order",
      { id: "ord_1" },
      { type: "user", id: "u1", groups: [] },
      { channel: "internal" },
    );

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    const ctx = data.context as ErrorContext;
    expect(ctx).toBeDefined();
    expect(ctx.entity).toBe("order");
    expect(ctx.action).toBe("submit_order");
    expect(ctx.field).toBe("status");
    expect(ctx.constraint).toBe("state_transition");
    expect(ctx.actual).toContain("approved");
    expect(ctx.expected).toContain("draft");
  });
});

// ── StateMachine error context ─────────────────────────────

describe("StateMachine transition context", () => {
  const sm = createStateMachine({
    name: "order_lifecycle",
    entity: "order",
    field: "status",
    initial: "draft",
    states: ["draft", "submitted", "approved", "rejected"],
    transitions: [
      { from: "draft", to: "submitted", action: "submit_order" },
      { from: "submitted", to: "approved", action: "approve_order" },
      { from: "submitted", to: "rejected", action: "reject_order" },
    ],
  });

  it("should include context for invalid current state", () => {
    const result = transition(sm, "nonexistent", "submit_order");

    expect(result.allowed).toBe(false);
    expect(result.context).toBeDefined();
    expect(result.context?.entity).toBe("order");
    expect(result.context?.field).toBe("status");
    expect(result.context?.constraint).toBe("state_machine");
    expect(result.context?.actual).toBe("nonexistent");
    expect(result.context?.expected).toContain("draft");
    expect(result.context?.suggestion).toContain("not defined");
  });

  it("should include context for no matching transition", () => {
    const result = transition(sm, "approved", "submit_order");

    expect(result.allowed).toBe(false);
    expect(result.context).toBeDefined();
    expect(result.context?.entity).toBe("order");
    expect(result.context?.action).toBe("submit_order");
    expect(result.context?.constraint).toBe("state_transition");
    expect(result.context?.suggestion).toContain("No actions available");
  });

  it("should suggest available actions when transition is denied", () => {
    const result = transition(sm, "submitted", "submit_order");

    expect(result.allowed).toBe(false);
    expect(result.context).toBeDefined();
    expect(result.context?.suggestion).toContain("approve_order");
    expect(result.context?.suggestion).toContain("reject_order");
  });

  it("should not include context for successful transitions", () => {
    const result = transition(sm, "draft", "submit_order");

    expect(result.allowed).toBe(true);
    expect(result.context).toBeUndefined();
  });
});

// ── RuleEngine error context ───────────────────────────────

describe("RuleEngine evaluation context", () => {
  it("should include contexts for block effects", async () => {
    const rules: RuleDefinition[] = [
      {
        name: "budget_check",
        trigger: { action: "submit_request" },
        condition: { field: "target.amount", operator: "gt", value: 50000 },
        effect: { type: "block", reason: "Amount exceeds budget limit" },
      },
    ];

    const output = await evaluateRules(rules, {
      target: { amount: 75000 },
      actor: { type: "user", id: "u1", groups: [] },
    });

    expect(output.blocked).toBe(true);
    expect(output.contexts.length).toBeGreaterThan(0);
    expect(output.contexts[0].constraint).toBe("budget_check");
    expect(output.contexts[0].suggestion).toContain("budget_check");
    expect(output.contexts[0].suggestion).toContain("blocked");
  });

  it("should include contexts for warn effects", async () => {
    const rules: RuleDefinition[] = [
      {
        name: "large_order_warning",
        trigger: { action: "create_order" },
        condition: { field: "target.quantity", operator: "gt", value: 100 },
        effect: { type: "warn", message: "Large order — review recommended" },
      },
    ];

    const output = await evaluateRules(rules, {
      target: { quantity: 200 },
      actor: { type: "user", id: "u1", groups: [] },
    });

    expect(output.triggered).toBe(true);
    expect(output.contexts.length).toBeGreaterThan(0);
    expect(output.contexts[0].constraint).toBe("large_order_warning");
    expect(output.contexts[0].suggestion).toContain("Warning");
  });

  it("should have empty contexts when no rules triggered", async () => {
    const rules: RuleDefinition[] = [
      {
        name: "budget_check",
        trigger: { action: "submit_request" },
        condition: { field: "target.amount", operator: "gt", value: 50000 },
        effect: { type: "block", reason: "Over budget" },
      },
    ];

    const output = await evaluateRules(rules, {
      target: { amount: 100 },
      actor: { type: "user", id: "u1", groups: [] },
    });

    expect(output.triggered).toBe(false);
    expect(output.contexts).toEqual([]);
  });
});
