/**
 * PatternInsight contract — shared between core's ProposalEngine and the
 * concrete pattern-detection implementation in `@linchkit/cap-ai-provider`.
 *
 * The detection algorithm itself lives in `cap-ai-provider`
 * (Spec 56 Phase 2 Step 2c — `PatternDetector` was moved out of core), but
 * `ProposalEngine.createFromInsight()` still has to accept the resulting
 * shape. Putting the data contract in core keeps the engine API intact
 * without forcing core to depend on the capability.
 */

import type { ProposalDraft } from "./proposal-engine";

/** Categories of pattern that an Awareness-layer detector may surface. */
export type PatternType =
  | "repetitive_action"
  | "default_value"
  | "validation_pattern"
  | "state_flow"
  | "timing";

/** Evidence supporting a detected pattern. */
export interface PatternEvidence {
  /** Number of occurrences observed. */
  count: number;
  /** Human-readable timespan (e.g. "7 days", "30 days"). */
  timespan: string;
  /** Sample data points illustrating the pattern. */
  examples: unknown[];
}

/**
 * A detected pattern insight ready for proposal generation.
 *
 * Concrete pattern detectors (e.g. cap-ai-provider's `PatternDetector`)
 * produce values matching this shape; `ProposalEngine.createFromInsight()`
 * consumes them. Capabilities are free to extend the shape — only the
 * fields below are part of the contract with core.
 */
export interface PatternInsight {
  /** Unique insight identifier. */
  id: string;
  /** Type of pattern detected. */
  type: PatternType;
  /** Entity name this pattern relates to. */
  entity: string;
  /** Human-readable description of the pattern. */
  description: string;
  /** Confidence score, 0–1. */
  confidence: number;
  /** Supporting evidence. */
  evidence: PatternEvidence;
  /** Suggested change based on this pattern. */
  suggestedAction: ProposalDraft;
}
