/**
 * Capability registration — declare which capabilities to load.
 *
 * This file is the single place to enable/disable capabilities.
 * System configuration (port, database, AI) stays in linchkit.config.ts.
 * Permission groups are declared by each capability, not here.
 */

import { createCapAdapterAgUi } from "@linchkit/cap-adapter-ag-ui";
import { createCapAdapterMcp } from "@linchkit/cap-adapter-mcp";
import { capAdapterServer } from "@linchkit/cap-adapter-server";
import { capAdapterUi } from "@linchkit/cap-adapter-ui";
// import { createCapAuth } from "@linchkit/cap-auth";
// import { capAuthBetterAuth } from "@linchkit/cap-auth-better-auth";
// import { createCapPermission } from "@linchkit/cap-permission";
import { createCapChatter } from "@linchkit/cap-chatter";
import { capPurchaseDemo } from "@linchkit/cap-purchase-demo";
import type { CapabilityDefinition } from "@linchkit/core";
// Reference/demo capabilities for the in-place extension (Odoo `_inherit`) demo.
// Authored as plain modules (not workspace packages) so they resolve through the
// worktree's symlinked node_modules; imported here via relative path.
import { partnerCapability } from "./capabilities/partner";
import { salesCapability } from "./capabilities/sales";

// Side-effect imports: register UI panels in the panel/route registry
import "@linchkit/cap-chatter-ui";
import "@linchkit/cap-mcp-ui";

export const capabilities: CapabilityDefinition[] = [
  // Protocol adapters
  capAdapterServer,
  createCapAdapterMcp({ config: { transport: "sse", ssePort: 3002 } }),
  capAdapterUi,
  // AG-UI protocol (#89): registering the capability opts in the
  // `POST /api/agui/run` route on the main server (:3001) — the admin UI
  // assistant talks this endpoint via @ag-ui/client. The addon's own
  // standalone transport (port 3003) stays disabled by default.
  createCapAdapterAgUi(),

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
  // In-place extension demo: cap-sales adds `credit_limit` to cap-partner's
  // `partner` entity + `partner_form` view IN PLACE (no fork). Order does not
  // matter — extensions are folded after all caps are collected.
  partnerCapability,
  salesCapability,
];
