/**
 * Saga runner tests (Spec 26 §1.2).
 *
 * Covers:
 *   - Forward happy path
 *   - Forward failure triggers reverse-order compensation
 *   - Nested Saga (a Saga driven from another Saga's step)
 *   - Compensation idempotency key plumbing
 *   - Best-effort compensation: a single compensation failure does not
 *     abort the remaining ones; the original error is what's thrown,
 *     wrapped with compensation failure context
 *   - fail_fast policy skips compensation
 *   - onStateChange snapshots track every status transition
 */

import { describe, expect, it } from "bun:test";
import { createSagaRunner, defineSaga, runSaga, type SagaExecutionState } from "../src/saga";

// ── Helpers ──────────────────────────────────────────────

interface ActionCall {
  action: string;
  input: Record<string, unknown>;
  idempotencyKey?: string;
}

/**
 * Build a runAction stub with a registry of handlers. Records every call
 * (including idempotency keys) so tests can assert ordering AND key shape.
 */
function buildRunAction(
  handlers: Record<string, (input: Record<string, unknown>) => unknown | Promise<unknown>>,
  calls: ActionCall[],
) {
  return async (
    action: string,
    input: Record<string, unknown>,
    options?: { idempotencyKey?: string },
  ): Promise<unknown> => {
    calls.push({ action, input, idempotencyKey: options?.idempotencyKey });
    const handler = handlers[action];
    if (!handler) {
      return { ok: true, action };
    }
    return handler(input);
  };
}

// ── Tests ────────────────────────────────────────────────

describe("defineSaga", () => {
  it("returns the definition unchanged on valid input", () => {
    const saga = defineSaga({
      name: "purchase_to_payment",
      steps: [
        { id: "inbound", action: "create_inbound", compensation: "cancel_inbound" },
        { id: "payment", action: "create_payment", compensation: "cancel_payment" },
      ],
    });
    expect(saga.name).toBe("purchase_to_payment");
    expect(saga.steps).toHaveLength(2);
  });

  it("rejects missing name", () => {
    expect(() =>
      defineSaga({
        name: "",
        steps: [{ id: "a", action: "do_a" }],
      }),
    ).toThrow(/non-empty name/);
  });

  it("rejects empty step list", () => {
    expect(() => defineSaga({ name: "empty", steps: [] })).toThrow(/at least one step/);
  });

  it("rejects duplicate step ids", () => {
    expect(() =>
      defineSaga({
        name: "dup",
        steps: [
          { id: "a", action: "do_a" },
          { id: "a", action: "do_a_again" },
        ],
      }),
    ).toThrow(/duplicate step id/);
  });
});

describe("Saga runner — forward happy path", () => {
  it("invokes steps in order and surfaces the last output", async () => {
    const calls: ActionCall[] = [];
    const runAction = buildRunAction(
      {
        create_inbound: () => ({ inboundId: "ib_1" }),
        create_payment: () => ({ paymentId: "pm_1" }),
      },
      calls,
    );

    const saga = defineSaga({
      name: "p2p",
      steps: [
        { id: "inbound", action: "create_inbound", compensation: "cancel_inbound" },
        { id: "payment", action: "create_payment", compensation: "cancel_payment" },
      ],
    });

    const state = await runSaga({
      definition: saga,
      runAction,
      runId: "run-1",
      input: { orderId: "o_1" },
    });

    expect(state.status).toBe("succeeded");
    expect(state.steps.every((s) => s.status === "succeeded")).toBe(true);
    expect(state.compensationLog).toEqual([]);
    expect(state.output).toEqual({ paymentId: "pm_1" });
    expect(calls.map((c) => c.action)).toEqual(["create_inbound", "create_payment"]);
  });
});

describe("Saga runner — compensation on failure", () => {
  it("runs compensations in reverse order with idempotency keys", async () => {
    const calls: ActionCall[] = [];
    const runAction = buildRunAction(
      {
        create_inbound: () => ({ inboundId: "ib_1" }),
        create_payment: () => {
          throw new Error("payment_declined");
        },
      },
      calls,
    );

    const saga = defineSaga({
      name: "p2p",
      steps: [
        { id: "inbound", action: "create_inbound", compensation: "cancel_inbound" },
        { id: "payment", action: "create_payment", compensation: "cancel_payment" },
      ],
    });

    await expect(
      runSaga({
        definition: saga,
        runAction,
        runId: "run-1",
      }),
    ).rejects.toThrow("payment_declined");

    // Call sequence: forward inbound, forward payment (throws), compensate inbound
    expect(calls.map((c) => c.action)).toEqual([
      "create_inbound",
      "create_payment",
      "cancel_inbound",
    ]);

    // Compensation call carries the documented idempotency key shape
    const compensationCall = calls[2];
    expect(compensationCall?.idempotencyKey).toBe("run-1:0:inbound:compensate");

    // Compensation input falls back to the forward step's output
    expect(compensationCall?.input).toEqual({ inboundId: "ib_1" });
  });

  it("skips steps without a compensation declaration", async () => {
    const calls: ActionCall[] = [];
    const runAction = buildRunAction(
      {
        send_email: () => ({ messageId: "msg_1" }),
        create_inbound: () => ({ inboundId: "ib_1" }),
        create_payment: () => {
          throw new Error("decline");
        },
      },
      calls,
    );

    const saga = defineSaga({
      name: "p2p_with_email",
      steps: [
        // send_email has no inverse — must remain in forward log but not compensated
        { id: "email", action: "send_email" },
        { id: "inbound", action: "create_inbound", compensation: "cancel_inbound" },
        { id: "payment", action: "create_payment", compensation: "cancel_payment" },
      ],
    });

    await expect(
      runSaga({
        definition: saga,
        runAction,
        runId: "run-2",
      }),
    ).rejects.toThrow("decline");

    // Only inbound is compensated; send_email is skipped (no inverse declared)
    const compensationActions = calls
      .filter((c) => c.idempotencyKey !== undefined)
      .map((c) => c.action);
    expect(compensationActions).toEqual(["cancel_inbound"]);
  });

  it("uses explicit compensationInput when declared", async () => {
    const calls: ActionCall[] = [];
    const runAction = buildRunAction(
      {
        create_inbound: () => ({ inboundId: "ib_1", warehouseId: "wh_1" }),
        create_payment: () => {
          throw new Error("decline");
        },
      },
      calls,
    );

    const saga = defineSaga({
      name: "p2p_explicit",
      steps: [
        {
          id: "inbound",
          action: "create_inbound",
          compensation: "cancel_inbound",
          compensationInput: { reason: "rollback" },
        },
        { id: "payment", action: "create_payment", compensation: "cancel_payment" },
      ],
    });

    await expect(runSaga({ definition: saga, runAction, runId: "run-3" })).rejects.toThrow(
      "decline",
    );

    const compensationCall = calls.find((c) => c.action === "cancel_inbound");
    expect(compensationCall?.input).toEqual({ reason: "rollback" });
  });
});

describe("Saga runner — best-effort compensation", () => {
  it("records compensation failures but continues with the rest", async () => {
    const calls: ActionCall[] = [];
    const runAction = buildRunAction(
      {
        step_a: () => ({ a: 1 }),
        step_b: () => ({ b: 2 }),
        step_c: () => {
          throw new Error("c_failed");
        },
        compensate_b: () => {
          throw new Error("b_compensation_failed");
        },
        compensate_a: () => ({ undone: true }),
      },
      calls,
    );

    const saga = defineSaga({
      name: "best_effort",
      steps: [
        { id: "a", action: "step_a", compensation: "compensate_a" },
        { id: "b", action: "step_b", compensation: "compensate_b" },
        { id: "c", action: "step_c", compensation: "compensate_c" },
      ],
    });

    let captured: SagaExecutionState | undefined;
    await expect(
      runSaga({
        definition: saga,
        runAction,
        runId: "run-best",
        onStateChange: (snap) => {
          captured = snap;
        },
      }),
    ).rejects.toThrow(/c_failed.*compensation failures.*b->compensate_b/);

    // Both compensations were attempted, even after compensate_b failed
    const compensationCalls = calls.filter((c) => c.idempotencyKey !== undefined);
    expect(compensationCalls.map((c) => c.action)).toEqual(["compensate_b", "compensate_a"]);

    // Final state reflects compensation_failed; log captures both entries
    expect(captured?.status).toBe("compensation_failed");
    expect(captured?.compensationLog).toHaveLength(2);
    const bEntry = captured?.compensationLog.find((e) => e.stepId === "b");
    const aEntry = captured?.compensationLog.find((e) => e.stepId === "a");
    expect(bEntry?.status).toBe("failed");
    expect(bEntry?.error).toBe("b_compensation_failed");
    expect(aEntry?.status).toBe("succeeded");
  });
});

describe("Saga runner — fail_fast policy", () => {
  it("propagates the original error without compensation", async () => {
    const calls: ActionCall[] = [];
    const runAction = buildRunAction(
      {
        a: () => ({ ok: true }),
        b: () => {
          throw new Error("boom");
        },
      },
      calls,
    );

    const saga = defineSaga({
      name: "ff",
      failurePolicy: "fail_fast",
      steps: [
        { id: "a", action: "a", compensation: "undo_a" },
        { id: "b", action: "b", compensation: "undo_b" },
      ],
    });

    await expect(runSaga({ definition: saga, runAction, runId: "run-ff" })).rejects.toThrow("boom");

    // No compensation calls were made
    expect(calls.every((c) => c.idempotencyKey === undefined)).toBe(true);
    expect(calls.map((c) => c.action)).toEqual(["a", "b"]);
  });
});

describe("Saga runner — nested Saga", () => {
  it("can run a Saga inside another Saga's step", async () => {
    const innerCalls: ActionCall[] = [];
    const innerRunAction = buildRunAction(
      {
        reserve_stock: () => ({ ticket: "rsv_1" }),
        capture_payment: () => ({ chargeId: "ch_1" }),
      },
      innerCalls,
    );
    const innerSaga = defineSaga({
      name: "checkout",
      steps: [
        { id: "stock", action: "reserve_stock", compensation: "release_stock" },
        { id: "pay", action: "capture_payment", compensation: "refund_payment" },
      ],
    });

    const outerCalls: ActionCall[] = [];
    const outerRunAction = buildRunAction(
      {
        validate_order: () => ({ valid: true }),
        // The middle step drives the inner Saga via the SAME callback shape
        run_checkout: async () => {
          const state = await runSaga({
            definition: innerSaga,
            runAction: innerRunAction,
            runId: "outer-1:checkout",
            parentSagaRunId: "outer-1",
            parentStepId: "checkout",
          });
          return state.output;
        },
        confirm_shipment: () => ({ shipmentId: "sh_1" }),
      },
      outerCalls,
    );

    const outerSaga = defineSaga({
      name: "order_pipeline",
      steps: [
        { id: "validate", action: "validate_order" },
        { id: "checkout", action: "run_checkout", compensation: "abort_checkout" },
        { id: "ship", action: "confirm_shipment", compensation: "cancel_shipment" },
      ],
    });

    const state = await runSaga({
      definition: outerSaga,
      runAction: outerRunAction,
      runId: "outer-1",
    });

    expect(state.status).toBe("succeeded");
    // Outer step "checkout" captured the inner Saga's last output as its own
    const checkoutStep = state.steps.find((s) => s.stepId === "checkout");
    expect(checkoutStep?.output).toEqual({ chargeId: "ch_1" });
    // Inner Saga steps both ran forward
    expect(innerCalls.map((c) => c.action)).toEqual(["reserve_stock", "capture_payment"]);
  });

  it("compensates the outer step (which can fan out to the inner Saga's own undo)", async () => {
    const innerCalls: ActionCall[] = [];
    const innerRunAction = buildRunAction(
      {
        reserve_stock: () => ({ ticket: "rsv_1" }),
        capture_payment: () => ({ chargeId: "ch_1" }),
        // Compensations the outer abort triggers — exercised when outer rolls back
        release_stock: () => ({ released: true }),
        refund_payment: () => ({ refunded: true }),
      },
      innerCalls,
    );
    const innerSaga = defineSaga({
      name: "checkout",
      steps: [
        { id: "stock", action: "reserve_stock", compensation: "release_stock" },
        { id: "pay", action: "capture_payment", compensation: "refund_payment" },
      ],
    });

    // Tracks whether the outer abort fired its inner-Saga rollback
    let abortRanInnerCompensation = false;
    const outerCalls: ActionCall[] = [];
    const outerRunAction = buildRunAction(
      {
        run_checkout: async () => {
          const state = await runSaga({
            definition: innerSaga,
            runAction: innerRunAction,
            runId: "nested-2:checkout",
          });
          return { checkoutState: state.runId };
        },
        confirm_shipment: () => {
          throw new Error("warehouse_offline");
        },
        // Outer compensation drives the inner Saga's reverse path manually,
        // showing the nesting works in both directions.
        abort_checkout: async () => {
          for (let i = innerSaga.steps.length - 1; i >= 0; i--) {
            const step = innerSaga.steps[i];
            if (!step?.compensation) continue;
            await innerRunAction(step.compensation, {});
          }
          abortRanInnerCompensation = true;
          return { aborted: true };
        },
      },
      outerCalls,
    );

    const outerSaga = defineSaga({
      name: "order_pipeline",
      steps: [
        { id: "checkout", action: "run_checkout", compensation: "abort_checkout" },
        { id: "ship", action: "confirm_shipment", compensation: "cancel_shipment" },
      ],
    });

    await expect(
      runSaga({ definition: outerSaga, runAction: outerRunAction, runId: "nested-2" }),
    ).rejects.toThrow("warehouse_offline");

    expect(abortRanInnerCompensation).toBe(true);
    // Inner compensations fired in reverse order
    const innerCompensationOrder = innerCalls
      .map((c) => c.action)
      .filter((a) => a === "release_stock" || a === "refund_payment");
    expect(innerCompensationOrder).toEqual(["refund_payment", "release_stock"]);
  });
});

describe("Saga runner — state snapshots", () => {
  it("invokes onStateChange for every transition", async () => {
    const transitions: Array<{ saga: string; step?: string }> = [];
    const runAction = buildRunAction(
      {
        a: () => ({ done: true }),
        b: () => {
          throw new Error("fail");
        },
        compensate_a: () => ({}),
      },
      [],
    );

    const saga = defineSaga({
      name: "snap",
      steps: [
        { id: "a", action: "a", compensation: "compensate_a" },
        { id: "b", action: "b", compensation: "compensate_b" },
      ],
    });

    const runner = createSagaRunner({
      definition: saga,
      runAction,
      runId: "snap-1",
      onStateChange: (snap) => {
        // Track unique (sagaStatus, focused step status) tuples
        const focused = snap.steps.find((s) => s.status !== "pending" && s.status !== "succeeded");
        transitions.push({ saga: snap.status, step: focused?.status });
      },
    });

    await expect(runner.run()).rejects.toThrow("fail");

    // Saga transitions include running, compensating, and a terminal state
    const sagaStatuses = new Set(transitions.map((t) => t.saga));
    expect(sagaStatuses.has("running")).toBe(true);
    expect(sagaStatuses.has("compensating")).toBe(true);
    expect(sagaStatuses.has("compensated")).toBe(true);
  });

  it("snapshots are independent — mutating one does not affect later notifications", async () => {
    const snapshots: SagaExecutionState[] = [];
    const runAction = buildRunAction({ a: () => ({}) }, []);
    const saga = defineSaga({
      name: "iso",
      steps: [{ id: "a", action: "a" }],
    });

    await runSaga({
      definition: saga,
      runAction,
      runId: "iso-1",
      onStateChange: (snap) => {
        snapshots.push(snap);
      },
    });

    // Mutate the FIRST snapshot. Later ones must remain unaffected.
    const first = snapshots[0];
    const firstStep = first?.steps[0];
    if (first && firstStep) {
      first.status = "failed";
      firstStep.status = "failed";
    }
    const last = snapshots[snapshots.length - 1];
    expect(last?.status).toBe("succeeded");
    expect(last?.steps[0]?.status).toBe("succeeded");
  });
});
