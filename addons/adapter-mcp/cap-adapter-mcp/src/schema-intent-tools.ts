/**
 * Spec 52 "说→有" — MCP `resolve_schema_intent` tool (issue #583).
 *
 * The MCP-channel sibling of the HTTP route
 * `POST /api/ai/resolve-schema-intent` (issue #578). It lets an MCP-connected
 * agent send a natural-language utterance (e.g. "增加一个商品管理") and get a
 * GOVERNED proposal draft — closing the "every channel" gap for 说→有 on the
 * MCP channel.
 *
 * It is a faithful port of the route's wiring + security posture:
 *  - Validates/sanitizes the prompt (Zod min-length; the resolver's
 *    `sanitizePrompt` runs the prompt-injection defense internally).
 *  - Builds a PERMISSION-SCOPED ontology via `buildSchemaIntentOntology`
 *    (LOCAL copy in `./schema-intent-ontology` — adapter-mcp must not import
 *    from adapter-server; see that file's header for the boundary rationale).
 *  - Guards on `aiService?.configured` / `ontologyRegistry` / `proposalEngine`
 *    — degrades gracefully with a structured "unavailable" error (mirrors the
 *    route's 503 semantics) instead of throwing.
 *  - Runs the canonical `resolveSchemaIntent()` engine, drafting into a
 *    THROWAWAY draft engine (Engine A) exactly like the route.
 *  - Persists the validated draft into the SAME governed `proposalEngine`
 *    (Engine B) the MCP server already uses for `create_proposal` — so it
 *    surfaces in `list_proposals` / `/api/proposals`.
 *
 * Hard rules (repo principle "AI Never Modifies Production Directly"):
 *  - The tool NEVER submits, approves, or applies the proposal. The persisted
 *    governed Proposal is ALWAYS `draft`. Graduating it is a separate,
 *    human-gated path.
 */

import type {
  Actor,
  AIService,
  EntityDefinition,
  OntologyRegistry,
  PermissionRegistry,
  ProposalChange,
  ProposalDefinition,
  RuleDefinition,
} from "@linchkit/core";
import type {
  SchemaIntentEntityProposalDraft,
  SchemaIntentOutcome,
  SchemaIntentProposalDraft,
} from "@linchkit/core/ai";
import {
  ProposalEngine,
  REQUIRES_CODE_CHANGE_MARKER,
  resolveSchemaIntent,
} from "@linchkit/core/ai";
import type { ProposalEngine as GovernedProposalEngine } from "@linchkit/core/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildSchemaIntentOntology } from "./schema-intent-ontology";
import { toMcpShape } from "./zod-compat";

/** Error result returned when a tool is blocked by policy or unavailable. */
interface ToolBlockedResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError: true;
}

export interface SchemaIntentToolsOptions {
  /** AI service — provides LLM completion. The tool degrades when not configured. */
  aiService?: AIService;
  /** Unified ontology registry — projected into a permission-scoped catalog. */
  ontologyRegistry?: OntologyRegistry;
  /**
   * GOVERNED proposal engine — the SAME instance `create_proposal` /
   * `list_proposals` use, so the NL draft surfaces in the review pipeline.
   */
  proposalEngine?: GovernedProposalEngine;
  /**
   * Permission registry — when present, the ontology catalog is scoped to
   * entities the resolved actor can act on (least-privilege). Optional: dev
   * runs without RBAC pass everything through.
   */
  permissionRegistry?: PermissionRegistry;
  /** Session actor getter — called at invocation time to reflect auth changes. */
  getSessionActor?: () => Actor | undefined;
  /**
   * Tool policy checker. Returns an error result if the tool is not allowed,
   * or undefined if the tool is permitted.
   */
  checkToolPolicy?: (toolName: string, category: string) => ToolBlockedResult | undefined;
}

/** Default actor when no session actor is wired (open access / stdio). */
const DEFAULT_ACTOR: Actor = {
  type: "ai",
  id: "mcp-client",
  name: "MCP Client",
  groups: ["ai_agent"],
};

/** Wrap a payload object as a successful MCP text tool result. */
function textResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/** Wrap a structured error as an MCP error tool result (mirrors route 503/500). */
function errorResult(payload: Record<string, unknown>): ToolBlockedResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

// ── Translate the resolver draft → governed Proposal ─────────
// Ports `persistGovernedRuleDraft` / `persistGovernedEntityDraft` from
// adapter-server's `ai-resolve-schema-intent.ts`. The functions depend ONLY
// on core types + the governed engine's `createProposal`, so the port carries
// no adapter-server dependency.

/**
 * Persist a resolver-produced `add_rule` / `update_rule` draft into the shared
 * GOVERNED engine — the same instance `list_proposals` reads from — so the NL
 * draft surfaces in the review pipeline.
 *
 * The resolver runs ALL of its security validation first; by the time we reach
 * here the draft carries only validated, typed values. The proposal lands in
 * `draft` status. It is NEVER submitted, approved, or applied here.
 *
 * Returns `undefined` when the draft does not carry a usable rule definition
 * for a definition-bearing path (defensive — the resolver only emits
 * `proposal_draft` with a built rule).
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

  const rawDefinition = draft.diff?.definition;
  const definition =
    rawDefinition && typeof rawDefinition === "object"
      ? (rawDefinition as RuleDefinition)
      : undefined;
  if (!definition && !diffOnly) return undefined;

  // A diff-only draft is an HONEST developer change-request: it has no
  // definition BY DESIGN (the rule cannot be rebuilt declaratively). The
  // PERSISTED proposal carries a stable text marker on the change's diff and
  // the description — the fields the review UI renders.
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
    // Preserve the original utterance + the requesting actor for the audit
    // trail. The utterance is never interpolated into a privileged context —
    // this string is display/audit metadata only.
    description: `${reasoning}\n\n(Requested by ${actor.type}:${actor.id})${codeChangeNote}`,
    author: { type: "ai", id: "schema-intent-resolver", name: "Schema Intent Resolver" },
    // The rule attaches to its target entity — the governed capability key.
    capability: targetEntity,
    changeType: "minor",
    changes: [change],
  });
}

/**
 * Persist a resolver-produced `add_entity` draft into the shared GOVERNED
 * engine. The resolver runs ALL of its structural validation first; we
 * translate the validated `EntityDefinition` into a single governed
 * `ProposalChange` (`{ target: "entity", operation: "create", ... }`) in
 * `draft` status. It is NEVER submitted, approved, or applied here.
 *
 * A drafted relation rides along inside the resolver draft's definition, but it
 * is NOT carried into the governed change (the relation is stripped below) —
 * mirroring the route's #580 deferral. The relation still surfaces in the tool
 * response for the review UI.
 *
 * Throws (rather than returning undefined) on a malformed/missing definition —
 * a silent undefined would let the tool report success while nothing governed.
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
    throw new Error(
      `persistGovernedEntityDraft: missing or non-object entity definition (entityName=${entityName})`,
    );
  }
  // Strip the drafted relation extra — the governed `entity` change's
  // definition must be a clean `EntityDefinition`. The relation surfaces
  // separately in the response (#580 deferral).
  const { relation: _relation, ...entityRest } = definition as Record<string, unknown>;
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

  const change: ProposalChange = {
    target: "entity",
    operation: "create",
    name: entityName,
    definition: entityDefinition,
    diff: explanation,
  };

  return engine.createProposal({
    title: explanation,
    description: `${reasoning}\n\n(Requested by ${actor.type}:${actor.id})`,
    author: { type: "ai", id: "schema-intent-resolver", name: "Schema Intent Resolver" },
    capability: entityName,
    changeType: "minor",
    changes: [change],
  });
}

// ── Response shaping ─────────────────────────────────────────

/**
 * Shape the structured tool response from the resolver outcome + the persisted
 * governed proposal. Mirrors the HTTP route's `toResponse`: surfaces the
 * outcome kind, the governed proposalId + status, and the key fields per kind.
 */
function shapeResponse(
  outcome: SchemaIntentOutcome,
  governed?: ProposalDefinition,
): Record<string, unknown> {
  switch (outcome.kind) {
    case "proposal_draft":
      return {
        outcome: "proposal_draft",
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

// ── Tool registration ────────────────────────────────────────

const resolveSchemaIntentShape = {
  prompt: z
    .string()
    .min(1, "prompt must be a non-empty string")
    .describe(
      "Natural-language utterance describing a desired metamodel change " +
        "(e.g. '增加一个商品管理' or 'block purchase requests over 10000'). " +
        "Resolves into a GOVERNED proposal draft — never auto-applied.",
    ),
};

/**
 * Register the `resolve_schema_intent` tool on the MCP server.
 *
 * The caller must only register this when `aiService.configured`,
 * `ontologyRegistry`, and `proposalEngine` are all present (mirroring how
 * `registerProposalTools` is conditionally registered). The tool still
 * re-guards at invocation time and returns a structured unavailable error if
 * any dependency is missing — defense-in-depth.
 */
export function registerSchemaIntentTools(
  server: McpServer,
  options: SchemaIntentToolsOptions,
): void {
  server.tool(
    "resolve_schema_intent",
    "说→有 (Spec 52): turn a natural-language utterance into a GOVERNED metamodel " +
      "change proposal (new entity, new/updated business rule). The proposal is " +
      "always created in DRAFT status and surfaces in list_proposals / the review " +
      "pipeline — AI never auto-applies. Human approval is required before any " +
      "structural change is applied.",
    toMcpShape(resolveSchemaIntentShape),
    async (args: { prompt: string }) => {
      // Defense-in-depth: verify tool is allowed for current session. Reuses
      // the "proposals" category — a schema-intent resolution produces a
      // governed proposal, same as create_proposal.
      const blocked = options.checkToolPolicy?.("resolve_schema_intent", "proposals");
      if (blocked) return blocked;

      const { aiService, ontologyRegistry, proposalEngine, permissionRegistry } = options;

      // Graceful degradation — structured unavailable error, never throw.
      // Mirrors the route's 503 semantics.
      if (!aiService?.configured) {
        return errorResult({
          error: "unavailable",
          message:
            "AI service is not configured. Configure an AI provider in linchkit.config.ts to enable schema intent resolution.",
        });
      }
      if (!ontologyRegistry) {
        return errorResult({
          error: "unavailable",
          message:
            "Ontology registry is not available — schema intent resolution requires the unified Ontology layer.",
        });
      }
      if (!proposalEngine) {
        return errorResult({
          error: "unavailable",
          message:
            "Proposal engine is not available — schema intent resolution requires the governed proposal pipeline.",
        });
      }

      // Resolve the actor from the trusted session context (NEVER from input).
      const actor = options.getSessionActor?.() ?? DEFAULT_ACTOR;

      // Permission-scoped ontology — the AI sees only what the actor can act on.
      const ontology = buildSchemaIntentOntology({
        base: ontologyRegistry,
        permissionRegistry,
        actor,
      });

      // Engine A — the resolver's throwaway draft sink. Every successful
      // resolution is TRANSLATED into the governed engine (Engine B) below,
      // then this engine is cleared so its in-memory map never grows unbounded.
      const draftEngine = new ProposalEngine();

      let outcome: SchemaIntentOutcome;
      try {
        outcome = await resolveSchemaIntent(
          {
            utterance: args.prompt,
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
        // an unexpected programmer error. Surface a structured error; nothing
        // is applied.
        const message = err instanceof Error ? err.message : "Schema intent resolution failed";
        return errorResult({ error: "resolution_failed", message });
      } finally {
        // Engine A is throwaway — its entry was already translated into the
        // governed engine (or nothing was minted). Clearing keeps its in-memory
        // map bounded. The resolver's returned proposal object survives the
        // clear (we only drop the map entry); translation reads it by reference.
        draftEngine.clear();
      }

      // ── Persist the GOVERNED draft (only for a real proposed rule/entity) ──
      // `clarification` / `no_match` are NOT governed changes — nothing persists.
      let governed: ProposalDefinition | undefined;
      try {
        if (outcome.kind === "proposal_draft") {
          governed = persistGovernedRuleDraft({
            engine: proposalEngine,
            outcome,
            reasoning: args.prompt,
            actor,
          });
        } else if (outcome.kind === "entity_proposal_draft") {
          governed = persistGovernedEntityDraft({
            engine: proposalEngine,
            outcome,
            reasoning: args.prompt,
            actor,
          });
        }
      } catch (err) {
        // persistGovernedEntityDraft throws on a malformed/missing definition
        // (defensive guards that should never fire in normal flow). Keep the
        // structured-error envelope instead of leaking an unhandled throw.
        const message = err instanceof Error ? err.message : "Failed to persist governed proposal";
        return errorResult({ error: "persist_failed", message });
      }

      return textResult(shapeResponse(outcome, governed));
    },
  );
}
