/**
 * Saga compensation tests for the Restate flow runtime.
 *
 * The compiled run handler is exercised directly with a stub WorkflowContext
 * — no real Restate server is required. The stub mirrors the small surface
 * (`ctx.key`, `ctx.run`, `ctx.set`) the compensation orchestration relies on,
 * matching the pattern used by other in-memory flow tests in this repo.
 */

import { describe, expect, it } from "bun:test";
import type { FlowDefinition } from "@linchkit/core";
import type { FlowExecuteActionOptions, FlowStepContext } from "@linchkit/core/server";
import { buildFlowRunHandler } from "../src/flow-compiler";

// ── Stub WorkflowContext ─────────────────────────────────

interface ActionInvocation {
  actionName: string;
  input: Record<string, unknown>;
  options?: FlowExecuteActionOptions;
}

interface StubContext {
  key: string;
  state: Map<string, unknown>;
  runCalls: string[];
  set: (key: string, value: unknown) => void;
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

/**
 * Build a stub Restate WorkflowContext that records `set()` calls into a Map,
 * delegates `run()` to the inner function (no durability), and exposes `key`
 * as the flow instance ID.
 */
function createStubContext(key: string): StubContext {
  const state = new Map<string, unknown>();
  const runCalls: string[] = [];

  return {
    key,
    state,
    runCalls,
    set(k, v) {
      state.set(k, v);
    },
    async run(name, fn) {
      runCalls.push(name);
      return fn();
    },
  };
}

/**
 * Build a stub FlowStepContext that records every executeAction invocation
 * (including options) and dispatches to the supplied action handlers.
 */
function createStubStepContext(
  handlers: Record<
    string,
    (input: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>
  >,
  invocations: ActionInvocation[],
): FlowStepContext {
  return {
    flowContext: {},
    async executeAction(actionName, input, options) {
      invocations.push({ actionName, input, options });
      const handler = handlers[actionName];
      if (!handler) {
        return { ok: true, actionName };
      }
      return handler(input);
    },
    async callAI() {
      return { response: "stub", tokensUsed: 0 };
    },
    evaluateCondition() {
      return false;
    },
  };
}

/**
 * Build the stepIndex map the way `compileFlow` would.
 */
function buildStepIndex(definition: FlowDefinition): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < definition.steps.length; i++) {
    const step = definition.steps[i];
    if (step) map.set(step.id, i);
  }
  return map;
}

// ── Tests ────────────────────────────────────────────────

describe("Restate Saga compensation", () => {
  it("runs compensations in reverse order when a step fails (failurePolicy: 'compensate')", async () => {
    const invocations: ActionInvocation[] = [];
    const stepCtx = createStubStepContext(
      {
        create_inbound: (input) => ({ inboundId: "ib-1", ...input }),
        reserve_warehouse: (input) => ({ slotId: "slot-7", ...input }),
        create_payment: () => {
          throw new Error("Payment gateway timeout");
        },
        cancel_inbound: () => ({ cancelled: "ib-1" }),
        release_warehouse: () => ({ released: "slot-7" }),
      },
      invocations,
    );

    const flow: FlowDefinition = {
      name: "purchase_to_payment",
      trigger: { type: "manual" },
      failurePolicy: "compensate",
      steps: [
        {
          id: "step_inbound",
          name: "Create Inbound",
          type: "action",
          actionName: "create_inbound",
          compensation: "cancel_inbound",
        },
        {
          id: "step_warehouse",
          name: "Reserve Warehouse",
          type: "action",
          actionName: "reserve_warehouse",
          compensation: "release_warehouse",
        },
        {
          id: "step_payment",
          name: "Create Payment",
          type: "action",
          actionName: "create_payment",
        },
      ],
    };

    const ctx = createStubContext("flow-instance-001");
    const run = buildFlowRunHandler(flow, flow.steps, buildStepIndex(flow), stepCtx);

    await expect(run(ctx as never, {})).rejects.toThrow("Payment gateway timeout");

    // Three forward calls + two compensations (step 3 had no compensation to run).
    const order = invocations.map((i) => i.actionName);
    expect(order).toEqual([
      "create_inbound",
      "reserve_warehouse",
      "create_payment",
      "release_warehouse",
      "cancel_inbound",
    ]);

    // Compensation log was published into workflow state in reverse order.
    const log = ctx.state.get("compensation_log") as Array<{ stepId: string; status: string }>;
    expect(log).toHaveLength(2);
    expect(log[0]?.stepId).toBe("step_warehouse");
    expect(log[1]?.stepId).toBe("step_inbound");
    expect(log.every((entry) => entry.status === "succeeded")).toBe(true);

    expect(ctx.state.get("status")).toBe("compensated");
  });

  it("skips steps without a compensation declaration", async () => {
    const invocations: ActionInvocation[] = [];
    const stepCtx = createStubStepContext(
      {
        prepare: () => ({ prepared: true }),
        finalize: () => ({ finalized: true }),
        crash: () => {
          throw new Error("oops");
        },
        undo_finalize: () => ({ undone: true }),
      },
      invocations,
    );

    const flow: FlowDefinition = {
      name: "partial-compensation",
      trigger: { type: "manual" },
      failurePolicy: "compensate",
      steps: [
        // No compensation declared on this step — it must be skipped during rollback.
        { id: "s1", name: "Prepare", type: "action", actionName: "prepare" },
        {
          id: "s2",
          name: "Finalize",
          type: "action",
          actionName: "finalize",
          compensation: "undo_finalize",
        },
        { id: "s3", name: "Crash", type: "action", actionName: "crash" },
      ],
    };

    const ctx = createStubContext("flow-002");
    const run = buildFlowRunHandler(flow, flow.steps, buildStepIndex(flow), stepCtx);

    await expect(run(ctx as never, {})).rejects.toThrow("oops");

    expect(invocations.map((i) => i.actionName)).toEqual([
      "prepare",
      "finalize",
      "crash",
      "undo_finalize", // only step with a compensation runs
    ]);

    const log = ctx.state.get("compensation_log") as Array<{ stepId: string }>;
    expect(log).toHaveLength(1);
    expect(log[0]?.stepId).toBe("s2");
  });

  it("continues compensating when one compensation throws and surfaces both errors", async () => {
    const invocations: ActionInvocation[] = [];
    const stepCtx = createStubStepContext(
      {
        do_a: () => ({ a: 1 }),
        do_b: () => ({ b: 2 }),
        boom: () => {
          throw new Error("primary failure");
        },
        undo_a: () => ({ undone: "a" }),
        undo_b: () => {
          throw new Error("undo_b failed");
        },
      },
      invocations,
    );

    const flow: FlowDefinition = {
      name: "best-effort-compensation",
      trigger: { type: "manual" },
      failurePolicy: "compensate",
      steps: [
        { id: "a", name: "A", type: "action", actionName: "do_a", compensation: "undo_a" },
        { id: "b", name: "B", type: "action", actionName: "do_b", compensation: "undo_b" },
        { id: "c", name: "C", type: "action", actionName: "boom" },
      ],
    };

    const ctx = createStubContext("flow-003");
    const run = buildFlowRunHandler(flow, flow.steps, buildStepIndex(flow), stepCtx);

    let captured: Error | undefined;
    try {
      await run(ctx as never, {});
    } catch (err) {
      captured = err as Error;
    }

    expect(captured).toBeDefined();
    // Original error survives; the compensation failure is wrapped into context.
    expect(captured?.message).toContain("primary failure");
    expect(captured?.message).toContain("compensation failures");
    expect(captured?.message).toContain("b->undo_b");

    // Both compensations ran in reverse order even though undo_b threw.
    expect(invocations.map((i) => i.actionName)).toEqual([
      "do_a",
      "do_b",
      "boom",
      "undo_b",
      "undo_a",
    ]);

    const log = ctx.state.get("compensation_log") as Array<{
      stepId: string;
      status: string;
      error?: string;
    }>;
    expect(log).toHaveLength(2);
    expect(log[0]?.stepId).toBe("b");
    expect(log[0]?.status).toBe("failed");
    expect(log[0]?.error).toBe("undo_b failed");
    expect(log[1]?.stepId).toBe("a");
    expect(log[1]?.status).toBe("succeeded");
  });

  it("does not compensate when failurePolicy is 'fail_fast' (or unset)", async () => {
    for (const policyVariant of [{ failurePolicy: "fail_fast" as const }, {}]) {
      const invocations: ActionInvocation[] = [];
      const stepCtx = createStubStepContext(
        {
          step_one: () => ({ ok: true }),
          step_two: () => {
            throw new Error("step_two failed");
          },
          undo_one: () => ({ undone: true }),
        },
        invocations,
      );

      const flow: FlowDefinition = {
        name: "fail-fast-flow",
        trigger: { type: "manual" },
        ...policyVariant,
        steps: [
          {
            id: "s1",
            name: "Step One",
            type: "action",
            actionName: "step_one",
            compensation: "undo_one",
          },
          { id: "s2", name: "Step Two", type: "action", actionName: "step_two" },
        ],
      };

      const ctx = createStubContext("flow-fail-fast");
      const run = buildFlowRunHandler(flow, flow.steps, buildStepIndex(flow), stepCtx);

      await expect(run(ctx as never, {})).rejects.toThrow("step_two failed");

      // No compensation was attempted — only the two forward steps ran.
      expect(invocations.map((i) => i.actionName)).toEqual(["step_one", "step_two"]);
      expect(ctx.state.get("compensation_log")).toBeUndefined();
      expect(ctx.state.get("status")).not.toBe("compensated");
    }
  });

  it("forwards a deterministic idempotency key for each compensation invocation", async () => {
    const invocations: ActionInvocation[] = [];
    const stepCtx = createStubStepContext(
      {
        do_a: () => ({}),
        do_b: () => ({}),
        crash: () => {
          throw new Error("boom");
        },
        undo_a: () => ({}),
        undo_b: () => ({}),
      },
      invocations,
    );

    const flow: FlowDefinition = {
      name: "idem-flow",
      trigger: { type: "manual" },
      failurePolicy: "compensate",
      steps: [
        { id: "a", name: "A", type: "action", actionName: "do_a", compensation: "undo_a" },
        { id: "b", name: "B", type: "action", actionName: "do_b", compensation: "undo_b" },
        { id: "c", name: "C", type: "action", actionName: "crash" },
      ],
    };

    const ctx = createStubContext("flow-idem-XYZ");
    const run = buildFlowRunHandler(flow, flow.steps, buildStepIndex(flow), stepCtx);

    await expect(run(ctx as never, {})).rejects.toThrow("boom");

    // Forward steps must NOT carry an idempotency key.
    const forward = invocations.filter((i) => ["do_a", "do_b", "crash"].includes(i.actionName));
    for (const call of forward) {
      expect(call.options?.idempotencyKey).toBeUndefined();
    }

    const undoB = invocations.find((i) => i.actionName === "undo_b");
    const undoA = invocations.find((i) => i.actionName === "undo_a");
    // Key shape: `${ctx.key}:${completionIndex}:${stepId}:compensate`.
    // The completion index disambiguates compensations for steps that ran
    // multiple times in a loop — see the "loop" regression test below.
    expect(undoB?.options?.idempotencyKey).toBe("flow-idem-XYZ:1:b:compensate");
    expect(undoA?.options?.idempotencyKey).toBe("flow-idem-XYZ:0:a:compensate");
  });

  it("treats legacy onError === 'compensate' as a compensation trigger", async () => {
    const invocations: ActionInvocation[] = [];
    const stepCtx = createStubStepContext(
      {
        do_a: () => ({ a: 1 }),
        crash: () => {
          throw new Error("legacy boom");
        },
        undo_a: () => ({ undone: true }),
      },
      invocations,
    );

    const flow: FlowDefinition = {
      name: "legacy-onerror-flow",
      trigger: { type: "manual" },
      // Note: failurePolicy unset; fall back to legacy onError contract.
      onError: "compensate",
      steps: [
        { id: "a", name: "A", type: "action", actionName: "do_a", compensation: "undo_a" },
        { id: "b", name: "B", type: "action", actionName: "crash" },
      ],
    };

    const ctx = createStubContext("flow-legacy");
    const run = buildFlowRunHandler(flow, flow.steps, buildStepIndex(flow), stepCtx);

    await expect(run(ctx as never, {})).rejects.toThrow("legacy boom");
    expect(invocations.map((i) => i.actionName)).toEqual(["do_a", "crash", "undo_a"]);
  });

  it("disambiguates compensation keys for steps that ran multiple times in a loop", async () => {
    // Regression test for the loop key-collision: when a single action step
    // executes more than once via __jump, each completion must get its own
    // idempotency key + ctx.run name. Otherwise Restate's ctx.run cache and
    // the ActionEngine's idempotency dedupe would collapse all compensations
    // into a single call — the second debit would never be credited back.
    const invocations: ActionInvocation[] = [];
    let bodyRunCount = 0;
    let checkRunCount = 0;
    const stepCtx = createStubStepContext(
      {
        body: () => {
          bodyRunCount++;
          return { iter: bodyRunCount };
        },
        check: () => {
          checkRunCount++;
          // First time: jump back to body so it runs a second time.
          // Second time: fall through to crash.
          return checkRunCount === 1 ? { __jump: "body" } : { ok: true };
        },
        crash: () => {
          throw new Error("after loop boom");
        },
        undo_body: () => ({ undone: true }),
      },
      invocations,
    );

    const flow: FlowDefinition = {
      name: "loop-flow",
      trigger: { type: "manual" },
      failurePolicy: "compensate",
      steps: [
        { id: "body", name: "Body", type: "action", actionName: "body", compensation: "undo_body" },
        { id: "check", name: "Check", type: "action", actionName: "check" },
        { id: "after", name: "After", type: "action", actionName: "crash" },
      ],
    };

    const ctx = createStubContext("flow-loop-1");
    const run = buildFlowRunHandler(flow, flow.steps, buildStepIndex(flow), stepCtx);

    await expect(run(ctx as never, {})).rejects.toThrow("after loop boom");

    // body should have executed twice and undo_body should have been called
    // twice — once per completion.
    expect(bodyRunCount).toBe(2);
    const undoCalls = invocations.filter((i) => i.actionName === "undo_body");
    expect(undoCalls).toHaveLength(2);

    // The two undo invocations must carry DISTINCT idempotency keys, with
    // the completion index baked in (1 first, then 0 — reverse order).
    expect(undoCalls[0]?.options?.idempotencyKey).toBe("flow-loop-1:1:body:compensate");
    expect(undoCalls[1]?.options?.idempotencyKey).toBe("flow-loop-1:0:body:compensate");

    // The two ctx.run names must also be distinct, so Restate's per-step
    // result cache cannot dedupe them into a single execution.
    const compensateRuns = ctx.runCalls.filter((n) => n.startsWith("compensate_"));
    expect(compensateRuns).toEqual(["compensate_1_body", "compensate_0_body"]);
  });
});
