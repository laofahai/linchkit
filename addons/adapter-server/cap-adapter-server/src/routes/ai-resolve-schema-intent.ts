/**
 * Spec 52 "说→有" (first slice) — POST /api/ai/resolve-schema-intent
 *
 * The governed sibling of `POST /api/ai/resolve-intent`. Where that endpoint
 * turns an utterance into a RUNTIME DATA action proposal, this endpoint turns
 * an utterance into a METAMODEL CHANGE — a new `defineRule()` — surfaced ONLY
 * as an `add_rule` Proposal in `draft` status.
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
} from "@linchkit/core";
import type {
  Proposal,
  SchemaIntentEntity,
  SchemaIntentOntology,
  SchemaIntentOutcome,
} from "@linchkit/core/ai";
import { ProposalEngine, resolveSchemaIntent } from "@linchkit/core/ai";
import { checkActionPermission } from "@linchkit/core/server";
import type { Elysia } from "elysia";
import { z } from "zod";
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
  ruleName?: string;
  targetEntity?: string;
  confidence?: number;
  explanation?: string;
  /** Present only for `clarification`. */
  question?: string;
  bestConfidence?: number;
  /** Present only for `no_match`. */
  reason?: string;
  message?: string;
}

function toResponse(outcome: SchemaIntentOutcome): ResolveSchemaIntentResponse {
  switch (outcome.kind) {
    case "proposal_draft":
      return {
        outcome: "proposal_draft",
        proposal: outcome.proposal,
        ruleName: outcome.ruleName,
        targetEntity: outcome.targetEntity,
        confidence: outcome.confidence,
        explanation: outcome.explanation,
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
 * A route-owned `ProposalEngine` mints the draft. Drafts in this slice stop at
 * `draft` and are not graduated here, so a per-route engine is sufficient and
 * keeps the server wiring untouched.
 */
export function mountResolveSchemaIntentRoute(app: Elysia, options: ServerOptions): void {
  const proposalEngine = new ProposalEngine();

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
          proposalEngine,
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
      // This slice STOPS at draft and returns it inline to the client — the
      // draft is never persisted server-side for later approval here. Freeing
      // the engine after each request prevents the in-memory map from growing
      // unbounded across requests. toResponse() (below) reads the proposal
      // object by reference, which survives this clear (we only drop the map
      // entry, not the object); building the response first keeps the draft in
      // the payload. Clearing also reinforces the "never applies" invariant —
      // there is no server-side handle left to graduate.
      proposalEngine.clear();
    }

    return toResponse(outcome);
  });
}
