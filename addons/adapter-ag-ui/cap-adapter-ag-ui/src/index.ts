/**
 * @linchkit/cap-adapter-ag-ui — AG-UI protocol adapter
 *
 * AG-UI (Agent-User Interaction) protocol adapter — CopilotKit open standard for
 * bidirectional, real-time agent ↔ frontend communication over SSE (Spec 15 §6.5).
 * Phase 1 (#89): canonical protocol types from `@ag-ui/core` (re-exported via
 * `./protocol`) + the `POST <basePath>/run` endpoint bridging the assistant
 * AIService seam to AG-UI events.
 */

export type { TransportAdapterDefinition } from "@linchkit/core";
// AG-UI transport definition
export { agUiTransport } from "./ag-ui-transport";
export { capAdapterAgUi } from "./capability";
// Config schema
export { capAdapterAgUiConfig } from "./config";
export type { CapAdapterAgUiOptions } from "./factory";
export { createCapAdapterAgUi } from "./factory";
// Interrupt store (Spec 71 §6.7) — the cross-connection HITL state.
export type {
  ActorBinding,
  InterruptStore,
  InterruptStoreEntry,
} from "./interrupt-store";
export { InMemoryInterruptStore } from "./interrupt-store";
// Canonical AG-UI protocol types (re-exported from @ag-ui/core) + SSE framing
export type {
  AGUIEvent,
  // Human-in-the-loop (Spec 71) runner→endpoint interrupt descriptor.
  AgUiInterruptDescriptor,
  BaseEvent,
  Context,
  CustomEvent,
  // Human-in-the-loop (Spec 71) interrupt/resume types.
  Interrupt,
  Message,
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
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  Tool,
  ToolCall,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallStartEvent,
} from "./protocol";
export {
  EventType,
  encodeSseEvent,
  // Human-in-the-loop (Spec 71) schemas + outcome helpers.
  InterruptSchema,
  makeInterruptOutcome,
  ResumeEntrySchema,
  RunAgentInputSchema,
  RunFinishedEventSchema,
  RunFinishedInterruptOutcomeSchema,
  RunFinishedOutcomeSchema,
  SUCCESS_OUTCOME,
} from "./protocol";
// Run endpoint (test seams: inject a fake AIService or a custom runner)
export type {
  AgUiAgentRunner,
  AgUiEmit,
  AgUiRunDeps,
  AgUiRunHandler,
  AgUiRunHandlerContext,
} from "./run-endpoint";
export {
  createAgUiApp,
  createAgUiRunHandler,
  DEFAULT_AG_UI_BASE_PATH,
  makeRunFinishedEvent,
  mountAgUiRunRoute,
  toAiMessages,
  toAiTools,
} from "./run-endpoint";
