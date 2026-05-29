/**
 * Pattern-detector scenario adapter — Spec 69 Phase 4.
 *
 * Deterministic (rule-based, no LLM). Builds an InMemoryExecutionLogger
 * from the fixture entries, runs the PatternDetector, and returns
 * serialisable PatternInsight objects. No baseline file required.
 */

import type { ActorType } from "@linchkit/core";
import { InMemoryExecutionLogger } from "@linchkit/core/server";
import type {
  PatternEvalOutput,
  PatternExecLogInput,
  PatternFixtureContext,
  PatternFixtureInput,
  ScenarioAdapter,
} from "@linchkit/devtools";
import {
  PatternDetector,
  type PatternDetectorConfig,
  type PatternType,
} from "../src/pattern-detector";

/** Core `ActorType` literals — used to narrow fixture-supplied actor types. */
const ACTOR_TYPES: readonly ActorType[] = ["human", "ai", "system", "worker", "timer", "external"];

/** Detector `PatternType` literals — used to narrow fixture-supplied pattern names. */
const PATTERN_TYPES: readonly PatternType[] = [
  "repetitive_action",
  "default_value",
  "validation_pattern",
  "state_flow",
  "timing",
];

/**
 * Coerce a fixture-supplied actor type string to a valid core `ActorType`.
 *
 * Fixtures author actors as plain `{ id, type }` JSON, so `type` is an
 * unconstrained string. Map the common `"user"` alias to the canonical
 * `"human"` actor, pass through any valid `ActorType`, and fall back to
 * `"system"` for anything else so the logger always receives a valid `Actor`.
 */
function coerceActorType(type: string): ActorType {
  if (type === "user") return "human";
  return (ACTOR_TYPES as readonly string[]).includes(type) ? (type as ActorType) : "system";
}

/**
 * Narrow the fixture's `enabledPatterns: string[]` to the detector's
 * `PatternType[]`. Fail loud on unknown names: a fixture typo (e.g.
 * `"stateflow"` instead of `"state_flow"`) would otherwise silently drop the
 * pattern and yield a false-green eval. `undefined` is passed through
 * unchanged — that path means "use the detector defaults" and is legitimate.
 */
export function coerceEnabledPatterns(patterns: string[] | undefined): PatternType[] | undefined {
  if (!patterns) return undefined;
  const valid = PATTERN_TYPES as readonly string[];
  const unknown = patterns.filter((p) => !valid.includes(p));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown pattern type(s) in fixture enabledPatterns: ${unknown.join(", ")}. ` +
        `Valid: ${PATTERN_TYPES.join(", ")}`,
    );
  }
  return patterns as PatternType[];
}

async function runPatternDetector(
  input: PatternFixtureInput,
  _context: PatternFixtureContext | undefined,
): Promise<PatternEvalOutput> {
  const logger = new InMemoryExecutionLogger();

  for (const entry of input.entries as PatternExecLogInput[]) {
    logger.log({
      id: entry.id,
      action: entry.action,
      entity: entry.entity,
      capability: entry.capability,
      status: entry.status,
      input: entry.input,
      tenantId: entry.tenantId,
      actor: { id: entry.actor.id, type: coerceActorType(entry.actor.type), groups: [] },
      // `recordId` + `stateTransition` are top-level fields the detector reads
      // for state_flow analysis (it groups transitions by `entity::recordId`).
      // Map them straight through; they are `undefined` for non-state-flow
      // fixtures, which the detector skips.
      recordId: entry.recordId,
      stateTransition: entry.stateTransition,
      startedAt: new Date(entry.timestamp),
      duration: 0,
    });
  }

  // PatternDetector computes its lookback window as `new Date() - lookbackDays`
  // (wall clock; it has no injectable clock unlike AnomalyDetector), so
  // `context.now` cannot deterministically anchor the window here. Instead,
  // default to a very large lookback so fixed-date fixture entries always stay
  // in-window regardless of when the test runs. Build a NEW config object —
  // never mutate the caller's `input.config` (fixtures may be reused).
  //
  // Only copy keys the fixture actually set: the detector merges this over its
  // own DEFAULT_CONFIG, so an explicit `undefined` here would clobber a default
  // (e.g. `enabledPatterns`) rather than fall back to it.
  const config = input.config ?? {};
  const detectorConfig: PatternDetectorConfig = {
    lookbackDays: config.lookbackDays ?? 3650,
  };
  if (config.minOccurrences !== undefined) detectorConfig.minOccurrences = config.minOccurrences;
  if (config.minConfidence !== undefined) detectorConfig.minConfidence = config.minConfidence;
  if (config.maxExamples !== undefined) detectorConfig.maxExamples = config.maxExamples;
  const enabledPatterns = coerceEnabledPatterns(config.enabledPatterns);
  if (enabledPatterns !== undefined) detectorConfig.enabledPatterns = enabledPatterns;
  const detector = new PatternDetector(detectorConfig);

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
      return await runPatternDetector(fx.input, fx.context);
    },
    async replayFromBaseline(fx, _baseline) {
      // Deterministic rule-based scenario: recompute from the fixture and
      // ignore the baseline. `await` the async detector so callers receive
      // the resolved array, not a Promise.
      return await runPatternDetector(fx.input, fx.context);
    },
  };
}
