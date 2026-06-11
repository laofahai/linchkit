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
import { createSubprocessDryRunner } from "@linchkit/cap-dry-run";
import type {
  Actor,
  AIService,
  CommandLayer,
  ExecutionDryRunProvider,
  OntologyRegistry,
  ProposalChange,
  ProposalDefinition,
} from "@linchkit/core";
import {
  type CodeGenerationProvider,
  createSyntaxQualityGate,
  dryRunMaterializedChanges,
  type MaterializeChangeOutcome,
  materializeProposalChanges,
  type QualityGateRunner,
} from "@linchkit/core/server";
import { getSharedProposalEngine, serializeProposal } from "./proposal-api";
import { resolveActor, resolveStatusCode } from "./routes/shared";

/** Synthetic command name for the materialize dispatch (metrics/tracing only). */
const MATERIALIZE_COMMAND_NAME = "proposal.materialize";

/**
 * Sanitize the OPTIONAL, ALREADY-PARSED request body into a `changeNames` scope.
 *
 * The body is taken from the Elysia context (`context.body`), NOT re-read from
 * the raw `Request`. Calling `request.json()` inside the handler would throw
 * `TypeError: body stream already read` whenever Elysia's own body parser (or any
 * upstream middleware/plugin/derive hook) has already consumed the body stream —
 * which is the framework's default. Every other body-reading route in this addon
 * destructures `body` from the context; this one now follows suit.
 *
 * NEVER trust client input: a missing/empty/malformed body, or any body that is
 * not `{ changeNames: string[] }`, yields `undefined` (= materialize ALL, today's
 * behavior). From a well-formed array we keep ONLY non-empty string entries
 * (deduped); non-string garbage is dropped. If nothing survives, returns
 * `undefined` so an all-garbage `changeNames` degrades to "materialize all"
 * rather than scoping to the empty set (which would skip everything).
 *
 * This is STRING sanitation only. Membership against the proposal's ACTUAL
 * change names is enforced in {@link runProposalMaterialization} once the
 * proposal is loaded (names matching no change are dropped, and an all-unknown
 * scope likewise degrades to "materialize all").
 */
function sanitizeChangeNamesBody(body: unknown): readonly string[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const raw = (body as { changeNames?: unknown }).changeNames;
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  for (const entry of raw) {
    // Drop non-strings and empty/whitespace-only names; dedupe.
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    seen.add(trimmed);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

/**
 * Upper bound on the ontology Markdown embedded in the generation context. A real
 * project ontology can grow large; an unbounded summary would balloon the prompt
 * (cost + latency + truncation by the model). Past this many characters the
 * summary is cut and a clear marker is appended so the model knows it is partial.
 */
const ONTOLOGY_CONTEXT_MAX_CHARS = 12_000;

/** Marker appended when the ontology summary is truncated to fit the cap. */
const ONTOLOGY_TRUNCATION_MARKER = "\n\n… (truncated)";

/**
 * Fixed preamble of project conventions prepended to the ontology summary. Mirrors
 * the conventions the materializer already enforces in its prompt so the generated
 * candidate source references real entities/actions and follows house style.
 */
const PROJECT_CONVENTIONS_PREAMBLE =
  "You are generating LinchKit definition source. Follow these project conventions:\n" +
  "- Use `defineAction()` for actions; name them `verb_noun` (e.g. `deduct_inventory`).\n" +
  "- TypeScript strict mode — never use the `any` type.\n" +
  "- Reference only entities, actions, and fields that exist in the ontology below.\n" +
  "\nProject ontology (real entities/actions/rules/etc.):\n";

/**
 * Build the effective generation context for a materialization request.
 *
 * Precedence:
 *   1. An explicit non-empty `context` override wins verbatim (caller knows best).
 *   2. Otherwise, if an `ontology` is supplied, build a context = a fixed
 *      conventions preamble + the (size-capped) ontology Markdown summary so the
 *      model references real project entities/actions instead of guessing.
 *   3. Otherwise `undefined` (unchanged default behavior — no system context).
 *
 * The ontology summary is capped at {@link ONTOLOGY_CONTEXT_MAX_CHARS} characters
 * to keep the prompt bounded; an overflowing summary is truncated with a marker.
 */
function resolveMaterializeContext(opts: {
  context?: string;
  ontology?: OntologyRegistry;
}): string | undefined {
  // 1. Explicit override wins verbatim.
  if (typeof opts.context === "string" && opts.context.trim() !== "") {
    return opts.context;
  }
  // 2. Derive from the project ontology when available.
  if (!opts.ontology) return undefined;
  let summary = opts.ontology.toMarkdown();
  if (summary.length > ONTOLOGY_CONTEXT_MAX_CHARS) {
    summary =
      summary.slice(0, ONTOLOGY_CONTEXT_MAX_CHARS - ONTOLOGY_TRUNCATION_MARKER.length) +
      ONTOLOGY_TRUNCATION_MARKER;
  }
  return PROJECT_CONVENTIONS_PREAMBLE + summary;
}

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
  /**
   * Optional scope: when provided (non-empty), ONLY changes whose `name` is in
   * this list are (re)materialized; every other change is preserved untouched.
   * When absent/empty, ALL materializable changes are materialized (current
   * behavior). Lets a reviewer retry one FAILED change without regenerating —
   * and risking regression of — the already-good ones.
   */
  changeNames?: readonly string[];
  /**
   * Optional execution dry-run runner (Spec 70 P3). When supplied, each
   * FRESHLY-materialized change is run once in the sandbox and its durable
   * `dryRunStatus`/`dryRunOutcomes` are stamped (validation Phase 5 reads them).
   * ADVISORY / WARN-ONLY: a dry-run failure NEVER fails materialization — the
   * candidate source still lands on the draft for human review. Absent → no
   * dry-run runs (off by default).
   */
  dryRunProvider?: ExecutionDryRunProvider;
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

  // Resolve the effective scope against the loaded proposal's actual change
  // names. Client `changeNames` is already string-sanitized at the route; here we
  // additionally DROP names that match no change on THIS proposal (never trust a
  // client to know the real names). If nothing survives, fall back to `undefined`
  // so an all-unknown scope degrades to "materialize all" rather than scoping to
  // a phantom set that would skip every change.
  let effectiveChangeNames: readonly string[] | undefined;
  if (deps.changeNames && deps.changeNames.length > 0) {
    const known = new Set(proposal.changes.map((c) => c.name));
    const filtered = deps.changeNames.filter((name) => known.has(name));
    effectiveChangeNames = filtered.length > 0 ? filtered : undefined;
  }

  try {
    const result = await materializeProposalChanges({
      proposal,
      provider: deps.provider,
      qualityGate: deps.qualityGate,
      context: deps.context,
      maxRetries: deps.maxRetries,
      changeNames: effectiveChangeNames,
    });
    // Advisory execution dry-run (Spec 70 P3): when a runner is injected, run each
    // freshly-materialized change in the sandbox and stamp its durable
    // `dryRunStatus`/`dryRunOutcomes` so validation Phase 5 can read them. This is
    // WARN-ONLY and must NEVER fail materialization — the candidate source still
    // enters human review regardless — so it is wrapped to swallow any orchestrator
    // fault (the per-case provider faults are already contained as `infra_error`).
    if (deps.dryRunProvider) {
      try {
        await dryRunMaterializedChanges({
          proposal: result.proposal,
          provider: deps.dryRunProvider,
          // Mirror the materialization scope: in a scoped retry, only the freshly
          // (re)materialized changes are dry-run, so an out-of-scope change the
          // materializer preserved keeps its prior durable dryRunStatus untouched.
          changeNames: effectiveChangeNames,
        });
      } catch {
        // Advisory signal only — a dry-run fault never wedges materialization.
      }
    }
    // Persist the candidate source (+ any dry-run signal) back onto the draft.
    // `updateProposal` replaces `changes` (recomputing impact) and is draft-only —
    // never approves/graduates.
    const updated = deps.engine.updateProposal(proposalId, { changes: result.proposal.changes });
    // Defensive: the engine contract returns the updated `ProposalDefinition`, but
    // a custom/future impl could return null/undefined. Surfacing that as an error
    // keeps the route from later dereferencing `proposal.id` in serializeProposal.
    if (!updated) {
      return {
        kind: "error",
        message: "Proposal update returned no proposal after materialization.",
      };
    }
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
  /**
   * Explicit project context forwarded to the provider on every attempt. When set
   * to a non-empty string it wins verbatim over the ontology-derived context.
   */
  context?: string;
  /**
   * Project ontology used to derive the generation context when no explicit
   * `context` is given. Its `toMarkdown()` summary (size-capped) is prepended with
   * a conventions preamble so generated candidate source references REAL entities
   * and actions instead of guessing. Read-only — never mutated here.
   */
  ontology?: OntologyRegistry;
  /**
   * Override how the execution dry-run runner (Spec 70 P3) is resolved. Return
   * `null` to disable the dry-run (no `dryRunStatus` is stamped). The default
   * resolver is OPT-IN and OFF BY DEFAULT: it builds a hardened subprocess runner
   * ONLY when `process.env.LINCHKIT_EXECUTION_DRY_RUN === "1"`, else returns null.
   * The dry-run is advisory/warn-only and fail-closed (reports `infra_error` when
   * no OS sandbox is available), so enabling it never blocks materialization.
   * Exposed mainly for tests (inject a fake runner without spawning a subprocess).
   */
  resolveDryRunProvider?: () => ExecutionDryRunProvider | null;
}

/**
 * Register `POST /api/proposals/:id/materialize` on the given Elysia app.
 *
 * Request body (OPTIONAL): `{ changeNames?: string[] }`. When a non-empty
 * `changeNames` is given, ONLY those changes are (re)materialized; every other
 * change is preserved untouched (its existing `generatedSource` is kept) and
 * reported as `skipped`. This lets a reviewer retry one FAILED change without
 * re-calling the AI provider for — and risking regression of — the already-good
 * ones. A missing/empty/malformed body materializes ALL changes (today's
 * behavior, byte-for-byte). Client `changeNames` is sanitized: non-string
 * entries and names that do not match an actual change on the proposal are
 * dropped (never trusted).
 *
 * Contract:
 *   - 404 `{ success: false, error }` — proposal not found.
 *   - 422 `{ success: false, error }` — proposal not a draft (draft-only guard).
 *   - 503 `{ success: false, error }` — command layer or AI provider not configured.
 *   - 500 `{ success: false, error }` — unexpected generation failure.
 *   - 200 `{ success: true, data: { proposalId, allMaterialized, outcomes, proposal } }`.
 *     With a `changeNames` scope, out-of-scope changes appear in `outcomes` with
 *     status `skipped` and their `generatedSource` on `proposal` is preserved.
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
  // Effective generation context: explicit override wins, else derive from the
  // project ontology, else undefined. Resolved PER REQUEST (not memoized at mount)
  // so a runtime-mutated ontology — overlays, dynamic schema changes, entities a
  // prior evolution cycle added — is reflected. Materialization is a rare,
  // AI-bound call, so rebuilding the ontology Markdown each time is negligible.
  const getContext = (): string | undefined =>
    resolveMaterializeContext({ context: options?.context, ontology: options?.ontology });
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
  // Execution dry-run runner (Spec 70 P3). OFF BY DEFAULT: the default resolver
  // builds a hardened subprocess runner ONLY when the operator opts in via
  // `LINCHKIT_EXECUTION_DRY_RUN=1`. Read per request so the flag can be toggled at
  // runtime; the runner itself fails closed (infra_error) when no OS sandbox is
  // present, and the dry-run is advisory, so enabling it never blocks the endpoint.
  const resolveDryRunProvider =
    options?.resolveDryRunProvider ??
    (() => (process.env.LINCHKIT_EXECUTION_DRY_RUN === "1" ? createSubprocessDryRunner() : null));

  app.post(
    "/api/proposals/:id/materialize",
    async ({
      params,
      set,
      request,
      body,
    }: {
      params: { id: string };
      set: { status: number };
      request: Request;
      // Elysia pre-parses the JSON body into the context. Read it from here, NOT
      // via `request.json()` — the raw stream is already consumed by the time the
      // handler runs, so re-reading it throws "body stream already read".
      body: unknown;
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

      // Sanitize the OPTIONAL pre-parsed body AFTER auth + provider preflight so
      // the slot order (permission FIRST) is preserved. A missing/empty/malformed
      // body → undefined → materialize all (today's behavior); a sanitized scope
      // restricts (re)materialization to the named changes, preserving every
      // out-of-scope change untouched.
      const changeNames = sanitizeChangeNamesBody(body);

      const outcome = await runProposalMaterialization(params.id, {
        engine,
        provider,
        qualityGate,
        context: getContext(),
        changeNames,
        dryRunProvider: resolveDryRunProvider() ?? undefined,
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
