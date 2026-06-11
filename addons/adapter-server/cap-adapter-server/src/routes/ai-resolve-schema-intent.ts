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
  ActionDefinition,
  Actor,
  AIService,
  FieldDefinition,
  OntologyRegistry,
  PermissionRegistry,
  ProposalChange,
  ProposalDefinition,
  RuleDefinition,
} from "@linchkit/core";
import type {
  Proposal,
  SchemaIntentEntity,
  SchemaIntentOntology,
  SchemaIntentOutcome,
  SchemaIntentProposalDraft,
  SchemaIntentRule,
} from "@linchkit/core/ai";
import { ProposalEngine, resolveSchemaIntent } from "@linchkit/core/ai";
import {
  checkActionPermission,
  type ProposalEngine as GovernedProposalEngine,
} from "@linchkit/core/server";
import type { Elysia } from "elysia";
import { z } from "zod";
import { getSharedProposalEngine } from "../proposal-api";
import type { ServerOptions } from "../server";
import { resolveActor, serviceUnavailable } from "./shared";

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

// ── Permission-scoped Ontology snapshot ─────────────────────

/**
 * Build the structural `SchemaIntentOntology` the resolver consumes from the
 * full `OntologyRegistry`, scoped to entities the calling actor can act on.
 *
 * An entity is exposed only when the actor can execute at least one of its
 * actions (matching the permission convention in `permission-middleware.ts`:
 * the action's `entity` is the capability name). When no `permissionRegistry`
 * is wired in (typical dev runs) we pass everything through — same permissive
 * default as `ai-resolve-intent.ts`.
 *
 * Exported for unit testing the permission gate in isolation (both
 * `listEntities` and `describeEntity` must enforce it).
 */
export function buildSchemaIntentOntology(opts: {
  base: OntologyRegistry;
  permissionRegistry?: PermissionRegistry;
  actor: Actor;
}): SchemaIntentOntology {
  const { base, permissionRegistry, actor } = opts;

  const allowedActions = (entityName: string): ActionDefinition[] => {
    const all = base.actionsFor(entityName);
    if (!permissionRegistry) return all;
    const allowed: ActionDefinition[] = [];
    for (const action of all) {
      const result = checkActionPermission(permissionRegistry, actor, action.entity, action.name);
      if (result.allowed) allowed.push(action);
    }
    return allowed;
  };

  const visibleEntities = (): string[] => {
    const out: string[] = [];
    for (const name of base.listEntities()) {
      // With no permission registry, every entity is visible. Otherwise an
      // entity is visible only if the actor can run at least one of its
      // actions — there is nothing to attach a rule trigger to otherwise.
      if (!permissionRegistry || allowedActions(name).length > 0) out.push(name);
    }
    return out;
  };

  // Project a registered RuleDefinition into the resolver's rule snapshot.
  // A CODE condition (a TypeScript function) is NEVER serialized — only its
  // kind + the rule's description are exposed, so the AI cannot pretend to
  // edit source it cannot see. Declarative conditions are structured data
  // and travel whole.
  const toSchemaIntentRule = (rule: RuleDefinition): SchemaIntentRule => {
    const isCode = typeof rule.condition === "function";
    const triggerActions =
      "action" in rule.trigger
        ? Array.isArray(rule.trigger.action)
          ? rule.trigger.action
          : [rule.trigger.action]
        : undefined;
    return {
      name: rule.name,
      label: rule.label,
      description: rule.description,
      ...(triggerActions ? { triggerActions } : {}),
      effectType: rule.effect.type,
      conditionKind: isCode ? "code" : "declarative",
      ...(isCode ? {} : { condition: rule.condition as SchemaIntentRule["condition"] }),
    };
  };

  // Permission gate for rules, mirroring `actionNames`: an action-triggered
  // rule is visible only when the actor can run at least one of its trigger
  // actions. Rules with non-action triggers (state/event/schedule) ride on
  // the entity-level gate, which already passed by the time this runs.
  const visibleRules = (entityName: string, rules: RuleDefinition[]): SchemaIntentRule[] => {
    if (!permissionRegistry) return rules.map(toSchemaIntentRule);
    const allowedNames = new Set(allowedActions(entityName).map((a) => a.name));
    return rules
      .filter((rule) => {
        if (!("action" in rule.trigger)) return true;
        const actions = Array.isArray(rule.trigger.action)
          ? rule.trigger.action
          : [rule.trigger.action];
        return actions.some((name) => allowedNames.has(name));
      })
      .map(toSchemaIntentRule);
  };

  return {
    listEntities: () => visibleEntities(),
    describeEntity: (entityName: string): SchemaIntentEntity | undefined => {
      // Enforce the SAME permission gate the visible-entity list uses. Without
      // this, calling describeEntity() directly with an entity the actor cannot
      // act on would leak its full description (least-privilege violation) —
      // listEntities() filters, but describeEntity() must too.
      if (permissionRegistry && allowedActions(entityName).length === 0) {
        return undefined;
      }
      const descriptor = base.describe(entityName);
      if (!descriptor) return undefined;
      const fields: SchemaIntentEntity["fields"] = [];
      for (const [name, raw] of Object.entries(descriptor.fields)) {
        const field = raw as FieldDefinition;
        fields.push({
          name,
          type: field.type,
          required: field.required === true,
          label: field.label,
          description: field.description,
        });
      }
      return {
        name: descriptor.name,
        label: descriptor.label,
        description: descriptor.description,
        fields,
        actionNames: allowedActions(entityName).map((a) => a.name),
        // EXISTING rules (includes inherited) — the `update_rule` target list.
        rules: visibleRules(entityName, descriptor.rules),
      };
    },
  };
}

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
  confidence?: number;
  explanation?: string;
  /** Present only for update drafts — human-readable diff vs the existing rule. */
  diffSummary?: string;
  /**
   * Present only for update drafts of CODE-condition rules. The draft carries
   * no declarative definition (the condition is a TS function the AI cannot
   * round-trip); a developer must apply the change in source.
   */
  requiresCodeChange?: boolean;
  /** Present only for `clarification`. */
  question?: string;
  bestConfidence?: number;
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
    case "clarification":
      return {
        outcome: "clarification",
        question: outcome.question,
        bestConfidence: outcome.bestConfidence,
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

  const change: ProposalChange = {
    target: "rule",
    operation,
    name: ruleName,
    ...(definition ? { definition } : {}),
    diff: outcome.diffSummary ?? explanation,
  };

  return engine.createProposal({
    title: explanation,
    // Preserve the original utterance as the proposal description's reasoning
    // trail, plus the requesting actor for the audit trail (governance: record
    // WHO initiated the AI resolution). The utterance is never interpolated into
    // a privileged context — this string is display/audit metadata only.
    description: `${reasoning}\n\n(Requested by ${actor.type}:${actor.id})`,
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

    // ── Persist the GOVERNED draft (only for a real proposed rule) ──
    // `clarification` / `no_match` are NOT governed changes — nothing is
    // persisted for them. Only a validated `add_rule` draft becomes a governed
    // Proposal in the shared engine `/api/proposals` reads from.
    let governed: ProposalDefinition | undefined;
    if (outcome.kind === "proposal_draft") {
      governed = persistGovernedRuleDraft({
        engine: governedEngine,
        outcome,
        reasoning: parsed.data.prompt,
        actor,
      });
    }

    return toResponse(outcome, governed);
  });
}
