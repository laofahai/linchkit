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
  // Keep replays deterministic: never fall back to `new Date()` (wall clock).
  // When `context.now` is omitted, anchor the detection window to the latest
  // event timestamp so the fixed-date fixture always stays in-window — the
  // same intent as the pattern/watcher scenarios, which have no wall-clock
  // dependence at all.
  const now = context?.now ? new Date(context.now) : latestEventDate(input.events);
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

/**
 * Deterministic clock for fixtures that omit `context.now`: the most recent
 * event timestamp. Falls back to the Unix epoch only when there are no events
 * (in which case the detector short-circuits on `minEventsForDetection`).
 */
function latestEventDate(events: AnomalyFixtureInput["events"]): Date {
  let latest = 0;
  for (const event of events) {
    const t = new Date(event.timestamp).getTime();
    if (!Number.isNaN(t) && t > latest) latest = t;
  }
  return new Date(latest);
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
    replayFromBaseline(fx, _baseline) {
      return runDetector(fx.input, fx.context);
    },
  };
}
