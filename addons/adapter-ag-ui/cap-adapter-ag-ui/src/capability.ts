/**
 * Capability definition for cap-adapter-ag-ui (SKELETON).
 *
 * Registers the AG-UI transport (Spec 15 §6.5). Transport factory logic lives
 * in ag-ui-transport.ts to keep this file declarative, mirroring cap-adapter-mcp.
 * The parametrized factory lives in factory.ts. Real AG-UI logic is deferred
 * to later slices (#89).
 */

import { defineCapability } from "@linchkit/core";
import { agUiTransport } from "./ag-ui-transport";
import { capAdapterAgUiConfig } from "./config";

export const capAdapterAgUi = defineCapability({
  name: "cap-adapter-ag-ui",
  label: "AG-UI Server",
  type: "adapter",
  category: "integration",
  version: "0.0.1",

  configSchema: capAdapterAgUiConfig.schema,

  extensions: {
    transports: [agUiTransport],
  },

  systemPermissions: ["network:outbound"],
});
