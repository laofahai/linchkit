/**
 * @linchkit/cap-adapter-ag-ui — AG-UI adapter (SKELETON)
 *
 * AG-UI (Agent-User Interaction) protocol adapter — CopilotKit open standard for
 * bidirectional, real-time agent ↔ frontend communication over SSE (Spec 15 §6.5).
 * Only the capability/transport scaffold is implemented; real logic is deferred (#89).
 */

export type { TransportAdapterDefinition } from "@linchkit/core";
// AG-UI transport definition
export { agUiTransport } from "./ag-ui-transport";
export { capAdapterAgUi } from "./capability";
// Config schema
export { capAdapterAgUiConfig } from "./config";
export type { CapAdapterAgUiOptions } from "./factory";
export { createCapAdapterAgUi } from "./factory";
