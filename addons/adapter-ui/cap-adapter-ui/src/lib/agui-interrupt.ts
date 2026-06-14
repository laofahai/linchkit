/**
 * AG-UI HITL interrupt → ActionProposalCard adapter (Spec 71 §4.4).
 *
 * Pure mapping helpers that turn an AG-UI `Interrupt` (carried on a
 * `RUN_FINISHED` interrupt outcome, surfaced by the transport via a
 * `data-lk-interrupt` chunk) into the `IntentResolution` the existing
 * `ActionProposalCard` already renders, and build the `resume[]` answer the
 * Approve/Cancel round-trip sends back.
 *
 * Naming note (Spec 71 §3.6): this is the AG-UI `Interrupt`/`resume`
 * vocabulary — deliberately NOT the core `ProposalEngine` graduation
 * vocabulary. No import from / collision with `proposal-engine.ts`.
 */

import type { Interrupt as AgUiInterrupt } from "@ag-ui/client";
import type { InterruptResumeAnswer, LkInterruptChunkData } from "./agui-chat-transport";
import { LK_INTERRUPT_DATA_CHUNK } from "./agui-chat-transport";
import type { IntentAlternative, IntentFieldSchema, IntentResolution } from "./ai-api";

/** The interrupt reason the server stamps on an action-approval interrupt. */
export const ACTION_APPROVAL_REASON = "action.approval.required";

/**
 * Shape of an action-approval interrupt's `metadata` (server contract, §4.2).
 * All fields are validated defensively — the wire `metadata` is
 * `Record<string, any> | undefined`.
 */
export interface ActionApprovalMetadata {
  action: string;
  proposedInput: Record<string, unknown>;
  inputSchema: Record<string, IntentFieldSchema>;
  actionLabel: string;
  inputDigest: string;
  /**
   * Server-vetted N-best alternatives (§2.5). The resume payload may pick a
   * swapped-in action only from this offered set; carried so the card's
   * `swapAlternative` UI keeps working. Optional — absent when the server
   * offered no alternatives.
   */
  alternatives?: IntentAlternative[];
  /** Advisory permission pre-check hint (§6.4) — not the gate. */
  permitted?: boolean;
}

// ── data-chunk detection ─────────────────────────────────────

/**
 * Narrow a `useChat` `onData` data-part to the interrupt chunk and return its
 * interrupts, or `null` when the part is not our interrupt signal. The data
 * part carries `{ type, data }`; `data` is `unknown`, so validate structurally.
 */
export function readInterruptChunk(part: { type: string; data?: unknown }): AgUiInterrupt[] | null {
  if (part.type !== LK_INTERRUPT_DATA_CHUNK) return null;
  const data = part.data as Partial<LkInterruptChunkData> | undefined;
  if (!data || !Array.isArray(data.interrupts)) return null;
  return data.interrupts;
}

// ── metadata extraction ──────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Validate the interrupt's `inputSchema` field-by-field rather than blind-casting
 * it: the metadata is server-shaped but untrusted at this boundary, and a
 * malformed field entry (null, wrong type) would reach `ActionProposalCard`'s
 * field renderer and break it. Keep only entries that have the minimal shape the
 * card relies on (`type: string`, `required: boolean`); drop the rest.
 */
function validInputSchema(value: unknown): Record<string, IntentFieldSchema> {
  const rec = asRecord(value);
  if (!rec) return {};
  const out: Record<string, IntentFieldSchema> = {};
  for (const [key, raw] of Object.entries(rec)) {
    const field = asRecord(raw);
    if (field && typeof field.type === "string" && typeof field.required === "boolean") {
      out[key] = field as unknown as IntentFieldSchema;
    }
  }
  return out;
}

/**
 * Validate the interrupt's N-best `alternatives` entry-by-entry: a malformed
 * alternative (no `action`, non-record `input`) would corrupt the card's swap UI
 * and the resume payload it produces. Keep only well-formed entries; `undefined`
 * when none survive (the card then hides the swap affordance).
 */
function validAlternatives(value: unknown): IntentAlternative[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: IntentAlternative[] = [];
  for (const raw of value) {
    const alt = asRecord(raw);
    if (alt && typeof alt.action === "string" && asRecord(alt.input)) {
      out.push(alt as unknown as IntentAlternative);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Extract + validate an action-approval interrupt's metadata, or `null` when
 * the interrupt is not a well-formed action-approval interrupt (wrong reason,
 * missing required fields). Callers skip interrupts that return `null`.
 */
export function readActionApprovalMetadata(
  interrupt: AgUiInterrupt,
): ActionApprovalMetadata | null {
  if (interrupt.reason !== ACTION_APPROVAL_REASON) return null;
  const meta = asRecord(interrupt.metadata);
  if (!meta) return null;

  const action = meta.action;
  const inputDigest = meta.inputDigest;
  if (typeof action !== "string" || typeof inputDigest !== "string") return null;

  const proposedInput = asRecord(meta.proposedInput) ?? {};
  const inputSchema = validInputSchema(meta.inputSchema);
  const actionLabel = typeof meta.actionLabel === "string" ? meta.actionLabel : action;
  const alternatives = validAlternatives(meta.alternatives);
  const permitted = typeof meta.permitted === "boolean" ? meta.permitted : undefined;

  return {
    action,
    proposedInput,
    inputSchema,
    actionLabel,
    inputDigest,
    ...(alternatives ? { alternatives } : {}),
    ...(permitted !== undefined ? { permitted } : {}),
  };
}

// ── Interrupt → IntentResolution (card input) ────────────────

/**
 * Map an action-approval interrupt's metadata onto the `IntentResolution` the
 * existing `ActionProposalCard` renders (§4.4). Confidence is irrelevant on the
 * interrupt path (the server already vetted the action), so it is fixed at 1 —
 * the card hides its alternatives/missing-fields affordances accordingly while
 * still rendering the editable input fields.
 */
export function interruptToIntent(meta: ActionApprovalMetadata): IntentResolution {
  return {
    action: meta.action,
    schema: meta.action,
    input: meta.proposedInput,
    missingFields: [],
    confidence: 1,
    explanation: "",
    actionLabel: meta.actionLabel,
    inputSchema: meta.inputSchema,
    ...(meta.alternatives ? { alternatives: meta.alternatives } : {}),
  };
}

// ── Approve / Cancel → resume answer ─────────────────────────

/**
 * Build the resolved (Approve) resume answer for one interrupt. `baseDigest`
 * echoes the interrupt's `metadata.inputDigest` (anti-TOCTOU anchor, §6.2);
 * `action` is the human-approved (possibly swapped) action, constrained
 * server-side to the interrupt's offered set; `input` is the edited input.
 */
export function buildApproveAnswer(args: {
  action: string;
  input: Record<string, unknown>;
  inputDigest: string;
}): InterruptResumeAnswer {
  return {
    status: "resolved",
    payload: { action: args.action, input: args.input, baseDigest: args.inputDigest },
  };
}

/** Build the cancelled (Cancel) resume answer for one interrupt (no payload). */
export function buildCancelAnswer(): InterruptResumeAnswer {
  return { status: "cancelled" };
}
