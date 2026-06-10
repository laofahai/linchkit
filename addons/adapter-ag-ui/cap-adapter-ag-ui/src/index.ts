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
// Canonical AG-UI protocol types (re-exported from @ag-ui/core) + SSE framing
export type {
  AGUIEvent,
  BaseEvent,
  Context,
  CustomEvent,
  Message,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
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
export { EventType, encodeSseEvent, RunAgentInputSchema } from "./protocol";
// Run endpoint (test seam: inject a fake AIService)
export type { AgUiRunDeps } from "./run-endpoint";
export {
  createAgUiApp,
  DEFAULT_AG_UI_BASE_PATH,
  mountAgUiRunRoute,
  toAiMessages,
  toAiTools,
} from "./run-endpoint";
