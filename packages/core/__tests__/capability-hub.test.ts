import { beforeEach, describe, expect, it } from "bun:test";
import type { CapabilityManifest } from "@linchkit/core";
import {
  type CapabilityHub,
  CapabilityHubError,
  createCapabilityHub,
  satisfiesVersionRange,
} from "@linchkit/core";

// ── Test fixtures ──────────────────────────────────────────

function makeManifest(
  overrides: Partial<CapabilityManifest> & { name: string },
): CapabilityManifest {
  return {
    version: "1.0.0",
    type: "standard",
    category: "business",
    ...overrides,
  };
}

const authManifest = makeManifest({
  name: "cap-auth",
  version: "1.2.0",
  type: "standard",
  category: "system",
  label: "Authentication",
  description: "Core authentication module",
  provides: {
    services: ["auth-provider"],
    schemas: ["user", "session"],
  },
});

const permissionManifest = makeManifest({
  name: "cap-permission",
  version: "1.0.0",
  type: "standard",
  category: "system",
  label: "Permission",
  description: "RBAC permission engine",
  dependencies: [{ name: "cap-auth", versionRange: "^1.0.0" }],
  requires: {
    services: ["auth-provider"],
  },
  provides: {
    services: ["permission-engine"],
  },
});

const mcpManifest = makeManifest({
  name: "cap-adapter-mcp",
  version: "0.5.0",
  type: "adapter",
  category: "integration",
  label: "MCP Adapter",
  description: "Model Context Protocol transport",
  provides: {
    services: ["mcp-transport"],
  },
});

const purchaseDemoManifest = makeManifest({
  name: "cap-purchase-demo",
  version: "0.1.0",
  type: "standard",
  category: "business",
  label: "Purchase Demo",
  description: "Purchase management demo",
  dependencies: [
    { name: "cap-auth", versionRange: "^1.0.0" },
    { name: "cap-permission", versionRange: "^1.0.0" },
  ],
  requires: {
    services: ["auth-provider", "permission-engine"],
    schemas: ["user"],
  },
  provides: {
    schemas: ["purchase_request", "department"],
    actions: ["submit_purchase", "approve_purchase"],
  },
});

// ── Tests ──────────────────────────────────────────────────

describe("CapabilityHub", () => {
  let hub: CapabilityHub;

  beforeEach(() => {
    hub = createCapabilityHub();
  });

  // ── Registration ───────────────────────────────────────

  describe("register", () => {
    it("should register a capability manifest", () => {
      hub.register(authManifest);
      expect(hub.has("cap-auth")).toBe(true);
      expect(hub.size).toBe(1);
    });

    it("should reject duplicate registration", () => {
      hub.register(authManifest);
      expect(() => hub.register(authManifest)).toThrow(CapabilityHubError);
      expect(() => hub.register(authManifest)).toThrow(/already registered/);
    });

    it("should register multiple capabilities", () => {
      hub.register(authManifest);
      hub.register(mcpManifest);
      expect(hub.size).toBe(2);
    });
  });

  // ── Retrieval ──────────────────────────────────────────

  describe("get / has / unregister", () => {
    it("should retrieve a manifest by name", () => {
      hub.register(authManifest);
      const result = hub.get("cap-auth");
      expect(result).toBeDefined();
      expect(result?.name).toBe("cap-auth");
      expect(result?.version).toBe("1.2.0");
    });

    it("should return undefined for unknown capability", () => {
      expect(hub.get("nonexistent")).toBeUndefined();
    });

    it("should unregister a capability", () => {
      hub.register(authManifest);
      expect(hub.unregister("cap-auth")).toBe(true);
      expect(hub.has("cap-auth")).toBe(false);
      expect(hub.size).toBe(0);
    });

    it("should return false when unregistering unknown capability", () => {
      expect(hub.unregister("nonexistent")).toBe(false);
    });
  });

  // ── List ───────────────────────────────────────────────

  describe("list", () => {
    it("should return all registered manifests", () => {
      hub.register(authManifest);
      hub.register(mcpManifest);
      const list = hub.list();
      expect(list).toHaveLength(2);
      expect(list.map((m) => m.name).sort()).toEqual(["cap-adapter-mcp", "cap-auth"]);
    });

    it("should return empty array when no capabilities registered", () => {
      expect(hub.list()).toEqual([]);
    });
  });

  // ── Search ─────────────────────────────────────────────

  describe("search", () => {
    beforeEach(() => {
      hub.register(authManifest);
      hub.register(permissionManifest);
      hub.register(mcpManifest);
      hub.register(purchaseDemoManifest);
    });

    it("should filter by type", () => {
      const adapters = hub.search({ type: "adapter" });
      expect(adapters).toHaveLength(1);
      expect(adapters[0]?.name).toBe("cap-adapter-mcp");
    });

    it("should filter by category", () => {
      const system = hub.search({ category: "system" });
      expect(system).toHaveLength(2);
      expect(system.map((m) => m.name).sort()).toEqual(["cap-auth", "cap-permission"]);
    });

    it("should search by keyword in name", () => {
      const results = hub.search({ query: "purchase" });
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("cap-purchase-demo");
    });

    it("should search by keyword in label", () => {
      const results = hub.search({ query: "Authentication" });
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("cap-auth");
    });

    it("should search by keyword in description", () => {
      const results = hub.search({ query: "RBAC" });
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("cap-permission");
    });

    it("should combine filters", () => {
      const results = hub.search({ type: "standard", category: "system" });
      expect(results).toHaveLength(2);
    });

    it("should combine type + query filters", () => {
      const results = hub.search({ type: "standard", query: "auth" });
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("cap-auth");
    });

    it("should be case-insensitive for query", () => {
      const results = hub.search({ query: "MCP" });
      expect(results).toHaveLength(1);
    });

    it("should return empty for no matches", () => {
      const results = hub.search({ query: "nonexistent" });
      expect(results).toEqual([]);
    });
  });

  // ── Dependency resolution ──────────────────────────────

  describe("resolveDependencyOrder", () => {
    it("should return correct initialization order for linear deps", () => {
      hub.register(authManifest);
      hub.register(permissionManifest);
      const order = hub.resolveDependencyOrder();
      const authIdx = order.indexOf("cap-auth");
      const permIdx = order.indexOf("cap-permission");
      expect(authIdx).toBeLessThan(permIdx);
    });

    it("should return correct order for diamond deps", () => {
      hub.register(authManifest);
      hub.register(permissionManifest);
      hub.register(mcpManifest);
      hub.register(purchaseDemoManifest);

      const order = hub.resolveDependencyOrder();
      expect(order.indexOf("cap-auth")).toBeLessThan(order.indexOf("cap-permission"));
      expect(order.indexOf("cap-auth")).toBeLessThan(order.indexOf("cap-purchase-demo"));
      expect(order.indexOf("cap-permission")).toBeLessThan(order.indexOf("cap-purchase-demo"));
    });

    it("should handle capabilities with no dependencies", () => {
      hub.register(mcpManifest);
      hub.register(authManifest);
      const order = hub.resolveDependencyOrder();
      expect(order).toHaveLength(2);
      // Both have no deps, so alphabetical
      expect(order).toEqual(["cap-adapter-mcp", "cap-auth"]);
    });

    it("should throw on unresolved required dependency", () => {
      hub.register(permissionManifest); // depends on cap-auth which is not registered
      expect(() => hub.resolveDependencyOrder()).toThrow(CapabilityHubError);
      expect(() => hub.resolveDependencyOrder()).toThrow(/cap-auth/);
    });

    it("should skip optional unresolved dependencies", () => {
      const withOptional = makeManifest({
        name: "cap-optional-user",
        dependencies: [{ name: "cap-analytics", optional: true }],
      });
      hub.register(withOptional);
      const order = hub.resolveDependencyOrder();
      expect(order).toEqual(["cap-optional-user"]);
    });

    it("should throw on circular dependency", () => {
      const a = makeManifest({
        name: "cap-a",
        dependencies: [{ name: "cap-b" }],
      });
      const b = makeManifest({
        name: "cap-b",
        dependencies: [{ name: "cap-a" }],
      });
      hub.register(a);
      hub.register(b);
      expect(() => hub.resolveDependencyOrder()).toThrow(CapabilityHubError);
      expect(() => hub.resolveDependencyOrder()).toThrow(/Circular dependency/);
    });

    it("should throw on transitive circular dependency", () => {
      const a = makeManifest({ name: "cap-a", dependencies: [{ name: "cap-b" }] });
      const b = makeManifest({ name: "cap-b", dependencies: [{ name: "cap-c" }] });
      const c = makeManifest({ name: "cap-c", dependencies: [{ name: "cap-a" }] });
      hub.register(a);
      hub.register(b);
      hub.register(c);
      expect(() => hub.resolveDependencyOrder()).toThrow(/Circular dependency/);
    });

    it("should throw on version mismatch", () => {
      hub.register(authManifest); // version 1.2.0
      const strict = makeManifest({
        name: "cap-strict",
        dependencies: [{ name: "cap-auth", versionRange: "^2.0.0" }],
      });
      hub.register(strict);
      expect(() => hub.resolveDependencyOrder()).toThrow(CapabilityHubError);
      expect(() => hub.resolveDependencyOrder()).toThrow(/version/i);
    });

    it("should return single item for lone capability", () => {
      hub.register(mcpManifest);
      expect(hub.resolveDependencyOrder()).toEqual(["cap-adapter-mcp"]);
    });

    it("should return empty array when no capabilities registered", () => {
      expect(hub.resolveDependencyOrder()).toEqual([]);
    });
  });

  // ── Validation ─────────────────────────────────────────

  describe("validate", () => {
    it("should report valid when all deps satisfied", () => {
      hub.register(authManifest);
      hub.register(permissionManifest);
      hub.register(mcpManifest);
      hub.register(purchaseDemoManifest);

      const result = hub.validate();
      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it("should report missing required dependency", () => {
      hub.register(permissionManifest); // needs cap-auth
      const result = hub.validate();
      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(2); // missing dep + missing service
      expect(result.issues.some((i) => i.type === "missing_dependency")).toBe(true);
    });

    it("should report version mismatch", () => {
      hub.register(makeManifest({ name: "cap-auth", version: "0.5.0" }));
      hub.register(permissionManifest); // needs ^1.0.0
      const result = hub.validate();
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.type === "version_mismatch")).toBe(true);
    });

    it("should report missing required service", () => {
      // Register auth without providing auth-provider service
      hub.register(makeManifest({ name: "cap-auth", version: "1.0.0" }));
      hub.register(permissionManifest); // requires auth-provider service
      const result = hub.validate();
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.type === "missing_service")).toBe(true);
    });

    it("should report missing required schema", () => {
      hub.register(authManifest);
      hub.register(permissionManifest);
      // purchase-demo requires "user" schema — auth provides it, so valid
      hub.register(purchaseDemoManifest);
      const result = hub.validate();
      expect(result.valid).toBe(true);
    });

    it("should report missing required schema when not provided", () => {
      const needsSchema = makeManifest({
        name: "cap-needs-schema",
        requires: { schemas: ["inventory"] },
      });
      hub.register(needsSchema);
      const result = hub.validate();
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.type === "missing_schema")).toBe(true);
    });

    it("should not report optional missing dependencies as issues", () => {
      const withOptional = makeManifest({
        name: "cap-optional-user",
        dependencies: [{ name: "cap-analytics", optional: true }],
      });
      hub.register(withOptional);
      const result = hub.validate();
      expect(result.valid).toBe(true);
    });

    it("should return valid for empty hub", () => {
      const result = hub.validate();
      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([]);
    });
  });

  // ── Dependency graph ───────────────────────────────────

  describe("dependencyGraph / dependentsOf", () => {
    beforeEach(() => {
      hub.register(authManifest);
      hub.register(permissionManifest);
      hub.register(mcpManifest);
      hub.register(purchaseDemoManifest);
    });

    it("should return correct adjacency list", () => {
      const graph = hub.dependencyGraph();
      expect(graph.get("cap-auth")).toEqual([]);
      expect(graph.get("cap-permission")).toEqual(["cap-auth"]);
      expect(graph.get("cap-adapter-mcp")).toEqual([]);
      expect(graph.get("cap-purchase-demo")?.sort()).toEqual(["cap-auth", "cap-permission"]);
    });

    it("should find dependents of a capability", () => {
      const dependents = hub.dependentsOf("cap-auth");
      expect(dependents.sort()).toEqual(["cap-permission", "cap-purchase-demo"]);
    });

    it("should return empty array for capability with no dependents", () => {
      expect(hub.dependentsOf("cap-purchase-demo")).toEqual([]);
    });
  });

  // ── Serialization ──────────────────────────────────────

  describe("toJSON", () => {
    it("should serialize to array of manifests", () => {
      hub.register(authManifest);
      hub.register(mcpManifest);
      const json = hub.toJSON();
      expect(Array.isArray(json)).toBe(true);
      expect(json).toHaveLength(2);
    });
  });
});

// ── satisfiesVersionRange ────────────────────────────────

describe("satisfiesVersionRange", () => {
  it("should match caret ranges", () => {
    expect(satisfiesVersionRange("1.2.3", "^1.0.0")).toBe(true);
    expect(satisfiesVersionRange("1.9.9", "^1.0.0")).toBe(true);
    expect(satisfiesVersionRange("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfiesVersionRange("0.9.9", "^1.0.0")).toBe(false);
    expect(satisfiesVersionRange("1.0.0", "^1.0.0")).toBe(true);
  });

  it("should match tilde ranges", () => {
    expect(satisfiesVersionRange("1.2.3", "~1.2.0")).toBe(true);
    expect(satisfiesVersionRange("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfiesVersionRange("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfiesVersionRange("1.1.9", "~1.2.0")).toBe(false);
  });

  it("should match >= ranges", () => {
    expect(satisfiesVersionRange("2.0.0", ">=1.0.0")).toBe(true);
    expect(satisfiesVersionRange("1.0.0", ">=1.0.0")).toBe(true);
    expect(satisfiesVersionRange("0.9.9", ">=1.0.0")).toBe(false);
  });

  it("should match <= ranges", () => {
    expect(satisfiesVersionRange("0.9.9", "<=1.0.0")).toBe(true);
    expect(satisfiesVersionRange("1.0.0", "<=1.0.0")).toBe(true);
    expect(satisfiesVersionRange("1.0.1", "<=1.0.0")).toBe(false);
  });

  it("should match exact versions", () => {
    expect(satisfiesVersionRange("1.0.0", "1.0.0")).toBe(true);
    expect(satisfiesVersionRange("1.0.0", "=1.0.0")).toBe(true);
    expect(satisfiesVersionRange("1.0.1", "1.0.0")).toBe(false);
  });

  it("should match bare > and < comparators", () => {
    expect(satisfiesVersionRange("1.0.1", ">1.0.0")).toBe(true);
    expect(satisfiesVersionRange("1.0.0", ">1.0.0")).toBe(false);
    expect(satisfiesVersionRange("0.9.9", "<1.0.0")).toBe(true);
    expect(satisfiesVersionRange("1.0.0", "<1.0.0")).toBe(false);
  });

  it("should match compound (AND) ranges joined by whitespace", () => {
    expect(satisfiesVersionRange("0.3.0", ">=0.2.0 <0.4.0")).toBe(true);
    expect(satisfiesVersionRange("0.2.0", ">=0.2.0 <0.4.0")).toBe(true);
    expect(satisfiesVersionRange("0.4.0", ">=0.2.0 <0.4.0")).toBe(false);
    expect(satisfiesVersionRange("0.1.9", ">=0.2.0 <0.4.0")).toBe(false);
  });

  it("should allow whitespace after a comparator operator", () => {
    // Regression guard: ">= 0.2.0" must not be split into [">=", "0.2.0"].
    expect(satisfiesVersionRange("0.3.0", ">= 0.2.0")).toBe(true);
    expect(satisfiesVersionRange("0.1.0", ">= 0.2.0")).toBe(false);
  });

  it("should match compound ranges with space after each operator", () => {
    expect(satisfiesVersionRange("0.3.0", ">= 0.2.0 < 0.4.0")).toBe(true);
    expect(satisfiesVersionRange("0.5.0", ">= 0.2.0 < 0.4.0")).toBe(false);
  });

  it("should match the * wildcard against any version", () => {
    expect(satisfiesVersionRange("9.9.9", "*")).toBe(true);
    expect(satisfiesVersionRange("0.0.1", "*")).toBe(true);
  });

  it("should fail an empty range", () => {
    expect(satisfiesVersionRange("1.0.0", "")).toBe(false);
    expect(satisfiesVersionRange("1.0.0", "   ")).toBe(false);
  });
});
