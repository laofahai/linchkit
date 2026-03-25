import { beforeEach, describe, expect, it } from "bun:test";
import type { SchemaDefinition } from "@linchkit/core";
import {
  analyzeCompatibility,
  applyMigration,
  classifyRelease,
  compareSemVer,
  createVersionRegistry,
  formatSemVer,
  getBreakingChanges,
  isCompatible,
  MigrationRegistry,
  parseSemVer,
  type SchemaMigration,
  type VersionRegistry,
  validateUpgrade,
} from "@linchkit/core";

// ── SemVer parsing ─────────────────────────────────────────

describe("parseSemVer", () => {
  it("parses a standard semver string", () => {
    const v = parseSemVer("1.2.3");
    expect(v).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("parses semver with prerelease", () => {
    const v = parseSemVer("1.0.0-beta.1");
    expect(v).toEqual({ major: 1, minor: 0, patch: 0, prerelease: "beta.1" });
  });

  it("throws on invalid format", () => {
    expect(() => parseSemVer("not-a-version")).toThrow("Invalid semver");
    expect(() => parseSemVer("1.2")).toThrow("Invalid semver");
    expect(() => parseSemVer("")).toThrow("Invalid semver");
  });
});

describe("formatSemVer", () => {
  it("formats version without prerelease", () => {
    expect(formatSemVer({ major: 2, minor: 1, patch: 0 })).toBe("2.1.0");
  });

  it("formats version with prerelease", () => {
    expect(formatSemVer({ major: 1, minor: 0, patch: 0, prerelease: "rc.1" })).toBe("1.0.0-rc.1");
  });
});

describe("compareSemVer", () => {
  it("returns 0 for equal versions", () => {
    expect(compareSemVer(parseSemVer("1.2.3"), parseSemVer("1.2.3"))).toBe(0);
  });

  it("compares major versions", () => {
    expect(compareSemVer(parseSemVer("2.0.0"), parseSemVer("1.0.0"))).toBeGreaterThan(0);
    expect(compareSemVer(parseSemVer("1.0.0"), parseSemVer("2.0.0"))).toBeLessThan(0);
  });

  it("compares minor versions", () => {
    expect(compareSemVer(parseSemVer("1.3.0"), parseSemVer("1.2.0"))).toBeGreaterThan(0);
  });

  it("compares patch versions", () => {
    expect(compareSemVer(parseSemVer("1.2.4"), parseSemVer("1.2.3"))).toBeGreaterThan(0);
  });

  it("prerelease is lower than release", () => {
    expect(compareSemVer(parseSemVer("1.0.0-alpha"), parseSemVer("1.0.0"))).toBeLessThan(0);
  });
});

// ── Compatibility checking ─────────────────────────────────

describe("isCompatible", () => {
  it("returns true for exact version match", () => {
    expect(isCompatible("1.2.3", "1.2.3")).toBe(true);
  });

  it("returns true when available has higher patch", () => {
    expect(isCompatible("1.2.0", "1.2.5")).toBe(true);
  });

  it("returns true when available has higher minor", () => {
    expect(isCompatible("1.2.0", "1.3.0")).toBe(true);
  });

  it("returns false for different major versions", () => {
    expect(isCompatible("1.0.0", "2.0.0")).toBe(false);
    expect(isCompatible("2.0.0", "1.9.9")).toBe(false);
  });

  it("returns false when available minor is lower", () => {
    expect(isCompatible("1.3.0", "1.2.0")).toBe(false);
  });

  it("returns false when available patch is lower (same minor)", () => {
    expect(isCompatible("1.2.5", "1.2.3")).toBe(false);
  });

  // Pre-1.0 semver: minor = breaking
  it("treats minor bump as breaking in 0.x", () => {
    expect(isCompatible("0.2.0", "0.3.0")).toBe(false);
    expect(isCompatible("0.3.0", "0.2.0")).toBe(false);
  });

  it("allows patch bumps in 0.x", () => {
    expect(isCompatible("0.2.0", "0.2.1")).toBe(true);
  });
});

// ── Breaking change detection ──────────────────────────────

describe("getBreakingChanges", () => {
  const baseSchema: SchemaDefinition = {
    name: "order",
    fields: {
      title: { type: "string" },
      amount: { type: "number" },
      status: { type: "string" },
    },
  };

  it("returns empty array when schemas are identical", () => {
    const changes = getBreakingChanges(baseSchema, baseSchema);
    expect(changes).toEqual([]);
  });

  it("detects field removal", () => {
    const newSchema: SchemaDefinition = {
      name: "order",
      fields: {
        title: { type: "string" },
        amount: { type: "number" },
        // status removed
      },
    };
    const changes = getBreakingChanges(baseSchema, newSchema);
    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe("field_removed");
    expect(changes[0].field).toBe("status");
    expect(changes[0].releaseType).toBe("contract");
  });

  it("detects field type change", () => {
    const newSchema: SchemaDefinition = {
      name: "order",
      fields: {
        title: { type: "string" },
        amount: { type: "string" }, // was number
        status: { type: "string" },
      },
    };
    const changes = getBreakingChanges(baseSchema, newSchema);
    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe("field_type_changed");
    expect(changes[0].field).toBe("amount");
    expect(changes[0].releaseType).toBe("breaking");
  });

  it("detects new required field without default", () => {
    const newSchema: SchemaDefinition = {
      name: "order",
      fields: {
        ...baseSchema.fields,
        priority: { type: "number", required: true },
      },
    };
    const changes = getBreakingChanges(baseSchema, newSchema);
    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe("field_required_added");
    expect(changes[0].field).toBe("priority");
    expect(changes[0].releaseType).toBe("contract");
  });

  it("does not flag new optional field", () => {
    const newSchema: SchemaDefinition = {
      name: "order",
      fields: {
        ...baseSchema.fields,
        notes: { type: "text" },
      },
    };
    const changes = getBreakingChanges(baseSchema, newSchema);
    expect(changes).toEqual([]);
  });

  it("does not flag new required field with default", () => {
    const newSchema: SchemaDefinition = {
      name: "order",
      fields: {
        ...baseSchema.fields,
        priority: { type: "number", required: true, default: 0 },
      },
    };
    const changes = getBreakingChanges(baseSchema, newSchema);
    expect(changes).toEqual([]);
  });
});

// ── Release classification ─────────────────────────────────

describe("classifyRelease", () => {
  const baseSchema: SchemaDefinition = {
    name: "order",
    fields: {
      title: { type: "string" },
      amount: { type: "number" },
    },
  };

  it("returns safe when no changes", () => {
    expect(classifyRelease(baseSchema, baseSchema)).toBe("safe");
  });

  it("returns expand when only new optional fields", () => {
    const newSchema: SchemaDefinition = {
      name: "order",
      fields: { ...baseSchema.fields, notes: { type: "text" } },
    };
    expect(classifyRelease(baseSchema, newSchema)).toBe("expand");
  });

  it("returns contract when field removed", () => {
    const newSchema: SchemaDefinition = {
      name: "order",
      fields: { title: { type: "string" } },
    };
    expect(classifyRelease(baseSchema, newSchema)).toBe("contract");
  });

  it("returns breaking when field type changed", () => {
    const newSchema: SchemaDefinition = {
      name: "order",
      fields: {
        title: { type: "number" }, // changed from string
        amount: { type: "number" },
      },
    };
    expect(classifyRelease(baseSchema, newSchema)).toBe("breaking");
  });
});

// ── analyzeCompatibility ───────────────────────────────────

describe("analyzeCompatibility", () => {
  const oldSchema: SchemaDefinition = {
    name: "order",
    fields: {
      title: { type: "string" },
      amount: { type: "number" },
    },
  };

  it("returns safe result for identical schemas", () => {
    const result = analyzeCompatibility(oldSchema, oldSchema);
    expect(result.releaseType).toBe("safe");
    expect(result.oldVersionCanRead).toBe(true);
    expect(result.oldVersionCanWrite).toBe(true);
    expect(result.rollbackMode).toBe("traffic_only");
    expect(result.blockers).toEqual([]);
  });

  it("returns expand result for new optional fields", () => {
    const newSchema: SchemaDefinition = {
      name: "order",
      fields: { ...oldSchema.fields, notes: { type: "text" } },
    };
    const result = analyzeCompatibility(oldSchema, newSchema);
    expect(result.releaseType).toBe("expand");
    expect(result.rollbackMode).toBe("traffic_only");
    expect(result.blockers).toHaveLength(0);
  });

  it("includes blockers for breaking changes", () => {
    const newSchema: SchemaDefinition = {
      name: "order",
      fields: {
        title: { type: "number" },
        amount: { type: "number" },
      },
    };
    const result = analyzeCompatibility(oldSchema, newSchema);
    expect(result.releaseType).toBe("breaking");
    expect(result.rollbackMode).toBe("manual");
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.blockers[0]).toContain("Breaking changes");
  });

  it("includes tenant override blockers", () => {
    const result = analyzeCompatibility(oldSchema, oldSchema, [
      { tenantId: "t1", target: "order.title", status: "valid" },
      { tenantId: "t2", target: "order.removed_field", status: "invalid" },
    ]);
    expect(result.blockers.some((b) => b.includes("t2"))).toBe(true);
  });

  it("flags requiresDualWrite for contract changes", () => {
    const newSchema: SchemaDefinition = {
      name: "order",
      fields: { title: { type: "string" } }, // amount removed
    };
    const result = analyzeCompatibility(oldSchema, newSchema);
    expect(result.releaseType).toBe("contract");
    expect(result.requiresDualWrite).toBe(true);
    expect(result.rollbackMode).toBe("version_only");
  });
});

// ── Migration Registry ─────────────────────────────────────

describe("MigrationRegistry", () => {
  let registry: MigrationRegistry;

  beforeEach(() => {
    registry = new MigrationRegistry();
  });

  const migrationV1toV2: SchemaMigration = {
    schemaName: "order",
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    up: (data) => ({ ...data, priority: data.priority ?? "normal" }),
    down: (data) => {
      const { priority: _, ...rest } = data;
      return rest;
    },
    description: "Add priority field with default",
  };

  const migrationV2toV3: SchemaMigration = {
    schemaName: "order",
    fromVersion: "2.0.0",
    toVersion: "3.0.0",
    up: (data) => ({ ...data, amount_cents: (data.amount as number) * 100 }),
    down: (data) => {
      const { amount_cents: _, ...rest } = data;
      return rest;
    },
    description: "Add amount_cents derived field",
  };

  it("registers and retrieves a migration", () => {
    registry.register(migrationV1toV2);
    const m = registry.get("order", "1.0.0", "2.0.0");
    expect(m).not.toBeNull();
    expect(m?.description).toBe("Add priority field with default");
  });

  it("returns null for unregistered migration", () => {
    expect(registry.get("order", "1.0.0", "2.0.0")).toBeNull();
  });

  it("throws on duplicate registration", () => {
    registry.register(migrationV1toV2);
    expect(() => registry.register(migrationV1toV2)).toThrow("already registered");
  });

  it("throws on invalid semver", () => {
    expect(() =>
      registry.register({
        ...migrationV1toV2,
        fromVersion: "bad",
      }),
    ).toThrow("Invalid semver");
  });

  it("lists migrations for a schema", () => {
    registry.register(migrationV1toV2);
    registry.register(migrationV2toV3);
    const list = registry.list("order");
    expect(list).toHaveLength(2);
  });

  it("returns empty list for unknown schema", () => {
    expect(registry.list("unknown")).toEqual([]);
  });

  describe("findPath", () => {
    it("finds direct upgrade path", () => {
      registry.register(migrationV1toV2);
      const path = registry.findPath("order", "1.0.0", "2.0.0");
      expect(path).toEqual(["1.0.0", "2.0.0"]);
    });

    it("finds multi-step upgrade path", () => {
      registry.register(migrationV1toV2);
      registry.register(migrationV2toV3);
      const path = registry.findPath("order", "1.0.0", "3.0.0");
      expect(path).toEqual(["1.0.0", "2.0.0", "3.0.0"]);
    });

    it("finds downgrade path when down functions exist", () => {
      registry.register(migrationV1toV2);
      const path = registry.findPath("order", "2.0.0", "1.0.0");
      expect(path).toEqual(["2.0.0", "1.0.0"]);
    });

    it("returns null when no path exists", () => {
      registry.register(migrationV1toV2);
      expect(registry.findPath("order", "1.0.0", "5.0.0")).toBeNull();
    });

    it("returns identity path for same version", () => {
      expect(registry.findPath("order", "1.0.0", "1.0.0")).toEqual(["1.0.0"]);
    });

    it("returns null for downgrade without down function", () => {
      const noDown: SchemaMigration = {
        schemaName: "order",
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        up: (data) => data,
        // no down
      };
      registry.register(noDown);
      expect(registry.findPath("order", "2.0.0", "1.0.0")).toBeNull();
    });
  });
});

// ── applyMigration ─────────────────────────────────────────

describe("applyMigration", () => {
  let registry: MigrationRegistry;

  beforeEach(() => {
    registry = new MigrationRegistry();

    registry.register({
      schemaName: "order",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      up: (data) => ({ ...data, priority: "normal" }),
      down: (data) => {
        const { priority: _, ...rest } = data;
        return rest;
      },
    });

    registry.register({
      schemaName: "order",
      fromVersion: "1.1.0",
      toVersion: "1.2.0",
      up: (data) => ({
        ...data,
        display_name: `Order: ${data.title}`,
      }),
      down: (data) => {
        const { display_name: _, ...rest } = data;
        return rest;
      },
    });
  });

  it("applies single-step upgrade", () => {
    const result = applyMigration(registry, "order", { title: "A", amount: 10 }, "1.0.0", "1.1.0");
    expect(result.data).toEqual({ title: "A", amount: 10, priority: "normal" });
    expect(result.stepsApplied).toBe(1);
    expect(result.path).toEqual(["1.0.0", "1.1.0"]);
  });

  it("applies multi-step upgrade", () => {
    const result = applyMigration(registry, "order", { title: "B", amount: 20 }, "1.0.0", "1.2.0");
    expect(result.data).toEqual({
      title: "B",
      amount: 20,
      priority: "normal",
      display_name: "Order: B",
    });
    expect(result.stepsApplied).toBe(2);
    expect(result.path).toEqual(["1.0.0", "1.1.0", "1.2.0"]);
  });

  it("applies downgrade", () => {
    const result = applyMigration(
      registry,
      "order",
      { title: "C", amount: 30, priority: "high" },
      "1.1.0",
      "1.0.0",
    );
    expect(result.data).toEqual({ title: "C", amount: 30 });
    expect(result.stepsApplied).toBe(1);
  });

  it("returns identity for same version", () => {
    const data = { title: "X", amount: 5 };
    const result = applyMigration(registry, "order", data, "1.0.0", "1.0.0");
    expect(result.data).toEqual(data);
    expect(result.stepsApplied).toBe(0);
  });

  it("throws when no migration path exists", () => {
    expect(() => applyMigration(registry, "order", { title: "X" }, "1.0.0", "5.0.0")).toThrow(
      "No migration path",
    );
  });

  it("throws for unknown schema", () => {
    expect(() => applyMigration(registry, "unknown", {}, "1.0.0", "2.0.0")).toThrow(
      "No migration path",
    );
  });
});

// ── validateUpgrade ────────────────────────────────────────

describe("validateUpgrade", () => {
  let registry: MigrationRegistry;

  beforeEach(() => {
    registry = new MigrationRegistry();
    registry.register({
      schemaName: "product",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      up: (d) => d,
      down: (d) => d,
    });
    registry.register({
      schemaName: "product",
      fromVersion: "1.1.0",
      toVersion: "2.0.0",
      up: (d) => d,
    });
  });

  it("validates successful upgrade path", () => {
    const result = validateUpgrade(registry, "product", "1.0.0", "2.0.0");
    expect(result.valid).toBe(true);
    expect(result.path).toEqual(["1.0.0", "1.1.0", "2.0.0"]);
  });

  it("rejects missing path", () => {
    const result = validateUpgrade(registry, "product", "1.0.0", "5.0.0");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("No migration path");
  });

  it("rejects downgrade without down function", () => {
    // 1.1.0 → 2.0.0 has no down, so 2.0.0 → 1.1.0 should fail
    const result = validateUpgrade(registry, "product", "2.0.0", "1.1.0");
    expect(result.valid).toBe(false);
  });

  it("validates downgrade when down functions exist", () => {
    const result = validateUpgrade(registry, "product", "1.1.0", "1.0.0");
    expect(result.valid).toBe(true);
    expect(result.path).toEqual(["1.1.0", "1.0.0"]);
  });
});

// ── Version Registry ───────────────────────────────────────

describe("VersionRegistry", () => {
  let registry: VersionRegistry;

  beforeEach(() => {
    registry = createVersionRegistry();
  });

  it("registers and retrieves a version entry", () => {
    registry.register({
      name: "order",
      type: "schema",
      version: "1.2.0",
      description: "Order schema v1.2",
    });
    const entry = registry.get("schema", "order");
    expect(entry).not.toBeNull();
    expect(entry?.version).toBe("1.2.0");
    expect(entry?.updatedAt).toBeInstanceOf(Date);
  });

  it("returns null for unregistered entry", () => {
    expect(registry.get("schema", "nonexistent")).toBeNull();
  });

  it("has() returns correct boolean", () => {
    registry.register({ name: "api-v1", type: "api", version: "1.0.0" });
    expect(registry.has("api", "api-v1")).toBe(true);
    expect(registry.has("api", "api-v2")).toBe(false);
  });

  it("updates version on re-register", () => {
    registry.register({ name: "cap-auth", type: "capability", version: "1.0.0" });
    registry.register({ name: "cap-auth", type: "capability", version: "1.1.0" });
    expect(registry.currentVersion("capability", "cap-auth")).toBe("1.1.0");
  });

  it("removes an entry", () => {
    registry.register({ name: "old-api", type: "api", version: "1.0.0" });
    expect(registry.remove("api", "old-api")).toBe(true);
    expect(registry.has("api", "old-api")).toBe(false);
    expect(registry.remove("api", "old-api")).toBe(false);
  });

  it("throws on invalid semver", () => {
    expect(() => registry.register({ name: "bad", type: "schema", version: "not-semver" })).toThrow(
      "Invalid semver",
    );
  });

  describe("list", () => {
    beforeEach(() => {
      registry.register({ name: "order", type: "schema", version: "1.0.0" });
      registry.register({ name: "product", type: "schema", version: "2.0.0" });
      registry.register({ name: "rest-v1", type: "api", version: "1.0.0" });
      registry.register({
        name: "cap-mcp",
        type: "capability",
        version: "1.0.0",
        deprecatedAt: "1.0.0",
      });
    });

    it("lists all entries without filter", () => {
      expect(registry.list()).toHaveLength(4);
    });

    it("filters by type", () => {
      const schemas = registry.list({ type: "schema" });
      expect(schemas).toHaveLength(2);
      expect(schemas.every((e) => e.type === "schema")).toBe(true);
    });

    it("filters by name prefix", () => {
      const caps = registry.list({ namePrefix: "cap-" });
      expect(caps).toHaveLength(1);
      expect(caps[0].name).toBe("cap-mcp");
    });

    it("excludes deprecated when requested", () => {
      const active = registry.list({ includeDeprecated: false });
      expect(active).toHaveLength(3);
      expect(active.every((e) => !e.deprecatedAt)).toBe(true);
    });
  });

  describe("checkCompatibility", () => {
    beforeEach(() => {
      registry.register({ name: "order", type: "schema", version: "1.5.0" });
      registry.register({
        name: "core-api",
        type: "api",
        version: "2.3.0",
        minCompatible: "2.1.0",
      });
    });

    it("returns compatible for satisfying version", () => {
      const result = registry.checkCompatibility("schema", "order", "1.3.0");
      expect(result.compatible).toBe(true);
    });

    it("returns incompatible for different major", () => {
      const result = registry.checkCompatibility("schema", "order", "2.0.0");
      expect(result.compatible).toBe(false);
    });

    it("returns incompatible for unregistered entity", () => {
      const result = registry.checkCompatibility("schema", "missing", "1.0.0");
      expect(result.compatible).toBe(false);
      expect(result.reason).toContain("not registered");
    });

    it("enforces minCompatible constraint", () => {
      const result = registry.checkCompatibility("api", "core-api", "2.0.0");
      expect(result.compatible).toBe(false);
      expect(result.reason).toContain("minimum compatible");
    });

    it("passes when above minCompatible", () => {
      const result = registry.checkCompatibility("api", "core-api", "2.2.0");
      expect(result.compatible).toBe(true);
    });
  });

  describe("checkMultiple", () => {
    it("batch checks multiple requirements", () => {
      registry.register({ name: "order", type: "schema", version: "1.5.0" });
      registry.register({ name: "product", type: "schema", version: "2.0.0" });

      const results = registry.checkMultiple([
        { type: "schema", name: "order", version: "1.3.0" },
        { type: "schema", name: "product", version: "3.0.0" },
        { type: "schema", name: "missing", version: "1.0.0" },
      ]);

      expect(results).toHaveLength(3);
      expect(results[0].compatible).toBe(true);
      expect(results[1].compatible).toBe(false);
      expect(results[2].compatible).toBe(false);
    });
  });

  describe("deprecate", () => {
    it("marks an entity as deprecated", () => {
      registry.register({ name: "old-cap", type: "capability", version: "1.0.0" });
      registry.deprecate("capability", "old-cap", "1.0.0");
      const entry = registry.get("capability", "old-cap");
      expect(entry?.deprecatedAt).toBe("1.0.0");
    });

    it("throws for unregistered entity", () => {
      expect(() => registry.deprecate("schema", "nope", "1.0.0")).toThrow("unregistered");
    });

    it("throws for invalid deprecation version", () => {
      registry.register({ name: "x", type: "api", version: "1.0.0" });
      expect(() => registry.deprecate("api", "x", "bad")).toThrow("Invalid semver");
    });
  });
});
