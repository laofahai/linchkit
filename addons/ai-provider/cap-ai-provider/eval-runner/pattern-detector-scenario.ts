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

  // Always default to a large lookback window so fixture entries are always
  // within the detection window regardless of when the test runs (PatternDetector
  // computes the window as new Date() - lookbackDays). Never mutate input.config.
  const config = input.config ?? {};
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
      return runPatternDetector(fx.input, fx.context);
    },
  };
}
