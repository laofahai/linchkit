/**
 * Tests for the watcher-engine scenario adapter.
 *
 * Deterministic (no LLM). Verifies correct wiring of WatcherEngine,
 * WatcherDefInput → WatcherDefinition conversion, and output serialisation.
 */

import { describe, expect, it } from "bun:test";
import type {
  EvalFixture,
  WatcherEvalOutput,
  WatcherFixtureContext,
  WatcherFixtureInput,
} from "@linchkit/devtools";
import { createWatcherEngineScenario } from "../../eval-runner/watcher-engine-scenario";

function makeFixture(
  id: string,
  input: WatcherFixtureInput,
  context?: WatcherFixtureContext,
): EvalFixture<WatcherFixtureInput, WatcherFixtureContext> {
  return {
    id,
    scenario: "watcher-engine",
    tags: ["test"],
    description: id,
    input,
    context,
    expected: { matchers: [] },
  };
}

describe("createWatcherEngineScenario.runLive", () => {
  const scenario = createWatcherEngineScenario();

  it("returns empty array when watchers list is empty", async () => {
    const fx = makeFixture("no-watchers", {
      entityName: "order",
      record: { id: "r1", amount: 2000 },
      watchers: [],
    });
    const out = await scenario.runLive(fx);
    expect(out).toEqual([]);
  });

  it("fires threshold watcher when condition is met (amount > 1000)", async () => {
    const fx = makeFixture("threshold-fires", {
      entityName: "order",
      record: { id: "r1", amount: 1500 },
      watchers: [
        {
          name: "high-value-order",
          enabled: true,
          watch: { entity: "order" },
          trigger: { type: "threshold", field: "amount", condition: { gt: 1000 } },
          effect: { action: "notify_manager", params: {} },
        },
      ],
    });
    const out = await scenario.runLive(fx);
    expect(out).toHaveLength(1);
    expect(out[0]?.watcherName).toBe("high-value-order");
    expect(out[0]?.fired).toBe(true);
  });

  it("does not fire threshold watcher when condition is not met", async () => {
    const fx = makeFixture("threshold-no-fire", {
      entityName: "order",
      record: { id: "r1", amount: 500 },
      watchers: [
        {
          name: "high-value-order",
          enabled: true,
          watch: { entity: "order" },
          trigger: { type: "threshold", field: "amount", condition: { gt: 1000 } },
          effect: { action: "notify_manager", params: {} },
        },
      ],
    });
    const out = await scenario.runLive(fx);
    expect(out[0]?.fired).toBe(false);
  });

  it("does not fire watcher for different entity", async () => {
    const fx = makeFixture("wrong-entity", {
      entityName: "order",
      record: { id: "r1", amount: 5000 },
      watchers: [
        {
          name: "invoice-watcher",
          enabled: true,
          watch: { entity: "invoice" }, // watches invoice, not order
          trigger: { type: "threshold", field: "amount", condition: { gt: 100 } },
          effect: { action: "flag_invoice", params: {} },
        },
      ],
    });
    const out = await scenario.runLive(fx);
    // No results: entity mismatch means getForEntity returns empty list
    expect(out).toHaveLength(0);
  });

  it("does not fire disabled watcher", async () => {
    const fx = makeFixture("disabled", {
      entityName: "order",
      record: { id: "r1", amount: 5000 },
      watchers: [
        {
          name: "disabled-watcher",
          enabled: false,
          watch: { entity: "order" },
          trigger: { type: "threshold", field: "amount", condition: { gt: 100 } },
          effect: { action: "notify", params: {} },
        },
      ],
    });
    const out = await scenario.runLive(fx);
    // Disabled watchers are excluded from getEnabled()
    expect(out).toHaveLength(0);
  });

  it("fires set_change watcher when record enters the filtered set (on=added)", async () => {
    const fx = makeFixture("set-change-added", {
      entityName: "order",
      record: { id: "r1", status: "active" },
      oldRecord: { id: "r1", status: "draft" },
      watchers: [
        {
          name: "activation-watcher",
          enabled: true,
          watch: {
            entity: "order",
            // DeclarativeCondition: field path uses "target." prefix (resolves against ConditionContext)
            filter: { field: "target.status", operator: "eq", value: "active" },
          },
          trigger: { type: "set_change", on: "added" },
          effect: { action: "send_welcome", params: {} },
        },
      ],
    });
    const out = await scenario.runLive(fx);
    expect(out[0]?.watcherName).toBe("activation-watcher");
    expect(out[0]?.fired).toBe(true);
  });

  it("schedule trigger is not reactive (not fired in post-mutation path)", async () => {
    const fx = makeFixture("schedule-not-reactive", {
      entityName: "order",
      record: { id: "r1", amount: 9999 },
      watchers: [
        {
          name: "daily-report",
          enabled: true,
          watch: { entity: "order" },
          trigger: { type: "schedule", cron: "0 9 * * *" },
          effect: { action: "generate_report", params: {} },
        },
      ],
    });
    const out = await scenario.runLive(fx);
    expect(out[0]?.fired).toBe(false);
    expect(out[0]?.reason).toBe("trigger_type_not_reactive");
  });

  it("output items have required serialisable fields", async () => {
    const fx = makeFixture("output-fields", {
      entityName: "order",
      record: { id: "r1", amount: 1500 },
      watchers: [
        {
          name: "test-watcher",
          enabled: true,
          watch: { entity: "order" },
          trigger: { type: "threshold", field: "amount", condition: { gt: 1000 } },
          effect: { action: "notify", params: {} },
        },
      ],
    });
    const out = await scenario.runLive(fx);
    expect(out).toHaveLength(1);
    const item = out[0] as WatcherEvalOutput[0];
    expect(typeof item.watcherName).toBe("string");
    expect(typeof item.fired).toBe("boolean");
  });

  it("multiple watchers: only matching ones fire", async () => {
    const fx = makeFixture("multi-watcher", {
      entityName: "order",
      record: { id: "r1", amount: 1500 },
      watchers: [
        {
          name: "fires-watcher",
          enabled: true,
          watch: { entity: "order" },
          trigger: { type: "threshold", field: "amount", condition: { gt: 1000 } },
          effect: { action: "notify", params: {} },
        },
        {
          name: "nofires-watcher",
          enabled: true,
          watch: { entity: "order" },
          trigger: { type: "threshold", field: "amount", condition: { gt: 2000 } },
          effect: { action: "escalate", params: {} },
        },
      ],
    });
    const out = await scenario.runLive(fx);
    expect(out).toHaveLength(2);
    const fired = out.find((r) => r.watcherName === "fires-watcher");
    const notFired = out.find((r) => r.watcherName === "nofires-watcher");
    expect(fired?.fired).toBe(true);
    expect(notFired?.fired).toBe(false);
  });
});

describe("createWatcherEngineScenario.replayFromBaseline", () => {
  const scenario = createWatcherEngineScenario();

  it("produces same result as runLive (deterministic adapter)", async () => {
    const fx = makeFixture("replay", {
      entityName: "order",
      record: { id: "r1", amount: 1500 },
      watchers: [
        {
          name: "test-watcher",
          enabled: true,
          watch: { entity: "order" },
          trigger: { type: "threshold", field: "amount", condition: { gt: 1000 } },
          effect: { action: "notify", params: {} },
        },
      ],
    });
    const live = await scenario.runLive(fx);
    const replayed = await scenario.replayFromBaseline(fx, null);
    expect(replayed).toEqual(live);
  });
});
