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
  type ActionFlowStarter,
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
  /** Input the `notify` side-effect action received (execute_action tests). */
  notifiedWith: Record<string, unknown> | null;
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

/** Side-effect action targeted by execute_action rules — records that it ran. */
function makeNotifyAction(captured: Captured): ActionDefinition {
  return {
    name: "notify",
    entity: "request",
    label: "Notify",
    policy: { mode: "sync", transaction: false },
    exposure: "all",
    handler: async (ctx) => {
      captured.notifiedWith = { ...(ctx.input as Record<string, unknown>) };
      return { notified: true };
    },
  };
}

/** Captures trigger_flow startFlow calls (an array so tests can assert count + order). */
interface FlowCapture {
  started: Array<{ flow: string; input: Record<string, unknown> }>;
}

function makeFlowStarter(cap: FlowCapture): ActionFlowStarter {
  return {
    startFlow: async (flow, input) => {
      cap.started.push({ flow, input });
      return { id: "flow_1" };
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
    captured = {
      created: null,
      updated: null,
      handlerInput: null,
      existingFields: {},
      notifiedWith: null,
    };
  });

  function build(
    rules: RuleDefinition[] | undefined,
    approvalEngine?: ActionApprovalSuspender,
    flowEngine?: ActionFlowStarter,
  ) {
    const executor = createActionExecutor({
      dataProvider: makeDataProvider(captured),
      rules,
      approvalEngine,
      flowEngine,
    });
    executor.registry.register(makeAction(captured));
    executor.registry.register(makeDeclarativeUpdateAction());
    executor.registry.register(makeNotifyAction(captured));
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

  it("execute_action: runs the named action post-commit (after the primary write)", async () => {
    const rule: RuleDefinition = {
      name: "notify_on_submit",
      label: "Notify on submit",
      trigger: { action: "submit_request" },
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "execute_action", action: "notify", params: { channel: "email" } },
    };
    const executor = build([rule]);
    const result = await executor.execute("submit_request", { amount: 10 }, actor);

    expect(result.success).toBe(true);
    // Primary write happened …
    expect(captured.created).toMatchObject({ amount: 10 });
    // … and the side-effect action ran with its params.
    expect(captured.notifiedWith).toMatchObject({ channel: "email" });
  });

  it("trigger_flow: starts the flow post-commit via the flow engine", async () => {
    const flowCap: FlowCapture = { started: [] };
    const rule: RuleDefinition = {
      name: "kickoff_flow",
      label: "Kick off fulfilment flow",
      trigger: { action: "submit_request" },
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "trigger_flow", flow: "fulfilment" },
    };
    const executor = build([rule], undefined, makeFlowStarter(flowCap));
    const result = await executor.execute("submit_request", { amount: 42 }, actor);

    expect(result.success).toBe(true);
    expect(captured.created).toMatchObject({ amount: 42 }); // write happened first
    expect(flowCap.started).toHaveLength(1);
    expect(flowCap.started[0]?.flow).toBe("fulfilment");
    // Defaults the flow input to the (enriched) action input.
    expect(flowCap.started[0]?.input).toMatchObject({ amount: 42 });
  });

  it("trigger_flow: explicit effect.input overrides the action input", async () => {
    const flowCap: FlowCapture = { started: [] };
    const rule: RuleDefinition = {
      name: "kickoff_flow_custom",
      label: "Kick off with custom input",
      trigger: { action: "submit_request" },
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "trigger_flow", flow: "audit", input: { reason: "high_value" } },
    };
    const executor = build([rule], undefined, makeFlowStarter(flowCap));
    await executor.execute("submit_request", { amount: 42 }, actor);

    expect(flowCap.started[0]?.flow).toBe("audit");
    expect(flowCap.started[0]?.input).toEqual({ reason: "high_value" });
  });

  it("trigger_flow: with no flow engine wired, the action still succeeds (skip + log)", async () => {
    const rule: RuleDefinition = {
      name: "kickoff_flow_noengine",
      label: "Kick off flow",
      trigger: { action: "submit_request" },
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "trigger_flow", flow: "fulfilment" },
    };
    const executor = build([rule]); // no flowEngine
    const result = await executor.execute("submit_request", { amount: 42 }, actor);

    expect(result.success).toBe(true);
    expect(captured.created).toMatchObject({ amount: 42 });
  });

  it("execute_action cycle terminates (recursion-depth guarded)", async () => {
    // A rule whose execute_action re-runs the SAME action would loop forever if
    // the post-commit invocation didn't count against the depth guard (codex P2).
    const selfRule: RuleDefinition = {
      name: "loop_self",
      label: "Self-executing rule",
      trigger: { action: "submit_request" },
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "execute_action", action: "submit_request" },
    };
    const executor = build([selfRule]);
    // Completing at all (no stack overflow / hang) proves the cycle is bounded.
    const result = await executor.execute("submit_request", { amount: 1 }, actor);
    expect(result.success).toBe(true);
    expect(captured.created).not.toBeNull();
  });

  it("nested: a child's trigger_flow bubbles to the parent's post-commit (fires once)", async () => {
    // A transactional parent calls a child via ctx.execute; the child has a
    // trigger_flow rule. The child's side effect must bubble to the parent and
    // fire on the parent's commit — not be silently dropped (codex P2).
    const flowCap: FlowCapture = { started: [] };
    const childRule: RuleDefinition = {
      name: "child_flow",
      label: "Child flow",
      trigger: { action: "child_act" },
      condition: { field: "target.amount", operator: "gt", value: 0 },
      effect: { type: "trigger_flow", flow: "child_flow" },
    };
    const txManager = {
      runInTransaction: async <T>(fn: (p: DataProvider) => Promise<T>) =>
        fn(makeDataProvider(captured)),
    };
    const executor = createActionExecutor({
      dataProvider: makeDataProvider(captured),
      transactionManager: txManager,
      rules: [childRule],
      flowEngine: makeFlowStarter(flowCap),
    });
    executor.registry.register({
      name: "child_act",
      entity: "request",
      label: "Child",
      policy: { mode: "sync", transaction: true },
      exposure: "all",
      handler: async () => ({ ok: true }),
    });
    executor.registry.register({
      name: "parent_act",
      entity: "request",
      label: "Parent",
      policy: { mode: "sync", transaction: true },
      exposure: "all",
      handler: async (ctx) => {
        await ctx.execute("child_act", { amount: 5 });
        // The child's trigger_flow must NOT have fired yet — it bubbles up and
        // fires only when THIS (parent) execution commits.
        expect(flowCap.started).toHaveLength(0);
        return { ok: true };
      },
    });
    const result = await executor.execute("parent_act", { amount: 5 }, actor);

    expect(result.success).toBe(true);
    // Fired exactly once, on the parent's post-commit.
    expect(flowCap.started).toHaveLength(1);
    expect(flowCap.started[0]?.flow).toBe("child_flow");
  });

  it("post-commit effects do NOT run when the action is blocked", async () => {
    const flowCap: FlowCapture = { started: [] };
    const rules: RuleDefinition[] = [
      blockRule(),
      {
        name: "kickoff_flow_blocked",
        label: "Kick off flow",
        trigger: { action: "submit_request" },
        condition: { field: "target.amount", operator: "gt", value: 0 },
        effect: { type: "trigger_flow", flow: "fulfilment" },
      },
    ];
    const executor = build(rules, undefined, makeFlowStarter(flowCap));
    const result = await executor.execute("submit_request", { amount: 5000 }, actor);

    expect(result.success).toBe(false); // blocked
    expect(captured.created).toBeNull(); // no write
    expect(flowCap.started).toHaveLength(0); // and no post-commit side effect
  });
});
