/**
 * API client for Proposal / Evolution / AI Insights endpoints.
 */

// Type-only import (erased at compile time — no core runtime reaches the UI),
// mirroring proposal-impact-preview.tsx which renders this same shape.
import type { ProposalPreAnalysisResult } from "@linchkit/core";

// ── Auth header helper (reuse from api.ts pattern) ──────

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem("linchkit:token");
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

// ── Types ─────────────────────────────────────────────────

/**
 * A side-effecting operation the handler ATTEMPTED inside the dry-run sandbox
 * (recorded, never performed). UI-local mirror of the core `AttemptedSideEffect`
 * type — kept here so the UI never imports the server/core runtime.
 */
export interface AttemptedSideEffect {
  kind: "db_write" | "db_read" | "network" | "fs" | "env" | "unknown";
  detail: string;
}

/**
 * Outcome of running ONE generated change against ONE input case in the sandbox
 * (Spec 70 P3/P4). UI-local mirror of core `DryRunOutcome`.
 */
export interface DryRunOutcome {
  changeName: string;
  target: string;
  status: string;
  durationMs?: number;
  peakMemoryBytes?: number;
  attemptedSideEffects?: AttemptedSideEffect[];
  error?: string;
  logs?: string;
  inputCaseId?: string;
}

export interface ProposalChange {
  target: string;
  operation: string;
  name: string;
  definition?: unknown;
  diff?: string;
  /**
   * AI-generated candidate source for this change's code parts (G5). Present
   * after materialization on a draft; still gated by validation + human review.
   */
  generatedSource?: string;
  /**
   * Durable status of the last materialization attempt for this change (UI mirror
   * of the server wire field). "failed" means the AI-generated source did not pass
   * the build/syntax gate — the reason is in `materializationErrors` and there is
   * no `generatedSource`. Undefined for changes never materialized or declarative.
   */
  materializationStatus?: "materialized" | "failed";
  /** Build/syntax-gate errors from the final failed attempt (only when status==="failed"). */
  materializationErrors?: string[];
  /**
   * Durable worst-case dry-run status for this change (Spec 70 P3/P4). Set by the
   * materialize path when an `ExecutionDryRunProvider` is wired in. Undefined when
   * the dry-run feature is off or the change was never materialized.
   */
  dryRunStatus?: string;
  /** Per-input-case dry-run outcomes behind the aggregate `dryRunStatus`. */
  dryRunOutcomes?: DryRunOutcome[];
}

export interface ProposalImpact {
  entitiesAffected: string[];
  actionsAffected: string[];
  rulesAffected: string[];
  dependentsAffected: string[];
  migrationRequired: boolean;
}

/**
 * A single validation finding (error or warning) surfaced by a validation
 * phase. Mirrors the core `ValidationError` / `ValidationWarning` shape — kept
 * local so the UI never imports the server/core runtime. `target` / `field` are
 * optional context the producer may attach (e.g. the entity/field a breaking
 * reference points at). Guarded as optional because older payloads omit them.
 */
export interface ProposalValidationFinding {
  code: string;
  message: string;
  target?: string;
  field?: string;
}

/** One validation phase's outcome (mirrors core `PhaseResult`). */
export interface ProposalValidationPhase {
  phase: number;
  /** "passed" | "failed" | "skipped" — kept as a string for forward-compat. */
  status: string;
  errors: ProposalValidationFinding[];
  warnings: ProposalValidationFinding[];
  duration: number;
}

/** Aggregate validation result attached to a proposal (mirrors core). */
export interface ProposalValidationResult {
  passed: boolean;
  phases: ProposalValidationPhase[];
  impactSummary: string;
}

/**
 * Wire shape of the per-proposal pre-analysis (Spec 55 §7.3). Mirrors the core
 * `ProposalPreAnalysisResult` but with `analyzedAt` as an ISO **string** — the
 * server serializes the `Date` before sending it — so consumers never call Date
 * methods on what is actually a string. `ProposalImpactPreview` accepts this.
 */
export type ProposalAnalysis = Omit<ProposalPreAnalysisResult, "analyzedAt"> & {
  analyzedAt: string;
};

export interface Proposal {
  id: string;
  title: string;
  description: string;
  author: { type: "human" | "ai"; id: string; name: string };
  capability: string;
  changeType: "patch" | "minor" | "major";
  changes: ProposalChange[];
  impact: ProposalImpact;
  status: string;
  validationResult?: ProposalValidationResult;
  /**
   * Per-proposal pre-analysis (Spec 55 §7.3) — dedup / conflict / impact /
   * backtest envelopes surfaced to the human reviewer. Present on AI-surfaced
   * proposals that ran through the pre-analysis pipeline; absent for manual drafts.
   * `analyzedAt` arrives as an ISO string over the wire (serialized server-side).
   */
  analysis?: ProposalAnalysis;
  createdAt: string;
  updatedAt: string;
  validatedAt?: string;
  approvedAt?: string;
  committedAt?: string;
  deployedAt?: string;
  approvedBy?: { type: string; id: string };
  rejectionReason?: string;
}

export interface AIInsight {
  id: string;
  description: string;
  confidence: number;
  category: "rule_suggestion" | "default_value" | "validation" | "optimization" | "anomaly";
  suggestedAction: string;
  relatedSchema?: string;
  relatedField?: string;
  detectedAt: string;
  dataPoints?: number;
}

export interface EvolutionEntry {
  id: string;
  proposalId: string;
  title: string;
  description: string;
  changeType: "patch" | "minor" | "major";
  capability: string;
  authorType: "human" | "ai";
  authorName: string;
  approvedBy: string;
  appliedAt: string;
  reasoning: string;
  changes: Array<{
    target: string;
    operation: string;
    name: string;
    diff?: string;
  }>;
  version?: string;
  canRevert: boolean;
}

// ── API calls ─────────────────────────────────────────────

export async function fetchProposals(status?: string): Promise<{
  items: Proposal[];
  total: number;
  pendingCount: number;
}> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  const url = `/api/proposals${params.toString() ? `?${params}` : ""}`;
  const res = await fetch(url, { headers: getAuthHeaders() });
  const json = await res.json();
  return json.data ?? { items: [], total: 0, pendingCount: 0 };
}

export async function fetchProposal(id: string): Promise<Proposal | null> {
  const res = await fetch(`/api/proposals/${id}`, { headers: getAuthHeaders() });
  const json = await res.json();
  return json.data ?? null;
}

export async function approveProposal(id: string): Promise<Proposal> {
  const res = await fetch(`/api/proposals/${id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Approval failed");
  return json.data;
}

export async function rejectProposal(id: string, reason: string): Promise<Proposal> {
  const res = await fetch(`/api/proposals/${id}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify({ reason }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Rejection failed");
  return json.data;
}

export async function fetchAIInsights(): Promise<AIInsight[]> {
  const res = await fetch("/api/ai/insights", { headers: getAuthHeaders() });
  const json = await res.json();
  return json.data ?? [];
}

export async function fetchEvolutionHistory(): Promise<EvolutionEntry[]> {
  const res = await fetch("/api/evolution/history", { headers: getAuthHeaders() });
  const json = await res.json();
  return json.data ?? [];
}

export async function fetchPendingCount(): Promise<number> {
  const res = await fetch("/api/proposals/pending-count", { headers: getAuthHeaders() });
  const json = await res.json();
  return json.data?.count ?? 0;
}

// ── Evolution cycle + graduation (governance loop — human-driven) ──────────
//
// These two endpoints complete the human-drivable governance loop:
//   1. `runEvolutionCycle` — runs ONE on-demand evolution cycle and persists
//      its output as `draft` Proposals (NEVER approves / applies).
//   2. `graduateProposal` — takes an ALREADY-APPROVED Proposal, writes its
//      definition files + opens a GitHub PR. It NEVER merges.
//
// Both return a discriminated result so the caller can render each outcome
// distinctly (mirrors `resolveSchemaIntent` in `lib/api.ts`). Each accepts an
// optional `{ fetchImpl?; signal? }` last param and uses `opts.fetchImpl ?? fetch`
// — never a global fetch mock, so the batched test suite can inject a stub.

/**
 * Discriminated result of `runEvolutionCycle`.
 *
 *  - `{ kind: "ran" }` — the server ran a cycle and persisted draft proposals.
 *  - `{ kind: "unavailable" }` — 501 (evolution runtime not configured) OR 503
 *    (command layer not configured); surface a graceful "not available" state.
 *  - `{ kind: "denied" }` — 401 / 403 (AUTHZ_DENIED).
 *  - `{ kind: "error" }` — transport error / other non-2xx / invalid JSON.
 */
export type RunEvolutionCycleResult =
  | { kind: "ran"; created: number; deduped: number; total: number; createdIds: string[] }
  | { kind: "unavailable"; message?: string }
  | { kind: "denied" }
  | { kind: "error"; message: string };

/**
 * Discriminated result of `graduateProposal`.
 *
 *  - `{ kind: "ok" }` — graduation opened a PR (never merged).
 *  - `{ kind: "not_found" }` — 404 (proposal not found).
 *  - `{ kind: "not_approved" }` — 422 (proposal is not in `approved` state).
 *  - `{ kind: "unavailable" }` — 503 (graduation not configured — no GitHub
 *    token, or no command layer).
 *  - `{ kind: "denied" }` — 401 / 403 (AUTHZ_DENIED).
 *  - `{ kind: "error" }` — transport error / 500 / other non-2xx / invalid JSON.
 */
export type GraduateProposalResult =
  | { kind: "ok"; prUrl: string; branch: string; commitSha: string; committed: boolean }
  | { kind: "not_found" }
  | { kind: "not_approved"; message?: string }
  | { kind: "unavailable"; message?: string }
  | { kind: "denied" }
  | { kind: "error"; message: string };

/** Per-change result of a materialization attempt (UI mirror of the wire shape). */
export interface MaterializeChangeOutcome {
  changeName: string;
  target: string;
  /** `materialized` = source attached; `skipped` = declarative target; `failed` = gate never passed. */
  status: "materialized" | "skipped" | "failed";
  attempts: number;
  errors?: string[];
}

/**
 * Discriminated result of `materializeProposal`.
 *
 *  - `{ kind: "ok" }` — generation ran; `proposal` carries the candidate source
 *    on its changes' `generatedSource`. `allMaterialized` is false if any
 *    materializable change failed the build gate.
 *  - `{ kind: "not_found" }` — 404 (proposal not found).
 *  - `{ kind: "not_draft" }` — 422 (proposal is not a draft — materialize is pre-review only).
 *  - `{ kind: "unavailable" }` — 503 (no AI provider, or no command layer).
 *  - `{ kind: "denied" }` — 401 / 403 (AUTHZ_DENIED).
 *  - `{ kind: "error" }` — transport error / 500 / other non-2xx / invalid JSON.
 */
export type MaterializeProposalResult =
  | {
      kind: "ok";
      proposal: Proposal | null;
      outcomes: MaterializeChangeOutcome[];
      allMaterialized: boolean;
    }
  | { kind: "not_found" }
  | { kind: "not_draft"; message?: string }
  | { kind: "unavailable"; message?: string }
  | { kind: "denied" }
  | { kind: "error"; message: string };

/** Shape of the `run-cycle` JSON envelope. Local mirror of the wire contract. */
interface RunCycleWireResponse {
  success?: boolean;
  data?: {
    created?: number;
    deduped?: number;
    total?: number;
    createdIds?: string[];
  };
  error?: { code?: string; message?: string };
}

/** Shape of the `graduate` JSON envelope. Local mirror of the wire contract. */
interface GraduateWireResponse {
  success?: boolean;
  data?: {
    prUrl?: string;
    branch?: string;
    commitSha?: string;
    committed?: boolean;
  };
  error?: { code?: string; message?: string };
}

/** Best-effort extraction of the structured error message from a JSON body. */
async function readErrorMessage(res: Response): Promise<string | undefined> {
  try {
    const json = (await res.json()) as { error?: { message?: string }; message?: string };
    return json.error?.message ?? json.message;
  } catch {
    // Body was empty / non-JSON — caller falls back to its own message.
    return undefined;
  }
}

/**
 * Run ONE on-demand evolution cycle and persist its output as `draft` Proposals.
 *
 * Wire contract (POST /api/evolution/run-cycle):
 *   200 → { success: true, data: { created, deduped, total, createdIds } }
 *   501 → evolution runtime not configured (mapped to `unavailable`)
 *   503 → command layer not configured (mapped to `unavailable`)
 *   401/403 → AUTHZ_DENIED (mapped to `denied`)
 *   other non-2xx → `error`
 *
 * This NEVER approves or applies anything — the persisted proposals stay in the
 * human-gated review pipeline. The optional `fetchImpl` lets tests inject a stub
 * `fetch` without leaking a global mock across the batched suite.
 */
export async function runEvolutionCycle(
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<RunEvolutionCycleResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch("/api/evolution/run-cycle", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      signal: opts.signal,
    });
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Evolution cycle failed",
    };
  }

  // 401 / 403 — access denied.
  if (res.status === 401 || res.status === 403) {
    return { kind: "denied" };
  }

  // 501 (runtime not configured) / 503 (command layer not configured).
  if (res.status === 501 || res.status === 503) {
    return { kind: "unavailable", message: await readErrorMessage(res) };
  }

  // Other non-2xx — surface a user-friendly error.
  if (!res.ok) {
    return { kind: "error", message: (await readErrorMessage(res)) ?? "Evolution cycle failed" };
  }

  let json: RunCycleWireResponse;
  try {
    json = (await res.json()) as RunCycleWireResponse;
  } catch {
    return { kind: "error", message: "Evolution cycle returned an invalid response" };
  }

  // A `null` body is valid JSON but not a usable envelope — guard before reading
  // `.data` so this can't throw an unhandled TypeError outside the catch above.
  if (!json || typeof json !== "object") {
    return { kind: "error", message: "Evolution cycle returned an invalid response" };
  }

  const data = json.data;
  return {
    kind: "ran",
    created: data?.created ?? 0,
    deduped: data?.deduped ?? 0,
    total: data?.total ?? 0,
    createdIds: Array.isArray(data?.createdIds) ? data.createdIds : [],
  };
}

/**
 * Graduate an ALREADY-APPROVED Proposal: write its definition files + open a
 * GitHub PR for review. This NEVER merges — graduation only ever opens a PR.
 *
 * Wire contract (POST /api/proposals/:id/graduate):
 *   200 → { success: true, data: { prUrl, branch, commitSha, committed } }
 *   404 → not found (mapped to `not_found`)
 *   422 → not approved (mapped to `not_approved`)
 *   503 → graduation not configured (mapped to `unavailable`)
 *   401/403 → AUTHZ_DENIED (mapped to `denied`)
 *   500 → `error`
 *
 * The optional `fetchImpl` lets tests inject a stub `fetch` without leaking a
 * global mock across the batched suite.
 */
export async function graduateProposal(
  id: string,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GraduateProposalResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`/api/proposals/${encodeURIComponent(id)}/graduate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      signal: opts.signal,
    });
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Graduation failed",
    };
  }

  // 401 / 403 — access denied.
  if (res.status === 401 || res.status === 403) {
    return { kind: "denied" };
  }

  // 404 — proposal not found.
  if (res.status === 404) {
    return { kind: "not_found" };
  }

  // 422 — proposal is not in `approved` state.
  if (res.status === 422) {
    return { kind: "not_approved", message: await readErrorMessage(res) };
  }

  // 503 — graduation not configured (no GitHub token, or no command layer).
  if (res.status === 503) {
    return { kind: "unavailable", message: await readErrorMessage(res) };
  }

  // 500 / other non-2xx — surface a user-friendly error.
  if (!res.ok) {
    return { kind: "error", message: (await readErrorMessage(res)) ?? "Graduation failed" };
  }

  let json: GraduateWireResponse;
  try {
    json = (await res.json()) as GraduateWireResponse;
  } catch {
    return { kind: "error", message: "Graduation returned an invalid response" };
  }

  // A `null` body is valid JSON but not a usable envelope — guard before reading
  // `.data` so this can't throw an unhandled TypeError outside the catch above.
  if (!json || typeof json !== "object") {
    return { kind: "error", message: "Graduation returned an invalid response" };
  }

  const data = json.data;
  return {
    kind: "ok",
    prUrl: data?.prUrl ?? "",
    branch: data?.branch ?? "",
    commitSha: data?.commitSha ?? "",
    committed: data?.committed ?? false,
  };
}

/** Shape of the `materialize` JSON envelope. Local mirror of the wire contract. */
interface MaterializeWireResponse {
  success?: boolean;
  data?: {
    proposalId?: string;
    allMaterialized?: boolean;
    outcomes?: MaterializeChangeOutcome[];
    proposal?: Proposal;
  };
  error?: { code?: string; message?: string };
}

/**
 * Materialize a DRAFT Proposal: ask the server to AI-generate candidate source
 * for the proposal's code parts (today, action handler bodies) and attach it to
 * the draft. This NEVER approves, graduates, writes files, or runs code — the
 * candidate stays on the draft inside the human-gated review pipeline.
 *
 * Wire contract (POST /api/proposals/:id/materialize):
 *   200 → { success: true, data: { proposalId, allMaterialized, outcomes, proposal } }
 *   404 → not found (mapped to `not_found`)
 *   422 → not a draft (mapped to `not_draft`)
 *   503 → AI provider / command layer not configured (mapped to `unavailable`)
 *   401/403 → AUTHZ_DENIED (mapped to `denied`)
 *   500 → `error`
 *
 * Pass `opts.changeNames` (non-empty) to scope materialization to JUST those
 * change names — used by the per-failed-change "re-generate" retry so a reviewer
 * can retry one failed change without regenerating the already-good ones. Omit it
 * (or pass an empty array) to materialize every materializable change (default).
 *
 * The optional `fetchImpl` lets tests inject a stub `fetch` without leaking a
 * global mock across the batched suite.
 */
export async function materializeProposal(
  id: string,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; changeNames?: string[] } = {},
): Promise<MaterializeProposalResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  // Scope the request to specific change names only when a non-empty list is
  // given; otherwise send no body so the server materializes all changes (the
  // pre-existing default behavior).
  const scopedNames =
    Array.isArray(opts.changeNames) && opts.changeNames.length > 0 ? opts.changeNames : undefined;
  let res: Response;
  try {
    res = await doFetch(`/api/proposals/${encodeURIComponent(id)}/materialize`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      signal: opts.signal,
      ...(scopedNames ? { body: JSON.stringify({ changeNames: scopedNames }) } : {}),
    });
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Materialization failed",
    };
  }

  // 401 / 403 — access denied.
  if (res.status === 401 || res.status === 403) {
    return { kind: "denied" };
  }

  // 404 — proposal not found.
  if (res.status === 404) {
    return { kind: "not_found" };
  }

  // 422 — proposal is not in `draft` state.
  if (res.status === 422) {
    return { kind: "not_draft", message: await readErrorMessage(res) };
  }

  // 503 — AI provider or command layer not configured.
  if (res.status === 503) {
    return { kind: "unavailable", message: await readErrorMessage(res) };
  }

  // 500 / other non-2xx — surface a user-friendly error.
  if (!res.ok) {
    return { kind: "error", message: (await readErrorMessage(res)) ?? "Materialization failed" };
  }

  let json: MaterializeWireResponse;
  try {
    json = (await res.json()) as MaterializeWireResponse;
  } catch {
    return { kind: "error", message: "Materialization returned an invalid response" };
  }

  // A `null` body is valid JSON but not a usable envelope — guard before reading
  // `.data` so this can't throw an unhandled TypeError outside the catch above.
  if (!json || typeof json !== "object") {
    return { kind: "error", message: "Materialization returned an invalid response" };
  }

  const data = json.data;
  return {
    kind: "ok",
    proposal: data?.proposal ?? null,
    outcomes: Array.isArray(data?.outcomes) ? data.outcomes : [],
    allMaterialized: data?.allMaterialized ?? false,
  };
}
