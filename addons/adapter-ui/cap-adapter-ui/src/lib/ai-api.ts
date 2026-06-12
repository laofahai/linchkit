/**
 * AI endpoint clients — auto-fill, search, intent resolution, and schema-intent.
 */

import { getAuthHeaders, handleUnauthorized } from "./api";

// ── AI Auto-Fill ────────────────────────────────────────

/** Single AI suggestion for a field */
export interface AiFieldSuggestion {
  value: unknown;
  confidence: number;
  reason?: string;
}

/** Response from the AI auto-fill endpoint */
export interface AiAutoFillResult {
  suggestions: Record<string, AiFieldSuggestion>;
}

/**
 * Request AI-powered auto-fill suggestions for empty form fields.
 */
export async function requestAiAutoFill(params: {
  schema: string;
  fields: Record<
    string,
    { label?: string; type?: string; required?: boolean; options?: string[]; description?: string }
  >;
  currentValues: Record<string, unknown>;
  locale?: string;
}): Promise<AiAutoFillResult> {
  const res = await fetch("/api/ai/auto-fill", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(params),
  });
  handleUnauthorized(res);
  if (!res.ok) {
    throw new Error("AI auto-fill failed");
  }
  const json = await res.json();
  if (!json.success) {
    throw new Error(json.error?.message ?? "AI auto-fill failed");
  }
  return json.data ?? { suggestions: {} };
}

// ── AI Search ───────────────────────────────────────────

export interface AISearchRequest {
  query: string;
  schema: string;
  fields: Record<string, { label?: string; type?: string; options?: string[] }>;
  locale?: string;
}

export interface AISearchResult {
  filter: Record<string, unknown>;
  explanation: string;
}

/**
 * Send a natural language query to the AI search endpoint.
 * Returns a DeclarativeCondition filter or null if AI is not configured.
 */
export async function aiSearch(request: AISearchRequest): Promise<AISearchResult | null> {
  const res = await fetch("/api/ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(request),
  });
  handleUnauthorized(res);
  if (!res.ok) {
    throw new Error("AI search request failed");
  }
  const json = await res.json();
  return json.data ?? null;
}

// ── AI Intent Resolution ────────────────────────────────

/** Field schema info returned from intent resolution */
export interface IntentFieldSchema {
  type: string;
  label?: string;
  required: boolean;
  options?: Array<{ value: string; label?: string }>;
  description?: string;
}

/**
 * Bare alternative interpretation returned alongside a primary proposal.
 *
 * The server returns N-best alternatives sorted by confidence DESC (capped at
 * 3) when the primary's confidence is below the AI provider's surfacing
 * threshold. Each alternative is a bare `ActionProposal` from the resolver —
 * the route enriches only the primary with display metadata, so alternatives
 * carry no `actionLabel` / `inputSchema` of their own. When a user swaps an
 * alternative into the primary slot the UI must look up its display metadata
 * (label, description, input schema) on demand.
 */
export interface IntentAlternative {
  /** Matched action name. */
  action: string;
  /** Pre-filled input parameters validated against the action's schema. */
  input: Record<string, unknown>;
  /** Confidence in [0, 1]. */
  confidence: number;
  /** Required fields the AI did not fill. */
  missingFields: string[];
  /** Human-readable summary suitable for UI display. */
  explanation: string;
  /**
   * Display metadata. Server-returned alternatives never carry these (the
   * route only enriches the primary), but when the UI demotes a previous
   * primary into the alternatives list it preserves the metadata here so
   * swapping back is fully reversible (no degraded fields / labels).
   */
  schema?: string;
  actionLabel?: string;
  actionDescription?: string;
  inputSchema?: Record<string, IntentFieldSchema>;
}

/** Result from AI intent resolution */
export interface IntentResolution {
  action: string;
  schema: string;
  input: Record<string, unknown>;
  missingFields: string[];
  confidence: number;
  explanation: string;
  actionLabel: string;
  actionDescription?: string;
  inputSchema: Record<string, IntentFieldSchema>;
  /** Optional N-best alternatives surfaced when primary confidence is low. */
  alternatives?: IntentAlternative[];
}

/** Optional scoping mirrors the server's `ResolveIntentInput.scope`. */
export interface ResolveIntentScope {
  /** Restrict the catalog to actions on these entities. */
  entityFilter?: string[];
  /** Restrict the catalog to these specific action names. */
  actionFilter?: string[];
}

/**
 * Discriminated result of `resolveIntent`.
 *
 * Three outcomes need to be distinguished by the caller:
 *
 *  - `{ kind: "proposal" }` — the server returned a usable proposal; render
 *    the Action Proposal Card.
 *  - `{ kind: "unavailable" }` — the server returned 503 (AI not configured
 *    or upstream provider unreachable); the caller should surface a
 *    non-blocking toast/banner instead of silently falling through.
 *  - `{ kind: "no-match" }` — the server returned 200 with `proposal: null`
 *    (no usable match for the prompt); the caller should fall back to the
 *    general chat endpoint.
 */
export type ResolveIntentResult =
  | { kind: "proposal"; proposal: IntentResolution }
  | { kind: "unavailable" }
  | { kind: "no-match" };

/**
 * Resolve a natural-language prompt to an action intent.
 *
 * Wire contract (Spec 52 §2.6 — POST /api/ai/resolve-intent):
 *   request:  { prompt, scope? }
 *   response: { proposal: ActionProposalView | null }
 *
 * Returns a discriminated `ResolveIntentResult` so callers can distinguish
 * "no usable match" (200 + null) from "service unavailable" (503). Network
 * errors and other non-2xx responses still throw.
 */
export async function resolveIntent(
  prompt: string,
  scope?: ResolveIntentScope,
): Promise<ResolveIntentResult> {
  const res = await fetch("/api/ai/resolve-intent", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify({ prompt, scope }),
  });
  handleUnauthorized(res);
  if (res.status === 503) {
    // Graceful degradation per Spec 52 §1.1 — caller surfaces the
    // appropriate "AI unavailable" UX (toast / banner).
    return { kind: "unavailable" };
  }
  if (!res.ok) {
    throw new Error("AI intent resolution failed");
  }
  const json = await res.json();
  const proposal = (json.proposal as IntentResolution | null | undefined) ?? null;
  if (!proposal) {
    return { kind: "no-match" };
  }
  return { kind: "proposal", proposal };
}

// ── Schema-intent resolution ("说→有" — Spec 52) ──────────

/**
 * A natural-language rule draft that was minted as a GOVERNED, `draft`-status
 * Proposal in the shared review engine. Mirrors the `proposal_draft` arm of the
 * server's `ResolveSchemaIntentResponse` — the fields the UI needs to surface
 * the draft and route the user to the existing review flow.
 *
 * Defined locally (the UI NEVER imports from `@linchkit/core` / server packages
 * per the module-boundary rule); kept in sync with the route's wire response in
 * `ai-resolve-schema-intent.ts`.
 */
export interface SchemaIntentDraft {
  /**
   * The governed Proposal id (persisted into `/api/proposals`). Use it to link
   * the user into the existing review surface. Always references a `draft`-status
   * Proposal — the endpoint never submits, approves, or applies it.
   */
  proposalId?: string;
  /** Lifecycle status at persist time — always `"draft"`. */
  proposalStatus?: string;
  /** The generated rule's name. */
  ruleName?: string;
  /** The entity the rule attaches to. */
  targetEntity?: string;
  /** Resolver confidence (0-1). */
  confidence?: number;
  /** Human-readable explanation of the proposed rule. */
  explanation?: string;
}

/**
 * Discriminated result of `resolveSchemaIntent`.
 *
 * Mirrors `resolveIntent`'s discriminated shape so callers can render each
 * outcome distinctly:
 *
 *  - `{ kind: "proposal_draft" }` — the server minted a `draft` governed
 *    Proposal; surface it and link into the review flow. NEVER auto-approve.
 *  - `{ kind: "clarification" }` — the resolver needs more info; show the
 *    `question` and let the user refine + resubmit.
 *  - `{ kind: "no_match" }` — no rule could be drafted; show the `reason`.
 *  - `{ kind: "unavailable" }` — the server returned 503 (AI / ontology not
 *    configured); surface a graceful "AI not configured" state.
 *  - `{ kind: "error" }` — a 400 / 500 / transport error; show a user-friendly
 *    error message.
 */
export type ResolveSchemaIntentResult =
  | { kind: "proposal_draft"; draft: SchemaIntentDraft }
  | { kind: "clarification"; question: string; bestConfidence?: number }
  | { kind: "no_match"; reason?: string; message?: string }
  | { kind: "unavailable"; message?: string }
  | { kind: "error"; message: string };

/** Shape of the JSON the server returns. Local mirror of the wire contract. */
interface SchemaIntentWireResponse {
  outcome?: "proposal_draft" | "clarification" | "no_match";
  proposalId?: string;
  proposalStatus?: string;
  ruleName?: string;
  targetEntity?: string;
  confidence?: number;
  explanation?: string;
  question?: string;
  bestConfidence?: number;
  reason?: string;
  message?: string;
  error?: { code?: string; message?: string };
}

/**
 * Resolve a natural-language utterance into a GOVERNED rule draft.
 *
 * Wire contract (Spec 52 — POST /api/ai/resolve-schema-intent):
 *   request:  { prompt }
 *   response: discriminated by `outcome`
 *             (proposal_draft / clarification / no_match), or a 503 envelope.
 *
 * Returns a discriminated `ResolveSchemaIntentResult` so the caller can render
 * each outcome. This NEVER submits / approves / applies anything — the server
 * persists a `draft`-status Proposal and the UI only routes the user to review
 * it. The optional `fetchImpl` parameter lets tests inject a stub `fetch`
 * without leaking a global mock across the batched suite.
 */
export async function resolveSchemaIntent(
  text: string,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ResolveSchemaIntentResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch("/api/ai/resolve-schema-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ prompt: text }),
      signal: opts.signal,
    });
  } catch (err) {
    // Transport-level error (network down, etc.).
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Schema intent resolution failed",
    };
  }

  handleUnauthorized(res);

  // 503 — AI service / ontology not configured (graceful degradation).
  if (res.status === 503) {
    let message: string | undefined;
    try {
      const json = (await res.json()) as SchemaIntentWireResponse;
      message = json.error?.message ?? json.message;
    } catch {
      // Body may be empty/non-JSON — fall back to the generic message below.
    }
    return { kind: "unavailable", message };
  }

  // 400 / 500 / other non-2xx — surface a user-friendly error.
  if (!res.ok) {
    let message = "Schema intent resolution failed";
    try {
      const json = (await res.json()) as SchemaIntentWireResponse;
      message = json.error?.message ?? json.message ?? message;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    return { kind: "error", message };
  }

  let json: SchemaIntentWireResponse;
  try {
    json = (await res.json()) as SchemaIntentWireResponse;
  } catch {
    return { kind: "error", message: "Schema intent resolution returned an invalid response" };
  }

  switch (json.outcome) {
    case "proposal_draft":
      return {
        kind: "proposal_draft",
        draft: {
          proposalId: json.proposalId,
          proposalStatus: json.proposalStatus,
          ruleName: json.ruleName,
          targetEntity: json.targetEntity,
          confidence: json.confidence,
          explanation: json.explanation,
        },
      };
    case "clarification":
      return {
        kind: "clarification",
        question: json.question ?? "",
        bestConfidence: json.bestConfidence,
      };
    case "no_match":
      return { kind: "no_match", reason: json.reason, message: json.message };
    default:
      // Unknown / missing outcome — treat as an error rather than silently
      // dropping it, so the UI surfaces something actionable.
      return { kind: "error", message: "Schema intent resolution returned an unknown outcome" };
  }
}
