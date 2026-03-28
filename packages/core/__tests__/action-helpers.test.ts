import { describe, expect, it } from "bun:test";
import {
  checkPermissions,
  generateExecutionId,
  isExposed,
  resolveFieldExpression,
  runPreValidation,
  validateInput,
} from "../src/engine/action-helpers";
import type { ActionDefinition, Actor } from "../src/types/action";

// ── Fixtures ─────────────────────────────────────────────

const defaultActor: Actor = {
  type: "human",
  id: "user-1",
  name: "Alice",
  groups: ["employee", "manager"],
};

function makeAction(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    name: "test_action",
    schema: "order",
    label: "Test Action",
    policy: { execution: "immediate" },
    ...overrides,
  } as ActionDefinition;
}

// ── resolveFieldExpression ────────────────────────────────

describe("resolveFieldExpression", () => {
  it("returns plain values unchanged", () => {
    expect(resolveFieldExpression("hello", {}, defaultActor)).toBe("hello");
    expect(resolveFieldExpression(42, {}, defaultActor)).toBe(42);
    expect(resolveFieldExpression(null, {}, defaultActor)).toBeNull();
    expect(resolveFieldExpression(false, {}, defaultActor)).toBe(false);
  });

  it("resolves $now to ISO timestamp", () => {
    const result = resolveFieldExpression("$now", {}, defaultActor);
    expect(typeof result).toBe("string");
    expect(() => new Date(result as string)).not.toThrow();
  });

  it("resolves $now.date to YYYY-MM-DD format", () => {
    const result = resolveFieldExpression("$now.date", {}, defaultActor) as string;
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("resolves $actor.id", () => {
    expect(resolveFieldExpression("$actor.id", {}, defaultActor)).toBe("user-1");
  });

  it("resolves $actor.name", () => {
    expect(resolveFieldExpression("$actor.name", {}, defaultActor)).toBe("Alice");
  });

  it("resolves $actor.type", () => {
    expect(resolveFieldExpression("$actor.type", {}, defaultActor)).toBe("human");
  });

  it("resolves $input.<field>", () => {
    const input = { amount: 99.99, note: "test" };
    expect(resolveFieldExpression("$input.amount", input, defaultActor)).toBe(99.99);
    expect(resolveFieldExpression("$input.note", input, defaultActor)).toBe("test");
  });

  it("returns unknown $expressions as-is", () => {
    expect(resolveFieldExpression("$unknown.thing", {}, defaultActor)).toBe("$unknown.thing");
  });
});

// ── generateExecutionId ───────────────────────────────────

describe("generateExecutionId", () => {
  it("generates a string starting with exec_", () => {
    const id = generateExecutionId();
    expect(id).toMatch(/^exec_/);
  });

  it("generates unique IDs on each call", () => {
    const id1 = generateExecutionId();
    const id2 = generateExecutionId();
    expect(id1).not.toBe(id2);
  });
});

// ── isExposed ─────────────────────────────────────────────

describe("isExposed", () => {
  it("returns true when exposure is undefined", () => {
    expect(isExposed(undefined, "http")).toBe(true);
    expect(isExposed(undefined, "mcp")).toBe(true);
  });

  it("returns true when exposure is 'all'", () => {
    expect(isExposed("all", "http")).toBe(true);
    expect(isExposed("all", "cli")).toBe(true);
  });

  it("returns false when channel is explicitly false", () => {
    expect(isExposed({ http: false }, "http")).toBe(false);
    expect(isExposed({ mcp: false }, "mcp")).toBe(false);
  });

  it("returns true when channel is not explicitly set in exposure object", () => {
    expect(isExposed({ http: true }, "mcp")).toBe(true);
    expect(isExposed({ cli: false }, "http")).toBe(true);
  });

  it("returns true when channel is explicitly true", () => {
    expect(isExposed({ ui: true }, "ui")).toBe(true);
  });

  it("handles all channels", () => {
    const channels = ["http", "mcp", "cli", "ui", "internal"] as const;
    for (const ch of channels) {
      expect(isExposed("all", ch)).toBe(true);
    }
  });
});

// ── checkPermissions ──────────────────────────────────────

describe("checkPermissions", () => {
  it("returns null when no permissions defined", () => {
    const action = makeAction({ permissions: undefined });
    expect(checkPermissions(action, defaultActor)).toBeNull();
  });

  it("returns null when actor type is in allowedTypes", () => {
    const action = makeAction({
      permissions: { actorTypes: ["human", "ai"] },
    });
    expect(checkPermissions(action, defaultActor)).toBeNull();
  });

  it("returns error message when actor type is not allowed", () => {
    const action = makeAction({
      permissions: { actorTypes: ["ai"] },
    });
    const result = checkPermissions(action, defaultActor);
    expect(result).toContain("human");
  });

  it("returns null when actor belongs to required group", () => {
    const action = makeAction({
      permissions: { groups: ["manager"] },
    });
    expect(checkPermissions(action, defaultActor)).toBeNull();
  });

  it("returns error message when actor lacks required group", () => {
    const action = makeAction({
      permissions: { groups: ["admin"] },
    });
    const result = checkPermissions(action, defaultActor);
    expect(result).toContain("admin");
  });

  it("returns null when actor is in at least one required group", () => {
    const action = makeAction({
      permissions: { groups: ["admin", "employee"] },
    });
    expect(checkPermissions(action, defaultActor)).toBeNull();
  });

  it("returns null for empty actorTypes list (no restriction)", () => {
    const action = makeAction({
      permissions: { actorTypes: [] },
    });
    expect(checkPermissions(action, defaultActor)).toBeNull();
  });
});

// ── validateInput ─────────────────────────────────────────

describe("validateInput", () => {
  it("returns valid when no input definition", () => {
    const action = makeAction({ input: undefined });
    const result = validateInput(action, {});
    expect(result.valid).toBe(true);
  });

  it("returns valid when all required fields are present", () => {
    const action = makeAction({
      input: {
        amount: { type: "number", required: true },
        note: { type: "string", required: false },
      },
    });
    const result = validateInput(action, { amount: 100 });
    expect(result.valid).toBe(true);
  });

  it("returns invalid when required field is missing", () => {
    const action = makeAction({
      input: {
        amount: { type: "number", required: true },
      },
    });
    const result = validateInput(action, {});
    expect(result.valid).toBe(false);
    expect(result.errors?.some((e) => e.field === "amount")).toBe(true);
  });

  it("returns invalid when required field is null", () => {
    const action = makeAction({
      input: { amount: { type: "number", required: true } },
    });
    const result = validateInput(action, { amount: null });
    expect(result.valid).toBe(false);
  });
});

// ── runPreValidation ──────────────────────────────────────

describe("runPreValidation", () => {
  const baseCtx = {
    actor: defaultActor,
    input: { note: "hello", amount: 100 },
    record: {},
    schema: "order",
    action: "test_action",
    tenantId: "t1",
    executionId: "exec_1",
  } as never;

  it("returns valid when no validate defined", () => {
    const action = makeAction({ validate: undefined });
    expect(runPreValidation(action, baseCtx).valid).toBe(true);
  });

  it("validates required fields from validate.required", () => {
    const action = makeAction({
      validate: { required: ["note", "amount"] },
    });
    expect(runPreValidation(action, baseCtx).valid).toBe(true);
  });

  it("fails when validate.required field is missing", () => {
    const action = makeAction({
      validate: { required: ["missing_field"] },
    });
    const result = runPreValidation(action, baseCtx);
    expect(result.valid).toBe(false);
    expect(result.errors?.some((e) => e.field === "missing_field")).toBe(true);
  });

  it("fails when validate.required field is empty string", () => {
    const action = makeAction({
      validate: { required: ["note"] },
    });
    const ctx = { ...baseCtx, input: { note: "" } } as never;
    const result = runPreValidation(action, ctx);
    expect(result.valid).toBe(false);
  });

  it("runs custom validation function", () => {
    const action = makeAction({
      validate: {
        custom: (ctx) => {
          const amount = (ctx.input as Record<string, unknown>).amount as number;
          if (amount < 0) {
            return { valid: false, errors: [{ field: "amount", message: "must be positive" }] };
          }
          return { valid: true };
        },
      },
    });
    const goodCtx = { ...baseCtx, input: { amount: 10 } } as never;
    const badCtx = { ...baseCtx, input: { amount: -5 } } as never;
    expect(runPreValidation(action, goodCtx).valid).toBe(true);
    expect(runPreValidation(action, badCtx).valid).toBe(false);
  });

  it("catches exceptions from custom validator and returns error", () => {
    const action = makeAction({
      validate: {
        custom: () => {
          throw new Error("validator exploded");
        },
      },
    });
    const result = runPreValidation(action, baseCtx);
    expect(result.valid).toBe(false);
    expect(result.errors?.some((e) => e.message.includes("exploded"))).toBe(true);
  });
});
