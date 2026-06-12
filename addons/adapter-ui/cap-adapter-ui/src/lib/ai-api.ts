import { getAuthHeaders, handleUnauthorized } from "./api";

// ── AI Auto-Fill ─────────────────────────────────────────

export interface AiFieldSuggestion {
  value: unknown;
  confidence: number;
  reason?: string;
}

export interface AiAutoFillResult {
  suggestions: Record<string, AiFieldSuggestion>;
}

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
  const json = await res.json();
  if (!json.success) {
    throw new Error(json.error?.message ?? "AI auto-fill failed");
  }
  return json.data ?? { suggestions: {} };
}

// ── AI Search ────────────────────────────────────────────

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

// ── AI Intent Resolution ─────────────────────────────────

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
  action: string;
  input: Record<string, unknown>;
  confidence: number;
  missingFields: string[];
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
  alternatives?: IntentAlternative[];
}

export interface ResolveIntentScope {
  entityFilter?: string[];
  actionFilter?: string[];
}

/**
 * Discriminated result of `resolveIntent`.
 *
 *  - `{ kind: "proposal" }` — usable proposal; render the Action Proposal Card.
 *  - `{ kind: "unavailable" }` — 503 (AI not configured or upstream unreachable).
 *  - `{ kind: "no-match" }` — 200 with `proposal: null` (no usable match).
 */
export type ResolveIntentResult =
  | { kind: "proposal"; proposal: IntentResolution }
  | { kind: "unavailable" }
  | { kind: "no-match" };

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

// ── Schema-intent resolution ("说→有" — Spec 52) ─────────

/**
 * A natural-language rule draft minted as a GOVERNED, `draft`-status Proposal.
 * Mirrors the `proposal_draft` arm of the server's `ResolveSchemaIntentResponse`.
 *
 * Defined locally (the UI NEVER imports from `@linchkit/core` / server packages
 * per the module-boundary rule); kept in sync with the route's wire response in
 * `ai-resolve-schema-intent.ts`.
 */
export interface SchemaIntentDraft {
  proposalId?: string;
  proposalStatus?: string;
  ruleName?: string;
  targetEntity?: string;
  confidence?: number;
  explanation?: string;
}

/**
 * Discriminated result of `resolveSchemaIntent`.
 *
 *  - `{ kind: "proposal_draft" }` — server minted a `draft` governed Proposal.
 *  - `{ kind: "clarification" }` — resolver needs more info.
 *  - `{ kind: "no_match" }` — no rule could be drafted.
 *  - `{ kind: "unavailable" }` — 503 (AI / ontology not configured).
 *  - `{ kind: "error" }` — 400 / 500 / transport error.
 */
export type ResolveSchemaIntentResult =
  | { kind: "proposal_draft"; draft: SchemaIntentDraft }
  | { kind: "clarification"; question: string; bestConfidence?: number }
  | { kind: "no_match"; reason?: string; message?: string }
  | { kind: "unavailable"; message?: string }
  | { kind: "error"; message: string };

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
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Schema intent resolution failed",
    };
  }

  handleUnauthorized(res);

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
      return { kind: "error", message: "Schema intent resolution returned an unknown outcome" };
  }
}
