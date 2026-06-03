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
import {
  type ActionApprovalSuspender,
  createActionExecutor,
  type DataProvider,
} from "../src/engine/action-engine";
import type { ActionDefinition, Actor } from "../src/types/action";
import type { ApprovalPendingResult } from "../src/types/approval";
import type { RuleDefinition } from "../src/types/rule";

const actor: Actor = { type: "human", id: "user-1", groups: ["staff"] };

/** Captures writes so tests can assert enrich reached the handler + write paths. */
interface Captured {
  created: Record<string, unknown> | null;
  updated: { id: string; data: Record<string, unknown> } | null;
  handlerInput: Record<string, unknown> | null;
  /** Extra fields the mock `get` returns for a record — drives record-state tests. */
  existingFields: Record<string, unknown>;
}

function makeDataProvider(captured: Captured): DataProvider {
  return {
    get: async (_entity, id) => ({ id, ...captured.existingFields }),
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

function approvalRule(): RuleDefinition {
  return {
    name: "approve_large",
    label: "Require approval for large amount",
    trigger: { action: "submit_request" },
    condition: { field: "target.amount", operator: "gt", value: 1000 },
    effect: { type: "require_approval", level: "manager", message: "Needs manager sign-off" },
  };
}

/** Captures the createRequest call so tests can assert the suspend happened. */
interface ApprovalCapture {
  request: Parameters<ActionApprovalSuspender["createRequest"]>[0] | null;
}

function makeApprovalEngine(cap: ApprovalCapture): ActionApprovalSuspender {
  return {
    createRequest: async (opts) => {
      cap.request = opts;
      return {
        status: "pending_approval",
        approvalId: "appr_1",
        message: "Pending approval",
        level: opts.effect.level,
      };
    },
  };
}

describe("Action Engine ↔ Rule Engine integration (Spec 23 §1.1)", () => {
  let captured: Captured;

  beforeEach(() => {
    captured = { created: null, updated: null, handlerInput: null, existingFields: {} };
  });

  function build(rules: RuleDefinition[] | undefined, approvalEngine?: ActionApprovalSuspender) {
    const executor = createActionExecutor({
      dataProvider: makeDataProvider(captured),
      rules,
      approvalEngine,
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

  it("require_approval: suspends the action into an approval request (no write)", async () => {
    const apprCap: ApprovalCapture = { request: null };
    const executor = build([approvalRule()], makeApprovalEngine(apprCap));
    const result = await executor.execute("submit_request", { amount: 5000 }, actor);

    const pending = result.data as ApprovalPendingResult;
    expect(pending.status).toBe("pending_approval");
    expect(pending.level).toBe("manager");
    // createRequest received the effect + the triggering rule name(s).
    expect(apprCap.request?.effect.level).toBe("manager");
    expect(apprCap.request?.triggerRules).toEqual(["approve_large"]);
    // The action was suspended — the write never ran.
    expect(captured.created).toBeNull();
  });

  it("require_approval: with no approval engine wired, the action proceeds (no silent block)", async () => {
    const executor = build([approvalRule()]); // no approvalEngine
    const result = await executor.execute("submit_request", { amount: 5000 }, actor);

    expect(result.success).toBe(true);
    expect(captured.created).toMatchObject({ amount: 5000 });
  });

  it("require_approval: setApprovalEngine late-binding seam works", async () => {
    const apprCap: ApprovalCapture = { request: null };
    const executor = build([approvalRule()]); // constructed without an engine
    executor.setApprovalEngine(makeApprovalEngine(apprCap));
    const result = await executor.execute("submit_request", { amount: 5000 }, actor);

    expect((result.data as ApprovalPendingResult).status).toBe("pending_approval");
    expect(apprCap.request).not.toBeNull();
    expect(captured.created).toBeNull();
  });

  it("require_approval: skipRules bypasses the gate (approved re-execution proceeds)", async () => {
    const apprCap: ApprovalCapture = { request: null };
    const executor = build([approvalRule()], makeApprovalEngine(apprCap));
    const result = await executor.execute("submit_request", { amount: 5000 }, actor, {
      skipRules: ["approve_large"],
    });

    expect(result.success).toBe(true);
    expect(apprCap.request).toBeNull(); // gate skipped — no new request
    expect(captured.created).toMatchObject({ amount: 5000 });
  });

  it("record-state: a rule reading the pre-existing record fires (status from the DB, not input)", async () => {
    // The current record is "closed"; the caller's input does not carry status.
    captured.existingFields = { status: "closed" };
    const blockClosed: RuleDefinition = {
      name: "block_closed",
      label: "Block edits to closed records",
      trigger: { action: "tag_request" },
      condition: { field: "target.status", operator: "eq", value: "closed" },
      effect: { type: "block", message: "Record is closed", reason: "record_closed" },
    };
    const executor = build([blockClosed]);
    // tag_request is an update (input carries an id) → executor reads the record.
    const result = await executor.execute("tag_request", { id: "req_1", region: "x" }, actor);

    expect(result.success).toBe(false);
    expect((result.data as { error?: string }).error).toContain("record_closed");
    expect(captured.updated).toBeNull(); // blocked before the write
  });

  it("record-state: input overrides record state in the rule's target view", async () => {
    // Record is "closed", but the caller's input flips status to "open" — the
    // merged target should reflect the input, so the block does NOT fire.
    captured.existingFields = { status: "closed" };
    const blockClosed: RuleDefinition = {
      name: "block_closed_2",
      label: "Block edits to closed records",
      trigger: { action: "tag_request" },
      condition: { field: "target.status", operator: "eq", value: "closed" },
      effect: { type: "block", message: "Record is closed" },
    };
    const executor = build([blockClosed]);
    const result = await executor.execute(
      "tag_request",
      { id: "req_1", status: "open", region: "x" },
      actor,
    );

    expect(result.success).toBe(true);
    expect(captured.updated).not.toBeNull();
  });
});
