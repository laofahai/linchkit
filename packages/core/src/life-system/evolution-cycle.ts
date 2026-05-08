/**
 * EvolutionCycle — end-to-end orchestrator (Spec 55 §2.2).
 *
 * Wires the full pipeline: Sense → Memory → Awareness → Insight → Proposal.
 * A single `runCycle()` call:
 *   1. Collects signals from all registered sensors (SignalBus)
 *   2. Ingests each signal into Memory (MemoryEngine)
 *   3. Feeds each signal into Awareness (AwarenessEngine)
 *   4. Detects drift and records candidates (MemoryEngine → InsightEngine)
 *   5. Generates Insights, capped by AwarenessEngine.attentionBudget
 *   6. Translates surfaced Insights into Proposals via the translator
 *      registry, when one is supplied (Spec 55 §7).
 *
 * Slice 3 closes the Insight → Proposal half of the cycle. The pre-analysis
 * pipeline (`proposal-preanalysis/*`, Spec 55 §7.3) is NOT invoked here —
 * proposal validation, dedup, and impact analysis stay separate concerns
 * orchestrated by capabilities (TODO: wire pre-analysis once proposal flow
 * is finalized — Spec 55 §7.3).
 */

import type { OntologyRegistry } from "../ontology/ontology-registry";
import type {
  AwarenessEngine,
  EvolutionCycle,
  EvolutionCycleResult,
  SensorContext,
} from "../types/life-system";
import type { ProposalAuthor, ProposalDefinition } from "../types/proposal";
import type { InsightEngineOptions } from "./insight-engine";
import { createInsightEngine } from "./insight-engine";
import type { InsightTranslatorRegistry, TranslatorContext } from "./insight-to-proposal";
import type { MemoryEngine } from "./memory-engine";
import type { SignalBus } from "./signal-bus";

export interface EvolutionCycleOptions {
  signalBus: SignalBus;
  memoryEngine: MemoryEngine;
  awareness: AwarenessEngine;
  /** Override insight engine promotion config */
  insightPromotion?: InsightEngineOptions["promotion"];
  /**
   * Optional Insight → Proposal translator registry (Spec 55 §7).
   *
   * When supplied, every insight surfaced by `generateInsights` is passed
   * through `registry.translate(insight, ctx)`. Non-null returns are
   * collected into `result.proposals`. When omitted, the cycle behaves as
   * pre-Slice-3 — no proposals emitted, just insights — preserving zero
   * regression for callers that never wired the translator.
   */
  translatorRegistry?: InsightTranslatorRegistry;
  /**
   * Optional ontology forwarded into {@link TranslatorContext}. Lets
   * structural translators (e.g. `schema_no_view`) enrich their default
   * view fields from real entity descriptors. AwarenessEngine consumes the
   * ontology internally but does not re-expose it, so we accept it
   * separately here rather than reaching through the awareness instance.
   */
  ontology?: OntologyRegistry;
  /**
   * Optional capability label stamped onto every translated proposal.
   * Defaults to the translator's own default ("evolution") when omitted.
   */
  proposalCapability?: string;
  /** Optional default author stamped onto every translated proposal. */
  proposalAuthor?: ProposalAuthor;
}

export function createEvolutionCycle(opts: EvolutionCycleOptions): EvolutionCycle {
  const { signalBus, memoryEngine, awareness, translatorRegistry } = opts;

  const insightEngine = createInsightEngine({
    awareness,
    promotion: opts.insightPromotion,
  });

  // Build a TranslatorContext template once. The same instance is reused
  // for every translation in a cycle — translators must not mutate it.
  const translatorCtxTemplate: TranslatorContext = {
    ontology: opts.ontology,
    capability: opts.proposalCapability,
    author: opts.proposalAuthor,
  };

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

      // 5. Insight: generate and promote insights, capped by the attention
      // budget exposed on the AwarenessEngine. Without a budget the engine
      // returns every newly produced insight (legacy behavior).
      const surfacedInsights = await insightEngine.generateInsights({
        budget: awareness.attentionBudget,
      });

      // 6. Proposal: translate ONLY surfaced insights. Budget-dropped
      // insights stay in the unsurfaced pool inside InsightEngine and may
      // surface (and translate) on a later cycle. When no registry is
      // wired, proposals stays empty — preserves pre-Slice-3 contract.
      let proposals: ProposalDefinition[] = [];
      if (translatorRegistry && surfacedInsights.length > 0) {
        const translated = await Promise.all(
          surfacedInsights.map((insight) =>
            translatorRegistry.translate(insight, translatorCtxTemplate),
          ),
        );
        proposals = translated.filter((p): p is ProposalDefinition => p !== null);
      }

      return {
        signalsCollected: signals.length,
        driftsDetected,
        newInsights: surfacedInsights,
        totalInsights: insightEngine.getInsights().length,
        proposals,
      };
    },
  };
}
