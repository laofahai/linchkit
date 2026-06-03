/**
 * Action Engine ↔ Rule Engine integration (Spec 23 §1.1).
 *
 * These tests exercise the REAL execution path: a business rule (`defineRule`)
 * is injected into `createActionExecutor({ rules })` and we assert it actually
 * fires when the action runs through `executor.execute(...)` — NOT by calling
 * `evaluateRules` directly. This is the load-bearing wiring: before it, rule
 * effects (block / warn / enrich) were collected by the pure rule engine but
 * never applied during action execution.
 *
 * Phase 1 covers block / warn / enrich (pre-write decision effects).
 * require_approval / execute_action / trigger_flow land in later phases.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { createActionExecutor, type DataProvider } from "../src/engine/action-engine";
import type { ActionDefinition, Actor } from "../src/types/action";
import type { RuleDefinition } from "../src/types/rule";

const actor: Actor = { type: "human", id: "user-1", groups: ["staff"] };

/** Captures writes so tests can assert enrich reached the handler + write paths. */
interface Captured {
  created: Record<string, unknown> | null;
  updated: { id: string; data: Record<string, unknown> } | null;
  handlerInput: Record<string, unknown> | null;
}

function makeDataProvider(captured: Captured): DataProvider {
  return {
    get: async (_entity, id) => ({ id }),
    query: async () => [],
    create: async (_entity, data) => {
      captured.created = data;
      return { id: "req_1", ...data };
    },
    update: async (_entity, id, data) => {
      captured.updated = { id, data };
      return { id, ...data };
    },
    delete: async () => {},
    count: async () => 0,
  };
}

/** Action whose handler records ctx.input and writes it via ctx.create. */
function makeAction(captured: Captured): ActionDefinition {
  return {
    name: "submit_request",
    entity: "request",
    label: "Submit Request",
    policy: { mode: "sync", transaction: false },
    exposure: "all",
    handler: async (ctx) => {
      captured.handlerInput = { ...(ctx.input as Record<string, unknown>) };
      const record = await ctx.create("request", ctx.input as Record<string, unknown>);
      return record;
    },
  };
}

/** Declarative UPDATE action (no handler) — writes setFields resolved from input. */
function makeDeclarativeUpdateAction(): ActionDefinition {
  return {
    name: "tag_request",
    entity: "request",
    label: "Tag Request",
    policy: { mode: "sync", transaction: false },
    exposure: "all",
    setFields: { region: "$input.region" },
  };
}

function blockRule(): RuleDefinition {
  return {
    name: "block_overlimit",
    label: "Block over-limit amount",
    trigger: { action: "submit_request" },
    condition: { field: "target.amount", operator: "gt", value: 1000 },
    effect: { type: "block", message: "Amount exceeds the limit", reason: "exceeds_limit" },
  };
}

describe("Action Engine ↔ Rule Engine integration (Spec 23 §1.1)", () => {
  let captured: Captured;

  beforeEach(() => {
    captured = { created: null, updated: null, handlerInput: null };
  });

  function build(rules: RuleDefinition[] | undefined) {
    const executor = createActionExecutor({
      dataProvider: makeDataProvider(captured),
      rules,
    });
    executor.registry.register(makeAction(captured));
    executor.registry.register(makeDeclarativeUpdateAction());
    return executor;
  }

  it("block: a matching block rule aborts the action before the write", async () => {
    const executor = build([blockRule()]);
    const result = await executor.execute("submit_request", { amount: 5000 }, actor);

    expect(result.success).toBe(false);
    expect((result.data as { error?: string }).error).toContain("exceeds_limit");
    // The handler/write never ran.
    expect(captured.handlerInput).toBeNull();
    expect(captured.created).toBeNull();
  });

  it("block: the action proceeds when the block condition does not match", async () => {
    const executor = build([blockRule()]);
    const result = await executor.execute("submit_request", { amount: 500 }, actor);

    expect(result.success).toBe(true);
    expect(captured.created).toMatchObject({ amount: 500 });
  });

  it("enrich: rule-set fields reach the handler and the write", async () => {
    const enrich: RuleDefinition = {
      name: "stamp_region",
      label: "Stamp region",
      trigger: { action: "submit_request" },
      condition: { field: "target.amount", operator: "gte", value: 0 },
      effect: { type: "enrich", setFields: { region: "emea", priority: 3 } },
    };
    const executor = build([enrich]);
    const result = await executor.execute("submit_request", { amount: 10 }, actor);

    expect(result.success).toBe(true);
    expect(captured.handlerInput).toMatchObject({ amount: 10, region: "emea", priority: 3 });
    expect(captured.created).toMatchObject({ region: "emea", priority: 3 });
  });

  it("enrich: reaches DECLARATIVE writes too ($input.* resolves rule-enriched fields)", async () => {
    // Regression (codex review): the no-handler declarative path read raw
    // `input`, so `setFields: { region: "$input.region" }` resolved to the
    // pre-enrichment value and the rule effect was silently dropped.
    const enrich: RuleDefinition = {
      name: "stamp_region_decl",
      label: "Stamp region (declarative)",
      trigger: { action: "tag_request" },
      condition: { field: "target.id", operator: "not_null" },
      effect: { type: "enrich", setFields: { region: "emea" } },
    };
    const executor = build([enrich]);
    // Caller supplies only the record id — `region` comes from the rule.
    const result = await executor.execute("tag_request", { id: "req_1" }, actor);

    expect(result.success).toBe(true);
    expect(captured.updated).not.toBeNull();
    expect(captured.updated?.data).toMatchObject({ region: "emea" });
  });

  it("warn: warning messages surface on the result, action still succeeds", async () => {
    const warn: RuleDefinition = {
      name: "warn_large",
      label: "Warn on large amount",
      trigger: { action: "submit_request" },
      condition: { field: "target.amount", operator: "gt", value: 100 },
      effect: { type: "warn", message: "Large amount — please double-check" },
    };
    const executor = build([warn]);
    const result = await executor.execute("submit_request", { amount: 500 }, actor);

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual(["Large amount — please double-check"]);
    expect(captured.created).toMatchObject({ amount: 500 });
  });

  it("filtering: a rule targeting a different action does NOT fire", async () => {
    const otherRule: RuleDefinition = {
      name: "block_other",
      label: "Block other action",
      trigger: { action: "delete_request" },
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "block", message: "should not apply" },
    };
    const executor = build([otherRule]);
    const result = await executor.execute("submit_request", { amount: 9999 }, actor);

    expect(result.success).toBe(true);
    expect(captured.created).toMatchObject({ amount: 9999 });
  });

  it("back-compat: no rules option → action runs unchanged", async () => {
    const executor = build(undefined);
    const result = await executor.execute("submit_request", { amount: 9999 }, actor);

    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
    expect(captured.created).toMatchObject({ amount: 9999 });
  });

  it("skipRules: a blocking rule listed in skipRules is bypassed (approved re-execution)", async () => {
    const executor = build([blockRule()]);
    const result = await executor.execute("submit_request", { amount: 5000 }, actor, {
      skipRules: ["block_overlimit"],
    });

    expect(result.success).toBe(true);
    expect(captured.created).toMatchObject({ amount: 5000 });
  });
});
