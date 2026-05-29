/**
 * createCapAdapterAgUi — Factory that produces the AG-UI adapter capability (SKELETON).
 *
 * Returns a CapabilityDefinition with the AG-UI transport registered in
 * extensions.transports. Mirrors cap-adapter-mcp's createCapAdapterMcp shape.
 * The transport is currently a no-op; real logic arrives in later slices (#89).
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
 * SKELETON: wires the AG-UI transport definition into the capability but does
 * not yet implement the SSE run-session. See ag-ui-transport.ts TODO(#89 S6+).
 */
export function createCapAdapterAgUi(options?: CapAdapterAgUiOptions): CapabilityDefinition {
  return defineCapability({
    name: "cap-adapter-ag-ui",
    label: "AG-UI Server",
    description:
      "Exposes LinchKit to a frontend AI agent via the AG-UI SSE protocol (Spec 15 §6.5, skeleton)",
    type: "adapter",
    category: "integration",
    version: "0.0.1",

    configSchema: capAdapterAgUiConfig.schema,
    config: options?.config,

    dependencies: [],

    extensions: {
      transports: [agUiTransport],
    },

    systemPermissions: ["network:outbound"],
  });
}
