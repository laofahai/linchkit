/**
 * @linchkit/cap-adapter-a2a — A2A (Agent-to-Agent) protocol adapter
 *
 * Exposes the LinchKit Command Layer over the A2A protocol (Spec 15 §6.5).
 * Phase-1 spike (#89): AgentCard generator + config schema + a2a exposure flag.
 * HTTP serving and JSON-RPC task lifecycle deferred to later slices.
 */

// Transport definition
export { a2aTransport } from "./a2a-transport";
// AgentCard generator
export type { AgentCardOptions } from "./agent-card";
export { actionToSkill, generateAgentCard, isA2aExposed } from "./agent-card";
// Static capability export
export { capAdapterA2a } from "./capability";
// Config schema
export { capAdapterA2aConfig } from "./config";
// Factory
export type { CapAdapterA2aOptions } from "./factory";
export { createCapAdapterA2a } from "./factory";
// A2A v1.0 types
export type {
  AgentCapabilities,
  AgentCard,
  AgentExtension,
  AgentInterface,
  AgentProvider,
  AgentSkill,
  APIKeySecurityScheme,
  HTTPAuthSecurityScheme,
  SecurityScheme,
} from "./types";

import { capAdapterA2a } from "./capability";

export default capAdapterA2a;
