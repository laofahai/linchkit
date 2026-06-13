/**
 * Manual proposal graduation REST endpoint — Spec 55 §7.6 + §7.7.
 *
 * Adds `POST /api/proposals/:id/graduate`: an ADMIN-triggered, on-demand path
 * that takes an ALREADY-APPROVED proposal, writes its definition files to disk
 * (`ProposalFileWriter`), and opens a GitHub PR (`ProposalGitCommitter`).
 *
 * SAFETY BOUNDARY (do NOT cross — see CLAUDE.md "AI Never Modifies Production Directly"):
 *   - Graduation is MANUAL only. This endpoint is the sole trigger. We do NOT
 *     wire `ProposalEngine.onApproved` to auto-graduate, and there is no
 *     background scheduler.
 *   - We NEVER auto-merge. `ProposalGitCommitter.commitAndOpenPR` only opens a
 *     PR for human review; this module never calls any merge path.
 *   - Approved-only. A non-approved proposal is refused with a 4xx and nothing
 *     is written or committed.
 *
 * The HTTP handler is a thin shell around the injectable {@link graduateProposal}
 * orchestrator so the core flow can be unit-tested with fake writer/committer
 * stubs (no real `git`/`gh`/filesystem). The route mirrors the error envelope,
 * handler shape, and `set.status` discipline of the approve/reject routes in
 * `proposal-api.ts`.
 */

import type { Actor, CommandLayer, ProposalDefinition, SourcePatcher } from "@linchkit/core";
import {
  createProposalGitCommitter,
  ProposalFileWriter,
  type ProposalGitCommitResult,
} from "@linchkit/core/server";
import { getSharedProposalEngine } from "./proposal-api";
import { resolveActor, resolveStatusCode } from "./routes/shared";

/** Synthetic command name for the graduate dispatch (metrics/tracing only). */
const GRADUATE_COMMAND_NAME = "proposal.graduate";

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

/** Minimal writer contract — `ProposalFileWriter` satisfies this. */
export interface GraduationFileWriter {
  writeApprovedProposal(proposal: ProposalDefinition): Promise<string[]>;
}

/** Minimal committer contract — `ProposalGitCommitter` satisfies this. */
export interface GraduationGitCommitter {
  commitAndOpenPR(
    proposal: ProposalDefinition,
    writtenFiles: readonly string[],
  ): Promise<ProposalGitCommitResult>;
}

/** Engine surface the orchestrator depends on (subset of `ProposalEngine`). */
export interface GraduationEngine {
  getProposal(id: string): ProposalDefinition;
  commitProposal?: (options: { proposalId: string }) => unknown;
}

// ── Result envelope ──────────────────────────────────────────

/** Discriminated outcome of a graduation attempt. */
export type GraduationOutcome =
  | { kind: "ok"; result: ProposalGitCommitResult; committed: boolean }
  | { kind: "not_found" }
  | { kind: "not_approved"; status: string }
  | { kind: "not_configured"; message: string }
  | { kind: "error"; message: string };

// ── Config resolution ────────────────────────────────────────

/** Resolved git/GitHub settings needed to construct the FileWriter + GitCommitter. */
export interface GraduationConfig {
  /** Absolute repository root (cwd of every git/gh subprocess + file writes). */
  rootDir: string;
  /** Base branch the PR targets (default "main"). */
  baseBranch?: string;
  /** Git remote name (default "origin"). */
  remote?: string;
}

/**
 * Source graduation config from the environment.
 *
 * Returns `null` when graduation is NOT configured, which the handler maps to a
 * graceful 503 rather than crashing or guessing credentials. Graduation needs
 * to push a branch and open a PR via the `gh` CLI, which requires a GitHub
 * token to be present in the environment (`GITHUB_TOKEN` or `GH_TOKEN`). When
 * neither is set we treat graduation as unconfigured.
 *
 * Overrides:
 *   - `PROPOSAL_GRADUATE_ROOT_DIR` — repo root (defaults to `process.cwd()`).
 *   - `PROPOSAL_GRADUATE_BASE_BRANCH` — PR base branch (defaults to committer's "main").
 *   - `PROPOSAL_GRADUATE_REMOTE` — git remote (defaults to committer's "origin").
 */
export function resolveGraduationConfig(
  env: Record<string, string | undefined> = process.env,
): GraduationConfig | null {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (!token || token.trim().length === 0) {
    return null;
  }
  const rootDir = env.PROPOSAL_GRADUATE_ROOT_DIR?.trim() || process.cwd();
  const config: GraduationConfig = { rootDir };
  const baseBranch = env.PROPOSAL_GRADUATE_BASE_BRANCH?.trim();
  if (baseBranch) config.baseBranch = baseBranch;
  const remote = env.PROPOSAL_GRADUATE_REMOTE?.trim();
  if (remote) config.remote = remote;
  return config;
}

// ── Core orchestrator (injectable, framework-free) ───────────

export interface GraduateProposalDeps {
  engine: GraduationEngine;
  writer: GraduationFileWriter;
  committer: GraduationGitCommitter;
}

/**
 * Graduate a single approved proposal: write its files, then open a PR.
 *
 * Returns a discriminated {@link GraduationOutcome} instead of throwing so the
 * HTTP handler can map each case to the right status code. The approved-only
 * guard runs FIRST — when it trips, neither the writer nor the committer is
 * invoked (no partial state).
 */
export async function graduateProposal(
  proposalId: string,
  deps: GraduateProposalDeps,
): Promise<GraduationOutcome> {
  let proposal: ProposalDefinition;
  try {
    proposal = deps.engine.getProposal(proposalId);
  } catch {
    return { kind: "not_found" };
  }
  // Defensive: the engine contract returns a `ProposalDefinition`, but a custom
  // or future `GraduationEngine` impl could return `null`/`undefined` for a
  // missing id instead of throwing. Treat that as not-found so the next line's
  // `proposal.status` read can never throw an unhandled (non-envelope) 500.
  if (!proposal) {
    return { kind: "not_found" };
  }

  // ── Approved-only guard (REQUIRED) ──
  // Graduation only ever acts on an approved proposal. Anything else is
  // refused before any disk/git side effect.
  if (proposal.status !== "approved") {
    return { kind: "not_approved", status: proposal.status };
  }

  // ── Write files, then open a PR (NEVER merge) ──
  let writtenFiles: string[];
  let result: ProposalGitCommitResult;
  try {
    writtenFiles = await deps.writer.writeApprovedProposal(proposal);
    result = await deps.committer.commitAndOpenPR(proposal, writtenFiles);
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }

  // ── Record graduation (approved → committed) when the engine supports it ──
  // Best-effort: the PR is already open, so a bookkeeping failure here must not
  // surface as a graduation failure. We only flip the flag on success.
  let committed = false;
  if (typeof deps.engine.commitProposal === "function") {
    try {
      deps.engine.commitProposal({ proposalId });
      committed = true;
    } catch {
      committed = false;
    }
  }

  return { kind: "ok", result, committed };
}

// ── Mount the Elysia route ───────────────────────────────────

export interface MountProposalGraduateAPIOptions {
  /**
   * CommandLayer used to run the permission slot before any side effect.
   * REQUIRED in production — graduation writes files and opens a PR, so an
   * unauthorized caller must be rejected. When absent the endpoint returns 503.
   */
  commandLayer?: CommandLayer;
  /** Resolve the request actor for the permission slot (defaults to anonymous). */
  resolveRequestActor?: (request: Request) => Promise<Actor | undefined> | Actor | undefined;
  /**
   * Override the proposal engine (defaults to the shared governed engine).
   * Exposed mainly for tests.
   */
  engine?: GraduationEngine;
  /**
   * Override config resolution (defaults to {@link resolveGraduationConfig}
   * over `process.env`). Return `null` to force the "not configured" path.
   */
  resolveConfig?: () => GraduationConfig | null;
  /**
   * Override how the writer is built from config (defaults to a real
   * `ProposalFileWriter`). Exposed for tests so no real filesystem is touched.
   */
  createWriter?: (config: GraduationConfig) => GraduationFileWriter;
  /**
   * TS-AST source patcher injected into the DEFAULT writer so an approved
   * code-condition rule update (a change carrying `sourcePatch`) rewrites the
   * named constant in real source during graduation. Ignored when
   * `createWriter` is overridden (tests then fully control the writer). The
   * composition root supplies `patchNamedConstant` from `@linchkit/devtools`.
   */
  sourcePatcher?: SourcePatcher;
  /**
   * Override how the committer is built from config (defaults to a real
   * `ProposalGitCommitter`). Exposed for tests so no real `git`/`gh` runs.
   */
  createCommitter?: (config: GraduationConfig) => GraduationGitCommitter;
}

/**
 * Register `POST /api/proposals/:id/graduate` on the given Elysia app.
 *
 * Contract:
 *   - 404 `{ success: false, error }` — proposal not found.
 *   - 422 `{ success: false, error }` — proposal not approved (approved-only guard).
 *   - 503 `{ success: false, error }` — git/GitHub not configured (graceful degradation).
 *   - 500 `{ success: false, error }` — write/commit/PR failure.
 *   - 200 `{ success: true, data: { prUrl, branch, commitSha, committed } }` — PR opened.
 *
 * @param app Elysia app instance
 * @param options Engine + construction overrides (all optional; production uses defaults).
 */
export function mountProposalGraduateAPI(
  // biome-ignore lint/suspicious/noExplicitAny: Elysia plugin typing
  app: any,
  options?: MountProposalGraduateAPIOptions,
): void {
  const commandLayer = options?.commandLayer;
  const resolveRequestActor = options?.resolveRequestActor;
  const engine: GraduationEngine = options?.engine ?? getSharedProposalEngine();
  const resolveConfig = options?.resolveConfig ?? (() => resolveGraduationConfig());
  const createWriter =
    options?.createWriter ??
    ((config: GraduationConfig) =>
      // Format generated source through Biome so the graduation PR's files pass
      // the same Code Quality gate every other PR faces. Formatting failures are
      // swallowed by the writer (it falls back to un-formatted source), so this
      // can never block graduation.
      new ProposalFileWriter({
        ...config,
        formatter: true,
        sourcePatcher: options?.sourcePatcher,
      }));
  const createCommitter =
    options?.createCommitter ??
    ((config: GraduationConfig) =>
      createProposalGitCommitter({
        rootDir: config.rootDir,
        baseBranch: config.baseBranch,
        remote: config.remote,
      }));

  app.post(
    "/api/proposals/:id/graduate",
    async ({
      params,
      set,
      request,
    }: {
      params: { id: string };
      set: { status: number };
      request: Request;
    }) => {
      // ── Permission slot (CommandLayer) — run FIRST, before any config probe,
      // engine read, disk write, or git/PR side effect. Graduation is a
      // high-impact mutation (writes files + opens a PR), so the permission slot
      // is NEVER skipped; an unauthorized caller must learn nothing (not even
      // whether the proposal exists). Mirrors the onchange route convention.
      if (!commandLayer) {
        set.status = 503;
        return {
          success: false,
          error: {
            code: "GRADUATION.NOT_CONFIGURED",
            message: "Command layer is not configured — cannot authorize proposal graduation.",
          },
        };
      }
      const actor = await resolveActor(request, resolveRequestActor);
      const headers: Record<string, string> = {};
      for (const [key, value] of request.headers.entries()) {
        headers[key] = value;
      }
      const commandResult = await commandLayer.execute({
        command: GRADUATE_COMMAND_NAME,
        input: { proposalId: params.id },
        actor,
        channel: "http",
        headers,
        traceId: request.headers.get("x-trace-id") ?? undefined,
        meta: { proposal: { operation: "graduate", proposalId: params.id } },
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
            code: (errData?.code as string) ?? "GRADUATION.BLOCKED",
            message: (errData?.error as string) ?? "Proposal graduation blocked",
          },
        };
      }

      // ── Pre-flight: is graduation configured? ──
      // Resolve config BEFORE touching the engine so an unconfigured server
      // degrades gracefully without leaking proposal existence/state.
      const config = resolveConfig();
      if (!config) {
        set.status = 503;
        return {
          success: false,
          error: {
            code: "GRADUATION.NOT_CONFIGURED",
            message:
              "Proposal graduation is not configured. Set a GitHub token " +
              "(GITHUB_TOKEN or GH_TOKEN) so the server can push a branch and open a PR.",
          },
        };
      }

      const outcome = await graduateProposal(params.id, {
        engine,
        writer: createWriter(config),
        committer: createCommitter(config),
      });

      switch (outcome.kind) {
        case "not_found":
          set.status = 404;
          return { success: false, error: { message: `Proposal "${params.id}" not found.` } };
        case "not_approved":
          set.status = 422;
          return {
            success: false,
            error: {
              message: `Graduation requires an approved proposal — "${params.id}" is "${outcome.status}".`,
            },
          };
        case "not_configured":
          // Defensive: graduateProposal never emits this today, but keep the
          // mapping so a future config check inside the orchestrator degrades
          // to 503 rather than an unhandled case.
          set.status = 503;
          return { success: false, error: { message: outcome.message } };
        case "error":
          set.status = 500;
          return { success: false, error: { message: outcome.message } };
        case "ok":
          return {
            success: true,
            data: {
              prUrl: outcome.result.prUrl,
              branch: outcome.result.branch,
              commitSha: outcome.result.commitSha,
              committed: outcome.committed,
            },
          };
      }
    },
  );
}
