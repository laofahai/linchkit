/**
 * Unit tests for `evaluateActionRules` (engine/action-rule-eval.ts).
 *
 * These exercise the rule-evaluation DECISION in isolation — with a fake
 * DataProvider and hand-built rule sets — independent of the full action
 * executor. The end-to-end wiring (executor → logExecution / approval engine /
 * post-commit side effects) is covered by action-engine-rule-integration.test.ts.
 */

import { describe, expect, test } from "bun:test";
import type { DataProvider } from "../src/engine/action-engine";
import { type EvaluateActionRulesArgs, evaluateActionRules } from "../src/engine/action-rule-eval";
import { collectRules } from "../src/engine/rule-engine";
import { noopMetricsCollector } from "../src/observability/metrics";
import type { Actor } from "../src/types/action";
import { createExecutionMeta } from "../src/types/execution-meta";
import type { RuleDefinition } from "../src/types/rule";

const ACTOR: Actor = { type: "human", id: "u1", groups: ["staff"] };

/** A DataProvider whose `get` returns a fixed record (or throws). */
function fakeProvider(record: Record<string, unknown> | (() => never) | null): DataProvider {
  const get = async (): Promise<Record<string, unknown>> => {
    if (typeof record === "function") record();
    // The executor treats a falsy record as "not found" and degrades to
    // input-only; the DataProvider contract is non-null, so we cast here to
    // emulate a not-found read without widening the interface.
    return record as Record<string, unknown>;
  };
  return {
    get,
    query: async () => [],
    create: async (_s, data) => data,
    update: async (_s, _id, data) => data,
    delete: async () => {},
    count: async () => 0,
  };
}

/** Build args with sensible defaults; rules are collected + sorted like the executor does. */
function args(
  rules: RuleDefinition[],
  input: Record<string, unknown>,
  overrides: Partial<EvaluateActionRulesArgs> = {},
): EvaluateActionRulesArgs {
  const trigger = rules[0]?.trigger as { action?: string } | undefined;
  const actionName = trigger?.action ?? "do_thing";
  return {
    applicableRules: collectRules(actionName, rules),
    entity: "order",
    effectiveInput: input,
    actor: ACTOR,
    meta: createExecutionMeta({}),
    readProvider: fakeProvider(null),
    metrics: noopMetricsCollector,
    ...overrides,
  } as EvaluateActionRulesArgs;
}

describe("evaluateActionRules", () => {
  test("block effect → blocked decision with reason + suggestion, nothing else applied", async () => {
    const rule: RuleDefinition = {
      name: "no_huge",
      label: "Block huge amounts",
      trigger: { action: "create_order" },
      condition: { field: "target.amount", operator: "gt", value: 1000 },
      effect: { type: "block", message: "Amount too large", reason: "amount exceeds 1000" },
    };
    const d = await evaluateActionRules(args([rule], { amount: 5000 }));
    expect(d.blocked).not.toBeNull();
    expect(d.blocked?.reason).toBe("amount exceeds 1000");
    expect(d.blocked?.suggestion).toContain("amount exceeds 1000");
    expect(d.requiredApproval).toBeNull();
    expect(d.warnings).toEqual([]);
    expect(d.pendingActions).toEqual([]);
    expect(d.pendingFlows).toEqual([]);
  });

  test("enrich effect → merged into returned effectiveInput (input wins on conflict)", async () => {
    const rule: RuleDefinition = {
      name: "stamp_source",
      label: "Stamp source",
      trigger: { action: "create_order" },
      condition: { field: "target.amount", operator: "gte", value: 0 },
      effect: { type: "enrich", setFields: { source: "rule", note: "auto" } },
    };
    const d = await evaluateActionRules(args([rule], { amount: 10, note: "user" }));
    expect(d.blocked).toBeNull();
    // enrich merges OVER input, so its values win for keys it sets.
    expect(d.effectiveInput).toEqual({ amount: 10, note: "auto", source: "rule" });
  });

  test("warn effect → message collected, decision still proceeds", async () => {
    const rule: RuleDefinition = {
      name: "warn_big",
      label: "Warn on big",
      trigger: { action: "create_order" },
      condition: { field: "target.amount", operator: "gt", value: 100 },
      effect: { type: "warn", message: "Large order" },
    };
    const d = await evaluateActionRules(args([rule], { amount: 500 }));
    expect(d.blocked).toBeNull();
    expect(d.warnings).toEqual(["Large order"]);
  });

  test("require_approval effect → reported with triggerRules, not auto-applied", async () => {
    const rule: RuleDefinition = {
      name: "needs_signoff",
      label: "Needs signoff",
      trigger: { action: "create_order" },
      condition: { field: "target.amount", operator: "gt", value: 100 },
      effect: { type: "require_approval", level: "manager" },
    };
    const d = await evaluateActionRules(args([rule], { id: "o1", amount: 500 }));
    expect(d.requiredApproval?.effect.level).toBe("manager");
    expect(d.requiredApproval?.triggerRules).toEqual(["needs_signoff"]);
    expect(d.recordId).toBe("o1");
  });

  test("record-state condition reads current record via provider", async () => {
    const rule: RuleDefinition = {
      name: "no_edit_shipped",
      label: "No edit when shipped",
      trigger: { action: "update_order" },
      // Condition references a field NOT in the input — only the stored record.
      condition: { field: "target.status", operator: "eq", value: "shipped" },
      effect: { type: "block", message: "Order already shipped" },
    };
    const d = await evaluateActionRules(
      args(
        [rule],
        { id: "o1", note: "tweak" },
        {
          readProvider: fakeProvider({ id: "o1", status: "shipped" }),
        },
      ),
    );
    expect(d.blocked?.reason).toBe("Order already shipped");
  });

  test("input value overrides stored record for the merged condition target", async () => {
    const rule: RuleDefinition = {
      name: "no_edit_shipped",
      label: "No edit when shipped",
      trigger: { action: "update_order" },
      condition: { field: "target.status", operator: "eq", value: "shipped" },
      effect: { type: "block", message: "Order already shipped" },
    };
    // Stored status is "shipped" but the input moves it to "draft" → input wins,
    // condition does NOT match, action proceeds.
    const d = await evaluateActionRules(
      args(
        [rule],
        { id: "o1", status: "draft" },
        {
          readProvider: fakeProvider({ id: "o1", status: "shipped" }),
        },
      ),
    );
    expect(d.blocked).toBeNull();
  });

  test("read failure degrades to input-only evaluation (no throw)", async () => {
    const rule: RuleDefinition = {
      name: "warn_draft",
      label: "Warn draft",
      trigger: { action: "update_order" },
      condition: { field: "target.status", operator: "eq", value: "draft" },
      effect: { type: "warn", message: "still draft" },
    };
    const d = await evaluateActionRules(
      args(
        [rule],
        { id: "o1", status: "draft" },
        {
          readProvider: fakeProvider(() => {
            throw new Error("db down");
          }),
        },
      ),
    );
    // The read threw, so evaluation falls back to input-only — input has
    // status:"draft", so the warn still fires.
    expect(d.warnings).toEqual(["still draft"]);
  });

  test("no entity / no id → no record read, input-only", async () => {
    const rule: RuleDefinition = {
      name: "warn_any",
      label: "Warn any",
      trigger: { action: "do_thing" },
      condition: { field: "target.x", operator: "eq", value: 1 },
      effect: { type: "warn", message: "x is 1" },
    };
    let getCalled = false;
    const provider = fakeProvider({ should: "not-read" });
    const origGet = provider.get;
    provider.get = async (...a) => {
      getCalled = true;
      return origGet(...a);
    };
    const d = await evaluateActionRules(
      args([rule], { x: 1 }, { entity: undefined, readProvider: provider }),
    );
    expect(getCalled).toBe(false);
    expect(d.warnings).toEqual(["x is 1"]);
    expect(d.recordId).toBeUndefined();
  });

  test("execute_action + trigger_flow effects collected as pending side effects", async () => {
    const rules: RuleDefinition[] = [
      {
        name: "spawn_action",
        label: "Spawn",
        trigger: { action: "create_order" },
        condition: { field: "target.amount", operator: "gte", value: 0 },
        effect: { type: "execute_action", action: "notify_ops", params: { reason: "new" } },
      },
      {
        name: "spawn_flow",
        label: "Flow",
        trigger: { action: "create_order" },
        condition: { field: "target.amount", operator: "gte", value: 0 },
        effect: { type: "trigger_flow", flow: "fulfillment" },
      },
    ];
    const d = await evaluateActionRules(args(rules, { amount: 1 }));
    expect(d.pendingActions).toHaveLength(1);
    expect(d.pendingActions[0]?.action).toBe("notify_ops");
    expect(d.pendingFlows).toHaveLength(1);
    expect(d.pendingFlows[0]?.flow).toBe("fulfillment");
  });

  test("skipRules suppresses the named rule", async () => {
    const rule: RuleDefinition = {
      name: "needs_signoff",
      label: "Needs signoff",
      trigger: { action: "create_order" },
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "require_approval", level: "manager" },
    };
    const d = await evaluateActionRules(
      args([rule], { amount: 500 }, { skipRules: ["needs_signoff"] }),
    );
    expect(d.requiredApproval).toBeNull();
  });

  test("empty-string id → recordId undefined and no record read", async () => {
    const rule: RuleDefinition = {
      name: "warn_any",
      label: "Warn any",
      trigger: { action: "update_order" },
      condition: { field: "target.amount", operator: "gte", value: 0 },
      effect: { type: "warn", message: "hi" },
    };
    let getCalled = false;
    const provider = fakeProvider({ id: "" });
    provider.get = async () => {
      getCalled = true;
      return { id: "" };
    };
    const d = await evaluateActionRules(
      args([rule], { id: "", amount: 1 }, { readProvider: provider }),
    );
    expect(getCalled).toBe(false);
    expect(d.recordId).toBeUndefined();
  });
});
