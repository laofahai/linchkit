import { describe, expect, it } from "bun:test";
import type { PgTable } from "drizzle-orm/pg-core";
import { generateDrizzleTable } from "../src/entity/entity-to-drizzle";
import { TableRegistry } from "../src/persistence/table-registry";
import type { EntityDefinition } from "../src/types/entity";

// ── Fixtures ─────────────────────────────────────────────

function makeEntity(name: string, extra: Partial<EntityDefinition> = {}): EntityDefinition {
  return {
    name,
    fields: {
      title: { type: "string", required: false },
    },
    ...extra,
  };
}

function makeTable(schema: EntityDefinition): PgTable {
  return generateDrizzleTable(schema);
}

// ── TableRegistry ─────────────────────────────────────────

describe("TableRegistry", () => {
  describe("register / getTable / has", () => {
    it("registers a table and retrieves it", () => {
      const registry = new TableRegistry();
      const schema = makeEntity("order");
      const table = makeTable(schema);
      registry.register("order", table);
      expect(registry.has("order")).toBe(true);
      expect(registry.getTable("order")).toBe(table);
    });

    it("returns undefined for unregistered schema", () => {
      const registry = new TableRegistry();
      expect(registry.getTable("nonexistent")).toBeUndefined();
    });

    it("has() returns false for unregistered schema", () => {
      const registry = new TableRegistry();
      expect(registry.has("nonexistent")).toBe(false);
    });
  });

  describe("getRegisteredSchemas", () => {
    it("returns empty array when nothing is registered", () => {
      const registry = new TableRegistry();
      expect(registry.getRegisteredSchemas()).toHaveLength(0);
    });

    it("returns all registered schema names", () => {
      const registry = new TableRegistry();
      registry.register("order", makeTable(makeEntity("order")));
      registry.register("product", makeTable(makeEntity("product")));
      const names = registry.getRegisteredSchemas();
      expect(names).toContain("order");
      expect(names).toContain("product");
      expect(names).toHaveLength(2);
    });
  });

  describe("buildFromEntityRegistry", () => {
    it("generates and registers tables from schema map", () => {
      const registry = new TableRegistry();
      const schemas = new Map<string, EntityDefinition>([
        ["order", makeEntity("order")],
        ["product", makeEntity("product")],
      ]);
      registry.buildFromEntityRegistry(schemas);
      expect(registry.has("order")).toBe(true);
      expect(registry.has("product")).toBe(true);
    });

    it("skips schemas that already have a manually registered table (no collision override)", () => {
      const registry = new TableRegistry();
      const schema = makeEntity("order");
      const manualTable = makeTable(schema);
      registry.register("order", manualTable);

      const schemas = new Map<string, EntityDefinition>([["order", schema]]);
      registry.buildFromEntityRegistry(schemas);

      // The manually registered table should be preserved
      expect(registry.getTable("order")).toBe(manualTable);
    });

    it("only adds schemas not already registered", () => {
      const registry = new TableRegistry();
      registry.register("order", makeTable(makeEntity("order")));

      const schemas = new Map<string, EntityDefinition>([
        ["order", makeEntity("order")],
        ["product", makeEntity("product")],
      ]);
      registry.buildFromEntityRegistry(schemas);

      expect(registry.has("order")).toBe(true);
      expect(registry.has("product")).toBe(true);
      expect(registry.getRegisteredSchemas()).toHaveLength(2);
    });

    it("handles empty schema map", () => {
      const registry = new TableRegistry();
      registry.buildFromEntityRegistry(new Map());
      expect(registry.getRegisteredSchemas()).toHaveLength(0);
    });

    it("applies table prefix option", () => {
      const registry = new TableRegistry();
      const schemas = new Map<string, EntityDefinition>([["order", makeEntity("order")]]);
      // Just verify it doesn't throw with prefix option
      expect(() =>
        registry.buildFromEntityRegistry(schemas, { tablePrefix: "test_" }),
      ).not.toThrow();
      expect(registry.has("order")).toBe(true);
    });
  });
});
