/**
 * EvolutionCycle — end-to-end orchestrator (Spec 55 §2.2).
 *
 * Wires the full pipeline: Sense → Memory → Awareness → Insight.
 * A single `runCycle()` call:
 *   1. Collects signals from all registered sensors (SignalBus)
 *   2. Ingests each signal into Memory (MemoryEngine)
 *   3. Feeds each signal into Awareness (AwarenessEngine)
 *   4. Detects drift and records candidates (MemoryEngine → InsightEngine)
 *   5. Generates and promotes Insights (InsightEngine)
 */

import type {
  AwarenessEngine,
  EvolutionCycle,
  EvolutionCycleResult,
  SensorContext,
} from "../types/life-system";
import type { InsightEngineOptions } from "./insight-engine";
import { createInsightEngine } from "./insight-engine";
import type { MemoryEngine } from "./memory-engine";
import type { SignalBus } from "./signal-bus";

export interface EvolutionCycleOptions {
  signalBus: SignalBus;
  memoryEngine: MemoryEngine;
  awareness: AwarenessEngine;
  /** Override insight engine promotion config */
  insightPromotion?: InsightEngineOptions["promotion"];
}

export function createEvolutionCycle(opts: EvolutionCycleOptions): EvolutionCycle {
  const { signalBus, memoryEngine, awareness } = opts;

  const insightEngine = createInsightEngine({
    awareness,
    promotion: opts.insightPromotion,
  });

  return {
    get insightEngine() {
      return insightEngine;
    },

    get awarenessEngine() {
      return awareness;
    },

    async runCycle(ctx?: SensorContext): Promise<EvolutionCycleResult> {
      const sensorContext: SensorContext = ctx ?? { timestamp: new Date() };

      // 1. Sense: collect signals from all registered sensors
      const signals = await signalBus.collectSignals(sensorContext);

      let driftsDetected = 0;

      // 2–4. For each signal: Drift check (against old baseline) → Memory ingest → Awareness
      for (const signal of signals) {
        // Detect drift BEFORE ingest — ingest updates the baseline
        const drift = await memoryEngine.detectDrift(signal);
        if (drift.drifted) {
          driftsDetected++;
          insightEngine.recordDriftCandidate(signal, drift.deviation);
        }

        await memoryEngine.ingest(signal);
        awareness.ingestSignal(signal);
      }

      // 5. Insight: generate and promote insights
      const newInsights = await insightEngine.generateInsights();

      return {
        signalsCollected: signals.length,
        driftsDetected,
        newInsights,
        totalInsights: insightEngine.getInsights().length,
      };
    },
  };
}
