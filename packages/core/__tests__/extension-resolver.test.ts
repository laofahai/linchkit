/**
 * Tests for ExtensionResolver — bridge capability override resolution engine
 */

import { describe, expect, test } from "bun:test";
import { buildActionChain, createExtensionResolver } from "../src/capability/extension-resolver";
import type { ActionContext, ActionDefinition } from "../src/types/action";
import type { RuleDefinition } from "../src/types/rule";
import type { SchemaDefinition } from "../src/types/schema";

// ── Helpers ──────────────────────────────────────────────

function makeSchema(
  name: string,
  fields: Record<string, { type: string; label?: string; required?: boolean }>,
): SchemaDefinition {
  return {
    name,
    label: name,
    fields: fields as SchemaDefinition["fields"],
  };
}

function makeAction(
  name: string,
  handler?: (ctx: ActionContext) => Promise<unknown>,
): ActionDefinition {
  return {
    name,
    schema: "test",
    label: name,
    policy: { mode: "sync", transaction: false },
    handler,
  };
}

function makeRule(name: string): RuleDefinition {
  return {
    name,
    label: name,
    trigger: { action: "test_action" },
    condition: { field: "amount", operator: "gt", value: 100 },
    effect: { type: "block", message: "Amount too high" },
    priority: 10,
  };
}

/** Minimal ActionContext stub for testing handler chains */
function stubCtx(extra?: Record<string, unknown>): ActionContext {
  return {
    input: {},
    actor: { type: "human", id: "u1", groups: [] },
    ai: {} as ActionContext["ai"],
    config: {} as ActionContext["config"],
    executionId: "exec_test",
    timestamp: new Date(),
    get: async () => ({}),
    query: async () => [],
    create: async () => ({}),
    update: async () => ({}),
    delete: async () => {},
    execute: async () => undefined,
    emit: () => {},
    hasCapability: () => false,
    ...extra,
  } as ActionContext;
}

// ── Schema Extension Tests ────────────────────────────────

describe("ExtensionResolver — Schema Extensions", () => {
  test("adds new fields to a schema", () => {
    const resolver = createExtensionResolver();
    const schemas = [makeSchema("order", { total: { type: "number" } })];

    resolver.addSchemaExtension(
      "order",
      { fields: { notes: { type: "text", label: "Notes" } as any } },
      "cap-notes",
      10,
    );

    const resolved = resolver.resolveSchemas(schemas);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.fields.notes).toBeDefined();
    expect(resolved[0]!.fields.notes.type).toBe("text");
    // Original field still present
    expect(resolved[0]!.fields.total).toBeDefined();
  });

  test("multiple extensions add fields from different sources", () => {
    const resolver = createExtensionResolver();
    const schemas = [makeSchema("order", { total: { type: "number" } })];

    resolver.addSchemaExtension(
      "order",
      { fields: { priority: { type: "number" } as any } },
      "cap-priority",
      10,
    );
    resolver.addSchemaExtension(
      "order",
      { fields: { tags: { type: "json" } as any } },
      "cap-tags",
      20,
    );

    const resolved = resolver.resolveSchemas(schemas);
    expect(resolved[0]!.fields.priority).toBeDefined();
    expect(resolved[0]!.fields.tags).toBeDefined();
    expect(resolved[0]!.fields.total).toBeDefined();
  });

  test("ignores extensions targeting non-existent schemas", () => {
    const resolver = createExtensionResolver();
    const schemas = [makeSchema("order", { total: { type: "number" } })];

    resolver.addSchemaExtension(
      "nonexistent",
      { fields: { foo: { type: "string" } as any } },
      "cap-x",
      10,
    );

    const resolved = resolver.resolveSchemas(schemas);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("order");
  });

  test("records conflict when multiple sources add the same field", () => {
    const resolver = createExtensionResolver();
    const schemas = [makeSchema("order", {})];

    resolver.addSchemaExtension(
      "order",
      { fields: { notes: { type: "text" } as any } },
      "cap-a",
      10,
    );
    resolver.addSchemaExtension(
      "order",
      { fields: { notes: { type: "string" } as any } },
      "cap-b",
      20,
    );

    resolver.resolveSchemas(schemas);
    const conflicts = resolver.getConflicts();
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(conflicts.some((c) => c.type === "schema_field_collision" && c.field === "notes")).toBe(
      true,
    );
  });

  test("higher priority extension wins when fields collide", () => {
    const resolver = createExtensionResolver();
    const schemas = [makeSchema("order", {})];

    resolver.addSchemaExtension(
      "order",
      { fields: { notes: { type: "text", label: "From A" } as any } },
      "cap-a",
      10,
    );
    resolver.addSchemaExtension(
      "order",
      { fields: { notes: { type: "string", label: "From B" } as any } },
      "cap-b",
      20,
    );

    const resolved = resolver.resolveSchemas(schemas);
    // Higher priority (20) is applied after lower (10), so it wins
    expect(resolved[0]!.fields.notes.type).toBe("string");
    expect(resolved[0]!.fields.notes.label).toBe("From B");
  });
});

// ── Schema Override Tests ─────────────────────────────────

describe("ExtensionResolver — Schema Overrides", () => {
  test("overrides existing field constraints", () => {
    const resolver = createExtensionResolver();
    const schemas = [makeSchema("order", { total: { type: "number", required: false } })];

    resolver.addSchemaOverride(
      "order",
      { fields: { total: { required: true, min: 0 } } },
      "cap-validation",
      10,
    );

    const resolved = resolver.resolveSchemas(schemas);
    expect(resolved[0]!.fields.total.required).toBe(true);
    expect((resolved[0]!.fields.total as any).min).toBe(0);
    // Original type preserved
    expect(resolved[0]!.fields.total.type).toBe("number");
  });

  test("higher priority override wins", () => {
    const resolver = createExtensionResolver();
    const schemas = [makeSchema("order", { total: { type: "number", min: 0 } })];

    resolver.addSchemaOverride("order", { fields: { total: { min: 10 } } }, "cap-a", 10);
    resolver.addSchemaOverride("order", { fields: { total: { min: 50 } } }, "cap-b", 20);

    const resolved = resolver.resolveSchemas(schemas);
    expect((resolved[0]!.fields.total as any).min).toBe(50);
  });

  test("skips override for non-existent fields", () => {
    const resolver = createExtensionResolver();
    const schemas = [makeSchema("order", { total: { type: "number" } })];

    resolver.addSchemaOverride(
      "order",
      { fields: { nonexistent: { required: true } } },
      "cap-x",
      10,
    );

    const resolved = resolver.resolveSchemas(schemas);
    expect(resolved[0]!.fields.nonexistent).toBeUndefined();
  });

  test("extensions and overrides can be combined", () => {
    const resolver = createExtensionResolver();
    const schemas = [makeSchema("order", { total: { type: "number" } })];

    // First add a field via extension
    resolver.addSchemaExtension(
      "order",
      { fields: { notes: { type: "text", required: false } as any } },
      "cap-notes",
      10,
    );

    // Then override a constraint on an existing field
    resolver.addSchemaOverride(
      "order",
      { fields: { total: { required: true } } },
      "cap-validation",
      10,
    );

    const resolved = resolver.resolveSchemas(schemas);
    expect(resolved[0]!.fields.notes).toBeDefined();
    expect(resolved[0]!.fields.total.required).toBe(true);
  });
});

// ── Action Override Tests ─────────────────────────────────

describe("ExtensionResolver — Action Overrides", () => {
  test("before/after hooks wrap the original handler in priority order", async () => {
    const resolver = createExtensionResolver();
    const callOrder: string[] = [];

    const actions = [
      makeAction("submit_order", async () => {
        callOrder.push("original");
        return "original_result";
      }),
    ];

    // Priority 10 — inner layer
    resolver.addActionOverride(
      "submit_order",
      {
        before: async () => {
          callOrder.push("A.before");
        },
        after: async () => {
          callOrder.push("A.after");
        },
      },
      "cap-a",
      10,
    );

    // Priority 20 — outer layer
    resolver.addActionOverride(
      "submit_order",
      {
        before: async () => {
          callOrder.push("B.before");
        },
        after: async () => {
          callOrder.push("B.after");
        },
      },
      "cap-b",
      20,
    );

    const resolved = resolver.resolveActions(actions);
    const ctx = stubCtx();
    const result = await resolved[0]!.handler!(ctx);

    expect(callOrder).toEqual(["B.before", "A.before", "original", "A.after", "B.after"]);
    expect(result).toBe("original_result");
  });

  test("before-only hook runs before original", async () => {
    const resolver = createExtensionResolver();
    const callOrder: string[] = [];

    const actions = [
      makeAction("submit_order", async () => {
        callOrder.push("original");
        return "ok";
      }),
    ];

    resolver.addActionOverride(
      "submit_order",
      {
        before: async () => {
          callOrder.push("before");
        },
      },
      "cap-audit",
      10,
    );

    const resolved = resolver.resolveActions(actions);
    await resolved[0]!.handler!(stubCtx());

    expect(callOrder).toEqual(["before", "original"]);
  });

  test("after-only hook runs after original", async () => {
    const resolver = createExtensionResolver();
    const callOrder: string[] = [];

    const actions = [
      makeAction("submit_order", async () => {
        callOrder.push("original");
        return "ok";
      }),
    ];

    resolver.addActionOverride(
      "submit_order",
      {
        after: async () => {
          callOrder.push("after");
        },
      },
      "cap-notify",
      10,
    );

    const resolved = resolver.resolveActions(actions);
    await resolved[0]!.handler!(stubCtx());

    expect(callOrder).toEqual(["original", "after"]);
  });

  test("full replacement handler with callOriginal()", async () => {
    const resolver = createExtensionResolver();
    const callOrder: string[] = [];

    const actions = [
      makeAction("submit_order", async () => {
        callOrder.push("original");
        return "original_result";
      }),
    ];

    resolver.addActionOverride(
      "submit_order",
      {
        handler: async (ctx: any) => {
          callOrder.push("replacement_before");
          const result = await ctx.callOriginal();
          callOrder.push("replacement_after");
          return `wrapped_${result}`;
        },
      },
      "cap-wrapper",
      10,
    );

    const resolved = resolver.resolveActions(actions);
    const result = await resolved[0]!.handler!(stubCtx());

    expect(callOrder).toEqual(["replacement_before", "original", "replacement_after"]);
    expect(result).toBe("wrapped_original_result");
  });

  test("full replacement without callOriginal() skips original", async () => {
    const resolver = createExtensionResolver();
    const callOrder: string[] = [];

    const actions = [
      makeAction("submit_order", async () => {
        callOrder.push("original");
        return "original_result";
      }),
    ];

    resolver.addActionOverride(
      "submit_order",
      {
        handler: async () => {
          callOrder.push("replacement");
          return "replaced_result";
        },
      },
      "cap-replace",
      10,
    );

    const resolved = resolver.resolveActions(actions);
    const result = await resolved[0]!.handler!(stubCtx());

    expect(callOrder).toEqual(["replacement"]);
    expect(result).toBe("replaced_result");
  });

  test("throws error when multiple sources fully replace the same action", () => {
    const resolver = createExtensionResolver();
    const actions = [makeAction("submit_order", async () => "ok")];

    resolver.addActionOverride("submit_order", { handler: async () => "from_a" }, "cap-a", 10);
    resolver.addActionOverride("submit_order", { handler: async () => "from_b" }, "cap-b", 20);

    expect(() => resolver.resolveActions(actions)).toThrow(
      /Action "submit_order" has conflicting full handler replacements.*cap-a.*cap-b/,
    );
  });

  test("single full replacement works without error", () => {
    const resolver = createExtensionResolver();
    const actions = [makeAction("submit_order", async () => "original")];

    resolver.addActionOverride("submit_order", { handler: async () => "replaced" }, "cap-a", 10);

    const resolved = resolver.resolveActions(actions);
    expect(resolved).toHaveLength(1);
    // No error thrown, no conflicts recorded for single replacement
    expect(resolver.getConflicts()).toHaveLength(0);
  });

  test("policy overrides are merged", () => {
    const resolver = createExtensionResolver();
    const actions = [makeAction("submit_order")];

    resolver.addActionOverride("submit_order", { policy: { transaction: true } }, "cap-tx", 10);

    const resolved = resolver.resolveActions(actions);
    expect(resolved[0]!.policy.transaction).toBe(true);
    // Original mode preserved
    expect(resolved[0]!.policy.mode).toBe("sync");
  });

  test("ignores overrides targeting non-existent actions", () => {
    const resolver = createExtensionResolver();
    const actions = [makeAction("submit_order")];

    resolver.addActionOverride("nonexistent_action", { before: async () => {} }, "cap-x", 10);

    const resolved = resolver.resolveActions(actions);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.name).toBe("submit_order");
  });
});

// ── buildActionChain standalone tests ─────────────────────

describe("buildActionChain", () => {
  test("handles no overrides (returns original)", async () => {
    const handler = buildActionChain(async () => "original", []);
    const result = await handler(stubCtx());
    expect(result).toBe("original");
  });

  test("handles null original handler", async () => {
    const handler = buildActionChain(undefined, [
      { override: { before: async () => {} }, priority: 10 },
    ]);
    const result = await handler(stubCtx());
    expect(result).toBeUndefined();
  });

  test("three layers of before/after hooks", async () => {
    const callOrder: string[] = [];

    const handler = buildActionChain(async () => {
      callOrder.push("original");
      return "ok";
    }, [
      {
        override: {
          before: async () => {
            callOrder.push("C.before");
          },
          after: async () => {
            callOrder.push("C.after");
          },
        },
        priority: 30,
      },
      {
        override: {
          before: async () => {
            callOrder.push("A.before");
          },
          after: async () => {
            callOrder.push("A.after");
          },
        },
        priority: 10,
      },
      {
        override: {
          before: async () => {
            callOrder.push("B.before");
          },
          after: async () => {
            callOrder.push("B.after");
          },
        },
        priority: 20,
      },
    ]);

    await handler(stubCtx());
    expect(callOrder).toEqual([
      "C.before",
      "B.before",
      "A.before",
      "original",
      "A.after",
      "B.after",
      "C.after",
    ]);
  });

  test("mixed hooks and full replacement", async () => {
    const callOrder: string[] = [];

    const handler = buildActionChain(async () => {
      callOrder.push("original");
      return "orig";
    }, [
      // Inner: before/after hooks
      {
        override: {
          before: async () => {
            callOrder.push("A.before");
          },
          after: async () => {
            callOrder.push("A.after");
          },
        },
        priority: 10,
      },
      // Outer: full replacement that calls through
      {
        override: {
          handler: async (ctx: any) => {
            callOrder.push("B.enter");
            const r = await ctx.callOriginal();
            callOrder.push("B.exit");
            return r;
          },
        },
        priority: 20,
      },
    ]);

    await handler(stubCtx());
    expect(callOrder).toEqual(["B.enter", "A.before", "original", "A.after", "B.exit"]);
  });
});

// ── Rule Override Tests ───────────────────────────────────

describe("ExtensionResolver — Rule Overrides", () => {
  test("overrides rule condition", () => {
    const resolver = createExtensionResolver();
    const rules = [makeRule("max_amount_rule")];

    resolver.addRuleOverride(
      "max_amount_rule",
      { condition: { field: "amount", operator: "gt", value: 500 } },
      "cap-enterprise",
      10,
    );

    const resolved = resolver.resolveRules(rules);
    expect(resolved[0]!.condition).toEqual({ field: "amount", operator: "gt", value: 500 });
  });

  test("overrides rule effect", () => {
    const resolver = createExtensionResolver();
    const rules = [makeRule("max_amount_rule")];

    resolver.addRuleOverride(
      "max_amount_rule",
      { effect: { type: "warn", message: "Amount is high" } },
      "cap-lenient",
      10,
    );

    const resolved = resolver.resolveRules(rules);
    expect(resolved[0]!.effect.type).toBe("warn");
  });

  test("overrides rule trigger", () => {
    const resolver = createExtensionResolver();
    const rules = [makeRule("max_amount_rule")];

    resolver.addRuleOverride(
      "max_amount_rule",
      { trigger: { action: "create_order" } },
      "cap-scoping",
      10,
    );

    const resolved = resolver.resolveRules(rules);
    expect(resolved[0]!.trigger).toEqual({ action: "create_order" });
  });

  test("overrides rule priority", () => {
    const resolver = createExtensionResolver();
    const rules = [makeRule("max_amount_rule")];

    resolver.addRuleOverride("max_amount_rule", { priority: 99 }, "cap-priority-bump", 10);

    const resolved = resolver.resolveRules(rules);
    expect(resolved[0]!.priority).toBe(99);
  });

  test("higher priority override wins for rule fields", () => {
    const resolver = createExtensionResolver();
    const rules = [makeRule("max_amount_rule")];

    resolver.addRuleOverride(
      "max_amount_rule",
      { effect: { type: "warn", message: "From A" } },
      "cap-a",
      10,
    );
    resolver.addRuleOverride(
      "max_amount_rule",
      { effect: { type: "block", message: "From B" } },
      "cap-b",
      20,
    );

    const resolved = resolver.resolveRules(rules);
    // Priority 20 applied last, so it wins
    expect(resolved[0]!.effect.type).toBe("block");
    expect((resolved[0]!.effect as any).message).toBe("From B");
  });

  test("records conflict when multiple sources override the same rule", () => {
    const resolver = createExtensionResolver();
    const rules = [makeRule("max_amount_rule")];

    resolver.addRuleOverride("max_amount_rule", { priority: 20 }, "cap-a", 10);
    resolver.addRuleOverride("max_amount_rule", { priority: 30 }, "cap-b", 20);

    resolver.resolveRules(rules);
    const conflicts = resolver.getConflicts();
    expect(
      conflicts.some((c) => c.type === "rule_override" && c.target === "max_amount_rule"),
    ).toBe(true);
  });

  test("ignores overrides targeting non-existent rules", () => {
    const resolver = createExtensionResolver();
    const rules = [makeRule("max_amount_rule")];

    resolver.addRuleOverride("nonexistent_rule", { priority: 99 }, "cap-x", 10);

    const resolved = resolver.resolveRules(rules);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.priority).toBe(10);
  });
});

// ── Integration: resolver does not mutate originals ──────

describe("ExtensionResolver — Immutability", () => {
  test("does not mutate the original schema array", () => {
    const resolver = createExtensionResolver();
    const original = makeSchema("order", { total: { type: "number" } });
    const schemas = [original];

    resolver.addSchemaExtension(
      "order",
      { fields: { notes: { type: "text" } as any } },
      "cap-notes",
      10,
    );

    const resolved = resolver.resolveSchemas(schemas);
    // Original schema should not have the new field
    expect(original.fields.notes).toBeUndefined();
    // Resolved schema should have it
    expect(resolved[0]!.fields.notes).toBeDefined();
  });

  test("does not mutate the original action array", async () => {
    const resolver = createExtensionResolver();
    const callOrder: string[] = [];
    const originalHandler = async () => {
      callOrder.push("original");
      return "ok";
    };
    const original = makeAction("submit", originalHandler);
    const actions = [original];

    resolver.addActionOverride(
      "submit",
      {
        before: async () => {
          callOrder.push("before");
        },
      },
      "cap-audit",
      10,
    );

    const resolved = resolver.resolveActions(actions);
    // Original action's handler should not be modified
    expect(original.handler).toBe(originalHandler);
    // But resolved handler is different
    expect(resolved[0]!.handler).not.toBe(originalHandler);
  });
});
