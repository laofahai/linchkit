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
 */
export function makeInterruptOutcome(interrupts: Interrupt[]): RunFinishedInterruptOutcome {
  return { type: "interrupt", interrupts };
}
