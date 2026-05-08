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

import type { OntologyRegistry } from "../ontology/ontology-registry";
import type { Insight, InsightEvidence, InsightType } from "../types/life-system";
import type { ProposalAuthor, ProposalChange, ProposalDefinition } from "../types/proposal";
import type { ViewDefinition } from "../types/view";

// ── Translator key ──────────────────────────────────────────

/**
 * Key used to look up a translator. Built from `Insight.type` plus an
 * insight-type-specific discriminator.
 *
 * - `structural` insights discriminate on `evidence.context.kind`
 *   (one of {@link import("../types/life-system").StructuralIssueKind}).
 * - Non-structural insights fall back to `Insight.type` alone for now;
 *   later slices may refine (e.g. anomaly + sensor name).
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

// ── Default registry factory ────────────────────────────────

/**
 * Create a registry pre-loaded with the Slice 1 deterministic translators.
 * Capabilities can register additional translators via
 * `extensions.insightTranslators` in later slices.
 */
export function createDefaultInsightTranslatorRegistry(): InsightTranslatorRegistry {
  const registry = createInsightTranslatorRegistry();
  registry.register("structural:schema_no_view", schemaNoViewTranslator);
  return registry;
}

// Re-exported for downstream typing convenience.
export type { Insight, InsightType };
