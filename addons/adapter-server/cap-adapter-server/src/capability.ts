/**
 * Capability definition for cap-adapter-server
 *
 * Registers the HTTP/GraphQL transport and dev server CLI command.
 * Transport factory logic lives in http-transport.ts to keep this file declarative.
 */

import type { CliCommandContext } from "@linchkit/core";
import { defineCapability } from "@linchkit/core";
import { createHttpTransport } from "./http-transport";

export const capAdapterServer = defineCapability({
  name: "cap-adapter-server",
  label: "HTTP/GraphQL Server",
  type: "adapter",
  category: "integration",
  version: "0.0.1",

  extensions: {
    transports: [
      {
        name: "http",
        label: "HTTP/GraphQL Server",
        factory: createHttpTransport,
        // port/host come from system:server config — no transport-level config needed
      },
    ],
    menuItems: [
      {
        id: "relation-graph",
        label: "t:relationGraph.navLabel",
        path: "/admin/graph",
        icon: "Network",
        section: "admin",
        order: 75,
      },
      {
        id: "evolution",
        label: "t:evolution.navLabel",
        path: "/admin/evolution",
        icon: "History",
        section: "admin",
        order: 80,
      },
      {
        id: "system-overview",
        label: "t:systemOverview.title",
        path: "/admin/system",
        icon: "Monitor",
        section: "admin",
        order: 90,
      },
      {
        id: "config-center",
        label: "t:configCenter.title",
        path: "/admin/config",
        icon: "Settings",
        section: "admin",
        order: 95,
      },
      {
        id: "ai-traces",
        label: "t:aiTraces.title",
        path: "/admin/ai-traces",
        icon: "Activity",
        section: "admin",
        order: 110,
      },
    ],
    commands: [
      {
        name: "dev",
        namespace: "server",
        description: "Start HTTP/GraphQL development server",
        isDefault: true,
        devOnly: true,
        args: {
          port: {
            type: "string",
            default: "3001",
            description: "Server port",
          },
          host: {
            type: "string",
            default: "0.0.0.0",
            description: "Server host",
          },
        },
        handler: async (_ctx: CliCommandContext) => {
          console.log("[cap-adapter-server] Starting HTTP/GraphQL dev server...");
          // Full implementation will be wired in CLI integration
        },
      },
    ],
  },

  systemPermissions: ["network:outbound"],
});
