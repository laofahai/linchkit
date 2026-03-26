import { beforeEach, describe, expect, it } from "bun:test";
import type { RegistryEntry } from "@linchkit/core";
import {
  LocalCapabilityRegistry,
  checkTrustPermissions,
  createLocalRegistry,
} from "@linchkit/core";

// ── Fixtures ────────────────────────────────────────────

function makeEntry(
  overrides: Partial<RegistryEntry> & { name: string },
): RegistryEntry {
  return {
    version: "1.0.0",
    type: "standard",
    category: "business",
    trustLevel: "community",
    ...overrides,
  };
}

const authEntry = makeEntry({
  name: "@linchkit/cap-auth",
  version: "1.2.0",
  category: "system",
  trustLevel: "official",
  label: "Authentication",
  description: "Core authentication module",
});

const permEntry = makeEntry({
  name: "@linchkit/cap-permission",
  version: "1.0.0",
  category: "system",
  trustLevel: "official",
  label: "Permission",
  description: "RBAC permission engine",
  dependencies: ["@linchkit/cap-auth"],
});

const crmEntry = makeEntry({
  name: "linchkit-cap-crm",
  version: "0.5.0",
  category: "business",
  trustLevel: "community",
  label: "CRM",
  description: "Customer relationship management",
  dependencies: ["@linchkit/cap-auth"],
});

const unknownEntry = makeEntry({
  name: "some-random-cap",
  version: "0.1.0",
  trustLevel: "unverified",
  label: "Unknown Cap",
});

// ── Tests ───────────────────────────────────────────────

describe("LocalCapabilityRegistry", () => {
  let registry: LocalCapabilityRegistry;

  beforeEach(() => {
    registry = createLocalRegistry();
  });

  describe("register / get / has / unregister", () => {
    it("should register and retrieve an entry", () => {
      registry.register(authEntry);
      expect(registry.has("@linchkit/cap-auth")).toBe(true);
      expect(registry.get("@linchkit/cap-auth")?.version).toBe("1.2.0");
      expect(registry.size).toBe(1);
    });

    it("should overwrite on re-register (upsert)", () => {
      registry.register(authEntry);
      registry.register({ ...authEntry, version: "2.0.0" });
      expect(registry.get("@linchkit/cap-auth")?.version).toBe("2.0.0");
      expect(registry.size).toBe(1);
    });

    it("should return undefined for unknown entry", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });

    it("should unregister an entry", () => {
      registry.register(authEntry);
      expect(registry.unregister("@linchkit/cap-auth")).toBe(true);
      expect(registry.has("@linchkit/cap-auth")).toBe(false);
      expect(registry.size).toBe(0);
    });

    it("should return false when unregistering unknown", () => {
      expect(registry.unregister("nonexistent")).toBe(false);
    });
  });

  describe("list", () => {
    it("should list all entries", () => {
      registry.register(authEntry);
      registry.register(crmEntry);
      const list = registry.list();
      expect(list).toHaveLength(2);
    });

    it("should return empty for empty registry", () => {
      expect(registry.list()).toEqual([]);
    });
  });

  describe("search", () => {
    beforeEach(() => {
      registry.register(authEntry);
      registry.register(permEntry);
      registry.register(crmEntry);
      registry.register(unknownEntry);
    });

    it("should search by keyword in name", () => {
      const results = registry.search({ query: "crm" });
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("linchkit-cap-crm");
    });

    it("should search by keyword in description", () => {
      const results = registry.search({ query: "RBAC" });
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("@linchkit/cap-permission");
    });

    it("should filter by type", () => {
      const results = registry.search({ type: "standard" });
      expect(results).toHaveLength(4);
    });

    it("should filter by category", () => {
      const results = registry.search({ category: "system" });
      expect(results).toHaveLength(2);
    });

    it("should filter by trust level", () => {
      const results = registry.search({ trustLevel: "official" });
      expect(results).toHaveLength(2);
    });

    it("should combine filters", () => {
      const results = registry.search({ trustLevel: "community", query: "crm" });
      expect(results).toHaveLength(1);
    });

    it("should return empty for no matches", () => {
      const results = registry.search({ query: "nonexistent" });
      expect(results).toEqual([]);
    });
  });

  describe("dependency protection", () => {
    beforeEach(() => {
      registry.register(authEntry);
      registry.register(permEntry);
      registry.register(crmEntry);
    });

    it("should find dependents of a capability", () => {
      const dependents = registry.dependentsOf("@linchkit/cap-auth");
      expect(dependents.sort()).toEqual(["@linchkit/cap-permission", "linchkit-cap-crm"]);
    });

    it("should return empty for capability with no dependents", () => {
      expect(registry.dependentsOf("linchkit-cap-crm")).toEqual([]);
    });

    it("should report unsafe to uninstall when dependents exist", () => {
      const result = registry.canUninstall("@linchkit/cap-auth");
      expect(result.safe).toBe(false);
      expect(result.dependents).toHaveLength(2);
    });

    it("should report safe to uninstall when no dependents", () => {
      const result = registry.canUninstall("linchkit-cap-crm");
      expect(result.safe).toBe(true);
      expect(result.dependents).toEqual([]);
    });
  });

  describe("serialization", () => {
    it("should serialize to JSON array", () => {
      registry.register(authEntry);
      registry.register(crmEntry);
      const json = registry.toJSON();
      expect(Array.isArray(json)).toBe(true);
      expect(json).toHaveLength(2);
    });

    it("should deserialize from JSON array", () => {
      const data = [authEntry, crmEntry];
      const loaded = LocalCapabilityRegistry.fromJSON(data);
      expect(loaded.size).toBe(2);
      expect(loaded.has("@linchkit/cap-auth")).toBe(true);
      expect(loaded.has("linchkit-cap-crm")).toBe(true);
    });

    it("should handle invalid JSON data gracefully", () => {
      const loaded = LocalCapabilityRegistry.fromJSON("not an array");
      expect(loaded.size).toBe(0);
    });

    it("should skip invalid entries in array", () => {
      const data = [authEntry, { invalid: true }, null, crmEntry];
      const loaded = LocalCapabilityRegistry.fromJSON(data);
      expect(loaded.size).toBe(2);
    });

    it("should roundtrip correctly", () => {
      registry.register(authEntry);
      registry.register(permEntry);
      const json = registry.toJSON();
      const loaded = LocalCapabilityRegistry.fromJSON(json);
      expect(loaded.size).toBe(2);
      expect(loaded.get("@linchkit/cap-auth")?.version).toBe("1.2.0");
      expect(loaded.get("@linchkit/cap-permission")?.dependencies).toEqual([
        "@linchkit/cap-auth",
      ]);
    });
  });

  describe("constructor with initial entries", () => {
    it("should accept initial entries", () => {
      const r = new LocalCapabilityRegistry([authEntry, crmEntry]);
      expect(r.size).toBe(2);
    });
  });
});

describe("checkTrustPermissions", () => {
  it("should allow all permissions for official", () => {
    const result = checkTrustPermissions("official", [
      "database.create_table",
      "system.exec",
    ]);
    expect(result.allowed).toBe(true);
    expect(result.denied).toEqual([]);
  });

  it("should allow all permissions for verified", () => {
    const result = checkTrustPermissions("verified", ["database.create_table"]);
    expect(result.allowed).toBe(true);
  });

  it("should allow limited permissions for community", () => {
    const result = checkTrustPermissions("community", [
      "database.create_table",
      "database.create_index",
    ]);
    expect(result.allowed).toBe(true);
  });

  it("should deny non-allowed permissions for community", () => {
    const result = checkTrustPermissions("community", [
      "database.create_table",
      "system.exec",
    ]);
    expect(result.allowed).toBe(false);
    expect(result.denied).toEqual(["system.exec"]);
  });

  it("should deny all permissions for unverified", () => {
    const result = checkTrustPermissions("unverified", ["database.create_table"]);
    expect(result.allowed).toBe(false);
    expect(result.denied).toEqual(["database.create_table"]);
  });

  it("should allow empty permissions for any trust level", () => {
    expect(checkTrustPermissions("unverified", []).allowed).toBe(true);
    expect(checkTrustPermissions("community", []).allowed).toBe(true);
  });
});

describe("createLocalRegistry", () => {
  it("should create empty registry", () => {
    const r = createLocalRegistry();
    expect(r.size).toBe(0);
  });

  it("should create registry with initial entries", () => {
    const r = createLocalRegistry([authEntry]);
    expect(r.size).toBe(1);
  });
});
