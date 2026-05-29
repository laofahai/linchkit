/**
 * a2a-transport — TransportAdapterDefinition for the A2A protocol.
 *
 * SKELETON slice (issue #89, Spec 15 §6.5): the factory returns a no-op
 * lifecycle handle so the capability can be loaded and wired into the
 * transport pipeline without yet speaking the A2A protocol.
 *
 * The factory is declarative on purpose — when it later dispatches inbound
 * agent messages to Actions it will route them through `ctx.commandLayer.execute`
 * (the sole write entry point), never bypassing the CommandLayer middleware.
 */

import type { TransportAdapterDefinition, TransportContext } from "@linchkit/core";
import { capAdapterA2aConfig } from "./config";

/**
 * The A2A transport definition registered via `extensions.transports`.
 *
 * `start`/`stop` are currently no-ops. Real protocol wiring is deferred —
 * see the TODO inside the factory.
 */
export const a2aTransport: TransportAdapterDefinition = {
  name: "a2a",
  label: "Agent-to-Agent Protocol",
  factory: (ctx: TransportContext) => {
    // Read config from the typed accessor (env resolved, validated, frozen).
    const cfg = capAdapterA2aConfig.from(ctx);

    return {
      start: async () => {
        // TODO(#89 S2+): publish the Agent Card, mount the JSON-RPC endpoint
        // (message/send, tasks/get, tasks/cancel) under `cfg.basePath`, and
        // dispatch inbound agent messages to Actions via `ctx.commandLayer.execute`.
        // The skeleton intentionally does not open a port or speak the protocol.
        console.log(
          `[cap-adapter-a2a] A2A transport is a no-op skeleton (enabled=${cfg.enabled}, basePath=${cfg.basePath}, port=${cfg.port}). Protocol logic deferred to a later slice (#89).`,
        );
      },
      stop: async () => {
        // No resources are held by the skeleton transport.
      },
    };
  },
  config: {
    enabled: {
      type: "boolean",
      default: false,
      description: "Enable the A2A transport adapter",
    },
    port: {
      type: "number",
      default: 3003,
      description: "Port for the A2A HTTP server",
    },
    basePath: {
      type: "string",
      default: "/a2a",
      description: "Base path the A2A endpoints are mounted under",
    },
  },
};
