/**
 * GeneratorPriorityAggregator — Spec 55 §7.7 Phase 3 "generator-priority feedback loop".
 *
 * Adjusts per-generator attention weights based on Proposal accept/reject history
 * so the runtime favours generators whose proposals are consistently accepted.
 *
 * Algorithm: simple linear weight adjustment (§8.6 pattern):
 *   weight += boostOnAccept  for each "accepted" outcome
 *   weight -= decayOnReject  for each "rejected" outcome
 *   weight is clamped to [minWeight, maxWeight]
 *
 * Design constraints:
 *   - Push model (observer pattern) — caller feeds outcome events via observe().
 *   - No MemoryStore dependency — self-contained in-memory state.
 *   - Caller-composed: wire alongside ProposalOutcomeRecorder (Phase 1) so every
 *     recorded outcome is also observed here.
 *   - Tracks weights per (authorId, changeType) pair per §7.7 spec.
 *
 * Caller wiring example (once Phase 1 / Phase 2 PRs merge):
 *   const recorder = createProposalOutcomeRecorder({ store });
 *   const aggregator = createGeneratorPriorityAggregator();
 *   const engine = createProposalEngine({
 *     onApproved: async (p) => {
 *       await recorder.recordOutcome({ proposal: p, outcome: 'accepted' });
 *       aggregator.observe({ authorId: p.author.id, changeType: p.changeType, outcome: 'accepted' });
 *     },
 *     onRejected: async (p) => {
 *       await recorder.recordOutcome({ proposal: p, outcome: 'rejected' });
 *       aggregator.observe({ authorId: p.author.id, changeType: p.changeType, outcome: 'rejected' });
 *     },
 *   });
 */

// ── Outcome type (mirrors Phase 1 ProposalOutcomeType) ───────

/** The four outcome types a Proposal can produce (Spec 55 §7.7). */
export type GeneratorOutcomeType = "accepted" | "rejected" | "merged" | "withdrawn";

// ── Config ────────────────────────────────────────────────────

/**
 * Configuration for weight adjustment (Spec 55 §8.6 attention-budget pattern).
 *
 * Defaults match §8.6 example values (boostOnAccept: 0.2, decayOnIgnore: 0.3).
 */
export interface GeneratorPriorityConfig {
  /** Weight added per accepted outcome (default: 0.2). */
  boostOnAccept?: number;
  /** Weight subtracted per rejected outcome (default: 0.3). */
  decayOnReject?: number;
  /** Starting weight for an unseen generator (default: 1.0). */
  initialWeight?: number;
  /** Floor — weight never falls below this value (default: 0.1). */
  minWeight?: number;
  /** Ceiling — weight never exceeds this value (default: 3.0). */
  maxWeight?: number;
}

// ── Input ──────────────────────────────────────────────────────

/**
 * A single Proposal outcome observation pushed to the aggregator.
 *
 * Intentionally generic — no dependency on Phase 1 ProposalOutcomePayload so
 * this engine is self-contained on main and callers map fields themselves.
 */
export interface OutcomeObservation {
  /** Generator ID — typically `proposal.author.id`. */
  authorId: string;
  /** Change type — typically `proposal.changeType` ("patch" | "minor" | "major"). */
  changeType: string;
  /** Outcome of the proposal. */
  outcome: GeneratorOutcomeType;
}

// ── Weight record ──────────────────────────────────────────────

/** Accumulated statistics and computed weight for one (authorId, changeType) pair. */
export interface GeneratorWeightRecord {
  authorId: string;
  changeType: string;
  acceptedCount: number;
  rejectedCount: number;
  mergedCount: number;
  withdrawnCount: number;
  /** Fraction of decided outcomes that were accepted. 0.5 when no decisions yet. */
  acceptanceRatio: number;
  /** Current computed weight, clamped to [minWeight, maxWeight]. */
  weight: number;
  lastUpdatedAt: Date;
}

// ── Options ────────────────────────────────────────────────────

export interface GeneratorPriorityAggregatorOptions {
  config?: GeneratorPriorityConfig;
}

// ── Internal resolved config ──────────────────────────────────

interface ResolvedConfig {
  boostOnAccept: number;
  decayOnReject: number;
  initialWeight: number;
  minWeight: number;
  maxWeight: number;
}

const DEFAULT_CONFIG: ResolvedConfig = {
  boostOnAccept: 0.2,
  decayOnReject: 0.3,
  initialWeight: 1.0,
  minWeight: 0.1,
  maxWeight: 3.0,
};

// ── GeneratorPriorityAggregator ───────────────────────────────

/**
 * Tracks proposal outcome history per (authorId, changeType) and computes
 * an attention weight for each generator so the runtime can prefer generators
 * with higher acceptance ratios.
 */
export class GeneratorPriorityAggregator {
  private readonly cfg: ResolvedConfig;
  private readonly records: Map<string, GeneratorWeightRecord> = new Map();

  constructor(opts: GeneratorPriorityAggregatorOptions = {}) {
    const c = opts.config ?? {};
    this.cfg = {
      boostOnAccept: c.boostOnAccept ?? DEFAULT_CONFIG.boostOnAccept,
      decayOnReject: c.decayOnReject ?? DEFAULT_CONFIG.decayOnReject,
      initialWeight: c.initialWeight ?? DEFAULT_CONFIG.initialWeight,
      minWeight: c.minWeight ?? DEFAULT_CONFIG.minWeight,
      maxWeight: c.maxWeight ?? DEFAULT_CONFIG.maxWeight,
    };
  }

  /**
   * Push a proposal outcome to the aggregator.
   *
   * Call this alongside `ProposalOutcomeRecorder.recordOutcome()` so the
   * aggregator stays in sync with the Memory-layer event log.
   */
  observe(observation: OutcomeObservation): void {
    const { authorId, changeType, outcome } = observation;
    const key = this.makeKey(authorId, changeType);

    let rec = this.records.get(key);
    if (!rec) {
      rec = this.makeEmptyRecord(authorId, changeType);
      this.records.set(key, rec);
    }

    switch (outcome) {
      case "accepted":
        rec.acceptedCount += 1;
        rec.weight = this.clamp(rec.weight + this.cfg.boostOnAccept);
        break;
      case "rejected":
        rec.rejectedCount += 1;
        rec.weight = this.clamp(rec.weight - this.cfg.decayOnReject);
        break;
      case "merged":
        rec.mergedCount += 1;
        break;
      case "withdrawn":
        rec.withdrawnCount += 1;
        break;
    }

    rec.acceptanceRatio = this.computeAcceptanceRatio(rec);
    rec.lastUpdatedAt = new Date();
  }

  /**
   * Return the attention weight for a generator.
   *
   * If `changeType` is provided, returns the weight for that specific
   * (authorId, changeType) pair.
   *
   * If `changeType` is omitted, returns the average weight across all change
   * types for the given `authorId`. Falls back to `initialWeight` if no
   * observations exist.
   */
  getWeight(authorId: string, changeType?: string): number {
    if (changeType !== undefined) {
      return this.records.get(this.makeKey(authorId, changeType))?.weight ?? this.cfg.initialWeight;
    }

    const authorRecords = [...this.records.values()].filter((r) => r.authorId === authorId);
    if (authorRecords.length === 0) return this.cfg.initialWeight;

    const total = authorRecords.reduce((sum, r) => sum + r.weight, 0);
    return total / authorRecords.length;
  }

  /**
   * Return all weight records, sorted by weight descending.
   * Useful for ranking generators before selecting which to invoke.
   */
  getAll(): GeneratorWeightRecord[] {
    return [...this.records.values()].sort((a, b) => b.weight - a.weight);
  }

  /** Clear all accumulated state. Primarily used in tests. */
  reset(): void {
    this.records.clear();
  }

  // ── Private helpers ─────────────────────────────────────────

  private makeKey(authorId: string, changeType: string): string {
    return `${authorId}::${changeType}`;
  }

  private makeEmptyRecord(authorId: string, changeType: string): GeneratorWeightRecord {
    return {
      authorId,
      changeType,
      acceptedCount: 0,
      rejectedCount: 0,
      mergedCount: 0,
      withdrawnCount: 0,
      acceptanceRatio: 0.5,
      weight: this.cfg.initialWeight,
      lastUpdatedAt: new Date(),
    };
  }

  private computeAcceptanceRatio(rec: GeneratorWeightRecord): number {
    const decisions = rec.acceptedCount + rec.rejectedCount;
    if (decisions === 0) return 0.5;
    return rec.acceptedCount / decisions;
  }

  private clamp(value: number): number {
    return Math.max(this.cfg.minWeight, Math.min(this.cfg.maxWeight, value));
  }
}

// ── Factory ────────────────────────────────────────────────────

/** Create a new GeneratorPriorityAggregator instance. */
export function createGeneratorPriorityAggregator(
  opts: GeneratorPriorityAggregatorOptions = {},
): GeneratorPriorityAggregator {
  return new GeneratorPriorityAggregator(opts);
}
