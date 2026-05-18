/**
 * Spec 52 §2.6 — POST /api/ai/resolve-intent
 *
 * Wires the canonical `resolveIntent()` engine from `@linchkit/core/server`
 * into a real HTTP endpoint. The route is a thin consumer of the resolver:
 *
 *  - Validates `{ prompt, scope }` with Zod.
 *  - Builds a permission-scoped Ontology view so the AI only sees actions the
 *    calling actor can actually execute (Spec 52 §1.1 — "AI sees only what the
 *    current user can see").
 *  - Returns a `ResolveIntentResponse` envelope (200 either way) carrying:
 *      * `proposal` — legacy single-step Action Proposal (back-compat).
 *      * `clarification` — Spec 52 §2.2 step 5 clarifying question, when low-confidence.
 *      * `multiStep` — Spec 52 §2.5 multi-action sequence (Saga-flagged), when applicable.
 *    A null `proposal` with no `clarification`/`multiStep` is a normal
 *    "no usable match" outcome, not an error.
 *  - Emits one AI audit entry per call (success, no-match, or failure) using
 *    the canonical `logIntentResolution()` helper so the full intent-resolution
 *    traffic is auditable per Spec 52 §8.1.4.
 *
 * Hard rules (Spec 52 §1.1):
 *  - This route NEVER executes the proposed action. The user confirms via
 *    the existing `POST /api/actions/:name` endpoint after reviewing the card.
 *  - When the resolver/AI is unavailable the endpoint degrades gracefully —
 *    503 with a structured envelope so the UI can show "AI unavailable" UX.
 */

import type { ActionCatalogEntry, ActionProposal } from "@linchkit/cap-ai-provider";
import type {
  ActionDefinition,
  Actor,
  AIService,
  FieldDefinition,
  OntologyRegistry,
  PermissionRegistry,
} from "@linchkit/core";
import type {
  AIAuditLogger,
  Intent,
  IntentAlternative,
  IntentClarification,
  IntentMultiStep,
  IntentStep,
} from "@linchkit/core/server";
import { checkActionPermission, resolveIntent } from "@linchkit/core/server";
import type { Elysia } from "elysia";
import { z } from "zod";
import {
  DEFAULT_MAX_ACTIONS_PER_ENTITY,
  DEFAULT_MAX_ENTITIES,
  limitCatalogToRelevant,
} from "../lib/relevant-actions";
import type { ServerOptions } from "../server";
import { resolveActor, serviceUnavailable } from "./shared";

// ── Request shape (Zod) ──────────────────────────────────────

/**
 * Wire-format request body. Matches the resolver's `ResolveIntentInput`
 * minus the server-managed `tenant` / `userId` fields, which are derived
 * from the authenticated request context (never client-supplied).
 */
const resolveIntentRequestSchema = z
  .object({
    prompt: z.string().min(1, "prompt must be a non-empty string"),
    scope: z
      .object({
        entityFilter: z.array(z.string()).optional(),
        actionFilter: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// ── Permission-scoped Ontology wrapper ──────────────────────

/**
 * Minimal `OntologyRegistryLike` exposed to `resolveIntent()`. We define this
 * locally rather than re-importing the resolver's type to keep the dependency
 * surface flat (the resolver intentionally consumes a structural type).
 */
interface OntologyRegistryLike {
  listEntities(): string[];
  actionsFor(entityName: string): ActionDefinition[];
}

/**
 * Build an `OntologyRegistryLike` view that only exposes actions the calling
 * actor can execute. Implements Spec 52 §1.1 hard rule: "AI sees only what the
 * current user can see." If `permissionRegistry` is missing (typical for dev
 * runs without cap-permission wired in), we pass actions through unchanged —
 * matching the rest of the server's permissive default for unauthenticated
 * dev environments.
 *
 * Permission convention follows `permission-middleware.ts`: when no explicit
 * capability resolver is provided, the action's `entity` is used as the
 * capability name in the registry lookup. Same convention used here.
 */
function buildPermissionScopedOntology(opts: {
  base: OntologyRegistry;
  permissionRegistry?: PermissionRegistry;
  actor: Actor;
}): OntologyRegistryLike {
  const { base, permissionRegistry, actor } = opts;

  if (!permissionRegistry) {
    // Pass-through wrapper. We still narrow to OntologyRegistryLike so that
    // callers can't accidentally rely on the wider OntologyRegistry surface.
    return {
      listEntities: () => base.listEntities(),
      actionsFor: (entityName: string) => base.actionsFor(entityName),
    };
  }

  return {
    listEntities: () => base.listEntities(),
    actionsFor: (entityName: string) => {
      const all = base.actionsFor(entityName);
      const allowed: ActionDefinition[] = [];
      for (const action of all) {
        const result = checkActionPermission(permissionRegistry, actor, action.entity, action.name);
        if (result.allowed) {
          allowed.push(action);
        }
      }
      return allowed;
    },
  };
}

// ── Audit emission helper ───────────────────────────────────

/**
 * Emit one AI audit entry per resolve-intent call (Spec 52 §8.1.4).
 *
 * Thin wrapper around the canonical `AIAuditLogger.logIntentResolution()`
 * helper — kept as a function in this module so future call sites (e.g. an
 * MCP transport) don't need to know the actor-id derivation.
 */
function emitIntentResolutionAudit(opts: {
  logger: AIAuditLogger;
  actor: Actor;
  tenantId: string | undefined;
  prompt: string;
  durationMs: number;
  matched: boolean;
  action: string | null;
  confidence: number | null;
  catalogSize: number;
  scoped: boolean;
  serviceUnavailable: boolean;
}): void {
  opts.logger.logIntentResolution({
    actorId: opts.actor.id,
    tenantId: opts.tenantId,
    prompt: opts.prompt,
    matched: opts.matched,
    action: opts.action,
    confidence: opts.confidence,
    durationMs: opts.durationMs,
    catalogSize: opts.catalogSize,
    scoped: opts.scoped,
    serviceUnavailable: opts.serviceUnavailable,
  });
}

// ── Route ───────────────────────────────────────────────────

/**
 * Mount `POST /api/ai/resolve-intent` onto the given Elysia app.
 *
 * Behavior summary:
 *   400 — request body fails Zod validation (missing/empty prompt, etc).
 *   503 — AI service is not configured on the server (`aiService.configured === false`).
 *   200 — every other case. `proposal` is `null` when the resolver returned null.
 */
export function mountResolveIntentRoute(app: Elysia, options: ServerOptions): void {
  app.post("/api/ai/resolve-intent", async ({ body, request, set }) => {
    const parsed = resolveIntentRequestSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      const issue = parsed.error.issues[0];
      return {
        success: false as const,
        error: {
          code: "VALIDATION.FAILED",
          message: issue?.message ?? "Invalid request body for /api/ai/resolve-intent",
        },
      };
    }

    const aiService: AIService | undefined = options.aiService;
    const ontologyRegistry = options.ontologyRegistry;
    const auditLogger = options.aiAuditLogger;

    // Resolve actor + tenant from the trusted request context. NEVER read
    // these from the body (Spec 52 §1.1 — AI operates as the user).
    const actor = await resolveActor(request, options.resolveRequestActor);
    const resolveTenant = options.resolveRequestTenantId;
    const tenantId = resolveTenant ? await resolveTenant(request, actor) : undefined;

    // Helper: audit the unavailable case + return 503. The audit entry is
    // emitted whether or not the AI service was even reachable so operators
    // can see the rate of attempts hitting an un-configured deployment.
    const handleUnavailable = (message: string) => {
      auditLogger &&
        emitIntentResolutionAudit({
          logger: auditLogger,
          actor,
          tenantId,
          prompt: parsed.data.prompt,
          durationMs: 0,
          matched: false,
          action: null,
          confidence: null,
          catalogSize: 0,
          scoped: false,
          serviceUnavailable: true,
        });
      return serviceUnavailable(set, message);
    };

    // Spec 52 §1.1 graceful degradation — if AI isn't configured, surface 503
    // with a structured error so the caller can show "AI unavailable" UX.
    if (!aiService?.configured) {
      return handleUnavailable(
        "AI service is not configured. Configure an AI provider in linchkit.config.ts to enable intent resolution.",
      );
    }

    // The resolver needs an Ontology view. If the server wasn't constructed
    // with one, treat that as misconfiguration → 503 (rare in dev runs;
    // CLI dev wiring always provides it).
    if (!ontologyRegistry) {
      return handleUnavailable(
        "Ontology registry is not available — intent resolution requires the unified Ontology layer.",
      );
    }

    const scopedOntology = buildPermissionScopedOntology({
      base: ontologyRegistry,
      permissionRegistry: options.permissionRegistry,
      actor,
    });

    // Compute the actor-visible catalog size BEFORE the resolver runs so the
    // audit entry has it even when the resolver returns null. This mirrors
    // the resolver's internal de-duplication (one entry per unique action
    // name across all entities).
    const catalogSize = computeUniqueCatalogSize(scopedOntology);

    // Spec 52 Phase 1 hardening (#262 item 1) — relevance-based catalog
    // pre-selection. For large ontologies the full action list blows past
    // the AI provider's context window. Build a lightweight preview catalog,
    // lexically rank it against the user's prompt, and pass the kept names
    // through to the resolver via the existing scope filters. The pre-filter
    // is a no-op when the catalog is already smaller than the entity cap,
    // so default behavior on small fixtures is unchanged.
    const intentOpts = options.intentResolverOptions ?? {};
    const maxEntities = intentOpts.maxEntities ?? DEFAULT_MAX_ENTITIES;
    const maxActionsPerEntity = intentOpts.maxActionsPerEntity ?? DEFAULT_MAX_ACTIONS_PER_ENTITY;
    const previewCatalog = buildPreviewCatalog(scopedOntology, parsed.data.scope);
    const filteredCatalog = limitCatalogToRelevant({
      catalog: previewCatalog,
      prompt: parsed.data.prompt,
      maxEntities,
      maxActionsPerEntity,
    });
    const augmentedScope = mergeScopeWithFilteredCatalog({
      requestScope: parsed.data.scope,
      filteredCatalog,
      previewCatalog,
    });

    const startedAt = Date.now();
    let intent: Intent;
    try {
      intent = await resolveIntent(
        {
          utterance: parsed.data.prompt,
          scope: augmentedScope,
          tenantId,
          userId: actor.id,
        },
        {
          provider: aiService,
          ontology: scopedOntology,
        },
      );
    } catch (err) {
      // The new core resolver swallows AI errors and returns IntentNoMatch,
      // so reaching this branch means a programmer error / unexpected throw.
      // Surface 500 but still emit an audit entry so the failure isn't invisible.
      const durationMs = Date.now() - startedAt;
      auditLogger &&
        emitIntentResolutionAudit({
          logger: auditLogger,
          actor,
          tenantId,
          prompt: parsed.data.prompt,
          durationMs,
          matched: false,
          action: null,
          confidence: null,
          catalogSize,
          scoped: Boolean(options.permissionRegistry),
          serviceUnavailable: false,
        });
      const message = err instanceof Error ? err.message : "Intent resolution failed";
      set.status = 500;
      return {
        success: false as const,
        error: { code: "AI.RESOLVE_INTENT.FAILED", message },
      };
    }

    const durationMs = Date.now() - startedAt;

    // Project the discriminated `Intent` into the wire shapes the UI
    // already understands: the legacy `proposal` slot stays populated for
    // match outcomes (backward compat), and we add OPTIONAL `clarification`
    // / `multiStep` slots so the chat UI can render the new cards without
    // a second round-trip (Spec 52 §2.2 step 5 + §2.5).
    const legacyProposal = intentToLegacyProposal(intent);
    const matched = legacyProposal !== null;
    const proposalView = enrichProposal(legacyProposal, scopedOntology);

    if (auditLogger) {
      emitIntentResolutionAudit({
        logger: auditLogger,
        actor,
        tenantId,
        prompt: parsed.data.prompt,
        durationMs,
        matched,
        action: legacyProposal?.action ?? null,
        confidence: legacyProposal?.confidence ?? null,
        catalogSize,
        scoped: Boolean(options.permissionRegistry),
        serviceUnavailable: false,
      });
    }

    const response: ResolveIntentResponse = { proposal: proposalView };
    if (intent.kind === "clarification") {
      response.clarification = toClarificationView(intent, scopedOntology);
    } else if (intent.kind === "multi_step") {
      response.multiStep = toMultiStepView(intent, scopedOntology);
    }
    return response;
  });
}

// ── Intent → wire format conversion ─────────────────────────

/**
 * Wire-format response envelope. The legacy `proposal` slot is preserved
 * for backward compatibility; `clarification` and `multiStep` are
 * NEW optional fields surfacing Spec 52 §2.2 step 5 / §2.5 outcomes.
 */
export interface ResolveIntentResponse {
  /** Match outcome (legacy shape). `null` when intent is not a single-step match. */
  proposal: ActionProposalView | null;
  /** Clarification outcome (Spec 52 §2.2 step 5). Present only when AI was unsure. */
  clarification?: ClarificationView;
  /** Multi-step sequence outcome (Spec 52 §2.5). Present only when AI proposed >1 step. */
  multiStep?: MultiStepView;
}

/**
 * Project an `IntentMatch` back to the legacy `ActionProposal` shape so
 * `enrichProposal()` can reuse the existing UI-display enrichment logic.
 * Returns null for every non-match outcome — callers branch on the
 * companion `clarification` / `multiStep` slots instead.
 */
function intentToLegacyProposal(intent: Intent): ActionProposal | null {
  if (intent.kind !== "match") return null;
  return {
    action: intent.action,
    input: intent.input,
    confidence: intent.confidence,
    missingFields: intent.missingFields,
    explanation: intent.explanation,
    ...(intent.alternatives && intent.alternatives.length > 0
      ? { alternatives: intent.alternatives.map(intentAlternativeToLegacy) }
      : {}),
  };
}

function intentAlternativeToLegacy(alt: IntentAlternative): ActionProposal {
  return {
    action: alt.action,
    input: alt.input,
    confidence: alt.confidence,
    missingFields: alt.missingFields,
    explanation: alt.explanation,
  };
}

// ── Clarification & multi-step view shapes ──────────────────

/**
 * Wire-format clarification — `IntentClarification` enriched with the
 * same display metadata as match-path alternatives so the UI can render
 * "Did you mean..." chips without a second round-trip.
 */
export interface ClarificationView {
  question: string;
  bestConfidence: number;
  candidates?: IntentAlternativeView[];
}

function toClarificationView(
  clarification: IntentClarification,
  ontology: OntologyRegistryLike,
): ClarificationView {
  const actionIndex = buildScopedActionIndex(ontology);
  const view: ClarificationView = {
    question: clarification.question,
    bestConfidence: clarification.bestConfidence,
  };
  if (clarification.candidates && clarification.candidates.length > 0) {
    const enriched = enrichAlternatives(
      clarification.candidates.map(intentAlternativeToLegacy),
      actionIndex,
    );
    if (enriched) view.candidates = enriched;
  }
  return view;
}

/**
 * Wire-format multi-step sequence — `IntentMultiStep` enriched with the
 * same display metadata each step needs to render in an Action Sequence
 * Card (Spec 52 §2.5).
 */
export interface MultiStepView {
  steps: MultiStepStepView[];
  confidence: number;
  explanation: string;
  saga: boolean;
}

export interface MultiStepStepView {
  index: number;
  action: string;
  schema: string;
  actionLabel: string;
  actionDescription?: string;
  input: Record<string, unknown>;
  missingFields: string[];
  explanation: string;
  inputSchema: Record<string, IntentFieldSchema>;
  dependsOn?: number;
}

function toMultiStepView(
  multiStep: IntentMultiStep,
  ontology: OntologyRegistryLike,
): MultiStepView {
  const actionIndex = buildScopedActionIndex(ontology);
  const steps: MultiStepStepView[] = [];
  for (const step of multiStep.steps) {
    const action = actionIndex.get(step.action);
    // Hallucination defense — the core resolver should have refused
    // unknown actions already, but the view layer enforces it again at
    // the exit point. A dropped step is preferable to one the user
    // cannot inspect.
    if (!action) continue;
    steps.push(toMultiStepStepView(step, action));
  }
  return {
    steps,
    confidence: multiStep.confidence,
    explanation: multiStep.explanation,
    saga: multiStep.saga,
  };
}

function toMultiStepStepView(step: IntentStep, action: ActionDefinition): MultiStepStepView {
  return {
    index: step.index,
    action: step.action,
    schema: action.entity,
    actionLabel: action.label ?? action.name,
    actionDescription: action.description,
    input: step.input,
    missingFields: step.missingFields,
    explanation: step.explanation,
    inputSchema: buildInputSchema(action),
    ...(step.dependsOn !== undefined ? { dependsOn: step.dependsOn } : {}),
  };
}

// ── Response enrichment ─────────────────────────────────────

/** Wire-format proposal: bare resolver output plus action display metadata. */
export interface ActionProposalView extends Omit<ActionProposal, "alternatives"> {
  /** Entity name the matched action operates on. */
  schema: string;
  /** Human-readable action label (from `defineAction({ label })`). */
  actionLabel: string;
  /** Optional human-readable action description. */
  actionDescription?: string;
  /** Input parameter descriptors suitable for rendering a confirmation form. */
  inputSchema: Record<string, IntentFieldSchema>;
  /**
   * Alternatives enriched with the same display metadata as the primary, so
   * the UI can swap one into the primary slot without a second round-trip.
   * Filtered against the scoped ontology (hallucination defense — same rule
   * as the primary). Omitted when no usable alternatives remain.
   */
  alternatives?: IntentAlternativeView[];
}

/**
 * Wire-format alternative: bare resolver alternative plus action display
 * metadata. Mirrors `ActionProposalView` minus the recursive `alternatives`
 * field (alternatives never themselves carry alternatives).
 */
export interface IntentAlternativeView {
  action: string;
  input: Record<string, unknown>;
  confidence: number;
  missingFields: string[];
  explanation: string;
  schema: string;
  actionLabel: string;
  actionDescription?: string;
  inputSchema: Record<string, IntentFieldSchema>;
}

/** Wire-format input field schema — minimal projection of `FieldDefinition`. */
export interface IntentFieldSchema {
  type: string;
  label?: string;
  required: boolean;
  options?: Array<{ value: string; label?: string }>;
  description?: string;
}

/**
 * Build a one-pass `name -> ActionDefinition` index over the (already scoped)
 * ontology. Used for O(1) lookups during proposal + alternatives enrichment
 * instead of repeated linear scans.
 */
function buildScopedActionIndex(ontology: OntologyRegistryLike): Map<string, ActionDefinition> {
  const index = new Map<string, ActionDefinition>();
  for (const entityName of ontology.listEntities()) {
    for (const action of ontology.actionsFor(entityName)) {
      // First-write-wins: the resolver de-dupes by name across entities and
      // we mirror that here so primary + alternatives see the same action.
      if (!index.has(action.name)) index.set(action.name, action);
    }
  }
  return index;
}

export function enrichProposal(
  proposal: ActionProposal | null,
  ontology: OntologyRegistryLike,
): ActionProposalView | null {
  if (!proposal) return null;

  const actionIndex = buildScopedActionIndex(ontology);
  const primaryAction = actionIndex.get(proposal.action);

  // Spec 52 §1.1 hard rule: "AI sees only what the current user can see."
  // The resolver's catalog-allowlist should already drop proposals outside
  // the scoped catalog, but we enforce it once more at the exit point so a
  // hallucinated action name (whether from prompt injection or a stale
  // training corpus) cannot be confirmed back to the caller. Returning null
  // is the same as "no usable match" from the resolver's own perspective.
  if (!primaryAction) return null;

  // Strip the bare `alternatives` from the primary spread — we replace it
  // with the enriched list (or omit when empty) below.
  const { alternatives: rawAlternatives, ...primaryRest } = proposal;
  const enrichedAlternatives = enrichAlternatives(rawAlternatives, actionIndex);

  return {
    ...primaryRest,
    schema: primaryAction.entity,
    actionLabel: primaryAction.label ?? primaryAction.name,
    actionDescription: primaryAction.description,
    inputSchema: buildInputSchema(primaryAction),
    ...(enrichedAlternatives ? { alternatives: enrichedAlternatives } : {}),
  };
}

/**
 * Enrich each alternative with the same display metadata as the primary.
 *
 * Filtering rules (mirror the primary's hallucination-defense exit gate):
 *  - Drop alternatives whose action is NOT in the scoped ontology (never echo
 *    a half-enriched placeholder — the user must not be able to confirm an
 *    action they can't see).
 *  - Preserve resolver order beyond a defensive DESC-by-confidence resort —
 *    filtering may have changed cardinality but not which alternatives are
 *    most relevant.
 *
 * Returns `undefined` when the input list is empty/missing or filtering
 * dropped every entry, matching the resolver's own "omit field when empty"
 * convention so the wire envelope stays uniform.
 */
function enrichAlternatives(
  rawAlternatives: ActionProposal[] | undefined,
  actionIndex: Map<string, ActionDefinition>,
): IntentAlternativeView[] | undefined {
  if (!rawAlternatives || rawAlternatives.length === 0) return undefined;

  const enriched: IntentAlternativeView[] = [];
  for (const alt of rawAlternatives) {
    const action = actionIndex.get(alt.action);
    if (!action) continue;
    enriched.push({
      action: alt.action,
      input: alt.input,
      confidence: alt.confidence,
      missingFields: alt.missingFields,
      explanation: alt.explanation,
      schema: action.entity,
      actionLabel: action.label ?? action.name,
      actionDescription: action.description,
      inputSchema: buildInputSchema(action),
    });
  }

  if (enriched.length === 0) return undefined;

  // Order is preserved from the resolver, which already sorts DESC by
  // confidence in `reconcileAlternatives`. Iteration above only appends —
  // filtering cannot rearrange surviving entries — so no extra sort is
  // needed here.
  return enriched;
}

function buildInputSchema(action: ActionDefinition): Record<string, IntentFieldSchema> {
  const schema: Record<string, IntentFieldSchema> = {};
  if (!action.input) return schema;
  for (const [name, raw] of Object.entries(action.input)) {
    const field = raw as FieldDefinition;
    schema[name] = {
      type: field.type,
      label: field.label,
      required: field.required === true,
      description: field.description,
      options: extractFieldOptions(field),
    };
  }
  return schema;
}

function extractFieldOptions(
  field: FieldDefinition,
): Array<{ value: string; label?: string }> | undefined {
  // EnumField uses `options: [{ value, label? }, ...]`. Other field types
  // do not carry option lists at this level. Read structurally to avoid
  // depending on the discriminated-union type narrowing of FieldDefinition.
  const fieldRecord = field as unknown as Record<string, unknown>;
  const options = fieldRecord.options;
  if (!Array.isArray(options)) return undefined;
  const out: Array<{ value: string; label?: string }> = [];
  for (const opt of options) {
    if (opt && typeof opt === "object" && "value" in opt) {
      const o = opt as { value: unknown; label?: unknown };
      // Coerce to string at the wire boundary — IntentFieldSchema.options
      // is `string` for UI form rendering, but EnumField definitions
      // sometimes use numeric values (status codes, version numbers).
      // Dropping them silently would leave the user without those choices.
      // NaN is excluded — `String(NaN) === "NaN"` would smuggle a useless
      // option into the UI.
      const isStringValue = typeof o.value === "string";
      const isFiniteNumberValue = typeof o.value === "number" && Number.isFinite(o.value);
      if (isStringValue || isFiniteNumberValue) {
        out.push({
          value: String(o.value),
          label: typeof o.label === "string" ? o.label : undefined,
        });
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Compute the de-duplicated number of actions visible through the given
 * Ontology view. Matches the resolver's own catalog construction so the
 * audit `catalogSize` field is meaningful for permission-scoping checks.
 */
function computeUniqueCatalogSize(ontology: OntologyRegistryLike): number {
  const seen = new Set<string>();
  for (const entityName of ontology.listEntities()) {
    for (const action of ontology.actionsFor(entityName)) {
      seen.add(action.name);
    }
  }
  return seen.size;
}

// ── Catalog preview + scope merging ─────────────────────────

/**
 * Build a flat `ActionCatalogEntry[]` snapshot of what the resolver would
 * see. Mirrors `buildActionCatalog()` in cap-ai-provider but is owned by
 * this route so we can run relevance ranking without invoking the resolver
 * twice. Identical de-duplication semantics: the FIRST entity exposing an
 * action wins (matching the iteration order of `listEntities()`).
 *
 * Honors the caller's `scope.entityFilter` / `scope.actionFilter` so the
 * relevance ranker scores the same set of candidates the resolver will.
 */
function buildPreviewCatalog(
  ontology: OntologyRegistryLike,
  scope: { entityFilter?: string[]; actionFilter?: string[] } | undefined,
): ActionCatalogEntry[] {
  const entityFilter = toFilterSet(scope?.entityFilter);
  const actionFilter = toFilterSet(scope?.actionFilter);

  const seen = new Set<string>();
  const catalog: ActionCatalogEntry[] = [];

  for (const entityName of ontology.listEntities()) {
    if (entityFilter && !entityFilter.has(entityName)) continue;
    for (const action of ontology.actionsFor(entityName)) {
      if (seen.has(action.name)) continue;
      if (actionFilter && !actionFilter.has(action.name)) continue;
      seen.add(action.name);
      catalog.push(toCatalogPreviewEntry(action));
    }
  }
  return catalog;
}

function toCatalogPreviewEntry(action: ActionDefinition): ActionCatalogEntry {
  const inputFields: ActionCatalogEntry["inputFields"] = [];
  if (action.input) {
    for (const [name, raw] of Object.entries(action.input)) {
      const field = raw as FieldDefinition;
      inputFields.push({
        name,
        type: field.type,
        required: field.required === true,
        label: field.label,
        description: field.description,
      });
    }
  }

  // Mirror cap-ai-provider's joining of description + promptHints so the
  // relevance ranker scores the same text the resolver would feed the AI.
  const hints = action.ai?.promptHints;
  const description =
    [action.description, ...(hints ?? [])].filter((s): s is string => Boolean(s)).join(" — ") ||
    undefined;

  return {
    name: action.name,
    entity: action.entity,
    label: action.label,
    description,
    inputFields,
  };
}

/**
 * Convert a filter list to a Set. An explicitly empty array is preserved as
 * an empty Set ("no candidates allowed"); only an `undefined` filter means
 * "do not filter". This mirrors the resolver's own `toFilterSet` semantics
 * so the preview catalog and the resolver agree on what an empty filter means.
 */
function toFilterSet(values: readonly string[] | undefined): Set<string> | undefined {
  if (values === undefined) return undefined;
  return new Set(values);
}

/**
 * Merge the caller-supplied scope with the relevance-pruned action list.
 *
 * No-op when no truncation occurred (filteredCatalog has the same length as
 * previewCatalog) — the caller's scope passes through unchanged so audit /
 * test behavior on small fixtures is byte-for-byte identical.
 *
 * When truncation DID happen we narrow `actionFilter` to the kept set
 * (intersected with any caller-supplied filter, which has already been
 * applied in `buildPreviewCatalog`). `entityFilter` is similarly narrowed
 * to the entities surviving truncation.
 */
function mergeScopeWithFilteredCatalog(opts: {
  requestScope: { entityFilter?: string[]; actionFilter?: string[] } | undefined;
  filteredCatalog: ActionCatalogEntry[];
  previewCatalog: ActionCatalogEntry[];
}): { entityFilter?: string[]; actionFilter?: string[] } | undefined {
  if (opts.filteredCatalog.length === opts.previewCatalog.length) {
    return opts.requestScope;
  }
  const keptActions = opts.filteredCatalog.map((e) => e.name);
  const keptEntities = Array.from(new Set(opts.filteredCatalog.map((e) => e.entity)));
  return {
    entityFilter: keptEntities,
    actionFilter: keptActions,
  };
}
