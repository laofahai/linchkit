/**
 * In-house AG-UI protocol types (https://docs.ag-ui.com/concepts/events).
 * Swap to @ag-ui/core once the dependency is approved — keep this module's
 * exports shape-compatible.
 *
 * Covers the phase-1 subset of the AG-UI event catalogue: run lifecycle,
 * text message streaming, tool call streaming, plus state/custom stubs.
 * Event names and field shapes were taken verbatim from
 * https://docs.ag-ui.com/sdk/js/core/events and
 * https://docs.ag-ui.com/sdk/js/core/types on 2026-06-10.
 */

import { z } from "zod";

// ── Event type identifiers ──────────────────────────────────

/** AG-UI event type discriminators (exact protocol string values). */
export const EventType = {
  RUN_STARTED: "RUN_STARTED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
  STEP_STARTED: "STEP_STARTED",
  STEP_FINISHED: "STEP_FINISHED",
  TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
  TOOL_CALL_START: "TOOL_CALL_START",
  TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
  TOOL_CALL_END: "TOOL_CALL_END",
  TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
  STATE_SNAPSHOT: "STATE_SNAPSHOT",
  STATE_DELTA: "STATE_DELTA",
  MESSAGES_SNAPSHOT: "MESSAGES_SNAPSHOT",
  RAW: "RAW",
  CUSTOM: "CUSTOM",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

// ── Event payloads ──────────────────────────────────────────

/** Fields shared by every AG-UI event. */
export interface BaseEvent {
  type: EventType;
  /** Unix epoch milliseconds when the event was created. */
  timestamp?: number;
  /** Original event data if this event was transformed from another source. */
  rawEvent?: unknown;
}

export interface RunStartedEvent extends BaseEvent {
  type: typeof EventType.RUN_STARTED;
  threadId: string;
  runId: string;
  parentRunId?: string;
}

export interface RunFinishedEvent extends BaseEvent {
  type: typeof EventType.RUN_FINISHED;
  threadId: string;
  runId: string;
  result?: unknown;
}

export interface RunErrorEvent extends BaseEvent {
  type: typeof EventType.RUN_ERROR;
  message: string;
  code?: string;
}

export interface StepStartedEvent extends BaseEvent {
  type: typeof EventType.STEP_STARTED;
  stepName: string;
}

export interface StepFinishedEvent extends BaseEvent {
  type: typeof EventType.STEP_FINISHED;
  stepName: string;
}

export interface TextMessageStartEvent extends BaseEvent {
  type: typeof EventType.TEXT_MESSAGE_START;
  messageId: string;
  role: "assistant";
}

export interface TextMessageContentEvent extends BaseEvent {
  type: typeof EventType.TEXT_MESSAGE_CONTENT;
  messageId: string;
  /** Text chunk — must be non-empty per the protocol. */
  delta: string;
}

export interface TextMessageEndEvent extends BaseEvent {
  type: typeof EventType.TEXT_MESSAGE_END;
  messageId: string;
}

export interface ToolCallStartEvent extends BaseEvent {
  type: typeof EventType.TOOL_CALL_START;
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}

export interface ToolCallArgsEvent extends BaseEvent {
  type: typeof EventType.TOOL_CALL_ARGS;
  toolCallId: string;
  /** JSON-encoded argument chunk. */
  delta: string;
}

export interface ToolCallEndEvent extends BaseEvent {
  type: typeof EventType.TOOL_CALL_END;
  toolCallId: string;
}

export interface ToolCallResultEvent extends BaseEvent {
  type: typeof EventType.TOOL_CALL_RESULT;
  messageId: string;
  toolCallId: string;
  content: string;
  role?: "tool";
}

/** Phase-1 stub — emitted by future slices for shared-state sync. */
export interface StateSnapshotEvent extends BaseEvent {
  type: typeof EventType.STATE_SNAPSHOT;
  snapshot: unknown;
}

/** Phase-1 stub — RFC 6902 JSON Patch operations against the shared state. */
export interface StateDeltaEvent extends BaseEvent {
  type: typeof EventType.STATE_DELTA;
  delta: unknown[];
}

/** Phase-1 stub — full conversation snapshot. */
export interface MessagesSnapshotEvent extends BaseEvent {
  type: typeof EventType.MESSAGES_SNAPSHOT;
  messages: Message[];
}

export interface RawEvent extends BaseEvent {
  type: typeof EventType.RAW;
  event: unknown;
  source?: string;
}

export interface CustomEvent extends BaseEvent {
  type: typeof EventType.CUSTOM;
  name: string;
  value: unknown;
}

/** Union of all AG-UI protocol events this adapter can emit. */
export type AgUiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | MessagesSnapshotEvent
  | RawEvent
  | CustomEvent;

// ── RunAgentInput (client → server) zod schemas ─────────────

/** Tool call made by an assistant message (OpenAI-style function call). */
export const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({
    name: z.string().min(1),
    /** JSON-encoded arguments. */
    arguments: z.string(),
  }),
});

export const developerMessageSchema = z.object({
  id: z.string().min(1),
  role: z.literal("developer"),
  content: z.string(),
  name: z.string().optional(),
});

export const systemMessageSchema = z.object({
  id: z.string().min(1),
  role: z.literal("system"),
  content: z.string(),
  name: z.string().optional(),
});

export const assistantMessageSchema = z.object({
  id: z.string().min(1),
  role: z.literal("assistant"),
  content: z.string().optional(),
  name: z.string().optional(),
  toolCalls: z.array(toolCallSchema).optional(),
});

// Phase 1 restricts user content to plain strings (the protocol also allows
// an InputContent[] array for multimodal input — deferred).
export const userMessageSchema = z.object({
  id: z.string().min(1),
  role: z.literal("user"),
  content: z.string(),
  name: z.string().optional(),
});

export const toolMessageSchema = z.object({
  id: z.string().min(1),
  role: z.literal("tool"),
  content: z.string(),
  toolCallId: z.string().min(1),
  error: z.string().optional(),
});

/** AG-UI conversation message (discriminated by role). */
export const messageSchema = z.discriminatedUnion("role", [
  developerMessageSchema,
  systemMessageSchema,
  assistantMessageSchema,
  userMessageSchema,
  toolMessageSchema,
]);

/** Frontend tool definition the agent may call (executed client-side). */
export const toolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  /** JSON Schema for the tool arguments. */
  parameters: z.record(z.string(), z.unknown()).default({}),
});

/** Additional contextual information provided by the client. */
export const contextSchema = z.object({
  description: z.string(),
  value: z.string(),
});

/**
 * RunAgentInput — the POST body of an AG-UI run request.
 *
 * The upstream type marks `state`, `messages`, `tools`, `context` and
 * `forwardedProps` as required; we accept them as optional with empty
 * defaults so minimal clients can start a run with just thread/run IDs.
 * The parsed output shape matches the upstream type.
 */
export const runAgentInputSchema = z.object({
  threadId: z.string().min(1),
  runId: z.string().min(1),
  parentRunId: z.string().min(1).optional(),
  state: z.unknown().optional(),
  messages: z.array(messageSchema).default([]),
  tools: z.array(toolSchema).default([]),
  context: z.array(contextSchema).default([]),
  forwardedProps: z.unknown().optional(),
});

export type ToolCall = z.infer<typeof toolCallSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Tool = z.infer<typeof toolSchema>;
export type Context = z.infer<typeof contextSchema>;
export type RunAgentInput = z.infer<typeof runAgentInputSchema>;

// ── SSE framing ─────────────────────────────────────────────

/**
 * Encode a protocol event as a Server-Sent Events frame:
 * `data: <json>\n\n`.
 */
export function encodeSseEvent(event: AgUiEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
