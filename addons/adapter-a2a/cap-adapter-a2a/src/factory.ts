/**
 * createCapAdapterA2a — Factory that produces the A2A adapter capability.
 *
 * SKELETON slice (issue #89, Spec 15 §6.5): returns a CapabilityDefinition with
 * the no-op `a2a` transport registered in `extensions.transports`. Real protocol
 * logic (Agent Card, JSON-RPC, task/message lifecycle) is deferred to later slices.
 *
 * Usage:
 * ```ts
 * import { createCapAdapterA2a } from "@linchkit/cap-adapter-a2a";
 *
 * const capA2a = createCapAdapterA2a({
 *   config: { enabled: true, port: 3003 },
 * });
 * ```
 */

import type { CapabilityDefinition } from "@linchkit/core";
import { defineCapability } from "@linchkit/core";
import type { z } from "zod";
import { a2aTransport } from "./a2a-transport";
import { capAdapterA2aConfig } from "./config";

export interface CapAdapterA2aOptions {
  /** Declarative configuration — validated by capAdapterA2aConfig schema */
  config?: Partial<z.infer<typeof capAdapterA2aConfig.schema>>;
}

/**
 * Create the A2A adapter capability.
 *
 * Registers the no-op A2A transport. When the protocol is implemented the
 * transport factory will wire inbound agent messages to the CommandLayer.
 */
export function createCapAdapterA2a(options?: CapAdapterA2aOptions): CapabilityDefinition {
  return defineCapability({
    name: "cap-adapter-a2a",
    label: "A2A Server",
    description:
      "Exposes LinchKit actions over the Agent-to-Agent (A2A) protocol (Spec 15 §6.5). SKELETON — protocol logic deferred to a later slice (#89).",
    type: "adapter",
    category: "integration",
    version: "0.0.1",

    configSchema: capAdapterA2aConfig.schema,
    config: options?.config,

    dependencies: [],

    extensions: {
      transports: [a2aTransport],
    },

    systemPermissions: ["network:outbound"],
  });
}
