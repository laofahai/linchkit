/**
 * Proposal code-materialization REST endpoint — G5 Phase 4 (live wiring).
 *
 * Adds `POST /api/proposals/:id/materialize`: an on-demand path that takes a
 * DRAFT proposal and generates the irreducibly-code parts of its changes (today
 * the `ActionDefinition.handler` body) via a `CodeGenerationProvider` over the
 * configured AI provider, build-checks the output (Phase 2 syntax gate), and
 * attaches the candidate source to each change as `generatedSource`.
 *
 * SAFETY BOUNDARY (do NOT cross — see CLAUDE.md "AI Never Modifies Production Directly"):
 *   - DRAFT-only. A non-draft proposal is refused with a 422 and nothing is
 *     generated or written. Materialization is meaningful only before review.
 *   - Candidate source ONLY. The generated code is attached to the draft so it
 *     enters the existing human review pipeline. This endpoint NEVER submits,
 *     validates-to-approve, approves, commits, graduates, writes files, or runs
 *     the generated code. Double human review (draft review + graduation PR)
 *     still gates whether it ever lands.
 *   - ON-DEMAND only. There is NO scheduler / cron / timer that auto-materializes
 *     — cadence is a deferred product decision.
 *   - The permission slot (CommandLayer) is NEVER skipped: it runs FIRST, before
 *     any engine read or AI call, so an unauthorized caller learns nothing (not
 *     even whether the proposal exists).
 *
 * The HTTP handler is a thin shell around the injectable {@link runProposalMaterialization}
 * orchestrator so the core flow can be unit-tested with a fake provider (no real
 * model call). The route mirrors the error envelope, handler shape, and
 * `set.status` discipline of `proposal-graduate-api.ts`.
 */

import { createCodeGenerationProvider } from "@linchkit/cap-ai-provider";
import type {
  Actor,
  AIService,
  CommandLayer,
  ProposalChange,
  ProposalDefinition,
} from "@linchkit/core";
import {
  type CodeGenerationProvider,
  createSyntaxQualityGate,
  type MaterializeChangeOutcome,
  materializeProposalChanges,
  type QualityGateRunner,
} from "@linchkit/core/server";
import { getSharedProposalEngine, serializeProposal } from "./proposal-api";
import { resolveActor, resolveStatusCode } from "./routes/shared";

/** Synthetic command name for the materialize dispatch (metrics/tracing only). */
const MATERIALIZE_COMMAND_NAME = "proposal.materialize";

/**
 * Canonical authorization-denied envelope — every 401/403 path returns the SAME
 * payload so the response text cannot be used as a side channel (e.g. to probe
 * whether a given proposal id exists).
 */
const AUTHZ_DENIED_BODY = {
  success: false as const,
  error: { code: "AUTHZ_DENIED", message: "Access denied" },
} as const;

// ── Injectable seams (for testing) ───────────────────────────

/**
 * Engine surface the orchestrator depends on (subset of `ProposalEngine`).
 * `updateProposal` is draft-only in the engine and replaces `changes`, so the
 * materialized changes (carrying `generatedSource`) are persisted back onto the
 * draft.
 */
export interface MaterializeEngine {
  getProposal(id: string): ProposalDefinition;
  updateProposal(id: string, updates: { changes?: ProposalChange[] }): ProposalDefinition;
}

// ── Result envelope ──────────────────────────────────────────

/** Discriminated outcome of a materialization attempt. */
export type MaterializeOutcome =
  | {
      kind: "ok";
      proposal: ProposalDefinition;
      outcomes: MaterializeChangeOutcome[];
      allMaterialized: boolean;
    }
  | { kind: "not_found" }
  | { kind: "not_draft"; status: string }
  | { kind: "error"; message: string };

// ── Core orchestrator (injectable, framework-free) ───────────

export interface RunProposalMaterializationDeps {
  engine: MaterializeEngine;
  /** AI code generation provider (e.g. cap-ai-provider's createCodeGenerationProvider). */
  provider: CodeGenerationProvider;
  /** Build/quality gate (Phase 2). Defaults to a syntax-only gate at the route. */
  qualityGate?: QualityGateRunner;
  /** Project conventions / context passed as the system message to the provider. */
  context?: string;
  /** Max generation attempts per change (defaults to the materializer's default). */
  maxRetries?: number;
}

/**
 * Materialize a single DRAFT proposal: generate candidate source for its
 * materializable changes and persist it back onto the draft via
 * `engine.updateProposal`.
 *
 * Returns a discriminated {@link MaterializeOutcome} instead of throwing so the
 * HTTP handler can map each case to the right status code. The draft-only guard
 * runs FIRST — when it trips, the provider is never called and nothing is
 * written.
 */
export async function runProposalMaterialization(
  proposalId: string,
  deps: RunProposalMaterializationDeps,
): Promise<MaterializeOutcome> {
  let proposal: ProposalDefinition;
  try {
    proposal = deps.engine.getProposal(proposalId);
  } catch {
    return { kind: "not_found" };
  }
  // Defensive: the engine contract returns a `ProposalDefinition`, but a custom
  // or future `MaterializeEngine` impl could return `null`/`undefined` for a
  // missing id instead of throwing. Treat that as not-found so the next line's
  // `proposal.status` read can never throw an unhandled (non-envelope) 500.
  if (!proposal) {
    return { kind: "not_found" };
  }

  // ── Draft-only guard (REQUIRED) ──
  // Materialization only ever acts on a draft (pre-review). Anything else is
  // refused before any AI call or write — and `updateProposal` itself rejects a
  // non-draft, so this also keeps the engine contract happy.
  if (proposal.status !== "draft") {
    return { kind: "not_draft", status: proposal.status };
  }

  try {
    const result = await materializeProposalChanges({
      proposal,
      provider: deps.provider,
      qualityGate: deps.qualityGate,
      context: deps.context,
      maxRetries: deps.maxRetries,
    });
    // Persist the candidate source back onto the draft. `updateProposal` replaces
    // `changes` (recomputing impact) and is draft-only — never approves/graduates.
    const updated = deps.engine.updateProposal(proposalId, { changes: result.proposal.changes });
    return {
      kind: "ok",
      proposal: updated,
      outcomes: result.outcomes,
      allMaterialized: result.allMaterialized,
    };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

// ── Mount the Elysia route ───────────────────────────────────

export interface MountProposalMaterializeAPIOptions {
  /**
   * CommandLayer used to run the permission slot before any side effect.
   * REQUIRED in production — materialization calls the AI provider and mutates a
   * draft, so an unauthorized caller must be rejected. When absent the endpoint
   * returns 503.
   */
  commandLayer?: CommandLayer;
  /** Resolve the request actor for the permission slot (defaults to anonymous). */
  resolveRequestActor?: (request: Request) => Promise<Actor | undefined> | Actor | undefined;
  /**
   * AI service used to build the default `CodeGenerationProvider`. When absent or
   * not `configured`, the endpoint returns 503 (graceful degradation) rather than
   * calling an unconfigured provider.
   */
  aiService?: AIService;
  /**
   * Override the proposal engine (defaults to the shared governed engine).
   * Exposed mainly for tests.
   */
  engine?: MaterializeEngine;
  /**
   * Override how the provider is built (defaults to
   * `createCodeGenerationProvider(aiService)`). Return `null` to force the
   * "not configured" 503 path. Exposed for tests so no real model is called.
   */
  resolveProvider?: () => CodeGenerationProvider | null;
  /** Override the build/quality gate (defaults to {@link createSyntaxQualityGate}). */
  qualityGate?: QualityGateRunner;
  /** Optional project context forwarded to the provider on every attempt. */
  context?: string;
}

/**
 * Register `POST /api/proposals/:id/materialize` on the given Elysia app.
 *
 * Contract:
 *   - 404 `{ success: false, error }` — proposal not found.
 *   - 422 `{ success: false, error }` — proposal not a draft (draft-only guard).
 *   - 503 `{ success: false, error }` — command layer or AI provider not configured.
 *   - 500 `{ success: false, error }` — unexpected generation failure.
 *   - 200 `{ success: true, data: { proposalId, allMaterialized, outcomes, proposal } }`.
 *
 * @param app Elysia app instance
 * @param options Engine + provider overrides (all optional; production uses defaults).
 */
export function mountProposalMaterializeAPI(
  // biome-ignore lint/suspicious/noExplicitAny: Elysia plugin typing
  app: any,
  options?: MountProposalMaterializeAPIOptions,
): void {
  const commandLayer = options?.commandLayer;
  const resolveRequestActor = options?.resolveRequestActor;
  const engine: MaterializeEngine = options?.engine ?? getSharedProposalEngine();
  const qualityGate = options?.qualityGate ?? createSyntaxQualityGate();
  const context = options?.context;
  const resolveProvider =
    options?.resolveProvider ??
    (() => {
      const ai = options?.aiService;
      // No service, or a noop/unconfigured one → degrade to 503 instead of
      // calling a provider that would throw "AIService is not configured".
      // (`ai?.configured !== true` also covers `ai === undefined`.)
      if (ai?.configured !== true) return null;
      return createCodeGenerationProvider(ai);
    });

  app.post(
    "/api/proposals/:id/materialize",
    async ({
      params,
      set,
      request,
    }: {
      params: { id: string };
      set: { status: number };
      request: Request;
    }) => {
      // ── Permission slot (CommandLayer) — run FIRST, before any provider build,
      // engine read, or AI call. Materialization invokes the AI and mutates a
      // draft, so the permission slot is NEVER skipped; an unauthorized caller
      // must learn nothing (not even whether the proposal exists).
      if (!commandLayer) {
        set.status = 503;
        return {
          success: false,
          error: {
            code: "MATERIALIZE.NOT_CONFIGURED",
            message: "Command layer is not configured — cannot authorize proposal materialization.",
          },
        };
      }
      const actor = await resolveActor(request, resolveRequestActor);
      const headers: Record<string, string> = {};
      for (const [key, value] of request.headers.entries()) {
        headers[key] = value;
      }
      const commandResult = await commandLayer.execute({
        command: MATERIALIZE_COMMAND_NAME,
        input: { proposalId: params.id },
        actor,
        channel: "http",
        headers,
        traceId: request.headers.get("x-trace-id") ?? undefined,
        meta: { proposal: { operation: "materialize", proposalId: params.id } },
        skipActionSlots: true,
      });
      if (!commandResult.success) {
        const status = resolveStatusCode(commandResult);
        set.status = status;
        if (status === 401 || status === 403) {
          return AUTHZ_DENIED_BODY;
        }
        const errData = commandResult.data as Record<string, unknown> | undefined;
        return {
          success: false,
          error: {
            code: (errData?.code as string) ?? "MATERIALIZE.BLOCKED",
            message: (errData?.error as string) ?? "Proposal materialization blocked",
          },
        };
      }

      // ── Pre-flight: is an AI provider configured? ──
      // Resolve the provider BEFORE touching the engine so an unconfigured server
      // degrades gracefully without leaking proposal existence/state.
      const provider = resolveProvider();
      if (!provider) {
        set.status = 503;
        return {
          success: false,
          error: {
            code: "MATERIALIZE.NOT_CONFIGURED",
            message:
              "AI code generation is not configured. Configure an AI provider " +
              "(linchkit.config `ai`) so the server can generate proposal source.",
          },
        };
      }

      const outcome = await runProposalMaterialization(params.id, {
        engine,
        provider,
        qualityGate,
        context,
      });

      switch (outcome.kind) {
        case "not_found":
          set.status = 404;
          return { success: false, error: { message: `Proposal "${params.id}" not found.` } };
        case "not_draft":
          set.status = 422;
          return {
            success: false,
            error: {
              message: `Materialization requires a draft proposal — "${params.id}" is "${outcome.status}".`,
            },
          };
        case "error":
          set.status = 500;
          return { success: false, error: { message: outcome.message } };
        case "ok":
          return {
            success: true,
            data: {
              proposalId: params.id,
              allMaterialized: outcome.allMaterialized,
              outcomes: outcome.outcomes,
              proposal: serializeProposal(outcome.proposal),
            },
          };
      }
    },
  );
}
