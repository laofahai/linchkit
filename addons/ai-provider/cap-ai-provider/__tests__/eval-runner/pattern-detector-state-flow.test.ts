/**
 * End-to-end regression guard for pattern-detector `state_flow` fixtures
 * (Issue #393).
 *
 * Loads the committed `state_flow` fixtures from disk, runs each through the
 * production pattern-detector scenario adapter, and applies every fixture's
 * own `expected.matchers` via the matcher registry. This proves the adapter
 * maps the top-level `recordId` / `stateTransition` fields the detector reads
 * for state-flow analysis — without these the matchers can never pass, which
 * is exactly the regression #393 fixes.
 */

import { describe, expect, it } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createMatcherRegistry,
  type EvalFixture,
  loadFixtures,
  type MatcherResult,
  type PatternEvalOutput,
  type PatternFixtureContext,
  type PatternFixtureInput,
  registerPatternMatchers,
} from "@linchkit/devtools";
import { createPatternDetectorScenario } from "../../eval-runner/pattern-detector-scenario";

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../eval/fixtures/pattern-detector/state_flow",
);

const scenario = createPatternDetectorScenario();

/**
 * `pd-sf-5` (two_flows) cannot pass under the current detector algorithm and is
 * excluded here (flagged in #393, not forced). `detectStateFlowPatterns` emits
 * at most ONE state_flow insight per entity — the single dominant path, and
 * only when its frequency clears `minConfidence`. The fixture splits 5 records
 * down `draft→approved` and 5 down `draft→rejected` under the same `request`
 * entity, so the dominant path is 50% (< the 0.7 threshold) and no state_flow
 * insight is produced. Asserting "two distinct state_flow patterns" requires a
 * per-path enumeration the detector does not implement; changing that is out of
 * scope for the adapter-wiring fix.
 */
const CANNOT_PASS_FIXTURE_IDS = new Set(["pd-sf-5"]);

// `registerPatternMatchers` accepts the scenario-agnostic `MatcherRegistry`
// (i.e. `MatcherRegistry<unknown>`), so the registry is created untyped and the
// `PatternEvalOutput` is passed to `invoke` (whose `output` param is `unknown`).
function makeRegistry() {
  const registry = createMatcherRegistry();
  registerPatternMatchers(registry);
  return registry;
}

async function runFixtureMatchers(
  fx: EvalFixture<PatternFixtureInput, PatternFixtureContext>,
): Promise<MatcherResult[]> {
  const output: PatternEvalOutput = await scenario.runLive(fx);
  const registry = makeRegistry();
  return fx.expected.matchers.map((m) => registry.invoke(m, output));
}

describe("pattern-detector state_flow fixtures (Issue #393)", () => {
  it("loads every committed state_flow fixture from disk", async () => {
    const fixtures = await loadFixtures<PatternFixtureInput, PatternFixtureContext>({
      fixturesDir: FIXTURES_DIR,
      scenario: "pattern-detector",
    });
    // 4 positive flows (pd-sf-1/4/5/6) + 2 negatives (pd-sf-2/3).
    expect(fixtures.length).toBe(6);
    expect(fixtures.every((f) => f.expected.matchers.length > 0)).toBe(true);
  });

  it("every supported state_flow fixture passes all of its strict matchers", async () => {
    const fixtures = (
      await loadFixtures<PatternFixtureInput, PatternFixtureContext>({
        fixturesDir: FIXTURES_DIR,
        scenario: "pattern-detector",
      })
    ).filter((f) => !CANNOT_PASS_FIXTURE_IDS.has(f.id));

    // pd-sf-1, pd-sf-2, pd-sf-3, pd-sf-4, pd-sf-6 (pd-sf-5 is flagged above).
    expect(fixtures.length).toBe(5);

    for (const fx of fixtures) {
      const results = await runFixtureMatchers(fx);
      const strictFailures = results.filter((r) => r.strict && !r.passed);
      expect({ fixture: fx.id, failures: strictFailures }).toEqual({
        fixture: fx.id,
        failures: [],
      });
    }
  });

  it("multi_step_flow (pd-sf-4) detects a single state_flow pattern", async () => {
    const fixtures = await loadFixtures<PatternFixtureInput, PatternFixtureContext>({
      fixturesDir: FIXTURES_DIR,
      scenario: "pattern-detector",
      fixtureFilter: "pd-sf-4",
    });
    expect(fixtures.length).toBe(1);
    const fx = fixtures[0];
    if (!fx) throw new Error("pd-sf-4 fixture not found");

    const output = await scenario.runLive(fx);
    const stateFlow = output.filter((p) => p.type === "state_flow");
    expect(stateFlow.length).toBe(1);
    // 6 contracts all follow draft→reviewed→approved→closed → 100% confidence.
    expect(stateFlow[0]?.confidence).toBe(1);
  });
});
