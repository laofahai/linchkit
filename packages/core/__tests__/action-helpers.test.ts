import { describe, expect, it } from "bun:test";
import {
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
    entity: "order",
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

  // ── strict mode (type-aware Zod validation) ──────────────

  describe("strict mode", () => {
    it("strict=false (default): a wrong-typed value the old code accepted still passes", () => {
      const action = makeAction({
        input: {
          amount: { type: "number", required: true },
          note: { type: "string", required: false },
        },
      });
      // "not-a-number" is the exact bug the audit flagged — the lenient path
      // only checks presence, so this MUST still pass with strict off (no
      // regression for dev/test toy inputs).
      const lenient = validateInput(action, { amount: "not-a-number", note: 42 });
      expect(lenient.valid).toBe(true);

      // Explicit strict=false behaves identically to the default.
      const explicit = validateInput(action, { amount: "not-a-number" }, { strict: false });
      expect(explicit.valid).toBe(true);
    });

    it("strict=true: rejects a missing required field", () => {
      const action = makeAction({
        input: { amount: { type: "number", required: true } },
      });
      const result = validateInput(action, {}, { strict: true });
      expect(result.valid).toBe(false);
      // The lenient required-presence check fires first and short-circuits.
      expect(result.errors?.some((e) => e.field === "amount")).toBe(true);
    });

    it("strict=true: rejects a non-numeric string for a number field", () => {
      const action = makeAction({
        input: { amount: { type: "number", required: true } },
      });
      const result = validateInput(action, { amount: "not-a-number" }, { strict: true });
      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.field === "amount")).toBe(true);
    });

    it("strict=true: rejects a bad enum value", () => {
      const action = makeAction({
        input: {
          status: {
            type: "enum",
            required: true,
            options: [{ value: "draft" }, { value: "submitted" }],
          },
        },
      });
      const result = validateInput(action, { status: "shipped" }, { strict: true });
      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.field === "status")).toBe(true);
    });

    it("strict=true: rejects a wrong primitive type (string for boolean)", () => {
      const action = makeAction({
        input: { active: { type: "boolean", required: true } },
      });
      const result = validateInput(action, { active: "yes" }, { strict: true });
      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.field === "active")).toBe(true);
    });

    it("strict=true: ACCEPTS realistic production-shaped wire input", () => {
      // This is the key safety test: every value below is exactly what a real
      // HTTP/GraphQL client sends (numbers stay numbers, dates are ISO STRINGS,
      // json is an arbitrary object, enums are their value strings). Strict
      // validation must NEVER reject any of these.
      const action = makeAction({
        input: {
          amount: { type: "number", required: true },
          title: { type: "string", required: true },
          active: { type: "boolean", required: false },
          // date/datetime fields cross JSON as ISO strings, never Date objects.
          due_date: { type: "date", required: false },
          created_at: { type: "datetime", required: false },
          // json fields accept any shape (generator maps to z.unknown()).
          metadata: { type: "json", required: false },
          status: {
            type: "enum",
            required: false,
            options: [{ value: "draft" }, { value: "submitted" }],
          },
        },
      });
      const result = validateInput(
        action,
        {
          amount: 1299.99,
          title: "Quarterly purchase",
          active: true,
          due_date: "2026-06-30",
          created_at: "2026-06-03T12:34:56.000Z",
          metadata: { vendor: "acme", tags: ["a", "b"], nested: { ok: 1 } },
          status: "submitted",
        },
        { strict: true },
      );
      expect(result.valid).toBe(true);
    });

    it("strict=true: does NOT reject unknown extra keys, but STRIPS them from value", () => {
      // generateZodSchema uses z.object, which STRIPS unknown keys by default.
      // A client (or an upstream layer) sending extra fields must not be
      // rejected (lenient-equivalent), AND the sanitized `value` must omit the
      // undeclared key so it never reaches handlers / the write path.
      const action = makeAction({
        input: { amount: { type: "number", required: true } },
      });
      const result = validateInput(
        action,
        { amount: 100, surprise: "extra", _version: 3 },
        { strict: true },
      );
      expect(result.valid).toBe(true);
      // Allowlist: declared field kept, undeclared key removed.
      expect(result.value).toBeDefined();
      expect(result.value?.amount).toBe(100);
      expect(result.value && "surprise" in result.value).toBe(false);
      // System field retained (server-managed identifiers must survive so the
      // executor's update/lock logic that reads input.id still works).
      expect(result.value?._version).toBe(3);
    });

    it("strict=true: retains the system `id` field in the sanitized value", () => {
      // The executor reads input.id (action-engine.ts) for update / field-lock;
      // includeSystemFields must keep it in `value` even though it is not part of
      // the action's declared input fields.
      const action = makeAction({
        input: { amount: { type: "number", required: true } },
      });
      const result = validateInput(action, { id: "rec-1", amount: 5 }, { strict: true });
      expect(result.valid).toBe(true);
      expect(result.value?.id).toBe("rec-1");
    });

    it("strict=false: does NOT sanitize (value is unset, lenient path)", () => {
      const action = makeAction({
        input: { amount: { type: "number", required: true } },
      });
      const result = validateInput(action, { amount: 1, surprise: "kept" }, { strict: false });
      expect(result.valid).toBe(true);
      // Lenient path returns no sanitized value → executor uses original input.
      expect(result.value).toBeUndefined();
    });

    it("strict=true: leniency pin — optional fields accept null / absent", () => {
      // generateZodSchema marks non-required fields nullable().optional(), so a
      // null or omitted optional value must pass (matches the lenient path).
      const action = makeAction({
        input: {
          amount: { type: "number", required: true },
          note: { type: "string", required: false },
        },
      });
      expect(validateInput(action, { amount: 1, note: null }, { strict: true }).valid).toBe(true);
      expect(validateInput(action, { amount: 1 }, { strict: true }).valid).toBe(true);
    });

    it("strict=true: no-op when the action declares no input", () => {
      const action = makeAction({ input: undefined });
      expect(validateInput(action, { anything: "goes" }, { strict: true }).valid).toBe(true);
    });
  });
});

// ── runPreValidation ──────────────────────────────────────

describe("runPreValidation", () => {
  const baseCtx = {
    actor: defaultActor,
    input: { note: "hello", amount: 100 },
    record: {},
    entity: "order",
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
