/**
 * Capability registration — declare which capabilities to load.
 *
 * This file is the single place to enable/disable capabilities.
 * System configuration (port, database, AI) stays in linchkit.config.ts.
 * Permission groups are declared by each capability, not here.
 */

import { capAdapterServer } from "@linchkit/cap-adapter-server";
import { capAdapterUiReact } from "@linchkit/cap-adapter-ui-react";
// import { createCapAuth } from "@linchkit/cap-auth";
// import { capAuthBetterAuth } from "@linchkit/cap-auth-better-auth";
// import { createCapPermission } from "@linchkit/cap-permission";
import { createCapChatter } from "@linchkit/cap-chatter";
import { capPurchaseDemo } from "@linchkit/cap-purchase-demo";
import type { CapabilityDefinition } from "@linchkit/core";

// Side-effect import: registers chatter UI panel in the panel registry
import "@linchkit/cap-ui-react-chatter";

export const capabilities: CapabilityDefinition[] = [
  // Protocol adapters
  capAdapterServer,
  capAdapterUiReact,

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
