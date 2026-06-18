/**
 * AG-UI HITL interrupt helpers (Spec 71 §4.2, P2a).
 *
 * Pure digest/canonical helpers + `buildProposeInterrupt` / `buildCardInputSchema`
 * extracted from agui-runner.ts to stay within the 500-line guideline (#607).
 * Two improvements bundled with the extraction:
 *   - buildProposeInterrupt: snapshots proposal.input as a canonical deep-copy
 *     before hashing/storing (anti-TOCTOU, §6.2 point 3). `Interrupt.metadata.proposedInput`
 *     is now the canonical form (keys sorted, `undefined` stripped).
 *   - buildCardInputSchema: handles primitive-valued enum options (string/number arrays)
 *     rather than assuming `{ value, label }` object shape.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Interrupt, InterruptStore } from "@linchkit/cap-adapter-ag-ui";
import type { Actor } from "@linchkit/core";
import type { ServerOptions } from "../server";
import type { ProposeMutationArgs } from "./tools";
import { PROPOSE_MUTATION_TOOL_CALL_ID_PREFIX } from "./tools";

// ── Default approval window ──────────────────────────────────

/** Default approval window — 10 minutes (Spec 71 §9 risk 7, configurable). */
export const DEFAULT_APPROVAL_WINDOW_MS = 10 * 60 * 1000;

// ── Canonical JSON + digest ──────────────────────────────────

/**
 * Canonical JSON with stable (sorted) key ordering at every object level, so
 * `inputDigest` is invariant to property insertion order — the same logical
 * input always hashes the same (Spec 71 §6.2 point 3). Arrays keep order
 * (order is semantically meaningful); primitives serialize as-is.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    // Drop `undefined`-valued keys: JSON.stringify omits them, so including
    // them here would make the digest depend on whether a key was explicitly
    // set to `undefined` vs absent — they must hash identically.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * The anti-TOCTOU anchor (Spec 71 §6.2 point 3):
 * `sha256(action + canonical(proposedInput))`. Stable for the same canonical
 * input regardless of key order. `baseDigest` on resume must echo this.
 */
export function computeInputDigest(action: string, proposedInput: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${action} ${canonicalJson(proposedInput)}`)
    .digest("hex");
}

// ── Interrupt construction ───────────────────────────────────

/** Stable identity binding ({ type, id }) for the interrupt store (§6.7). */
function actorBinding(actor: Actor): { type: string; id: string } {
  return { type: actor.type, id: actor.id };
}

/**
 * The card-renderable field schema shape (mirrors the UI's `IntentFieldSchema`:
 * `{ type, label?, required, options?, description? }`). Declared locally so the
 * server adapter needs no UI-package import (module-boundary rule: server never
 * imports ui). The card validates each entry defensively at the boundary.
 */
export interface CardFieldSchema {
  type: string;
  label?: string;
  required: boolean;
  options?: Array<{ value: string; label?: string }>;
  description?: string;
}

/**
 * Build the AG-UI `Interrupt` for a captured `proposeMutation` proposal
 * (Spec 71 §4.2) and write its server-authoritative store entry (§6.7) so a
 * later resume (P2b) can re-derive every §6.2 guarantee. Returns the interrupt
 * the runner hands back to the endpoint via `AgUiInterruptDescriptor`.
 *
 * Pure except for the single `store.put` side effect; exported so server tests
 * can assert the store entry independently.
 */
export function buildProposeInterrupt(options: {
  threadId: string;
  proposal: ProposeMutationArgs;
  proposerActor: Actor;
  tenant: string | undefined;
  store: InterruptStore;
  approvalWindowMs?: number;
  /** Injectable clock + id for deterministic tests. */
  now?: number;
  interruptId?: string;
  /** Optional human-friendly action label for the card (§4.2 metadata). */
  actionLabel?: string;
  /**
   * The `IntentFieldSchema`-shaped editable-field schema the card renders
   * (§4.2 / §4.4). When omitted the card falls back to read-only display of the
   * proposed input.
   */
  inputSchema?: Record<string, CardFieldSchema>;
}): Interrupt {
  const {
    threadId,
    proposal,
    proposerActor,
    tenant,
    store,
    approvalWindowMs = DEFAULT_APPROVAL_WINDOW_MS,
    actionLabel,
    inputSchema,
  } = options;
  const now = options.now ?? Date.now();
  const interruptId = options.interruptId ?? randomUUID();
  const toolCallId = `${PROPOSE_MUTATION_TOOL_CALL_ID_PREFIX}${interruptId}`;
  // Snapshot before hashing: any post-call mutation of proposal.input cannot
  // drift the stored entry from its inputDigest (anti-TOCTOU, §6.2 point 3).
  const proposedInput = JSON.parse(canonicalJson(proposal.input)) as Record<string, unknown>;
  const inputDigest = computeInputDigest(proposal.action, proposedInput);
  const expiresAt = new Date(now + approvalWindowMs).toISOString();

  store.put({
    threadId,
    interruptId,
    toolCallId,
    proposedAction: proposal.action,
    actionSet: [proposal.action],
    proposedInput,
    inputDigest,
    expiresAt,
    consumed: false,
    proposerActor: actorBinding(proposerActor),
    tenant,
  });

  return {
    id: interruptId,
    reason: "action.approval.required",
    toolCallId,
    message: `Approve action "${actionLabel ?? proposal.action}"?`,
    responseSchema: { type: "object" },
    expiresAt,
    metadata: {
      action: proposal.action,
      proposedInput,
      inputSchema: inputSchema ?? {},
      actionLabel: actionLabel ?? proposal.action,
      inputDigest,
    },
  };
}

// ── Card input schema (ontology → card fields) ───────────────

/**
 * Derive the card's editable `inputSchema` for a proposed action from the
 * ontology (§4.2 metadata). Maps each proposed-input key to the entity's field
 * definition (type / label / required / enum options) so the `ActionProposalCard`
 * renders real editable inputs — enabling approve-with-edits (§8 step 4). Returns
 * `undefined` when no ontology / matching entity is available.
 *
 * Field selection: the UNION of the keys present in the proposed input and the
 * entity's required fields — so the human sees every value they're approving
 * AND any required field the model omitted (which they may need to fill in).
 * System fields are excluded (server-managed, never client-settable).
 */
export function buildCardInputSchema(
  options: ServerOptions,
  action: string,
  proposedInput: Record<string, unknown>,
): Record<string, CardFieldSchema> | undefined {
  const ontology = options.ontologyRegistry;
  if (!ontology) return undefined;

  const SYSTEM_FIELDS = new Set([
    "id",
    "tenant_id",
    "created_at",
    "updated_at",
    "created_by",
    "updated_by",
    "_version",
  ]);

  for (const name of ontology.listEntities()) {
    const descriptor = ontology.describe(name);
    if (!descriptor?.fields || !descriptor.actions?.some((a) => a.name === action)) continue;

    const out: Record<string, CardFieldSchema> = {};
    const keys = new Set<string>(Object.keys(proposedInput));
    for (const [fieldName, field] of Object.entries(descriptor.fields)) {
      if (field.required) keys.add(fieldName);
    }

    for (const key of keys) {
      if (SYSTEM_FIELDS.has(key)) continue;
      const field = descriptor.fields[key];
      if (!field) {
        out[key] = { type: "string", required: false };
        continue;
      }
      const enumOptions =
        field.type === "enum" && Array.isArray(field.options)
          ? field.options.map((opt) =>
              typeof opt === "object" && opt !== null
                ? {
                    value: String((opt as { value?: unknown }).value ?? ""),
                    label: (opt as { label?: string }).label,
                  }
                : { value: String(opt), label: String(opt) },
            )
          : undefined;
      out[key] = {
        type: field.type,
        required: field.required ?? false,
        ...(field.label ? { label: field.label } : {}),
        ...(field.description ? { description: field.description } : {}),
        ...(enumOptions ? { options: enumOptions } : {}),
      };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}
