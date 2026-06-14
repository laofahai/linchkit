/**
 * AG-UI protocol surface — canonical definitions from `@ag-ui/core`.
 *
 * This module re-exports the official AG-UI protocol package
 * (https://docs.ag-ui.com) so the wire format can never drift from what real
 * AG-UI frontends validate against. It stays the single import point for the
 * rest of the addon: everything protocol-shaped comes from here.
 *
 * Only `encodeSseEvent` is local — `@ag-ui/core` defines events and input
 * types but ships no SSE transport framing.
 *
 * Zod-version note: `@ag-ui/core` depends on zod ^3 while this addon uses
 * zod ^4. Its schema instances (e.g. `RunAgentInputSchema`) are zod-3
 * objects — call THEIR `.parse`/`.safeParse` for validation; never compose
 * them into local zod-4 schemas via `.extend()`/`.merge()`/`z.union()`.
 */

// ── Protocol types (zod-inferred upstream) ──────────────────
export type {
  AGUIEvent,
  AssistantMessage,
  BaseEvent,
  Context,
  CustomEvent,
  DeveloperMessage,
  InputContent,
  // Human-in-the-loop (Spec 71): interrupt/resume types. `Interrupt` and
  // `resume` here are the AG-UI HITL vocabulary — deliberately NOT the core
  // evolution `ProposalEngine` vocabulary (Spec 71 §3.6 naming-collision rule).
  Interrupt,
  Message,
  MessagesSnapshotEvent,
  RawEvent,
  ResumeEntry,
  ResumeStatus,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunFinishedInterruptOutcome,
  RunFinishedOutcome,
  RunFinishedSuccessOutcome,
  RunStartedEvent,
  StateDeltaEvent,
  StateSnapshotEvent,
  StepFinishedEvent,
  StepStartedEvent,
  SystemMessage,
  TextInputContent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  Tool,
  ToolCall,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
  ToolMessage,
  UserMessage,
} from "@ag-ui/core";
// ── Event type identifiers + validation schemas ─────────────
export {
  ContextSchema,
  EventType,
  // Human-in-the-loop (Spec 71) schemas — call THEIR `.safeParse`/`.parse`
  // directly (zod-3); never compose them into local zod-4 schemas.
  InterruptSchema,
  MessageSchema,
  ResumeEntrySchema,
  RunAgentInputSchema,
  RunFinishedEventSchema,
  RunFinishedInterruptOutcomeSchema,
  RunFinishedOutcomeSchema,
  ToolCallSchema,
  ToolSchema,
} from "@ag-ui/core";

import type {
  AGUIEvent,
  Interrupt,
  RunFinishedInterruptOutcome,
  RunFinishedSuccessOutcome,
} from "@ag-ui/core";

// ── SSE framing (local — not provided by @ag-ui/core) ───────

/**
 * Encode a protocol event as a Server-Sent Events frame:
 * `data: <json>\n\n`.
 */
export function encodeSseEvent(event: AGUIEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// ── Human-in-the-loop run-outcome helpers (Spec 71 §3.1, §4.2) ──
//
// The AG-UI HITL protocol carries an approval interrupt as an optional
// `outcome` field on `RUN_FINISHED` (there is no dedicated INTERRUPT event —
// Spec 71 §3.1). A run that needs approval *finishes* with
// `outcome.type === "interrupt"`; the approval + resume is a new run on the
// same `threadId`. These helpers build those outcomes against the upstream
// schema so the rest of the addon never hand-writes the discriminated shape.

/** The plain success run outcome (`{ type: "success" }`). */
export const SUCCESS_OUTCOME: RunFinishedSuccessOutcome = { type: "success" };

/**
 * Build a typed interrupt run-outcome (Spec 71 §3.4 / §4.2):
 * `{ type: "interrupt", interrupts }`. The returned value is the exact
 * `RunFinishedInterruptOutcome` an `RUN_FINISHED.outcome` carries when a
 * model-proposed mutation is awaiting human approval.
 *
 * `RunFinishedInterruptOutcomeSchema` enforces `z.array(InterruptSchema).min(1)`,
 * so an empty `interrupts` list would produce a schema-INVALID frame that fails
 * downstream `RunFinishedEventSchema.safeParse`. Guard at the source: a caller
 * must never be able to emit an interrupt outcome with nothing to act on.
 */
export function makeInterruptOutcome(interrupts: Interrupt[]): RunFinishedInterruptOutcome {
  if (interrupts.length === 0) {
    throw new Error(
      "makeInterruptOutcome requires at least one interrupt — RunFinishedInterruptOutcome.interrupts is .min(1).",
    );
  }
  return { type: "interrupt", interrupts };
}

// ── Runner → endpoint interrupt channel (Spec 71 §4.3, P2a) ─────
//
// The runner returns to `void` on a plain finish, but when the model proposed a
// mutation mid-run it must hand an interrupt back to the endpoint so the
// endpoint (which owns the `RUN_FINISHED` frame) can attach the interrupt
// outcome. The currently-exported `AgUiAgentRunner` returns `Promise<void>`,
// which has no such channel — Spec 71 §4.3 changes the signature to
// `=> Promise<void | AgUiInterruptDescriptor>`. This is that descriptor: a
// minimal, fully-typed carrier for the `Interrupt[]` the endpoint feeds to
// `makeInterruptOutcome`. It deliberately carries ONLY the protocol-shaped
// interrupts — the server-authoritative store entry (action set, digest,
// proposer binding) is written by the runner directly into the interrupt store
// (§6.7), not threaded through this descriptor.

/**
 * What a runner hands back to the run endpoint when the model proposed a
 * mutation that needs human approval (Spec 71 §4.3). The endpoint attaches
 * `makeInterruptOutcome(descriptor.interrupts)` to the `RUN_FINISHED.outcome`.
 *
 * Returning `void` keeps the legacy plain-success finish; returning this
 * descriptor switches the same finish frame to the interrupt outcome.
 */
export interface AgUiInterruptDescriptor {
  /**
   * The AG-UI interrupts to carry on `RUN_FINISHED.outcome.interrupts[]`.
   * Always ≥1 (the endpoint passes this straight to `makeInterruptOutcome`,
   * which throws on empty — Spec 71 §3.1).
   */
  interrupts: Interrupt[];
}
