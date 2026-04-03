/**
 * Entry point for cap-mcp-ui
 *
 * Registers admin routes for MCP client management UI.
 */

import { registerAdminRoute } from "@linchkit/cap-adapter-ui/route-registry";

export { capMcpUi } from "./capability";

registerAdminRoute({
  id: "mcp",
  capability: "cap-adapter-mcp",
  path: "/admin/mcp",
  label: "mcp.admin.title",
  icon: "Plug",
  order: 300,
  component: () => import("./pages/mcp-dashboard"),
  children: [
    {
      id: "mcp-clients",
      capability: "cap-adapter-mcp",
      path: "/admin/mcp/clients",
      label: "mcp.admin.clients",
      icon: "Users",
      component: () => import("./pages/mcp-clients"),
    },
    {
      id: "mcp-client-detail",
      capability: "cap-adapter-mcp",
      path: "/admin/mcp/clients/:id",
      label: "mcp.admin.clientDetail",
      component: () => import("./pages/mcp-client-detail"),
    },
  ],
});
