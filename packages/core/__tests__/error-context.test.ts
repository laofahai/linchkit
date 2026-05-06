/**
 * Tests for AI-friendly ErrorContext (Spec 60 §3.4)
 *
 * Validates that LinchKitError and its subclasses carry structured context
 * for AI agents to understand and fix issues autonomously.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DataProvider } from "../src/engine/action-engine";
import { createActionExecutor } from "../src/engine/action-engine";
import { evaluateRules } from "../src/engine/rule-engine";
import { createStateMachine, transition } from "../src/engine/state-machine";
import {
  BusinessRuleError,
  ConflictError,
  isAiAgentCaller,
  LinchKitError,
  NotFoundError,
  shouldIncludeErrorContext,
  ValidationError,
} from "../src/errors";
import type { Actor } from "../src/types/action";
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

describe("ActionEngine error responses", () => {
  const mockDataProvider: DataProvider = {
    get: async (_schema: string, _id: string, _options?: Record<string, unknown>) => ({}),
    query: async (
      _schema: string,
      _filter: Record<string, unknown>,
      _options?: Record<string, unknown>,
    ) => [],
    create: async (_schema: string, _data: Record<string, unknown>) => ({}),
    update: async (
      _schema: string,
      _id: string,
      _data: Record<string, unknown>,
      _options?: Record<string, unknown>,
    ) => ({}),
    delete: async (_schema: string, _id: string, _options?: Record<string, unknown>) => {},
    count: async (
      _schema: string,
      _filter?: Record<string, unknown>,
      _options?: Record<string, unknown>,
    ) => 0,
  };

  it("should return error when action is not found", async () => {
    const executor = createActionExecutor({ dataProvider: mockDataProvider });
    const result = await executor.execute(
      "nonexistent_action",
      {},
      { type: "user", id: "u1", groups: [] },
    );

    expect(result.success).toBe(false);
    const data = result.data as Record<string, unknown>;
    expect(data.error).toContain("not found");
  });

  it("should return error for input validation failures", async () => {
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
    expect(data.error).toBe("Input validation failed");
  });

  it("should return error for state transition failures", async () => {
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
        get: async (_schema: string, _id: string, _options?: Record<string, unknown>) => ({
          id: "ord_1",
          status: "approved",
        }),
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
    expect(typeof data.error).toBe("string");
    expect(data.error as string).toContain("State transition not allowed");
    expect(data.error as string).toContain("approved");
  });
});

// ── StateMachine transition results ─────────────────────────

describe("StateMachine transition results", () => {
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

  it("should return reason for invalid current state", () => {
    const result = transition(sm, "nonexistent", "submit_order");

    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("Invalid current state");
    expect(result.reason).toContain("nonexistent");
  });

  it("should return reason for no matching transition", () => {
    const result = transition(sm, "approved", "submit_order");

    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("No transition");
    expect(result.reason).toContain("submit_order");
    expect(result.reason).toContain("approved");
  });

  it("should return from and action for denied transitions", () => {
    const result = transition(sm, "submitted", "submit_order");

    expect(result.allowed).toBe(false);
    expect(result.from).toBe("submitted");
    expect(result.action).toBe("submit_order");
    expect(result.reason).toBeDefined();
  });

  it("should return to state for successful transitions", () => {
    const result = transition(sm, "draft", "submit_order");

    expect(result.allowed).toBe(true);
    expect(result.from).toBe("draft");
    expect(result.to).toBe("submitted");
    expect(result.action).toBe("submit_order");
  });
});

// ── RuleEngine evaluation output ───────────────────────────

describe("RuleEngine evaluation output", () => {
  it("should report block details in results", async () => {
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
    expect(output.blockReasons.length).toBeGreaterThan(0);
    expect(output.blockReasons[0]).toBe("Amount exceeds budget limit");
    expect(output.results.length).toBe(1);
    expect(output.results[0].rule).toBe("budget_check");
    expect(output.results[0].triggered).toBe(true);
    expect(output.results[0].effect?.type).toBe("block");
  });

  it("should report warn details in results", async () => {
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
    expect(output.warnings.length).toBeGreaterThan(0);
    expect(output.warnings[0].message).toBe("Large order — review recommended");
    expect(output.results.length).toBe(1);
    expect(output.results[0].rule).toBe("large_order_warning");
    expect(output.results[0].triggered).toBe(true);
  });

  it("should have empty results when no rules triggered", async () => {
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
    expect(output.blocked).toBe(false);
    expect(output.blockReasons).toEqual([]);
    expect(output.results.length).toBe(1);
    expect(output.results[0].triggered).toBe(false);
  });
});

// ── ErrorContext extended fields (Spec 60 Phase 5) ─────────

describe("ErrorContext extended fields", () => {
  it("should accept relatedDocs", () => {
    const err = new LinchKitError({
      code: "rule.business.budget",
      message: "Budget exceeded",
      context: {
        entity: "purchase_request",
        action: "submit_request",
        suggestion: "Reduce amount or split into multiple requests",
        relatedDocs: ["docs/specs/60_observability.md", "docs/rules/budget.md"],
      },
    });

    expect(err.context?.relatedDocs).toEqual([
      "docs/specs/60_observability.md",
      "docs/rules/budget.md",
    ]);
  });

  it("should accept non-string expected and actual values", () => {
    const err = new LinchKitError({
      code: "validation.field.range",
      message: "Out of range",
      context: {
        field: "amount",
        constraint: "max",
        expected: 50000,
        actual: 75000,
      },
    });

    expect(err.context?.expected).toBe(50000);
    expect(err.context?.actual).toBe(75000);
  });

  it("should accept structured expected values (e.g. enum lists)", () => {
    const err = new LinchKitError({
      code: "validation.field.enum",
      message: "Invalid status",
      context: {
        field: "status",
        constraint: "enum",
        expected: ["draft", "submitted", "approved"],
        actual: "shipped",
      },
    });

    expect(err.context?.expected).toEqual(["draft", "submitted", "approved"]);
  });
});

// ── toResponse({ includeContext }) gating ──────────────────

describe("LinchKitError.toResponse includeContext option", () => {
  const buildErr = () =>
    new LinchKitError({
      code: "rule.business.budget",
      message: "Budget exceeded",
      context: {
        entity: "purchase_request",
        action: "submit_request",
        suggestion: "Reduce amount",
      },
    });

  it("includes context by default (legacy behavior)", () => {
    const res = buildErr().toResponse();
    expect(res.error.context).toBeDefined();
  });

  it("includes context when includeContext: true", () => {
    const res = buildErr().toResponse({ includeContext: true });
    expect(res.error.context).toBeDefined();
    expect(res.error.context?.entity).toBe("purchase_request");
  });

  it("omits context when includeContext: false", () => {
    const res = buildErr().toResponse({ includeContext: false });
    expect(res.error).not.toHaveProperty("context");
  });

  it("preserves subclass details when includeContext: false", () => {
    const err = new ValidationError({
      code: "user.validation.fields",
      message: "Validation failed",
      fields: [{ field: "email", message: "required" }],
      context: { entity: "user", field: "email", suggestion: "Provide email" },
    });
    const res = err.toResponse({ includeContext: false });
    expect(res.error).not.toHaveProperty("context");
    // Subclass payload (fields) survives the redaction
    expect(res.error.fields).toEqual([{ field: "email", message: "required" }]);
  });

  it("preserves NotFoundError resource details when includeContext: false", () => {
    const err = new NotFoundError({
      code: "record.not_found.order",
      message: "Order not found",
      resource: "order",
      resourceId: "ord_42",
      context: { entity: "order", suggestion: "Verify ID" },
    });
    const res = err.toResponse({ includeContext: false });
    expect(res.error).not.toHaveProperty("context");
    expect(res.error.details).toEqual({ resource: "order", resourceId: "ord_42" });
  });
});

// ── isAiAgentCaller helper ────────────────────────────────

describe("isAiAgentCaller", () => {
  const baseGroups: string[] = [];

  it("returns true for actor.type === 'ai'", () => {
    const actor: Actor = { type: "ai", id: "agent-1", groups: baseGroups };
    expect(isAiAgentCaller(actor)).toBe(true);
  });

  it("returns true when metadata.channel === 'mcp'", () => {
    const actor: Actor = {
      type: "human",
      id: "u1",
      groups: baseGroups,
      metadata: { channel: "mcp" },
    };
    expect(isAiAgentCaller(actor)).toBe(true);
  });

  it("returns true when metadata.channel === 'ai'", () => {
    const actor: Actor = {
      type: "system",
      id: "svc",
      groups: baseGroups,
      metadata: { channel: "ai" },
    };
    expect(isAiAgentCaller(actor)).toBe(true);
  });

  it("returns false for human actors with no AI metadata", () => {
    const actor: Actor = { type: "human", id: "u1", groups: baseGroups };
    expect(isAiAgentCaller(actor)).toBe(false);
  });

  it("returns false for system actors with no AI metadata", () => {
    const actor: Actor = { type: "system", id: "svc", groups: baseGroups };
    expect(isAiAgentCaller(actor)).toBe(false);
  });

  it("returns false for null/undefined actors", () => {
    expect(isAiAgentCaller(null)).toBe(false);
    expect(isAiAgentCaller(undefined)).toBe(false);
  });
});

// ── shouldIncludeErrorContext policy ──────────────────────

describe("shouldIncludeErrorContext", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it("returns true in non-production for any actor", () => {
    process.env.NODE_ENV = "development";
    expect(shouldIncludeErrorContext({ type: "human", id: "u1", groups: [] })).toBe(true);
    expect(shouldIncludeErrorContext(null)).toBe(true);
  });

  it("returns true in production only for AI/agent callers", () => {
    process.env.NODE_ENV = "production";
    expect(shouldIncludeErrorContext({ type: "ai", id: "agent", groups: [] })).toBe(true);
    expect(
      shouldIncludeErrorContext({
        type: "human",
        id: "u1",
        groups: [],
        metadata: { channel: "mcp" },
      }),
    ).toBe(true);
    expect(shouldIncludeErrorContext({ type: "human", id: "u1", groups: [] })).toBe(false);
    expect(shouldIncludeErrorContext(null)).toBe(false);
  });

  it("returns true in test env (NODE_ENV !== production)", () => {
    process.env.NODE_ENV = "test";
    expect(shouldIncludeErrorContext(null)).toBe(true);
  });
});

// ── Integration: ConflictError context survives toResponse ─

describe("ConflictError context plumbing", () => {
  it("passes structured context for state-conflict errors", () => {
    const err = new ConflictError({
      code: "order.conflict.state",
      message: "Cannot ship a draft order",
      currentState: "draft",
      expectedState: "approved",
      context: {
        entity: "order",
        action: "ship_order",
        field: "status",
        constraint: "state_transition",
        expected: "approved",
        actual: "draft",
        suggestion: "Approve the order before shipping",
      },
    });

    const res = err.toResponse({ includeContext: true });
    expect(res.error.context).toBeDefined();
    expect(res.error.context?.constraint).toBe("state_transition");
    expect(res.error.currentState).toBe("draft");
  });
});

// ── Integration: BusinessRuleError context plumbing ────────

describe("BusinessRuleError context plumbing", () => {
  it("populates context with rule constraint and expected/actual", () => {
    const err = new BusinessRuleError({
      code: "purchase.rule.budget",
      message: "Amount exceeds budget",
      rules: [{ rule: "budget_check", effect: "block", message: "Over $50,000" }],
      context: {
        entity: "purchase_request",
        action: "submit_request",
        constraint: "budget_check",
        expected: 50000,
        actual: 75000,
        suggestion: "Reduce the amount or split the request",
        relatedDocs: ["docs/rules/budget.md"],
      },
    });

    const res = err.toResponse({ includeContext: true });
    expect(res.error.context?.constraint).toBe("budget_check");
    expect(res.error.context?.expected).toBe(50000);
    expect(res.error.context?.relatedDocs).toEqual(["docs/rules/budget.md"]);
  });
});
