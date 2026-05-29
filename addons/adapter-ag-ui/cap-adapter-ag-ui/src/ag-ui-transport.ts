/**
 * AG-UI transport definition for cap-adapter-ag-ui (SKELETON).
 *
 * Extracted from capability.ts so the capability definition stays declarative,
 * mirroring cap-adapter-mcp's mcp-transport.ts. The factory currently returns a
 * no-op lifecycle; the real AG-UI runtime is deferred to later slices.
 */

import type { TransportAdapterDefinition, TransportContext } from "@linchkit/core";
import { capAdapterAgUiConfig } from "./config";

/**
 * AG-UI transport — Agent ↔ frontend bidirectional streaming over SSE
 * (CopilotKit open standard, Spec 15 §6.5).
 *
 * TODO(#89 S6+): implement the real transport — wire the SSE event encoder,
 * the per-connection run-session, and `ctx.aiService.completeStream(...)` so the
 * agent can stream tokens / tool calls / Human-in-the-Loop Proposal prompts to
 * the UI. For now `start`/`stop` are no-ops so the capability loads cleanly.
 */
export const agUiTransport: TransportAdapterDefinition = {
  name: "agui",
  label: "AG-UI (Agent-User Interaction)",
  factory: (ctx: TransportContext) => {
    // Read config from typed accessor (env resolved, validated, frozen).
    // Read here (not used yet) to mirror cap-adapter-mcp's factory shape and to
    // surface config validation errors at registration time.
    const _cfg = capAdapterAgUiConfig.from(ctx);

    return {
      start: async () => {
        // no-op skeleton — real SSE run-session wiring lands in a later slice.
      },
      stop: async () => {
        // no-op skeleton
      },
    };
  },
  config: {
    enabled: {
      type: "boolean",
      default: false,
      description: "Enable the AG-UI transport",
    },
    basePath: {
      type: "string",
      default: "/ag-ui",
      description: "Base path for the AG-UI SSE endpoint mounted on the main HTTP server",
    },
    port: {
      type: "number",
      default: 3003,
      description: "Port for a standalone AG-UI HTTP server (only used when not mounted)",
    },
  },
};
