/**
 * Route-registry unit tests run against an ISOLATED instance from
 * createAdminRouteRegistry() — never against the shared module singleton.
 * Capability packages (cap-adapter-mcp UI, …) register into the singleton at
 * import time and assert on it; clearing it here raced those assertions under
 * bun's batched test run (#539).
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { type AdminRouteRegistry, createAdminRouteRegistry } from "../src/lib/route-registry";

// ── Helpers ─────────────────────────────────────────────

function makeRoute(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-route",
    capability: "__builtin__",
    path: "/admin/test",
    label: "test.title",
    component: () => Promise.resolve({ default: () => null }),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────

describe("Admin Route Registry", () => {
  let registry: AdminRouteRegistry;

  beforeEach(() => {
    registry = createAdminRouteRegistry();
  });

  it("register adds a route", () => {
    registry.register(makeRoute());
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.getAll()[0]?.id).toBe("test-route");
  });

  it("getAll returns sorted by order", () => {
    registry.register(makeRoute({ id: "c", order: 300 }));
    registry.register(makeRoute({ id: "a", order: 10 }));
    registry.register(makeRoute({ id: "b", order: 50 }));

    const routes = registry.getAll();
    expect(routes.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("throws on duplicate ID", () => {
    registry.register(makeRoute({ id: "dup" }));
    expect(() => registry.register(makeRoute({ id: "dup" }))).toThrow(
      'Admin route "dup" is already registered',
    );
  });

  it("getAll returns a copy, not a reference", () => {
    registry.register(makeRoute());
    const a = registry.getAll();
    const b = registry.getAll();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("default order is 100", () => {
    registry.register(makeRoute({ id: "low", order: 50 }));
    registry.register(makeRoute({ id: "default" })); // no order → 100
    registry.register(makeRoute({ id: "high", order: 200 }));

    const routes = registry.getAll();
    expect(routes.map((r) => r.id)).toEqual(["low", "default", "high"]);
  });

  it("preserves all registration fields", () => {
    const route = makeRoute({
      id: "full",
      capability: "cap-mcp",
      path: "/admin/mcp",
      label: "mcp.title",
      icon: "Terminal",
      order: 42,
    });
    registry.register(route);

    const [result] = registry.getAll();
    expect(result?.id).toBe("full");
    expect(result?.capability).toBe("cap-mcp");
    expect(result?.path).toBe("/admin/mcp");
    expect(result?.label).toBe("mcp.title");
    expect(result?.icon).toBe("Terminal");
    expect(result?.order).toBe(42);
  });

  it("instances are isolated from each other and from the shared singleton", () => {
    registry.register(makeRoute({ id: "iso" }));
    const other = createAdminRouteRegistry();
    expect(other.getAll()).toHaveLength(0);
  });
});
