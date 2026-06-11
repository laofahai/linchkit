/**
 * createCapAdapterAgUi — Factory that produces the AG-UI adapter capability.
 *
 * Returns a CapabilityDefinition with the AG-UI transport registered in
 * extensions.transports. Mirrors cap-adapter-mcp's createCapAdapterMcp shape.
 * Phase 1 (#89): the transport serves the AG-UI run endpoint, bridging the
 * assistant AIService seam to protocol events over SSE.
 *
 * Usage:
 * ```ts
 * import { createCapAdapterAgUi } from '@linchkit/cap-adapter-ag-ui'
 *
 * const capAgUi = createCapAdapterAgUi()
 * ```
 */

import type { CapabilityDefinition } from "@linchkit/core";
import { defineCapability } from "@linchkit/core";
import type { z } from "zod";
import { agUiTransport } from "./ag-ui-transport";
import { capAdapterAgUiConfig } from "./config";

export interface CapAdapterAgUiOptions {
  /** Declarative configuration — validated by capAdapterAgUiConfig schema */
  config?: Partial<z.infer<typeof capAdapterAgUiConfig.schema>>;
}

/**
 * Create the AG-UI adapter capability.
 *
 * Wires the AG-UI transport definition into the capability. The transport
 * serves `POST <basePath>/run` and streams AG-UI protocol events by bridging
 * the assistant `aiService` seam (see run-endpoint.ts).
 */
export function createCapAdapterAgUi(options?: CapAdapterAgUiOptions): CapabilityDefinition {
  return defineCapability({
    name: "cap-adapter-ag-ui",
    label: "AG-UI Server",
    description:
      "Exposes LinchKit to a frontend AI agent via the AG-UI SSE protocol (Spec 15 §6.5)",
    type: "adapter",
    category: "integration",
    version: "0.0.1",

    configSchema: capAdapterAgUiConfig.schema,
    config: options?.config,

    dependencies: [],

    // Opt-in adapter — never auto-activated; enable it explicitly in
    // linchkit.config.ts and set `cap-adapter-ag-ui.enabled=true`.
    autoInstall: false,

    extensions: {
      transports: [agUiTransport],
    },

    systemPermissions: ["network:outbound"],
  });
}
