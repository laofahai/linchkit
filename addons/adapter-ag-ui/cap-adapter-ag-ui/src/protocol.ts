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
  Message,
  MessagesSnapshotEvent,
  RawEvent,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
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
// ── Event type identifiers + input validation schema ────────
export {
  ContextSchema,
  EventType,
  MessageSchema,
  RunAgentInputSchema,
  ToolCallSchema,
  ToolSchema,
} from "@ag-ui/core";

import type { AGUIEvent } from "@ag-ui/core";

// ── SSE framing (local — not provided by @ag-ui/core) ───────

/**
 * Encode a protocol event as a Server-Sent Events frame:
 * `data: <json>\n\n`.
 */
export function encodeSseEvent(event: AGUIEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
