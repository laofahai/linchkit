/**
 * Watcher-engine scenario adapter — Spec 69 Phase 4.
 *
 * Deterministic (rule-based, no LLM). Converts WatcherDefInput fixtures into
 * real WatcherDefinition objects, registers them, runs evaluateAfterMutation,
 * and returns serialisable WatcherEvalOutputItem results. No baseline needed.
 */

import type { DeclarativeCondition, WatcherDefinition, WatcherTrigger } from "@linchkit/core";
import { createWatcherRegistry } from "@linchkit/core/server";
import type {
  ScenarioAdapter,
  WatcherDefInput,
  WatcherEvalOutput,
  WatcherFixtureContext,
  WatcherFixtureInput,
} from "@linchkit/devtools";
import { createWatcherEngine } from "../src/watcher-engine";

function toWatcherDefinition(def: WatcherDefInput): WatcherDefinition {
  const trigger = buildTrigger(def);
  return {
    name: def.name,
    label: def.label,
    enabled: def.enabled ?? true,
    watch: {
      entity: def.watch.entity,
      filter: def.watch.filter as DeclarativeCondition | undefined,
    },
    trigger,
    effect: {
      action: def.effect.action,
      params: def.effect.params ?? {},
    },
    tenantScoped: def.tenantScoped,
  };
}

function buildTrigger(def: WatcherDefInput): WatcherTrigger {
  const t = def.trigger;
  switch (t.type) {
    case "threshold":
      return {
        type: "threshold",
        field: t.field,
        condition: t.condition,
        debounce: t.debounce,
        cooldownPeriod: t.cooldownPeriod,
      };
    case "staleness":
      return {
        type: "staleness",
        field: t.field,
        threshold: t.threshold,
        debounce: t.debounce,
        cooldownPeriod: t.cooldownPeriod,
      };
    case "set_change":
      return {
        type: "set_change",
        on: t.on,
        debounce: t.debounce,
        cooldownPeriod: t.cooldownPeriod,
      };
    case "schedule":
      return {
        type: "schedule",
        cron: t.cron,
        debounce: t.debounce,
        cooldownPeriod: t.cooldownPeriod,
      };
  }
}

async function runWatcherEngine(
  input: WatcherFixtureInput,
  _context: WatcherFixtureContext | undefined,
): Promise<WatcherEvalOutput> {
  const registry = createWatcherRegistry();

  for (const def of input.watchers) {
    registry.register(toWatcherDefinition(def));
  }

  const engine = createWatcherEngine({ registry });

  const results = await engine.evaluateAfterMutation(
    input.entityName,
    input.record,
    input.oldRecord,
  );

  return results.map((r) => ({
    watcherName: r.watcherName,
    fired: r.fired,
    reason: r.reason,
    error: r.error,
  }));
}

export type WatcherEngineScenarioAdapter = ScenarioAdapter<
  WatcherFixtureInput,
  WatcherFixtureContext,
  WatcherEvalOutput,
  void
>;

export function createWatcherEngineScenario(): WatcherEngineScenarioAdapter {
  return {
    async runLive(fx) {
      return runWatcherEngine(fx.input, fx.context);
    },
    replayFromBaseline(fx) {
      return runWatcherEngine(fx.input, fx.context);
    },
  };
}
