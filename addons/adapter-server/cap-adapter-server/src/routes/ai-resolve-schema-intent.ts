/**
 * Spec 52 "说→有" (first slice) — POST /api/ai/resolve-schema-intent
 *
 * The governed sibling of `POST /api/ai/resolve-intent`. Where that endpoint
 * turns an utterance into a RUNTIME DATA action proposal, this endpoint turns
 * an utterance into a METAMODEL CHANGE — a new `defineRule()` or an UPDATE to
 * an existing one — surfaced ONLY as an `add_rule` / `update_rule` Proposal in
 * `draft` status.
 *
 * It is a thin consumer of the canonical `resolveSchemaIntent()` engine from
 * `@linchkit/core/ai`:
 *
 *  - Validates `{ prompt }` with Zod.
 *  - Builds a permission-scoped Ontology view so the AI only sees entities
 *    whose actions the calling actor can execute (Spec 52 §1.1 — "AI sees only
 *    what the current user can see"). Same scoping convention as
 *    `ai-resolve-intent.ts`.
 *  - Mints the draft through a route-owned `ProposalEngine` and returns the
 *    `SchemaIntentOutcome` (proposal_draft / clarification / no_match).
 *
 * Hard rules (repo principle "AI Never Modifies Production Directly"):
 *  - This route NEVER submits, approves, or applies the proposal. The returned
 *    Proposal is ALWAYS `draft`. Graduating it is a separate, human-gated path.
 *  - When the AI service / ontology is unavailable the endpoint degrades
 *    gracefully — 503 with a structured envelope so the UI can show an
 *    "AI unavailable" state.
 */

import type {
  Actor,
  AIService,
  EntityDefinition,
  ProposalChange,
  ProposalDefinition,
  RelationDefinition,
  RuleDefinition,
} from "@linchkit/core";
import type {
  Proposal,
  SchemaIntentEntityFieldDraft,
  SchemaIntentEntityProposalDraft,
  SchemaIntentOutcome,
  SchemaIntentProposalDraft,
  SchemaIntentRelationDraft,
} from "@linchkit/core/ai";
import {
  ProposalEngine,
  REQUIRES_CODE_CHANGE_MARKER,
  resolveSchemaIntent,
} from "@linchkit/core/ai";
import type { ProposalEngine as GovernedProposalEngine } from "@linchkit/core/server";
import type { Elysia } from "elysia";
import { z } from "zod";
import { getSharedProposalEngine } from "../proposal-api";
import type { ServerOptions } from "../server";
import { buildSchemaIntentOntology } from "./ai-schema-intent-ontology";
import { resolveActor, serviceUnavailable } from "./shared";

// Re-export so existing consumers/tests keep importing from the route module.
export { buildSchemaIntentOntology } from "./ai-schema-intent-ontology";

// ── Request shape (Zod) ──────────────────────────────────────

/**
 * Wire-format request body. `tenant` / `userId` are derived from the
 * authenticated request context, never client-supplied (Spec 52 §1.1).
 */
const resolveSchemaIntentRequestSchema = z
  .object({
    prompt: z.string().min(1, "prompt must be a non-empty string"),
  })
  .strict();

// ── Wire-format response ─────────────────────────────────────

/**
 * Response envelope. Mirrors the discriminated `SchemaIntentOutcome` from the
 * resolver. On the `proposal_draft` path we surface the full draft Proposal so
 * the Proposal review UI can render it without a second round-trip; on the
 * other paths we surface the clarification / no-match details.
 */
export interface ResolveSchemaIntentResponse {
  outcome: SchemaIntentOutcome["kind"];
  /** Present only for `proposal_draft`. Always a `draft`-status Proposal. */
  proposal?: Proposal;
  /**
   * Present only for `proposal_draft`. The id of the GOVERNED Proposal that was
   * persisted into the shared engine `/api/proposals` serves — so a client can
   * fetch (`GET /api/proposals/:id`), approve, or reject the draft through the
   * existing review flow. Always references a `draft`-status governed Proposal;
   * this route never submits, approves, or applies it.
   */
  proposalId?: string;
  /**
   * Present only for `proposal_draft`. The governed Proposal's lifecycle status
   * at persist time — always `"draft"` (never auto-submitted / approved here).
   */
  proposalStatus?: string;
  /**
   * Present only for `proposal_draft` — `"create"` for a new rule
   * (`add_rule`), `"update"` for a change to an EXISTING rule (`update_rule`).
   */
  operation?: "create" | "update";
  ruleName?: string;
  targetEntity?: string;
  /** Present only for `entity_proposal_draft` — the new entity's name. */
  entityName?: string;
  /** Present only for `entity_proposal_draft` — the validated field drafts. */
  fields?: SchemaIntentEntityFieldDraft[];
  /** Present only for `entity_proposal_draft` when a relation was drafted. */
  relation?: SchemaIntentRelationDraft;
  confidence?: number;
  explanation?: string;
  /** Present only for update drafts — human-readable diff vs the existing rule. */
  diffSummary?: string;
  /**
   * Present only for diff-only update drafts (CODE-condition rules and any
   * other non-round-trippable rule — composite condition, non-action trigger,
   * non-declarative effect). The draft carries no declarative definition; a
   * developer must apply the change in source. The persisted governed
   * proposal carries the same signal as a `REQUIRES_CODE_CHANGE_MARKER`
   * prefix on the change diff + description.
   */
  requiresCodeChange?: boolean;
  /** Present only for `clarification`. */
  question?: string;
  bestConfidence?: number;
  /**
   * Present only for `clarification` when the utterance carried BOTH an entity
   * and a rule intent (issue #575 multi-intent guard).
   */
  detectedIntents?: Array<"add_entity" | "add_rule">;
  /** Present only for `no_match`. */
  reason?: string;
  message?: string;
}

/**
 * Build the wire response. For the `proposal_draft` path the route persists the
 * draft into the shared governed engine FIRST and passes the resulting governed
 * Proposal in `governed` so its id/status reach the client; the other paths
 * persist nothing (no governed Proposal is created).
 */
function toResponse(
  outcome: SchemaIntentOutcome,
  governed?: ProposalDefinition,
): ResolveSchemaIntentResponse {
  switch (outcome.kind) {
    case "proposal_draft":
      return {
        outcome: "proposal_draft",
        proposal: outcome.proposal,
        proposalId: governed?.id,
        proposalStatus: governed?.status,
        operation: outcome.operation,
        ruleName: outcome.ruleName,
        targetEntity: outcome.targetEntity,
        confidence: outcome.confidence,
        explanation: outcome.explanation,
        ...(outcome.diffSummary !== undefined ? { diffSummary: outcome.diffSummary } : {}),
        ...(outcome.requiresCodeChange ? { requiresCodeChange: true } : {}),
      };
    case "entity_proposal_draft":
      return {
        outcome: "entity_proposal_draft",
        proposal: outcome.proposal,
        proposalId: governed?.id,
        proposalStatus: governed?.status,
        entityName: outcome.entityName,
        fields: outcome.fields,
        ...(outcome.relation ? { relation: outcome.relation } : {}),
        confidence: outcome.confidence,
        explanation: outcome.explanation,
      };
    case "clarification":
      return {
        outcome: "clarification",
        question: outcome.question,
        bestConfidence: outcome.bestConfidence,
        ...(outcome.detectedIntents ? { detectedIntents: outcome.detectedIntents } : {}),
      };
    case "no_match":
      return {
        outcome: "no_match",
        reason: outcome.reason,
        message: outcome.message,
      };
  }
}

// ── Translate the resolver draft → governed Proposal ─────────

/**
 * Persist a resolver-produced `add_rule` / `update_rule` draft into the shared
 * GOVERNED engine (`packages/core/src/engine/proposal-engine.ts`) — the same
 * instance `/api/proposals` reads from — so the NL draft surfaces in the
 * review pipeline.
 *
 * The resolver runs ALL of its security validation first (prompt-injection
 * sanitize → entity allowlist → existing-rule allowlist → strict structural
 * rule allowlist). By the time we reach here the draft carries only validated,
 * typed values; we translate them into a single governed `ProposalChange`:
 *
 *  - create: `{ target: "rule", operation: "create", name, definition, diff }`
 *  - update: `{ target: "rule", operation: "update", name, definition, diff }`
 *    where `diff` is the human-readable summary of what changes. An update of
 *    a CODE-condition rule carries NO definition (the resolver flags it
 *    `requiresCodeChange` — the diff is the reviewable spec; a developer
 *    applies it in source).
 *
 * The proposal lands in `draft` status. It is NEVER submitted, approved, or
 * applied here — graduation is a separate, human-gated path.
 *
 * Returns `undefined` when the draft does not carry a usable rule definition
 * for a definition-bearing path (defensive — the resolver only emits
 * `proposal_draft` with a built rule, but we never want a malformed change to
 * reach the engine).
 */
function persistGovernedRuleDraft(opts: {
  engine: GovernedProposalEngine;
  outcome: SchemaIntentProposalDraft;
  reasoning: string;
  /** The actor who requested the resolution — recorded for the audit trail. */
  actor: Actor;
}): ProposalDefinition | undefined {
  const { engine, outcome, reasoning, actor } = opts;
  const { proposal: draft, ruleName, targetEntity, explanation, operation } = outcome;
  const diffOnly = outcome.requiresCodeChange === true;

  // The validated rule definition is the resolver draft's diff definition.
  // Optional-chain `diff` defensively against runtime drift in the draft shape.
  // Code-backed updates legitimately carry no definition (diff-only).
  const rawDefinition = draft.diff?.definition;
  const definition =
    rawDefinition && typeof rawDefinition === "object"
      ? (rawDefinition as RuleDefinition)
      : undefined;
  if (!definition && !diffOnly) return undefined;

  // A diff-only draft is an HONEST developer change-request: it has no
  // definition BY DESIGN (the rule cannot be rebuilt declaratively). The
  // `requiresCodeChange` flag exists only in the HTTP response, so the
  // PERSISTED proposal carries a stable text marker on the change's diff and
  // the proposal description — the fields the review UI renders — letting a
  // reviewer in /admin/proposals distinguish it from a malformed change.
  // (Text-only on purpose: ProposalChange has no structured extension point.)
  const diffText = outcome.diffSummary ?? explanation;
  const change: ProposalChange = {
    target: "rule",
    operation,
    name: ruleName,
    ...(definition ? { definition } : {}),
    diff: diffOnly ? `${REQUIRES_CODE_CHANGE_MARKER} ${diffText}` : diffText,
  };

  const codeChangeNote = diffOnly
    ? `\n\n${REQUIRES_CODE_CHANGE_MARKER} This update targets a rule that cannot be rebuilt declaratively; it intentionally carries no definition — a developer must apply the described change in source.`
    : "";

  return engine.createProposal({
    title: explanation,
    // Preserve the original utterance as the proposal description's reasoning
    // trail, plus the requesting actor for the audit trail (governance: record
    // WHO initiated the AI resolution). The utterance is never interpolated into
    // a privileged context — this string is display/audit metadata only.
    description: `${reasoning}\n\n(Requested by ${actor.type}:${actor.id})${codeChangeNote}`,
    // The change originates from an AI resolution acting on the user's behalf.
    author: { type: "ai", id: "schema-intent-resolver", name: "Schema Intent Resolver" },
    // The rule attaches to its target entity — used as the governed
    // capability/grouping key, mirroring the PatternDetector path in
    // proposal-api.ts (capability = entity name).
    capability: targetEntity,
    // Adding or updating a single business rule is a minor change.
    changeType: "minor",
    changes: [change],
  });
}

/**
 * Persist a resolver-produced `add_entity` draft into the shared GOVERNED engine
 * (issue #575). The resolver runs ALL of its structural validation first
 * (snake_case singular name, no system-field collisions, valid field types,
 * valid relation endpoints). By the time we reach here the draft carries a
 * validated, typed `EntityDefinition`; we translate it into a governed
 * `entity` `ProposalChange`
 * (`{ target: "entity", operation: "create", name, definition }`) in `draft`
 * status. It is NEVER submitted, approved, or applied here.
 *
 * A drafted relation rides along inside the resolver draft's definition
 * (`{ ...entityDef, relation }`). It is carried into the governed proposal as a
 * SECOND, first-class `relation` change
 * (`{ target: "relation", operation: "create", name, definition }`, #580) so
 * graduation emits BOTH `defineEntity(...)` and `defineRelation(...)`. The
 * relation is still removed from the `entity` change's definition (that change
 * carries a clean `EntityDefinition`); it also still surfaces in the HTTP
 * response (`outcome.relation`) for the review UI. The two changes are pushed
 * entity-first, then relation when present.
 *
 * Always returns a persisted governed `ProposalDefinition` (mirroring
 * `persistGovernedRuleDraft`). If the draft somehow lacks a usable entity
 * definition — or carries a relation that is present but malformed — it THROWS
 * rather than returning `undefined` / silently dropping: a silent undefined
 * would let the route report a successful `entity_proposal_draft` while nothing
 * was governed, and a silently-dropped relation would regress the #580 contract.
 */
function persistGovernedEntityDraft(opts: {
  engine: GovernedProposalEngine;
  outcome: SchemaIntentEntityProposalDraft;
  reasoning: string;
  actor: Actor;
}): ProposalDefinition {
  const { engine, outcome, reasoning, actor } = opts;
  const { proposal: draft, entityName, explanation } = outcome;

  const definition = draft.diff?.definition;
  if (!definition || typeof definition !== "object") {
    // Defensive: the resolver only emits entity_proposal_draft with a built
    // entity, so this is unreachable in normal flow. Throw rather than return
    // undefined — a silent undefined would let the route claim a successful
    // entity_proposal_draft while persisting no governed proposal.
    throw new Error(
      `persistGovernedEntityDraft: missing or non-object entity definition (entityName=${entityName})`,
    );
  }
  // The resolver draft carries a drafted relation alongside the entity
  // (`{ ...entityDef, relation }`). Separate the relation from the entity here:
  // the governed `entity` change's `definition` must be a clean `EntityDefinition`
  // (relation removed), while the relation becomes its OWN first-class governed
  // `relation` change below (#580) so graduation emits both `defineEntity(...)`
  // and `defineRelation(...)`. The relation also still surfaces in the API
  // response (`outcome.relation`) for the review UI.
  const { relation: relationDef, ...entityRest } = definition as Record<string, unknown>;
  // Minimal structural assertion before the unchecked cast. The resolver
  // validated this upstream, but persisting a governed EntityDefinition is
  // integrity-critical, so guard against future drift in the stored shape rather
  // than trusting `as unknown as EntityDefinition` to silently absorb it.
  if (
    typeof entityRest.name !== "string" ||
    typeof entityRest.fields !== "object" ||
    entityRest.fields === null
  ) {
    throw new Error(
      `persistGovernedEntityDraft: entity definition missing a string name or fields object (entityName=${entityName})`,
    );
  }
  const entityDefinition = entityRest as unknown as EntityDefinition;

  const entityChange: ProposalChange = {
    target: "entity",
    operation: "create",
    name: entityName,
    definition: entityDefinition,
    diff: explanation,
  };

  const changes: ProposalChange[] = [entityChange];

  // Carry the drafted relation as a SECOND, first-class governed change so it
  // graduates to `defineRelation(...)` source (#580). The resolver already
  // validated the relation endpoints upstream; mirror the entity guard and
  // assert the minimal RelationDefinition shape (non-null object with a string
  // `name`) before trusting the cast. If the relation is PRESENT but malformed,
  // THROW rather than silently drop — a silent drop would regress the #580
  // contract while still reporting a successful entity_proposal_draft.
  if (relationDef !== undefined && relationDef !== null) {
    if (
      typeof relationDef !== "object" ||
      typeof (relationDef as Record<string, unknown>).name !== "string"
    ) {
      throw new Error(
        `persistGovernedEntityDraft: relation present but malformed — expected an object with a string name (entityName=${entityName})`,
      );
    }
    const relationDefinition = relationDef as unknown as RelationDefinition;
    changes.push({
      target: "relation",
      operation: "create",
      name: relationDefinition.name,
      definition: relationDefinition,
      diff: explanation,
    });
  }

  return engine.createProposal({
    title: explanation,
    description: `${reasoning}\n\n(Requested by ${actor.type}:${actor.id})`,
    author: { type: "ai", id: "schema-intent-resolver", name: "Schema Intent Resolver" },
    // The new entity is its own governed capability/grouping key.
    capability: entityName,
    // A new entity is an additive, minor change.
    changeType: "minor",
    changes,
  });
}

// ── Route ───────────────────────────────────────────────────

/**
 * Mount `POST /api/ai/resolve-schema-intent` onto the given Elysia app.
 *
 * Behavior summary:
 *   400 — request body fails Zod validation (missing/empty prompt).
 *   503 — AI service / ontology not configured (graceful degradation).
 *   500 — unexpected resolver throw (the resolver swallows AI errors, so this
 *         only fires on a programmer error).
 *   200 — every resolved outcome (proposal_draft / clarification / no_match).
 *
 * The resolver mints a lightweight in-memory draft through a route-owned engine
 * (Engine A) AFTER running its full security validation. On the `proposal_draft`
 * path the route then TRANSLATES that validated draft into the shared GOVERNED
 * engine (Engine B — the one `/api/proposals` serves) so the NL draft enters the
 * human review pipeline. The governed draft lands in `draft` status and is never
 * submitted, approved, or applied here. `clarification` / `no_match` persist
 * nothing.
 */
export function mountResolveSchemaIntentRoute(app: Elysia, options: ServerOptions): void {
  // Engine A — the resolver's lightweight draft sink. Drafts here are
  // throwaway: every successful resolution is TRANSLATED into the shared
  // governed engine (Engine B) below, then this engine is cleared so its
  // in-memory map never grows unbounded across requests.
  const draftEngine = new ProposalEngine();
  // Engine B — the single GOVERNED Proposal engine `/api/proposals` serves.
  const governedEngine = getSharedProposalEngine();

  app.post("/api/ai/resolve-schema-intent", async ({ body, request, set }) => {
    const parsed = resolveSchemaIntentRequestSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      const issue = parsed.error.issues[0];
      return {
        success: false as const,
        error: {
          code: "VALIDATION.FAILED",
          message: issue?.message ?? "Invalid request body for /api/ai/resolve-schema-intent",
        },
      };
    }

    const aiService: AIService | undefined = options.aiService;
    const ontologyRegistry = options.ontologyRegistry;

    // Resolve actor + tenant from the trusted request context. NEVER read
    // these from the body (Spec 52 §1.1 — AI operates as the user).
    const actor = await resolveActor(request, options.resolveRequestActor);
    const resolveTenant = options.resolveRequestTenantId;
    const tenantId = resolveTenant ? await resolveTenant(request, actor) : undefined;

    // Graceful degradation — 503 with a structured error.
    if (!aiService?.configured) {
      return serviceUnavailable(
        set,
        "AI service is not configured. Configure an AI provider in linchkit.config.ts to enable schema intent resolution.",
      );
    }
    if (!ontologyRegistry) {
      return serviceUnavailable(
        set,
        "Ontology registry is not available — schema intent resolution requires the unified Ontology layer.",
      );
    }

    const ontology = buildSchemaIntentOntology({
      base: ontologyRegistry,
      permissionRegistry: options.permissionRegistry,
      actor,
    });

    let outcome: SchemaIntentOutcome;
    try {
      outcome = await resolveSchemaIntent(
        {
          utterance: parsed.data.prompt,
          tenantId,
          userId: actor.id,
        },
        {
          provider: aiService,
          ontology,
          // The resolver mints its draft + runs ALL security validation here.
          proposalEngine: draftEngine,
        },
      );
    } catch (err) {
      // The resolver swallows AI errors into no_match, so reaching here means
      // an unexpected programmer error. Surface 500 but never apply anything.
      const message = err instanceof Error ? err.message : "Schema intent resolution failed";
      set.status = 500;
      return {
        success: false as const,
        error: { code: "AI.RESOLVE_SCHEMA_INTENT.FAILED", message },
      };
    } finally {
      // The draft engine is throwaway — its entry has already been translated
      // into the governed engine below (or, for non-`proposal_draft` outcomes,
      // nothing was minted). Clearing keeps its in-memory map bounded across
      // requests. The resolver's returned proposal object survives the clear
      // (we only drop the map entry, not the object), so translation below can
      // still read it by reference.
      // NOTE: this clear runs BEFORE the persist below (finally fires on normal
      // completion of the try); the translation reads `outcome.proposal` by
      // reference, which is unaffected.
      draftEngine.clear();
    }

    // ── Persist the GOVERNED draft (only for a real proposed rule/entity) ──
    // `clarification` / `no_match` are NOT governed changes — nothing is
    // persisted for them. Only a validated `add_rule` / `update_rule` /
    // `add_entity` draft becomes a governed Proposal in the shared engine
    // `/api/proposals` reads from.
    let governed: ProposalDefinition | undefined;
    if (outcome.kind === "proposal_draft") {
      governed = persistGovernedRuleDraft({
        engine: governedEngine,
        outcome,
        reasoning: parsed.data.prompt,
        actor,
      });
    } else if (outcome.kind === "entity_proposal_draft") {
      // Scoped to the entity branch ONLY: persistGovernedEntityDraft throws on
      // a malformed/missing definition (defensive guards that should never fire
      // in normal flow), and the throw must keep the structured-error envelope
      // instead of leaking Elysia's default unstructured 500. The rule path
      // above keeps its pre-existing (non-throwing) behavior untouched.
      try {
        governed = persistGovernedEntityDraft({
          engine: governedEngine,
          outcome,
          reasoning: parsed.data.prompt,
          actor,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to persist governed proposal";
        set.status = 500;
        return {
          success: false as const,
          error: { code: "AI.RESOLVE_SCHEMA_INTENT.FAILED", message },
        };
      }
    }

    return toResponse(outcome, governed);
  });
}
