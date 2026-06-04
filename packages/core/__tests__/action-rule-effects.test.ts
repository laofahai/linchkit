/**
 * Unit tests for runPostCommitRuleEffects (packages/core/src/engine/action-rule-effects.ts).
 *
 * These tests exercise the post-commit best-effort side-effect runner directly,
 * using minimal fakes so no database or full executor is needed.
 */

import { describe, expect, it } from "bun:test";
import type { ActionFlowStarter, ExecuteOptions } from "../src/engine/action-engine-types";
import { runPostCommitRuleEffects } from "../src/engine/action-rule-effects";
import type { ActionResult, Actor } from "../src/types/action";
import type { ExecutionMeta } from "../src/types/execution-meta";
import { createExecutionMeta } from "../src/types/execution-meta";
import type { Logger } from "../src/types/logger";
import type { ExecuteActionEffect, TriggerFlowEffect } from "../src/types/rule";

// ── Test fixtures ────────────────────────────────────────────

const actor: Actor = { type: "human", id: "user-1", groups: ["staff"] };

function makeResolvedMeta(): ExecutionMeta {
  return createExecutionMeta({
    systemKeys: { _channel: "http", _execution_id: "exec-root", _depth: 0 },
  });
}

// ── Fake logger ──────────────────────────────────────────────

interface LogCapture {
  warns: string[];
  errors: string[];
}

function makeLogger(cap: LogCapture): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: (msg) => cap.warns.push(msg),
    error: (msg) => cap.errors.push(msg),
  };
}

// ── Fake execute function ────────────────────────────────────

interface ExecuteCall {
  actionName: string;
  input: Record<string, unknown>;
  actor: Actor;
  options: ExecuteOptions | undefined;
}

type FakeExecuteResult = { success: boolean; data?: unknown; executionId: string };

/**
 * Build a fake `execute` function that captures calls and either returns a
 * provided result or throws when the action name appears in `throwOn`.
 */
function makeFakeExecute(
  cap: ExecuteCall[],
  opts: {
    result?: FakeExecuteResult;
    throwOn?: string[];
  } = {},
): (
  actionName: string,
  input: Record<string, unknown>,
  actor: Actor,
  options?: ExecuteOptions,
) => Promise<ActionResult> {
  return async (actionName, input, callerActor, options) => {
    if (opts.throwOn?.includes(actionName)) {
      throw new Error(`simulated failure in ${actionName}`);
    }
    cap.push({ actionName, input, actor: callerActor, options });
    return opts.result ?? { success: true, executionId: "child-exec-1" };
  };
}

// ── Fake flow starter ────────────────────────────────────────

interface FlowCall {
  flowName: string;
  input: Record<string, unknown>;
  tenantId: string | undefined;
  actor: Actor | undefined;
}

function makeFakeFlowStarter(
  cap: FlowCall[],
  opts: { throwOn?: string[] } = {},
): ActionFlowStarter {
  return {
    startFlow: async (flowName, input, options) => {
      if (opts.throwOn?.includes(flowName)) {
        throw new Error(`simulated flow failure for ${flowName}`);
      }
      cap.push({
        flowName,
        input,
        tenantId: options?.tenantId,
        actor: options?.actor,
      });
      return { id: "flow-1" };
    },
  };
}

// ── Helper: build minimal args ───────────────────────────────

function baseArgs(overrides: Partial<Parameters<typeof runPostCommitRuleEffects>[0]> = {}) {
  return {
    pendingActions: [] as ExecuteActionEffect[],
    pendingFlows: [] as TriggerFlowEffect[],
    execute: makeFakeExecute([]),
    flowEngine: undefined as ActionFlowStarter | undefined,
    logger: makeLogger({ warns: [], errors: [] }),
    actionName: "submit_order",
    actor,
    effectiveInput: { orderId: "o-1", amount: 100 },
    resolvedMeta: makeResolvedMeta(),
    currentDepth: 0,
    tenantId: "tenant-abc",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe("runPostCommitRuleEffects", () => {
  describe("execute_action effects", () => {
    it("invokes the executor once for a single execute_action effect", async () => {
      const calls: ExecuteCall[] = [];
      const effect: ExecuteActionEffect = {
        type: "execute_action",
        action: "notify_user",
        params: { userId: "u-99", channel: "email" },
      };

      await runPostCommitRuleEffects(
        baseArgs({
          pendingActions: [effect],
          execute: makeFakeExecute(calls),
        }),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].actionName).toBe("notify_user");
      expect(calls[0].input).toEqual({ userId: "u-99", channel: "email" });
    });

    it("defaults params to effectiveInput when the effect omits params", async () => {
      const calls: ExecuteCall[] = [];
      const effectiveInput = { orderId: "o-1", amount: 200 };
      const effect: ExecuteActionEffect = {
        type: "execute_action",
        action: "archive_order",
        // params deliberately omitted
      };

      await runPostCommitRuleEffects(
        baseArgs({
          pendingActions: [effect],
          execute: makeFakeExecute(calls),
          effectiveInput,
        }),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].input).toEqual(effectiveInput);
    });

    it("forwards the actor unchanged to child executions", async () => {
      const calls: ExecuteCall[] = [];
      const childActor: Actor = { type: "service", id: "svc-42", groups: [] };
      const effect: ExecuteActionEffect = {
        type: "execute_action",
        action: "log_event",
        params: { event: "created" },
      };

      await runPostCommitRuleEffects(
        baseArgs({
          pendingActions: [effect],
          execute: makeFakeExecute(calls),
          actor: childActor,
        }),
      );

      expect(calls[0].actor).toEqual(childActor);
    });

    it("forwards tenantId to child executions", async () => {
      const calls: ExecuteCall[] = [];
      const effect: ExecuteActionEffect = {
        type: "execute_action",
        action: "send_receipt",
        params: {},
      };

      await runPostCommitRuleEffects(
        baseArgs({
          pendingActions: [effect],
          execute: makeFakeExecute(calls),
          tenantId: "tenant-xyz",
        }),
      );

      expect(calls[0].options?.tenantId).toBe("tenant-xyz");
    });

    it("forwards incremented depth to child executions via options._depth", async () => {
      const calls: ExecuteCall[] = [];
      const effect: ExecuteActionEffect = {
        type: "execute_action",
        action: "cascade_action",
        params: { foo: "bar" },
      };

      await runPostCommitRuleEffects(
        baseArgs({
          pendingActions: [effect],
          execute: makeFakeExecute(calls),
          currentDepth: 2,
        }),
      );

      // Child should receive depth = currentDepth + 1 = 3
      expect(calls[0].options?._depth).toBe(3);
    });

    it("stamps _depth and _source_action in the child meta", async () => {
      const calls: ExecuteCall[] = [];
      const effect: ExecuteActionEffect = {
        type: "execute_action",
        action: "side_effect_action",
        params: {},
      };

      await runPostCommitRuleEffects(
        baseArgs({
          pendingActions: [effect],
          execute: makeFakeExecute(calls),
          actionName: "submit_order",
          currentDepth: 1,
        }),
      );

      const childMeta = calls[0].options?.meta as ExecutionMeta | undefined;
      expect(childMeta).toBeDefined();
      // The child meta must carry the incremented depth and source action.
      // extendExecutionMeta stamps them as system overrides, so they appear in toJSON().
      const json = (childMeta as ExecutionMeta).toJSON();
      expect(json._depth).toBe(2);
      expect(json._source_action).toBe("submit_order");
    });
  });

  describe("trigger_flow effects", () => {
    it("invokes the flow starter once for a single trigger_flow effect", async () => {
      const flowCalls: FlowCall[] = [];
      const effect: TriggerFlowEffect = {
        type: "trigger_flow",
        flow: "onboarding_flow",
        input: { userId: "u-1" },
      };

      await runPostCommitRuleEffects(
        baseArgs({
          pendingFlows: [effect],
          flowEngine: makeFakeFlowStarter(flowCalls),
        }),
      );

      expect(flowCalls).toHaveLength(1);
      expect(flowCalls[0].flowName).toBe("onboarding_flow");
      expect(flowCalls[0].input).toEqual({ userId: "u-1" });
    });

    it("defaults flow input to effectiveInput when the effect omits input", async () => {
      const flowCalls: FlowCall[] = [];
      const effectiveInput = { orderId: "o-2", region: "eu" };
      const effect: TriggerFlowEffect = {
        type: "trigger_flow",
        flow: "fulfillment_flow",
        // input deliberately omitted
      };

      await runPostCommitRuleEffects(
        baseArgs({
          pendingFlows: [effect],
          flowEngine: makeFakeFlowStarter(flowCalls),
          effectiveInput,
        }),
      );

      expect(flowCalls[0].input).toEqual(effectiveInput);
    });

    it("forwards tenantId and actor to the flow starter", async () => {
      const flowCalls: FlowCall[] = [];
      const flowActor: Actor = { type: "human", id: "u-9", groups: ["admin"] };
      const effect: TriggerFlowEffect = {
        type: "trigger_flow",
        flow: "approval_flow",
        input: {},
      };

      await runPostCommitRuleEffects(
        baseArgs({
          pendingFlows: [effect],
          flowEngine: makeFakeFlowStarter(flowCalls),
          tenantId: "tenant-T1",
          actor: flowActor,
        }),
      );

      expect(flowCalls[0].tenantId).toBe("tenant-T1");
      expect(flowCalls[0].actor).toEqual(flowActor);
    });

    it("logs a warning and skips when flowEngine is undefined", async () => {
      const warns: string[] = [];
      const effect: TriggerFlowEffect = {
        type: "trigger_flow",
        flow: "missing_engine_flow",
        input: {},
      };

      await runPostCommitRuleEffects(
        baseArgs({
          pendingFlows: [effect],
          flowEngine: undefined,
          logger: makeLogger({ warns, errors: [] }),
          actionName: "submit_order",
        }),
      );

      // The function should NOT throw and should emit exactly one warning.
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("missing_engine_flow");
      expect(warns[0]).toContain("submit_order");
    });
  });

  describe("multiple effects — ordering", () => {
    it("runs all execute_action effects in order", async () => {
      const calls: ExecuteCall[] = [];
      const effects: ExecuteActionEffect[] = [
        { type: "execute_action", action: "alpha", params: { step: 1 } },
        { type: "execute_action", action: "beta", params: { step: 2 } },
        { type: "execute_action", action: "gamma", params: { step: 3 } },
      ];

      await runPostCommitRuleEffects(
        baseArgs({
          pendingActions: effects,
          execute: makeFakeExecute(calls),
        }),
      );

      expect(calls).toHaveLength(3);
      expect(calls.map((c) => c.actionName)).toEqual(["alpha", "beta", "gamma"]);
    });

    it("runs all trigger_flow effects in order", async () => {
      const flowCalls: FlowCall[] = [];
      const effects: TriggerFlowEffect[] = [
        { type: "trigger_flow", flow: "flow_a", input: { n: 1 } },
        { type: "trigger_flow", flow: "flow_b", input: { n: 2 } },
      ];

      await runPostCommitRuleEffects(
        baseArgs({
          pendingFlows: effects,
          flowEngine: makeFakeFlowStarter(flowCalls),
        }),
      );

      expect(flowCalls).toHaveLength(2);
      expect(flowCalls.map((f) => f.flowName)).toEqual(["flow_a", "flow_b"]);
    });
  });

  describe("best-effort error isolation", () => {
    it("does not propagate a thrown error from execute_action and still runs subsequent effects", async () => {
      const calls: ExecuteCall[] = [];
      const warns: string[] = [];
      // "failing_action" throws; "succeeding_action" must still run.
      const effects: ExecuteActionEffect[] = [
        { type: "execute_action", action: "failing_action", params: {} },
        { type: "execute_action", action: "succeeding_action", params: { after: "fail" } },
      ];

      await expect(
        runPostCommitRuleEffects(
          baseArgs({
            pendingActions: effects,
            execute: makeFakeExecute(calls, { throwOn: ["failing_action"] }),
            logger: makeLogger({ warns, errors: [] }),
          }),
        ),
      ).resolves.toBeUndefined(); // must not throw

      // The second effect must have run.
      expect(calls.map((c) => c.actionName)).toEqual(["succeeding_action"]);
      // A warning must have been emitted for the failing effect.
      expect(warns.some((w) => w.includes("failing_action"))).toBe(true);
    });

    it("does not propagate a failure result from execute_action and still runs subsequent effects", async () => {
      const calls: ExecuteCall[] = [];
      const warns: string[] = [];
      // First action returns { success: false }, second should still run.
      const failResult: ActionResult = {
        success: false,
        data: { error: "constraint_violation" },
        executionId: "child-fail-1",
      };
      let callCount = 0;
      const execute = async (
        actionName: string,
        input: Record<string, unknown>,
        callerActor: Actor,
        options?: ExecuteOptions,
      ): Promise<ActionResult> => {
        callCount++;
        calls.push({ actionName, input, actor: callerActor, options });
        if (callCount === 1) return failResult;
        return { success: true, executionId: "child-ok-2" };
      };

      const effects: ExecuteActionEffect[] = [
        { type: "execute_action", action: "check_stock", params: {} },
        { type: "execute_action", action: "reserve_stock", params: {} },
      ];

      await expect(
        runPostCommitRuleEffects(
          baseArgs({
            pendingActions: effects,
            execute,
            logger: makeLogger({ warns, errors: [] }),
          }),
        ),
      ).resolves.toBeUndefined();

      expect(calls).toHaveLength(2);
      // A warning should have been emitted for the unsuccessful first call.
      expect(warns.some((w) => w.includes("check_stock"))).toBe(true);
    });

    it("does not propagate a thrown error from trigger_flow and still runs subsequent flow effects", async () => {
      const flowCalls: FlowCall[] = [];
      const warns: string[] = [];
      const effects: TriggerFlowEffect[] = [
        { type: "trigger_flow", flow: "exploding_flow", input: {} },
        { type: "trigger_flow", flow: "safe_flow", input: { ok: true } },
      ];

      await expect(
        runPostCommitRuleEffects(
          baseArgs({
            pendingFlows: effects,
            flowEngine: makeFakeFlowStarter(flowCalls, { throwOn: ["exploding_flow"] }),
            logger: makeLogger({ warns, errors: [] }),
          }),
        ),
      ).resolves.toBeUndefined();

      // "safe_flow" must have run despite "exploding_flow" throwing.
      expect(flowCalls.map((f) => f.flowName)).toEqual(["safe_flow"]);
      expect(warns.some((w) => w.includes("exploding_flow"))).toBe(true);
    });
  });

  describe("empty effect lists", () => {
    it("is a no-op when both pendingActions and pendingFlows are empty", async () => {
      const calls: ExecuteCall[] = [];
      const flowCalls: FlowCall[] = [];

      await runPostCommitRuleEffects(
        baseArgs({
          pendingActions: [],
          pendingFlows: [],
          execute: makeFakeExecute(calls),
          flowEngine: makeFakeFlowStarter(flowCalls),
        }),
      );

      expect(calls).toHaveLength(0);
      expect(flowCalls).toHaveLength(0);
    });
  });
});
