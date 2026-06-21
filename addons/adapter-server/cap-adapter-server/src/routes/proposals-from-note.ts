/**
 * 经验→制度 (first segment) — POST /api/proposals/from-note
 *
 * A human-gated path that promotes an informal 经验 note (a chatter note a
 * reviewer is reading) into a DRAFT governed Proposal. A person clicks
 * "draft a rule from this note"; the server feeds the note text through the
 * EXISTING natural-language → proposal pipeline (`resolveSchemaIntent`) and
 * persists the resulting draft into the SHARED governed engine — the same one
 * `/api/proposals` serves — with the originating note recorded as the draft's
 * `evidence` (origin/provenance). The draft then flows through the EXISTING
 * approve→graduate pipeline; this route does NOT rebuild any of that.
 *
 * This route is a sibling of `POST /api/ai/resolve-schema-intent` and mirrors
 * it EXACTLY for actor/ontology/auth wiring:
 *  - Resolves the actor from the trusted request context (never the body).
 *  - Builds the actor-scoped Ontology view via `buildSchemaIntentOntology` — the
 *    actor-scoped ontology IS the permission slot for this NL-governance path
 *    (consistent with the sibling, which does not call `commandLayer.execute`).
 *  - Degrades gracefully (503) when AI / ontology is unavailable.
 *
 * Hard rules (repo principle "AI Never Modifies Production Directly"):
 *  - This route ONLY ever creates `draft` Proposals. It NEVER submits, approves,
 *    or applies them. Graduation is the existing, separate human-gated path.
 *  - `evidence.ref` is the CLIENT-ASSERTED note id. This route does NOT re-fetch
 *    the note server-side in this slice: ChatterService exposes no
 *    `getMessageById` and there is no service-registry seam in adapter-server,
 *    and importing cap-chatter from here would violate the module boundary. The
 *    human reviews the resulting draft (which surfaces the note text via the
 *    proposal description and the evidence ref) BEFORE any approval, so an
 *    incorrect ref cannot graduate unreviewed. Server-side note verification is
 *    a tracked follow-up.
 */

import type { AIService, ProposalDefinition } from "@linchkit/core";
import type { SchemaIntentOutcome } from "@linchkit/core/ai";
import { ProposalEngine, resolveSchemaIntent } from "@linchkit/core/ai";
import type { Elysia } from "elysia";
import { z } from "zod";
import { getSharedProposalEngine } from "../proposal-api";
import type { ServerOptions } from "../server";
import {
  persistGovernedEntityDraft,
  persistGovernedRuleDraft,
  type ResolveSchemaIntentResponse,
  toResponse,
} from "./ai-resolve-schema-intent";
import { buildSchemaIntentOntology } from "./ai-schema-intent-ontology";
import { resolveActor, serviceUnavailable } from "./shared";

// ── Request shape (Zod) ──────────────────────────────────────

/**
 * Wire-format request body. Identity (`tenant` / `userId`) is derived from the
 * authenticated request context, never client-supplied. `noteId` /
 * `entityName` / `recordId` are the originating-note coordinates recorded as
 * the draft's provenance; `noteBody` is the informal 经验 text fed to the NL
 * pipeline.
 */
const proposalsFromNoteRequestSchema = z
  .object({
    noteId: z.string().min(1, "noteId must be a non-empty string"),
    entityName: z.string().min(1, "entityName must be a non-empty string"),
    recordId: z.string().min(1, "recordId must be a non-empty string"),
    noteBody: z.string().min(1, "noteBody must be a non-empty string"),
  })
  .strict();

// ── Route ────────────────────────────────────────────────────

/**
 * Mount `POST /api/proposals/from-note` onto the given Elysia app.
 *
 * Behavior summary:
 *   400 — request body fails Zod validation (missing/empty field).
 *   503 — AI service / ontology not configured (graceful degradation).
 *   500 — unexpected resolver throw / malformed governed entity draft.
 *   200 — every resolved outcome (proposal_draft / entity_proposal_draft /
 *         clarification / no_match), mirroring the sibling response envelope.
 *
 * On a rule / entity draft the resolver's validated draft is TRANSLATED into
 * the shared GOVERNED engine (the one `/api/proposals` serves) with the
 * originating note stamped as `evidence`. The governed draft lands in `draft`
 * status and is never submitted, approved, or applied here.
 */
export function mountProposalsFromNoteRoute(app: Elysia, options: ServerOptions): void {
  // Engine A — the resolver's throwaway draft sink (mirrors the sibling). Every
  // successful resolution is translated into the shared governed engine below,
  // then this engine is cleared so its in-memory map never grows unbounded.
  const draftEngine = new ProposalEngine();
  // Engine B — the single GOVERNED Proposal engine `/api/proposals` serves.
  const governedEngine = getSharedProposalEngine();

  app.post("/api/proposals/from-note", async ({ body, request, set }) => {
    const parsed = proposalsFromNoteRequestSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      const issue = parsed.error.issues[0];
      return {
        success: false as const,
        error: {
          code: "VALIDATION.FAILED",
          message: issue?.message ?? "Invalid request body for /api/proposals/from-note",
        },
      };
    }

    const { noteId, entityName, recordId, noteBody } = parsed.data;

    const aiService: AIService | undefined = options.aiService;
    const ontologyRegistry = options.ontologyRegistry;

    // Resolve actor + tenant from the trusted request context. NEVER read these
    // from the body — the AI operates as the authenticated user.
    const actor = await resolveActor(request, options.resolveRequestActor);
    const resolveTenant = options.resolveRequestTenantId;
    const tenantId = resolveTenant ? await resolveTenant(request, actor) : undefined;

    // Graceful degradation — 503 with a structured error.
    if (!aiService?.configured) {
      return serviceUnavailable(
        set,
        "AI service is not configured. Configure an AI provider in linchkit.config.ts to enable note-to-proposal promotion.",
      );
    }
    if (!ontologyRegistry) {
      return serviceUnavailable(
        set,
        "Ontology registry is not available — note-to-proposal promotion requires the unified Ontology layer.",
      );
    }

    // The actor-scoped ontology IS the permission slot for this NL-governance
    // path — consistent with the sibling route.
    const ontology = buildSchemaIntentOntology({
      base: ontologyRegistry,
      permissionRegistry: options.permissionRegistry,
      actor,
    });

    let outcome: SchemaIntentOutcome;
    try {
      outcome = await resolveSchemaIntent(
        { utterance: noteBody, tenantId, userId: actor.id },
        {
          provider: aiService,
          ontology,
          // The resolver mints its draft + runs ALL security validation here.
          proposalEngine: draftEngine,
        },
      );
    } catch (err) {
      // The resolver swallows AI errors into no_match, so reaching here means an
      // unexpected programmer error. Surface 500 but never apply anything.
      const message = err instanceof Error ? err.message : "Note-to-proposal resolution failed";
      set.status = 500;
      return {
        success: false as const,
        error: { code: "PROPOSALS.FROM_NOTE.FAILED", message },
      };
    } finally {
      // The draft engine is throwaway — clearing keeps its in-memory map bounded
      // across requests. The resolver's returned proposal object survives the
      // clear (only the map entry is dropped), so translation below reads it by
      // reference.
      draftEngine.clear();
    }

    // The originating note recorded as the draft's provenance (经验→制度 first
    // segment). `ref` is the client-asserted note id — see the file doc comment.
    const evidence = {
      kind: "chatter_note",
      ref: noteId,
      context: { entityName, recordId },
    };

    // ── Persist the GOVERNED draft (only for a real proposed rule/entity) ──
    // `clarification` / `no_match` are NOT governed changes — nothing is
    // persisted for them.
    let governed: ProposalDefinition | undefined;
    if (outcome.kind === "proposal_draft") {
      governed = persistGovernedRuleDraft({
        engine: governedEngine,
        outcome,
        reasoning: noteBody,
        actor,
        evidence,
      });
    } else if (outcome.kind === "entity_proposal_draft") {
      // Scoped to the entity branch ONLY: persistGovernedEntityDraft throws on a
      // malformed/missing definition (defensive guards). Keep the structured-
      // error envelope instead of leaking Elysia's default unstructured 500.
      try {
        governed = persistGovernedEntityDraft({
          engine: governedEngine,
          outcome,
          reasoning: noteBody,
          actor,
          evidence,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to persist governed proposal";
        set.status = 500;
        return {
          success: false as const,
          error: { code: "PROPOSALS.FROM_NOTE.FAILED", message },
        };
      }
    }

    const response: ResolveSchemaIntentResponse = toResponse(outcome, governed);
    return response;
  });
}
