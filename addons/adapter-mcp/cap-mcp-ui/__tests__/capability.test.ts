/**
 * cap-mcp-ui capability shape tests.
 *
 * Importing the package entry also runs its side-effect `registerAdminRoute`
 * call, so we additionally assert the admin route it is supposed to register.
 */

import { describe, expect, it } from "bun:test";
import { getAdminRoutes } from "@linchkit/cap-adapter-ui/route-registry";
import { capMcpUi } from "../src";

describe("capMcpUi", () => {
  it("declares the expected identity fields", () => {
    expect(capMcpUi.name).toBe("cap-mcp-ui");
    expect(capMcpUi.type).toBe("standard");
    expect(capMcpUi.category).toBe("system");
    expect(capMcpUi.version).toBe("0.1.0");
  });

  it("depends on the UI shell and the MCP adapter", () => {
    expect(capMcpUi.dependencies).toEqual(
      expect.arrayContaining(["cap-adapter-ui", "cap-adapter-mcp"]),
    );
  });

  it("registers the MCP admin route on import", () => {
    const route = getAdminRoutes().find((r) => r.id === "mcp");
    expect(route).toBeDefined();
    expect(route?.path).toBe("/admin/mcp");
    expect(route?.capability).toBe("cap-adapter-mcp");
  });
});
