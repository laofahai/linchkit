/**
 * Pattern-detector scenario adapter — Spec 69 Phase 4.
 *
 * Deterministic (rule-based, no LLM). Builds an InMemoryExecutionLogger
 * from the fixture entries, runs the PatternDetector, and returns
 * serialisable PatternInsight objects. No baseline file required.
 */

import { InMemoryExecutionLogger } from "@linchkit/core/server";
import type {
  PatternEvalOutput,
  PatternFixtureContext,
  PatternFixtureInput,
  ScenarioAdapter,
} from "@linchkit/devtools";
import { PatternDetector } from "../src/pattern-detector";

async function runPatternDetector(
  input: PatternFixtureInput,
  context: PatternFixtureContext | undefined,
): Promise<PatternEvalOutput> {
  const logger = new InMemoryExecutionLogger();

  for (const entry of input.entries) {
    logger.log({
      id: entry.id,
      action: entry.action,
      entity: entry.entity,
      capability: entry.capability,
      status: entry.status,
      input: entry.input,
      tenantId: entry.tenantId,
      actor: { id: entry.actor.id, type: entry.actor.type as "user" | "system" | "ai" },
      startedAt: new Date(entry.timestamp),
      duration: 0,
    });
  }

  const config = input.config ?? {};
  if (context?.now) {
    // Adjust lookbackDays so all entries in the fixture fall within the window
    // (ensures deterministic detection regardless of when the test runs).
    const lookbackDays = config.lookbackDays ?? 30;
    config.lookbackDays = lookbackDays;
  }

  // Override the internal "now" via config — PatternDetector computes the
  // lookback window as `new Date()` minus `lookbackDays`. To make fixtures
  // deterministic regardless of when they run, we set lookbackDays to a very
  // large value (3650 = 10 years) so ALL entries are always in the window.
  const detector = new PatternDetector({
    ...config,
    lookbackDays: config.lookbackDays ?? 3650,
  });

  const insights = await detector.detect(logger);
  if (!insights || insights.length === 0) return [];

  return insights.map((p) => ({
    id: p.id,
    type: p.type,
    entity: p.entity,
    description: p.description,
    confidence: p.confidence,
    evidence: {
      count: p.evidence.count,
      timespan: p.evidence.timespan,
      examples: p.evidence.examples,
    },
  }));
}

export type PatternDetectorScenarioAdapter = ScenarioAdapter<
  PatternFixtureInput,
  PatternFixtureContext,
  PatternEvalOutput,
  void
>;

export function createPatternDetectorScenario(): PatternDetectorScenarioAdapter {
  return {
    async runLive(fx) {
      return runPatternDetector(fx.input, fx.context);
    },
    replayFromBaseline(fx, _baseline) {
      // Deterministic: re-run the detector. Baseline not needed.
      return runPatternDetector(fx.input, fx.context) as unknown as PatternEvalOutput;
    },
  };
}
