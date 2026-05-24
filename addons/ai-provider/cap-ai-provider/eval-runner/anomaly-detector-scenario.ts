/**
 * Anomaly-detector scenario adapter — Spec 69 Phase 4.
 *
 * Deterministic (no LLM). Both `runLive` and `replayFromBaseline`
 * instantiate a fresh AnomalyDetector with the fixture config, feed
 * the fixture events, and return the detected anomalies. No baseline
 * file required — the output is reproducible from the fixture alone.
 */

import type {
  AnomalyEvalOutput,
  AnomalyFixtureContext,
  AnomalyFixtureInput,
  ScenarioAdapter,
} from "@linchkit/devtools";
import { AnomalyDetector } from "../src/anomaly-detector";

function runDetector(
  input: AnomalyFixtureInput,
  context: AnomalyFixtureContext | undefined,
): AnomalyEvalOutput {
  const detector = new AnomalyDetector(input.config);
  for (const event of input.events) {
    detector.recordEvent({
      ...event,
      timestamp: new Date(event.timestamp),
    });
  }
  const now = context?.now ? new Date(context.now) : new Date();
  const anomalies = detector.detect({
    now,
    tenantId: context?.tenantId,
    actorId: context?.actorId,
  });
  return anomalies.map((a) => ({
    type: a.type,
    severity: a.severity,
    description: a.description,
    tenantId: a.tenantId,
    actorId: a.actorId,
    metrics: a.metrics,
    thresholds: a.thresholds,
  }));
}

export type AnomalyDetectorScenarioAdapter = ScenarioAdapter<
  AnomalyFixtureInput,
  AnomalyFixtureContext,
  AnomalyEvalOutput,
  void
>;

export function createAnomalyDetectorScenario(): AnomalyDetectorScenarioAdapter {
  return {
    async runLive(fx) {
      return runDetector(fx.input, fx.context);
    },
    replayFromBaseline(fx) {
      return runDetector(fx.input, fx.context);
    },
  };
}
