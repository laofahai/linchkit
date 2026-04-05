/**
 * Capability registration — declare which capabilities to load.
 *
 * This file is the single place to enable/disable capabilities.
 * System configuration (port, database, AI) stays in linchkit.config.ts.
 * Permission groups are declared by each capability, not here.
 */

import { createCapAdapterMcp } from "@linchkit/cap-adapter-mcp";
import { capAdapterServer } from "@linchkit/cap-adapter-server";
import { capAdapterUi } from "@linchkit/cap-adapter-ui";
// import { createCapAuth } from "@linchkit/cap-auth";
// import { capAuthBetterAuth } from "@linchkit/cap-auth-better-auth";
// import { createCapPermission } from "@linchkit/cap-permission";
import { createCapChatter } from "@linchkit/cap-chatter";
import { capPurchaseDemo } from "@linchkit/cap-purchase-demo";
import type { CapabilityDefinition } from "@linchkit/core";

// Side-effect imports: register UI panels in the panel/route registry
import "@linchkit/cap-chatter-ui";
import "@linchkit/cap-mcp-ui";

export const capabilities: CapabilityDefinition[] = [
  // Protocol adapters
  capAdapterServer,
  createCapAdapterMcp({ config: { transport: "sse", ssePort: 3002 } }),
  capAdapterUi,

  // Authentication & authorization
  // createCapAuth({
  //   config: {
  //     jwtSecret: "$env.JWT_SECRET",
  //     sessionCookieName: "lk_session",
  //     allowAnonymous: true,
  //   },
  // }),
  // capAuthBetterAuth(),
  // createCapPermission({
  //   config: {
  //     publicActions: ["login", "logout", "register", "reset_password", "health"],
  //   },
  // }),

  // System capabilities
  createCapChatter(),

  // Business modules
  capPurchaseDemo,
];
