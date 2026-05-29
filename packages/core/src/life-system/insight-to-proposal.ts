/**
 * InsightTranslator — Spec 55 §7 Insight → Proposal bridge.
 *
 * A registry of per-insight-kind translators. Each translator converts an
 * evidence-backed Insight into a ProposalDefinition the rest of the proposal
 * pipeline (validate → preanalyse → approve → commit) can consume.
 *
 * Slice 1 ships the contract plus ONE deterministic translator
 * (structural `schema_no_view` → `add_view`). AI-backed translators will be
 * registered later via capability extensions (mirrors `extensions.sensors`).
 */

import { ROLLBACK_CANDIDATE_TAG } from "../engine/rollback-insight-emitter";
import type { OntologyRegistry } from "../ontology/ontology-registry";
import type { Insight, InsightEvidence, InsightType } from "../types/life-system";
import type {
  ProposalAuthor,
  ProposalChange,
  ProposalDefinition,
  SuccessMetric,
} from "../types/proposal";
import type { ViewDefinition } from "../types/view";

// ── Translator key ──────────────────────────────────────────

/**
 * Key used to look up a translator. Built from `Insight.type` plus an
 * insight-type-specific discriminator.
 *
 * - `structural` insights discriminate on `evidence.context.kind`
 *   (one of {@link import("../types/life-system").StructuralIssueKind}).
 * - Insights tagged `rollback_candidate` (Spec 55 §7.7 Phase 2) discriminate
 *   on that tag, yielding `\`${type}:rollback_candidate\`` (e.g.
 *   `anomaly:rollback_candidate`) so a dedicated rollback translator handles
 *   them WITHOUT hijacking ordinary anomaly insights.
 * - All other non-structural insights fall back to `Insight.type` alone for
 *   now; later slices may refine (e.g. anomaly + sensor name).
 */
export type InsightTranslatorKey = string;

/** Build the lookup key for an insight. */
export function insightTranslatorKey(insight: Insight): InsightTranslatorKey {
  if (insight.type === "structural") {
    const kind = (insight.evidence.context as { kind?: unknown }).kind;
    if (typeof kind === "string" && kind.length > 0) {
      return `structural:${kind}`;
    }
    return "structural:unknown";
  }
  // Rollback-candidate insights route to a dedicated translator. The tag is the
  // sole discriminator so ordinary `anomaly` insights (no tag) still key on the
  // bare type and are unaffected.
  if (insight.tags?.includes(ROLLBACK_CANDIDATE_TAG)) {
    return `${insight.type}:${ROLLBACK_CANDIDATE_TAG}`;
  }
  return insight.type;
}

// ── Translator context ──────────────────────────────────────

/**
 * Context passed into every translator invocation.
 * Optional fields let tests stub deterministic ids/timestamps; production
 * code wires the real OntologyRegistry so translators can introspect
 * existing entities/views/fields when needed.
 */
export interface TranslatorContext {
  /** Optional ontology lookup. Required by translators that need to
   *  introspect existing entities (e.g. infer view fields). */
  ontology?: OntologyRegistry;
  /** Capability the proposal will target. Defaults to "evolution". */
  capability?: string;
  /** Author attached to the proposal. Defaults to the system bot. */
  author?: ProposalAuthor;
  /** Clock override (tests). */
  now?: () => Date;
  /** ID generator override (tests). */
  idGenerator?: () => string;
}

/** Default author used when context omits one. */
const DEFAULT_AUTHOR: ProposalAuthor = {
  type: "ai",
  id: "insight-translator",
  name: "Insight Translator",
};

const DEFAULT_CAPABILITY = "evolution";

// ── Translator function shape ───────────────────────────────

/**
 * A single translator. Receives the originating Insight plus context and
 * returns either a ProposalDefinition (translation succeeded) or `null`
 * (translator declined — the registry will fall through).
 *
 * Translators must NOT throw for "I don't know how to handle this kind";
 * they must return `null`. Throwing is reserved for genuinely broken state
 * (e.g. a structural translator was wired up but the insight evidence is
 * malformed).
 */
export type InsightTranslator = (
  insight: Insight,
  ctx: TranslatorContext,
) => ProposalDefinition | null | Promise<ProposalDefinition | null>;

// ── Registry ────────────────────────────────────────────────

export interface InsightTranslatorRegistry {
  /** Register a translator for a given key. Replaces any existing one. */
  register(key: InsightTranslatorKey, translator: InsightTranslator): void;
  /** Remove a translator. No-op if absent. */
  unregister(key: InsightTranslatorKey): void;
  /** Whether a translator is registered for the given key. */
  has(key: InsightTranslatorKey): boolean;
  /** List all registered keys (insertion order). */
  keys(): InsightTranslatorKey[];
  /**
   * Translate an Insight into a ProposalDefinition.
   * Returns `null` if no translator is registered for the insight's key,
   * OR if the matching translator declined (returned null).
   */
  translate(insight: Insight, ctx?: TranslatorContext): Promise<ProposalDefinition | null>;
}

/** Create an empty translator registry. */
export function createInsightTranslatorRegistry(): InsightTranslatorRegistry {
  const translators = new Map<InsightTranslatorKey, InsightTranslator>();

  return {
    register(key, translator) {
      translators.set(key, translator);
    },
    unregister(key) {
      translators.delete(key);
    },
    has(key) {
      return translators.has(key);
    },
    keys() {
      return [...translators.keys()];
    },
    async translate(insight, ctx = {}) {
      const key = insightTranslatorKey(insight);
      const fn = translators.get(key);
      if (!fn) return null;
      return await fn(insight, ctx);
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────

function defaultIdGenerator(): string {
  return `proposal_${crypto.randomUUID()}`;
}

/**
 * Maximum number of fields the deterministic structural translator inlines
 * into a default list view stub. Pulled from the head of the entity's
 * field map (insertion order). Later slices may replace this with an
 * importance-graph-aware selection.
 */
const DEFAULT_VIEW_FIELD_LIMIT = 5;

/**
 * Deep copy of evidence so translators cannot mutate the originating
 * Insight, and downstream consumers cannot back-leak edits into Memory.
 *
 * Requires `structuredClone` (Bun and Node 17+ both provide it). We
 * intentionally do NOT use a JSON round-trip fallback because evidence
 * carries `Date` instances (`SensorSignal.timestamp`, baseline timestamps)
 * which JSON.stringify silently coerces to ISO strings — that would break
 * the `InsightEvidence` type contract for downstream consumers.
 */
function cloneEvidence(evidence: InsightEvidence): InsightEvidence {
  return structuredClone(evidence) as InsightEvidence;
}

/**
 * Build a default ViewDefinition stub for an entity with no view.
 * Slice 1 emits a syntactically valid placeholder. Later slices may
 * pull fields from the OntologyRegistry to produce a richer default.
 */
function buildDefaultListView(entity: string, ctx: TranslatorContext): ViewDefinition {
  // Try to enrich from ontology when available; fall back to empty fields.
  const descriptor = ctx.ontology?.describe(entity);
  const fields = descriptor
    ? Object.keys(descriptor.fields)
        .slice(0, DEFAULT_VIEW_FIELD_LIMIT)
        .map((name) => ({ field: name }))
    : [];

  return {
    name: `${entity}_default_list`,
    entity,
    type: "list",
    label: `${entity} (default)`,
    description: `Auto-proposed default list view for "${entity}".`,
    fields,
  };
}

// ── Built-in translators ────────────────────────────────────

/**
 * Translator for structural `schema_no_view` insights.
 *
 * Emits a ProposalDefinition that creates a default list view for the
 * entity. Deterministic — no AI call. The resulting proposal is
 * `status: "draft"` and follows the same shape AI-generated proposals use
 * so the downstream pipeline (validate / preanalyse / approve) does not
 * need to special-case it.
 */
export const schemaNoViewTranslator: InsightTranslator = (insight, ctx) => {
  if (insight.type !== "structural") return null;
  const evidenceContext = insight.evidence.context as { kind?: unknown };
  if (evidenceContext.kind !== "schema_no_view") return null;

  const now = ctx.now?.() ?? new Date();
  const idGen = ctx.idGenerator ?? defaultIdGenerator;
  const author = ctx.author ?? DEFAULT_AUTHOR;
  const capability = ctx.capability ?? DEFAULT_CAPABILITY;

  const view = buildDefaultListView(insight.entity, ctx);

  const change: ProposalChange = {
    target: "view",
    operation: "create",
    name: view.name,
    definition: view,
    diff: `Add default list view for "${insight.entity}".`,
  };

  // Trace the proposal back to the originating insight by stamping its id
  // onto the (cloned) evidence context. Downstream consumers can read
  // `proposal.changes[0].definition` for the actual change and the proposal
  // metadata below for provenance.
  const evidence = cloneEvidence(insight.evidence);
  const traceContext: Record<string, unknown> = {
    ...evidence.context,
    insightId: insight.id,
    insightSummary: insight.summary,
    insightCausality: insight.causality,
  };

  const proposal: ProposalDefinition = {
    id: idGen(),
    title: `Add default view for "${insight.entity}"`,
    description: insight.summary,
    author,
    capability,
    changeType: "minor",
    changes: [change],
    impact: {
      schemasAffected: [insight.entity],
      actionsAffected: [],
      rulesAffected: [],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };

  // Attach evidence trace via a non-typed sidecar so we don't widen the
  // ProposalDefinition shape in Slice 1. Slice 3 may promote this to a
  // first-class field once the wiring is proven.
  Object.defineProperty(proposal, "evidence", {
    value: { ...evidence, context: traceContext },
    enumerable: true,
    writable: false,
    configurable: false,
  });

  return proposal;
};

/** Author stamped on rollback proposals so provenance is unambiguous. */
const ROLLBACK_AUTHOR: ProposalAuthor = {
  type: "ai",
  id: "rollback-translator",
  name: "Rollback Translator",
};

/**
 * Fixed name for the single `target:"revert"` change a rollback Proposal carries.
 *
 * Must satisfy the validation engine's `NAME_PATTERN` (`/^[a-z][a-z0-9_]*$/`),
 * so it deliberately does NOT embed the target proposalId (which may contain a
 * colon or uppercase, e.g. `rollback-insight:proposal_abc`). The proposalId
 * being reverted is carried in the change `diff` and the evidence sidecar's
 * `context.revertProposalId` instead. A rollback Proposal always has exactly one
 * revert change, so a constant name never collides under the DUPLICATE_CHANGE check.
 */
export const REVERT_CHANGE_NAME = "revert";

/**
 * Shape of the evidence context carried by a `rollback_candidate` Insight,
 * as produced by {@link import("../engine/rollback-insight-emitter").RollbackInsightEmitter}.
 * All numeric fields are optional because the upstream verifier may lack a
 * post-merge measurement; only `proposalId` is required to translate.
 */
interface RollbackEvidenceContext {
  proposalId?: unknown;
  capability?: unknown;
  signalRef?: unknown;
  baselineValue?: unknown;
  targetValue?: unknown;
  currentValue?: unknown;
  /**
   * Merged commit SHA of the regressed proposal (Spec 55 §7.7), threaded by
   * {@link import("../engine/rollback-insight-emitter").RollbackInsightEmitter}
   * from the effect-verification signal. Optional — absent on out-of-band
   * merges or proposals that predate SHA capture.
   */
  mergedSha?: unknown;
}

/** Narrow an `unknown` evidence field to a non-empty string, else `undefined`. */
function nonEmptyStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Narrow an `unknown` evidence field to a finite number, else `undefined`. */
function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Return the first candidate that is a non-empty string. Used to resolve a
 * fallback chain (most specific → most generic) while skipping any candidate
 * that is missing, empty, or not a string.
 */
function firstNonEmptyString(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return DEFAULT_CAPABILITY;
}

/**
 * Translator for `rollback_candidate`-tagged anomaly Insights (Spec 55 §7.7
 * Phase 2). Emits a GOVERNANCE-SAFE `status: "draft"` rollback Proposal so the
 * failed change flows through the normal Insight → Proposal pipeline to the
 * HUMAN approval gate.
 *
 * This translator NEVER executes a rollback: it does not call
 * DeployRollbackOrchestrator, does not touch Git, and does not auto-approve.
 * It only materialises the intent to revert as a reviewable draft Proposal
 * carrying a single `target: "revert"` change.
 *
 * The revert change uses the fixed, NAME_PATTERN-valid name {@link REVERT_CHANGE_NAME}
 * so the draft passes Phase-1 validation (a `revert:<proposalId>` name would
 * fail `INVALID_NAME` on the colon/uppercase). The target proposalId is carried
 * out-of-band in the change `diff` and the evidence sidecar's
 * `context.revertProposalId`, so a rollback executor can resolve which proposal
 * to revert.
 *
 * When the rollback Insight evidence carries `context.mergedSha` (threaded from
 * `ProposalGitCommitter` → outcome → effect-verifier → RollbackInsightEmitter),
 * that SHA is stamped on the revert change's typed `revertSha` field so
 * `DeployRollbackOrchestrator` can `git revert` the EXACT commit. The SHA is
 * OPTIONAL — when absent the draft is still produced and a human reviewer must
 * supply the SHA before a rollback can execute. Stamping the SHA NEVER triggers
 * auto-execution: the proposal remains `status: "draft"`.
 *
 * Returns `null` (declines) when the insight is not a tagged anomaly carrying a
 * non-empty `evidence.context.proposalId`. Malformed insights (e.g. an
 * undefined/null `evidence`) decline rather than throw.
 */
export const rollbackCandidateTranslator: InsightTranslator = (insight, ctx) => {
  // Defensive guard: only a tagged anomaly with a usable proposalId qualifies.
  if (insight.type !== "anomaly") return null;
  if (!insight.tags?.includes(ROLLBACK_CANDIDATE_TAG)) return null;

  // `evidence`/`evidence.context` are typed required, but runtime Insights
  // (deserialized from storage, or malformed) may carry an undefined/null
  // `evidence`. Access defensively so a malformed insight declines (returns
  // null) instead of throwing a TypeError.
  const context = (insight.evidence?.context ?? {}) as RollbackEvidenceContext;
  const proposalId = context.proposalId;
  if (typeof proposalId !== "string" || proposalId.length === 0) return null;

  const now = ctx.now?.() ?? new Date();
  const idGen = ctx.idGenerator ?? defaultIdGenerator;
  const author = ctx.author ?? ROLLBACK_AUTHOR;

  // Capability is resolved from the most specific source first so the rollback
  // stays scoped to the capability that owns the regressed proposal:
  //   evidence context → the insight's own entity → ctx override → shared default.
  const capability = firstNonEmptyString(
    context.capability,
    insight.entity,
    ctx.capability,
    DEFAULT_CAPABILITY,
  );

  const signalRef = typeof context.signalRef === "string" ? context.signalRef : undefined;
  // The INVERSE successMetric reuses only the pre-merge baseline (→ new target)
  // and the regressed current value (→ new baseline). The original targetValue
  // is intentionally not extracted — it has no role in a rollback's metric.
  const baselineValue = numberOrUndefined(context.baselineValue);
  const currentValue = numberOrUndefined(context.currentValue);

  // The merged commit SHA of the regressed proposal, threaded from the
  // effect-verification signal via the rollback Insight evidence. When present,
  // it is stamped on the revert change so DeployRollbackOrchestrator can
  // `git revert` the EXACT commit instead of only naming the proposal.
  const revertSha = nonEmptyStringOrUndefined(context.mergedSha);

  const change: ProposalChange = {
    target: "revert",
    operation: "update",
    // Fixed NAME_PATTERN-valid name; the target proposalId lives in `diff` and
    // the evidence sidecar so the draft can pass Phase-1 validation.
    name: REVERT_CHANGE_NAME,
    diff: revertSha
      ? `Roll back merged proposal "${proposalId}" (commit ${revertSha}) on capability "${capability}".`
      : `Roll back merged proposal "${proposalId}" on capability "${capability}".`,
    // Optional typed slot the rollback executor reads; omitted when the upstream
    // chain lacked a SHA so the field never carries an empty string.
    ...(revertSha ? { revertSha } : {}),
  };

  // INVERSE successMetric: the rollback succeeds when the metric returns from
  // the regressed `currentValue` back toward the pre-merge `baselineValue`.
  const successMetric: SuccessMetric = {
    description: `Revert proposal "${proposalId}" should restore ${signalRef ?? "the metric"} toward its pre-merge baseline.`,
    insightRef: insight.id,
    signalRef,
    baselineValue: currentValue,
    targetValue: baselineValue,
  };

  const proposal: ProposalDefinition = {
    id: idGen(),
    title: `Roll back proposal "${proposalId}" on "${capability}"`,
    description: insight.summary,
    author,
    capability,
    changeType: "major",
    changes: [change],
    impact: {
      schemasAffected: [],
      actionsAffected: [],
      rulesAffected: [],
      // Conservative: a rollback only re-affects the capability it reverts.
      dependentsAffected: [capability],
      migrationRequired: false,
    },
    status: "draft",
    successMetric,
    createdAt: now,
    updatedAt: now,
  };

  // Attach an evidence trace sidecar mirroring schemaNoViewTranslator's contract
  // exactly: the provenance lives under `.context` (not flat) and the sidecar is
  // enumerable so `JSON.stringify` and `ProposalGitCommitter.readSourceInsights`
  // (which reads `evidence.context.insightId`) can both recover it. `context`
  // also carries `revertProposalId` so the rollback-execution / SHA-threading
  // follow-up can resolve which proposal to revert.
  const evidence = cloneEvidence(insight.evidence);
  const traceContext: Record<string, unknown> = {
    ...evidence.context,
    insightId: insight.id,
    insightSummary: insight.summary,
    insightCausality: insight.causality,
    revertProposalId: proposalId,
    capability,
    signalRef,
    // Mirror the SHA on the sidecar so provenance survives even if a consumer
    // reads the evidence trace rather than the typed change field.
    revertSha,
  };
  Object.defineProperty(proposal, "evidence", {
    value: { ...evidence, context: traceContext },
    enumerable: true,
    writable: false,
    configurable: false,
  });

  return proposal;
};

// ── Default registry factory ────────────────────────────────

/**
 * Create a registry pre-loaded with the Slice 1 deterministic translators.
 * Capabilities can register additional translators via
 * `extensions.insightTranslators` in later slices.
 */
export function createDefaultInsightTranslatorRegistry(): InsightTranslatorRegistry {
  const registry = createInsightTranslatorRegistry();
  registry.register("structural:schema_no_view", schemaNoViewTranslator);
  registry.register(`anomaly:${ROLLBACK_CANDIDATE_TAG}`, rollbackCandidateTranslator);
  return registry;
}

// Re-exported for downstream typing convenience.
export type { Insight, InsightType };
