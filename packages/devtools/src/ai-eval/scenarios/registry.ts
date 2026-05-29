/**
 * Scenario registry — name → adapter map.
 *
 * Each scenario adapter encapsulates the "how do I produce a scenario
 * output from a fixture" logic (live AI call OR replay from recorded
 * baseline). The runner is scenario-agnostic: it asks the registry for
 * an adapter by `fixture.scenario` and trusts the adapter's contract.
 */

import type { BaselineFile, EvalFixture } from "../types";

export interface ScenarioAdapter<
  TInput = unknown,
  TContext = unknown,
  TOutput = unknown,
  TDeps = unknown,
> {
  /** Hit the real AI service and return the scenario output. */
  runLive(fx: EvalFixture<TInput, TContext>, deps: TDeps): Promise<TOutput>;
  /**
   * Reproduce the scenario output without hitting the live AI service.
   *
   * Baseline-backed scenarios (e.g. intent) look up the recorded output
   * in `baseline` and throw when the fixture is absent — spec 69 §6.4
   * demands replay fail loud rather than silently skip. Deterministic
   * rule-based scenarios (anomaly / pattern / watcher) recompute the
   * output from the fixture and ignore `baseline`; those that wrap an
   * async engine return a `Promise`, so the runner always `await`s the
   * result.
   */
  replayFromBaseline(
    fx: EvalFixture<TInput, TContext>,
    baseline: BaselineFile<TOutput> | null,
  ): TOutput | Promise<TOutput>;
}

export interface ScenarioRegistry {
  register<TInput, TContext, TOutput, TDeps>(
    name: string,
    adapter: ScenarioAdapter<TInput, TContext, TOutput, TDeps>,
  ): void;
  get(name: string): ScenarioAdapter | undefined;
  list(): string[];
}

export function createScenarioRegistry(): ScenarioRegistry {
  const adapters = new Map<string, ScenarioAdapter>();
  return {
    register(name, adapter) {
      if (adapters.has(name)) {
        throw new Error(`scenario already registered: ${name}`);
      }
      // Erase generics at the storage layer; the runner re-narrows per call.
      adapters.set(name, adapter as ScenarioAdapter);
    },
    get(name) {
      return adapters.get(name);
    },
    list() {
      return Array.from(adapters.keys());
    },
  };
}
