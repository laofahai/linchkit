/**
 * Pure helpers for {@link SchemaProposalCard} — extracted so the card's state
 * machine and display logic can be unit-tested without mounting React (this
 * package's test setup is logic-only — no happy-dom / jsdom).
 *
 * The card drives the in-product "say → exists" (说→有) loop's 4th channel:
 * a schema-change draft minted by `resolveSchemaIntent` is approved, then
 * graduated into a GitHub PR. NONE of these helpers perform I/O — they only
 * map results onto display state.
 */

import type { SchemaIntentDraft } from "../lib/ai-api";
import type { GraduateProposalResult } from "../lib/proposal-api";

// ── Card state machine ───────────────────────────────────

/**
 * Lifecycle of a single schema proposal card.
 *
 *  - `pending`     — draft surfaced; the Approve button is live.
 *  - `approving`   — `approveProposal` in flight.
 *  - `approved`    — approval succeeded; the Open PR button is live.
 *  - `graduating`  — `graduateProposal` in flight.
 *  - `done`        — graduation opened a PR; the PR link is shown (terminal).
 *  - `error`       — the last approve/graduate attempt failed; the card stays
 *                    so the user can read the reason and retry from the same
 *                    phase (`error` never erases which phase we failed in —
 *                    that is tracked separately by the caller).
 */
export type SchemaProposalStatus =
  | "pending"
  | "approving"
  | "approved"
  | "graduating"
  | "done"
  | "error";

/**
 * Format a confidence score (0-1) as a percentage. Defensive against
 * NaN/Infinity/undefined leaking from a malformed AI response — mirrors the
 * same helper in `nl-rule-drafter.tsx` / `action-proposal-card.tsx`.
 */
export function formatConfidencePct(confidence: number | undefined): string {
  if (confidence == null || !Number.isFinite(confidence)) return "—";
  return `${Math.round(confidence * 100)}%`;
}

/**
 * Display fields derived from a {@link SchemaIntentDraft}. The draft itself is
 * sparse (every field optional) — this normalizes it to exactly what the card
 * renders so the JSX stays branch-free.
 */
export interface SchemaProposalDisplay {
  /** The rule/entity name, or undefined when the draft omitted it. */
  name?: string;
  /** Status badge text — the proposal's own status, defaulting to "draft". */
  statusLabel: string;
  /** Confidence as a percentage string ("—" when absent). */
  confidencePct: string;
  /** Human explanation, or undefined. */
  explanation?: string;
  /** Target entity, or undefined. */
  targetEntity?: string;
  /** The persisted proposal id used to approve / graduate. */
  proposalId?: string;
  /**
   * Whether this change requires a code change (not just a declarative
   * data/config edit). Surfaced as a badge so the reviewer knows a PR with
   * source edits is coming. The wire response does not always carry this — it
   * defaults to `false`.
   */
  requiresCodeChange: boolean;
  /** Short human summary of the diff this proposal will produce, if any. */
  diffSummary?: string;
  /** True when this draft mints an entity (vs a rule). */
  isEntity: boolean;
}

/** Normalize a sparse draft into the fields the card renders. */
export function toSchemaProposalDisplay(draft: SchemaIntentDraft): SchemaProposalDisplay {
  return {
    name: draft.ruleName,
    statusLabel: draft.proposalStatus ?? "draft",
    confidencePct: formatConfidencePct(draft.confidence),
    explanation: draft.explanation,
    targetEntity: draft.targetEntity,
    proposalId: draft.proposalId,
    requiresCodeChange: draft.requiresCodeChange ?? false,
    diffSummary: draft.diffSummary,
    isEntity: draft.isEntity ?? false,
  };
}

// ── Graduate-result → display mapping ────────────────────

/**
 * Outcome of mapping a {@link GraduateProposalResult} onto the card. Either we
 * reached a PR (`done` with a `prUrl`) or we surface an `error` whose message
 * is an i18n KEY (the card resolves it via `t()` so copy stays centralized).
 *
 * `prUrl` may legitimately be empty on `ok` when the server committed without
 * a PR provider — callers treat an empty `prUrl` as "graduated, no link".
 */
export type GraduateDisplay =
  | { status: "done"; prUrl: string }
  | { status: "error"; messageKey: string; rawMessage?: string };

/**
 * Map a graduate result onto the card's next state. Every non-ok arm becomes an
 * `error` carrying an i18n key; the `error`/`unavailable`/`not_approved` arms
 * also forward the server's raw message so the card can show specifics under
 * the localized headline.
 */
export function mapGraduateResult(result: GraduateProposalResult): GraduateDisplay {
  switch (result.kind) {
    case "ok":
      return { status: "done", prUrl: result.prUrl };
    case "not_found":
      return { status: "error", messageKey: "schemaProposal.graduateNotFound" };
    case "not_approved":
      return {
        status: "error",
        messageKey: "schemaProposal.graduateNotApproved",
        rawMessage: result.message,
      };
    case "unavailable":
      return {
        status: "error",
        messageKey: "schemaProposal.graduateUnavailable",
        rawMessage: result.message,
      };
    case "denied":
      return { status: "error", messageKey: "schemaProposal.graduateDenied" };
    case "error":
      return {
        status: "error",
        messageKey: "schemaProposal.graduateError",
        rawMessage: result.message,
      };
  }
}
