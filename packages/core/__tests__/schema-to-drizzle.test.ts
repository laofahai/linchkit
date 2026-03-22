import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { generateDrizzleTable } from "../src/engine/schema-to-drizzle";
import type { SchemaDefinition } from "../src/types/schema";

/** Helper: get column config by name from a table */
function getColumn(table: ReturnType<typeof generateDrizzleTable>, name: string) {
  const config = getTableConfig(table);
  return config.columns.find((c) => c.name === name);
}

describe("generateDrizzleTable", () => {
  const simpleSchema: SchemaDefinition = {
    name: "task",
    fields: {
      title: { type: "string", required: true, label: "Title" },
      done: { type: "boolean", label: "Done" },
    },
  };

  test("generates a table with correct name", () => {
    const table = generateDrizzleTable(simpleSchema);
    expect(getTableName(table)).toBe("task");
  });

  test("string field maps to varchar", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        code: { type: "string", required: true, max: 100 },
      },
    };
    const table = generateDrizzleTable(schema);
    const col = getColumn(table, "code");
    expect(col).toBeDefined();
    expect(col?.columnType).toBe("PgVarchar");
    // max should be used as varchar length
    expect((col as Record<string, unknown>).length).toBe(100);
  });

  test("string field without max defaults to varchar(255)", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        name: { type: "string" },
      },
    };
    const table = generateDrizzleTable(schema);
    const col = getColumn(table, "name");
    expect(col).toBeDefined();
    expect(col?.columnType).toBe("PgVarchar");
    expect((col as Record<string, unknown>).length).toBe(255);
  });

  test("text field maps to text", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        description: { type: "text" },
      },
    };
    const table = generateDrizzleTable(schema);
    const col = getColumn(table, "description");
    expect(col).toBeDefined();
    expect(col?.columnType).toBe("PgText");
  });

  test("number field maps to numeric", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        amount: { type: "number", required: true },
      },
    };
    const table = generateDrizzleTable(schema);
    const col = getColumn(table, "amount");
    expect(col).toBeDefined();
    expect(col?.columnType).toBe("PgNumeric");
  });

  test("boolean field maps to boolean", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        active: { type: "boolean" },
      },
    };
    const table = generateDrizzleTable(schema);
    const col = getColumn(table, "active");
    expect(col).toBeDefined();
    expect(col?.columnType).toBe("PgBoolean");
  });

  test("date field maps to date", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        start_date: { type: "date" },
      },
    };
    const table = generateDrizzleTable(schema);
    const col = getColumn(table, "start_date");
    expect(col).toBeDefined();
    expect(col?.columnType).toBe("PgDateString");
  });

  test("datetime field maps to timestamp", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        event_time: { type: "datetime" },
      },
    };
    const table = generateDrizzleTable(schema);
    const col = getColumn(table, "event_time");
    expect(col).toBeDefined();
    expect(col?.columnType).toBe("PgTimestamp");
  });

  test("enum field maps to varchar", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        priority: {
          type: "enum",
          options: [{ value: "low" }, { value: "medium" }, { value: "high" }],
        },
      },
    };
    const table = generateDrizzleTable(schema);
    const col = getColumn(table, "priority");
    expect(col).toBeDefined();
    expect(col?.columnType).toBe("PgVarchar");
  });

  test("json field maps to jsonb", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        metadata: { type: "json" },
      },
    };
    const table = generateDrizzleTable(schema);
    const col = getColumn(table, "metadata");
    expect(col).toBeDefined();
    expect(col?.columnType).toBe("PgJsonb");
  });

  test("ref field maps to varchar (ID storage)", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        department: { type: "ref", target: "department", required: true },
      },
    };
    const table = generateDrizzleTable(schema);
    const col = getColumn(table, "department");
    expect(col).toBeDefined();
    expect(col?.columnType).toBe("PgVarchar");
  });

  test("state field maps to varchar", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        status: { type: "state", machine: "order_lifecycle" },
      },
    };
    const table = generateDrizzleTable(schema);
    const col = getColumn(table, "status");
    expect(col).toBeDefined();
    expect(col?.columnType).toBe("PgVarchar");
  });

  test("system columns (id, tenant_id, etc.) are always included", () => {
    const table = generateDrizzleTable(simpleSchema);
    const systemCols = [
      "id",
      "tenant_id",
      "created_at",
      "updated_at",
      "created_by",
      "updated_by",
      "_version",
      "deleted_at",
    ];

    for (const name of systemCols) {
      const col = getColumn(table, name);
      expect(col).toBeDefined();
    }

    // Verify specific system column properties
    const id = getColumn(table, "id");
    expect((id as Record<string, unknown>).config).toHaveProperty("primaryKey", true);

    const createdAt = getColumn(table, "created_at");
    expect(createdAt?.notNull).toBe(true);

    const updatedAt = getColumn(table, "updated_at");
    expect(updatedAt?.notNull).toBe(true);

    const version = getColumn(table, "_version");
    expect(version?.notNull).toBe(true);
    expect(version?.columnType).toBe("PgInteger");

    // deleted_at is nullable (soft delete)
    const deletedAt = getColumn(table, "deleted_at");
    expect(deletedAt?.notNull).toBe(false);
    expect(deletedAt?.columnType).toBe("PgTimestamp");
  });

  test("computed and has_many fields are skipped", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        title: { type: "string", required: true },
        total: {
          type: "computed",
          compute: (r: Record<string, unknown>) => r.amount,
        },
        items: { type: "has_many", target: "item" },
        tags: { type: "many_to_many", target: "tag" },
      },
    };
    const table = generateDrizzleTable(schema);

    // title should exist
    expect(getColumn(table, "title")).toBeDefined();

    // skipped fields should not exist
    expect(getColumn(table, "total")).toBeUndefined();
    expect(getColumn(table, "items")).toBeUndefined();
    expect(getColumn(table, "tags")).toBeUndefined();
  });

  test("required fields have notNull", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        name: { type: "string", required: true },
        bio: { type: "text" },
      },
    };
    const table = generateDrizzleTable(schema);

    expect(getColumn(table, "name")?.notNull).toBe(true);
    expect(getColumn(table, "bio")?.notNull).toBe(false);
  });

  test("unique fields have unique constraint", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        email: { type: "string", required: true, unique: true },
      },
    };
    const table = generateDrizzleTable(schema);
    const col = getColumn(table, "email");
    expect(col?.isUnique).toBe(true);
  });

  test("table prefix option works", () => {
    const table = generateDrizzleTable(simpleSchema, { tablePrefix: "app" });
    expect(getTableName(table)).toBe("app_task");
  });
});
