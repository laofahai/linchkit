/**
 * AG-UI transport definition for cap-adapter-ag-ui.
 *
 * Extracted from capability.ts so the capability definition stays declarative,
 * mirroring cap-adapter-mcp's transport modules. Like cap-adapter-mcp's SSE
 * transport, the AG-UI endpoint runs as a standalone HTTP server on its own
 * port (the main adapter-server app does not yet consume the
 * `TransportAdapterDefinition.routes` seam).
 */

import type { TransportAdapterDefinition, TransportContext } from "@linchkit/core";
import type { Elysia } from "elysia";
import { capAdapterAgUiConfig } from "./config";

/**
 * AG-UI transport — Agent ↔ frontend streaming over SSE
 * (CopilotKit open standard, Spec 15 §6.5, issue #89).
 *
 * Phase 1 serves `POST <basePath>/run`: validates a RunAgentInput body and
 * streams AG-UI protocol events (RUN_STARTED → TEXT_MESSAGE_* / TOOL_CALL_*
 * → RUN_FINISHED) by bridging `ctx.aiService` — the same assistant seam the
 * adapter-server AI routes use. Disabled by default (`enabled: false`).
 */
export const agUiTransport: TransportAdapterDefinition = {
  name: "agui",
  label: "AG-UI (Agent-User Interaction)",
  factory: (ctx: TransportContext) => {
    // Read config from typed accessor (env resolved, validated, frozen).
    const cfg = capAdapterAgUiConfig.from(ctx);
    let app: Elysia | null = null;

    return {
      start: async () => {
        if (!cfg.enabled) {
          console.log(
            "[cap-adapter-ag-ui] AG-UI transport disabled (set cap-adapter-ag-ui.enabled=true to serve the run endpoint).",
          );
          return;
        }
        // Lazy import to avoid loading elysia at capability registration time.
        const { createAgUiApp } = await import("./run-endpoint");
        app = await createAgUiApp({ aiService: ctx.aiService, basePath: cfg.basePath });
        app.listen(cfg.port);
        console.log(
          `[cap-adapter-ag-ui] AG-UI run endpoint listening on :${cfg.port} (POST ${cfg.basePath}/run)`,
        );
      },
      stop: async () => {
        if (app) {
          await app.stop();
          app = null;
          console.log("[cap-adapter-ag-ui] AG-UI transport stopped");
        }
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
      default: "/api/agui",
      description: "Base path the AG-UI run endpoint is mounted under",
    },
    port: {
      type: "number",
      default: 3003,
      description: "Port for the standalone AG-UI HTTP server",
    },
  },
};
