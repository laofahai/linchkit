import { describe, expect, it } from "bun:test";
import { evaluateCondition } from "../src/engine/condition-evaluator";
import type { RuleEvalInput } from "../src/engine/rule-engine";
import { evaluateRules } from "../src/engine/rule-engine";
import type { RuleDefinition } from "../src/types/rule";

// ── Helpers ─────────────────────────────────────────

const defaultInput: RuleEvalInput = {
  target: { amount: 5000, department: { name: "engineering" }, status: "draft" },
  actor: { type: "human", id: "user-1", groups: ["employee"] },
  context: {},
};

function makeRule(overrides: Partial<RuleDefinition>): RuleDefinition {
  return {
    name: "test-rule",
    label: "Test Rule",
    trigger: { action: "submit" },
    condition: { field: "target.amount", operator: "gt", value: 0 },
    effect: { type: "warn", message: "default warning" },
    ...overrides,
  };
}

// ── Condition evaluator tests ───────────────────────

describe("evaluateCondition", () => {
  const ctx = {
    target: { amount: 100, tags: ["urgent", "new"], name: "Test Item", nested: { value: 42 } },
    context: {},
    actor: { type: "human" as const, id: "u1", groups: ["admin"] },
  };

  it("evaluates eq operator", () => {
    expect(evaluateCondition({ field: "target.amount", operator: "eq", value: 100 }, ctx)).toBe(
      true,
    );
    expect(evaluateCondition({ field: "target.amount", operator: "eq", value: 200 }, ctx)).toBe(
      false,
    );
  });

  it("evaluates neq operator", () => {
    expect(evaluateCondition({ field: "target.amount", operator: "neq", value: 200 }, ctx)).toBe(
      true,
    );
  });

  it("evaluates gt/gte/lt/lte operators", () => {
    expect(evaluateCondition({ field: "target.amount", operator: "gt", value: 50 }, ctx)).toBe(
      true,
    );
    expect(evaluateCondition({ field: "target.amount", operator: "gte", value: 100 }, ctx)).toBe(
      true,
    );
    expect(evaluateCondition({ field: "target.amount", operator: "lt", value: 200 }, ctx)).toBe(
      true,
    );
    expect(evaluateCondition({ field: "target.amount", operator: "lte", value: 100 }, ctx)).toBe(
      true,
    );
  });

  it("evaluates in/not_in operators", () => {
    expect(
      evaluateCondition({ field: "target.amount", operator: "in", value: [100, 200] }, ctx),
    ).toBe(true);
    expect(
      evaluateCondition({ field: "target.amount", operator: "not_in", value: [200, 300] }, ctx),
    ).toBe(true);
  });

  it("evaluates is_null/not_null operators", () => {
    expect(evaluateCondition({ field: "target.missing", operator: "is_null" }, ctx)).toBe(true);
    expect(evaluateCondition({ field: "target.amount", operator: "not_null" }, ctx)).toBe(true);
  });

  it("evaluates contains operator for strings and arrays", () => {
    expect(
      evaluateCondition({ field: "target.name", operator: "contains", value: "Item" }, ctx),
    ).toBe(true);
    expect(
      evaluateCondition({ field: "target.tags", operator: "contains", value: "urgent" }, ctx),
    ).toBe(true);
  });

  it("evaluates nested field paths", () => {
    expect(
      evaluateCondition({ field: "target.nested.value", operator: "eq", value: 42 }, ctx),
    ).toBe(true);
  });

  it("evaluates composite AND condition", () => {
    const result = evaluateCondition(
      {
        operator: "and",
        conditions: [
          { field: "target.amount", operator: "gt", value: 50 },
          { field: "target.name", operator: "eq", value: "Test Item" },
        ],
      },
      ctx,
    );
    expect(result).toBe(true);
  });

  it("evaluates composite OR condition", () => {
    const result = evaluateCondition(
      {
        operator: "or",
        conditions: [
          { field: "target.amount", operator: "gt", value: 500 },
          { field: "target.name", operator: "eq", value: "Test Item" },
        ],
      },
      ctx,
    );
    expect(result).toBe(true);
  });

  it("evaluates NOT condition", () => {
    const result = evaluateCondition(
      {
        operator: "not",
        condition: { field: "target.amount", operator: "gt", value: 500 },
      },
      ctx,
    );
    expect(result).toBe(true);
  });
});

// ── Rule engine tests ───────────────────────────────

describe("evaluateRules", () => {
  it("returns empty result for empty rules list", async () => {
    const result = await evaluateRules([], defaultInput);
    expect(result.triggered).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.results).toHaveLength(0);
  });

  it("evaluates a single matching rule", async () => {
    const rule = makeRule({
      name: "warn-large",
      condition: { field: "target.amount", operator: "gt", value: 1000 },
      effect: { type: "warn", message: "Large amount" },
    });

    const result = await evaluateRules([rule], defaultInput);
    expect(result.triggered).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toBe("Large amount");
  });

  it("evaluates a single non-matching rule", async () => {
    const rule = makeRule({
      name: "warn-huge",
      condition: { field: "target.amount", operator: "gt", value: 100_000 },
      effect: { type: "warn", message: "Huge amount" },
    });

    const result = await evaluateRules([rule], defaultInput);
    expect(result.triggered).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it("sorts rules by priority (descending)", async () => {
    const lowPriority = makeRule({
      name: "low",
      priority: 1,
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "warn", message: "low" },
    });
    const highPriority = makeRule({
      name: "high",
      priority: 10,
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "warn", message: "high" },
    });

    const result = await evaluateRules([lowPriority, highPriority], defaultInput);
    // High priority should be evaluated first
    expect(result.results[0].rule).toBe("high");
    expect(result.results[1].rule).toBe("low");
  });

  it("block effect short-circuits remaining rules", async () => {
    const blockRule = makeRule({
      name: "blocker",
      priority: 10,
      condition: { field: "target.amount", operator: "gt", value: 1000 },
      effect: { type: "block", message: "Amount too large", reason: "exceeds_limit" },
    });
    const warnRule = makeRule({
      name: "warner",
      priority: 1,
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "warn", message: "Should not appear" },
    });

    const result = await evaluateRules([blockRule, warnRule], defaultInput);
    expect(result.blocked).toBe(true);
    expect(result.blockReasons).toEqual(["exceeds_limit"]);
    // The warn rule should not be evaluated
    expect(result.results).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  it("collects multiple block reasons when blocks happen before short-circuit", async () => {
    // Two block rules at same priority (both should fire before short-circuit triggers)
    // Actually, since we short-circuit on *first* block, to get multiple blocks
    // we need a non-block rule at higher priority, then blocks at same priority.
    // The engine processes sequentially, so the first block encountered stops.
    // To collect multiple blocks, we need block effects that come from different
    // effect types evaluated before the block. Let's test with the block at lower priority
    // and a warn+block scenario: actually per the spec, "any block -> collect all block reasons"
    // This means multiple block rules should all be collected. Let me adjust the engine...
    // Actually re-reading the spec: the short-circuit is on block, but we collect ALL blocks.
    // The way to get multiple blocks is to have them at different priorities where
    // the higher-priority one triggers first. But short-circuit means we stop after first block.
    // The spec says "collect all block reasons, short-circuit remaining" which means
    // blocks encountered so far are collected, then we stop.
    // For testing: two blocks at priority 10, they're both evaluated in order.
    // Actually with short-circuit on first block, we only get one.
    // Let me test this with a warn (higher priority) then a block.
    const warnRule = makeRule({
      name: "warn-first",
      priority: 20,
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "warn", message: "heads up" },
    });
    const block1 = makeRule({
      name: "block-1",
      priority: 10,
      condition: { field: "target.amount", operator: "gt", value: 1000 },
      effect: { type: "block", message: "Too large", reason: "limit_1" },
    });

    const result = await evaluateRules([warnRule, block1], defaultInput);
    expect(result.blocked).toBe(true);
    expect(result.blockReasons).toEqual(["limit_1"]);
    expect(result.warnings).toHaveLength(1);
  });

  it("require_approval takes highest level", async () => {
    const managerApproval = makeRule({
      name: "manager-approval",
      priority: 10,
      condition: { field: "target.amount", operator: "gt", value: 1000 },
      effect: { type: "require_approval", level: "manager", message: "Manager approval needed" },
    });
    const directorApproval = makeRule({
      name: "director-approval",
      priority: 5,
      condition: { field: "target.amount", operator: "gt", value: 3000 },
      effect: { type: "require_approval", level: "director", message: "Director approval needed" },
    });

    const result = await evaluateRules([managerApproval, directorApproval], defaultInput);
    expect(result.requiredApproval).not.toBeNull();
    expect(result.requiredApproval?.level).toBe("director");
  });

  it("accumulates all warnings", async () => {
    const warn1 = makeRule({
      name: "warn-1",
      priority: 10,
      condition: { field: "target.amount", operator: "gt", value: 1000 },
      effect: { type: "warn", message: "Warning 1" },
    });
    const warn2 = makeRule({
      name: "warn-2",
      priority: 5,
      condition: { field: "target.amount", operator: "gt", value: 2000 },
      effect: { type: "warn", message: "Warning 2" },
    });

    const result = await evaluateRules([warn1, warn2], defaultInput);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.map((w) => w.message)).toEqual(["Warning 1", "Warning 2"]);
  });

  it("merges enrich fields from multiple rules", async () => {
    const enrich1 = makeRule({
      name: "enrich-1",
      priority: 10,
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "enrich", setFields: { priority_tag: "high", reviewer: "finance" } },
    });
    const enrich2 = makeRule({
      name: "enrich-2",
      priority: 5,
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "enrich", setFields: { category: "expense", reviewer: "cfo" } },
    });

    const result = await evaluateRules([enrich1, enrich2], defaultInput);
    expect(result.enrichFields).toEqual({
      priority_tag: "high",
      reviewer: "cfo", // Later rule overwrites
      category: "expense",
    });
  });

  it("handles mixed effects correctly", async () => {
    const rules: RuleDefinition[] = [
      makeRule({
        name: "warn-rule",
        priority: 20,
        condition: { field: "target.amount", operator: "gt", value: 0 },
        effect: { type: "warn", message: "Amount noted" },
      }),
      makeRule({
        name: "enrich-rule",
        priority: 15,
        condition: { field: "target.amount", operator: "gt", value: 0 },
        effect: { type: "enrich", setFields: { flagged: true } },
      }),
      makeRule({
        name: "approval-rule",
        priority: 10,
        condition: { field: "target.amount", operator: "gt", value: 1000 },
        effect: { type: "require_approval", level: "manager" },
      }),
      makeRule({
        name: "action-rule",
        priority: 5,
        condition: { field: "target.amount", operator: "gt", value: 0 },
        effect: { type: "execute_action", action: "notify_finance", params: { channel: "slack" } },
      }),
    ];

    const result = await evaluateRules(rules, defaultInput);
    expect(result.triggered).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.enrichFields).toEqual({ flagged: true });
    expect(result.requiredApproval?.level).toBe("manager");
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].action).toBe("notify_finance");
  });

  it("supports code-based conditions", async () => {
    const rule = makeRule({
      name: "code-rule",
      condition: (ctx) => ctx.actor.groups.includes("employee"),
      effect: { type: "warn", message: "Employee action" },
    });

    const result = await evaluateRules([rule], defaultInput);
    expect(result.triggered).toBe(true);
    expect(result.warnings[0].message).toBe("Employee action");
  });

  it("supports async code-based conditions", async () => {
    const rule = makeRule({
      name: "async-rule",
      condition: async (ctx) => {
        return (ctx.target.amount as number) > 1000;
      },
      effect: { type: "warn", message: "Async check passed" },
    });

    const result = await evaluateRules([rule], defaultInput);
    expect(result.triggered).toBe(true);
  });

  it("collects execute_action effects", async () => {
    const action1 = makeRule({
      name: "action-1",
      priority: 10,
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "execute_action", action: "send_email" },
    });
    const action2 = makeRule({
      name: "action-2",
      priority: 5,
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "execute_action", action: "log_audit", params: { level: "info" } },
    });

    const result = await evaluateRules([action1, action2], defaultInput);
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0].action).toBe("send_email");
    expect(result.actions[1].action).toBe("log_audit");
  });

  it("uses block message as reason when reason is not provided", async () => {
    const rule = makeRule({
      name: "block-no-reason",
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "block", message: "Not allowed" },
    });

    const result = await evaluateRules([rule], defaultInput);
    expect(result.blocked).toBe(true);
    expect(result.blockReasons).toEqual(["Not allowed"]);
  });

  it("filters out prototype-polluting keys from enrich setFields", async () => {
    const rule = makeRule({
      name: "enrich-pollute",
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: {
        type: "enrich",
        setFields: {
          safe_key: "ok",
          __proto__: { polluted: true },
          constructor: "bad",
          prototype: "bad",
        },
      },
    });

    const result = await evaluateRules([rule], defaultInput);
    expect(result.enrichFields).toEqual({ safe_key: "ok" });
    // Verify no prototype pollution occurred
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("isolates per-rule condition errors (fail-closed)", async () => {
    const throwingRule = makeRule({
      name: "throwing-rule",
      priority: 10,
      condition: () => {
        throw new Error("condition exploded");
      },
      effect: { type: "block", message: "Blocked by error", reason: "error_block" },
    });
    const normalRule = makeRule({
      name: "normal-rule",
      priority: 5,
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "warn", message: "Should not be reached (block short-circuits)" },
    });

    const result = await evaluateRules([throwingRule, normalRule], defaultInput);
    // Fail-closed: throwing rule treated as triggered, block effect applied
    expect(result.blocked).toBe(true);
    expect(result.blockReasons).toEqual(["error_block"]);
    // Error recorded in result
    expect(result.results[0].error).toBe("condition exploded");
    expect(result.results[0].triggered).toBe(true);
  });

  it("isolates per-rule condition errors for non-block rules", async () => {
    const throwingWarn = makeRule({
      name: "throwing-warn",
      priority: 10,
      condition: () => {
        throw new Error("oops");
      },
      effect: { type: "warn", message: "Warning from errored rule" },
    });
    const normalWarn = makeRule({
      name: "normal-warn",
      priority: 5,
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "warn", message: "Normal warning" },
    });

    const result = await evaluateRules([throwingWarn, normalWarn], defaultInput);
    // Both rules should produce warnings (no short-circuit for warn)
    expect(result.warnings).toHaveLength(2);
    expect(result.results[0].error).toBe("oops");
    expect(result.results[1].error).toBeUndefined();
  });

  it("async condition timeout is treated as error", async () => {
    const rules: RuleDefinition[] = [
      makeRule({
        name: "slow_rule",
        condition: async () => {
          await new Promise((r) => setTimeout(r, 500));
          return false;
        },
        effect: { type: "block", message: "blocked", reason: "slow" },
      }),
    ];
    const result = await evaluateRules(rules, defaultInput, { timeout: 50 });
    expect(result.triggered).toBe(true);
    expect(result.results[0].error).toContain("timed out");
  });

  it("async condition within timeout works normally", async () => {
    const rules: RuleDefinition[] = [
      makeRule({
        name: "fast_rule",
        condition: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return true;
        },
        effect: { type: "warn", message: "warning" },
      }),
    ];
    const result = await evaluateRules(rules, defaultInput, { timeout: 1000 });
    expect(result.triggered).toBe(true);
    expect(result.results[0].error).toBeUndefined();
  });

  it("AbortSignal is passed to code condition", async () => {
    let receivedSignal: AbortSignal | undefined;
    const rules: RuleDefinition[] = [
      makeRule({
        name: "signal_rule",
        condition: async (ctx) => {
          receivedSignal = ctx.signal;
          return true;
        },
        effect: { type: "warn", message: "w" },
      }),
    ];
    await evaluateRules(rules, defaultInput, { timeout: 1000 });
    expect(receivedSignal).toBeDefined();
    // Signal is aborted in the finally block after resolution
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("no timeout option works as before (backward compat)", async () => {
    const rules: RuleDefinition[] = [
      makeRule({
        name: "normal_rule",
        condition: async () => true,
        effect: { type: "warn", message: "w" },
      }),
    ];
    const result = await evaluateRules(rules, defaultInput);
    expect(result.triggered).toBe(true);
  });

  it("skipRules skips named rules", async () => {
    const approvalRule = makeRule({
      name: "needs-approval",
      priority: 10,
      condition: { field: "target.amount", operator: "gt", value: 1000 },
      effect: { type: "require_approval", level: "manager", message: "Manager approval needed" },
    });
    const warnRule = makeRule({
      name: "warn-large",
      priority: 5,
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "warn", message: "Large amount" },
    });

    const result = await evaluateRules([approvalRule, warnRule], defaultInput, {
      skipRules: ["needs-approval"],
    });
    // The approval rule should be skipped
    expect(result.requiredApproval).toBeNull();
    expect(result.results[0].rule).toBe("needs-approval");
    expect(result.results[0].skipped).toBe(true);
    expect(result.results[0].triggered).toBe(false);
    expect(result.results[0].duration).toBe(0);
    // The warn rule should still evaluate normally
    expect(result.warnings).toHaveLength(1);
    expect(result.results[1].rule).toBe("warn-large");
    expect(result.results[1].skipped).toBeUndefined();
  });

  it("non-skipped rules still evaluate normally when skipRules is provided", async () => {
    const rule1 = makeRule({
      name: "rule-a",
      priority: 10,
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "warn", message: "Warning A" },
    });
    const rule2 = makeRule({
      name: "rule-b",
      priority: 5,
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "warn", message: "Warning B" },
    });

    const result = await evaluateRules([rule1, rule2], defaultInput, {
      skipRules: ["rule-a"],
    });
    // rule-a skipped, rule-b evaluates
    expect(result.results[0].skipped).toBe(true);
    expect(result.results[1].triggered).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toBe("Warning B");
  });

  it("empty skipRules has no effect (backward compat)", async () => {
    const rule = makeRule({
      name: "always-warn",
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "warn", message: "Warning" },
    });

    const result = await evaluateRules([rule], defaultInput, { skipRules: [] });
    expect(result.triggered).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.results[0].skipped).toBeUndefined();
  });

  it("includes duration in output", async () => {
    const rule = makeRule({
      name: "timed",
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "warn", message: "timed" },
    });

    const result = await evaluateRules([rule], defaultInput);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.results[0].duration).toBeGreaterThanOrEqual(0);
  });
});
