import { describe, expect, test } from "bun:test";
import { generateZodSchema } from "../src/schema/schema-to-zod";
import type { SchemaDefinition } from "../src/types/schema";

describe("generateZodSchema", () => {
  test("generates valid Zod schema from a simple SchemaDefinition", () => {
    const schema: SchemaDefinition = {
      name: "task",
      fields: {
        title: { type: "string", required: true, label: "Title" },
        done: { type: "boolean", label: "Done" },
      },
    };

    const zodSchema = generateZodSchema(schema);
    const result = zodSchema.safeParse({ title: "Hello" });
    expect(result.success).toBe(true);
  });

  test("string field with min/max becomes z.string().min().max()", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        code: { type: "string", required: true, min: 2, max: 10 },
      },
    };

    const zodSchema = generateZodSchema(schema);

    expect(zodSchema.safeParse({ code: "a" }).success).toBe(false);
    expect(zodSchema.safeParse({ code: "ab" }).success).toBe(true);
    expect(zodSchema.safeParse({ code: "a".repeat(11) }).success).toBe(false);
    expect(zodSchema.safeParse({ code: "a".repeat(10) }).success).toBe(true);
  });

  test("number field with min/max becomes z.number().min().max()", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        amount: { type: "number", required: true, min: 0, max: 100 },
      },
    };

    const zodSchema = generateZodSchema(schema);

    expect(zodSchema.safeParse({ amount: -1 }).success).toBe(false);
    expect(zodSchema.safeParse({ amount: 0 }).success).toBe(true);
    expect(zodSchema.safeParse({ amount: 100 }).success).toBe(true);
    expect(zodSchema.safeParse({ amount: 101 }).success).toBe(false);
  });

  test("required fields are not optional", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        name: { type: "string", required: true },
      },
    };

    const zodSchema = generateZodSchema(schema);

    expect(zodSchema.safeParse({}).success).toBe(false);
    expect(zodSchema.safeParse({ name: "Alice" }).success).toBe(true);
  });

  test("optional fields (required: false or missing) are optional", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        a: { type: "string", required: false },
        b: { type: "string" },
      },
    };

    const zodSchema = generateZodSchema(schema);

    expect(zodSchema.safeParse({}).success).toBe(true);
    expect(zodSchema.safeParse({ a: "x", b: "y" }).success).toBe(true);
  });

  test("enum field generates z.enum()", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        priority: {
          type: "enum",
          required: true,
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ],
        },
      },
    };

    const zodSchema = generateZodSchema(schema);

    expect(zodSchema.safeParse({ priority: "low" }).success).toBe(true);
    expect(zodSchema.safeParse({ priority: "medium" }).success).toBe(true);
    expect(zodSchema.safeParse({ priority: "invalid" }).success).toBe(false);
  });

  test("ref field generates z.string() (ID reference)", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        department: { type: "ref", target: "department", required: true },
      },
    };

    const zodSchema = generateZodSchema(schema);

    expect(zodSchema.safeParse({ department: "dept_123" }).success).toBe(true);
    expect(zodSchema.safeParse({ department: 123 }).success).toBe(false);
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

    const zodSchema = generateZodSchema(schema);
    const shape = zodSchema.shape;

    expect(shape.title).toBeDefined();
    expect(shape.total).toBeUndefined();
    expect(shape.items).toBeUndefined();
    expect(shape.tags).toBeUndefined();
  });

  test("format 'email' adds .email() validation", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        email: { type: "string", required: true, format: "email" },
      },
    };

    const zodSchema = generateZodSchema(schema);

    expect(zodSchema.safeParse({ email: "user@example.com" }).success).toBe(true);
    expect(zodSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
  });

  test("format 'url' adds .url() validation", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        website: { type: "string", required: true, format: "url" },
      },
    };

    const zodSchema = generateZodSchema(schema);

    expect(zodSchema.safeParse({ website: "https://example.com" }).success).toBe(true);
    expect(zodSchema.safeParse({ website: "not-a-url" }).success).toBe(false);
  });

  test("state field uses stateResolver to get enum values", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        status: { type: "state", machine: "order_lifecycle", required: true },
      },
    };

    const zodSchema = generateZodSchema(schema, {
      stateResolver: (machine) => {
        if (machine === "order_lifecycle") {
          return ["draft", "submitted", "approved", "rejected"];
        }
        return [];
      },
    });

    expect(zodSchema.safeParse({ status: "draft" }).success).toBe(true);
    expect(zodSchema.safeParse({ status: "approved" }).success).toBe(true);
    expect(zodSchema.safeParse({ status: "unknown" }).success).toBe(false);
  });

  test("state field without resolver falls back to z.string()", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        status: { type: "state", machine: "order_lifecycle", required: true },
      },
    };

    const zodSchema = generateZodSchema(schema);

    expect(zodSchema.safeParse({ status: "anything" }).success).toBe(true);
    expect(zodSchema.safeParse({ status: 123 }).success).toBe(false);
  });

  test("generated schema validates correct input", () => {
    const schema: SchemaDefinition = {
      name: "purchase_request",
      fields: {
        title: { type: "string", required: true, min: 1 },
        amount: { type: "number", required: true, min: 0 },
        description: { type: "text" },
        department: { type: "ref", target: "department", required: true },
        status: { type: "state", machine: "request_lifecycle" },
      },
    };

    const zodSchema = generateZodSchema(schema);

    const result = zodSchema.safeParse({
      title: "Office Supplies",
      amount: 500,
      department: "dept_001",
    });
    expect(result.success).toBe(true);
  });

  test("generated schema rejects invalid input", () => {
    const schema: SchemaDefinition = {
      name: "purchase_request",
      fields: {
        title: { type: "string", required: true, min: 1 },
        amount: { type: "number", required: true, min: 0, max: 1000000 },
        department: { type: "ref", target: "department", required: true },
      },
    };

    const zodSchema = generateZodSchema(schema);

    // Missing required fields
    expect(zodSchema.safeParse({}).success).toBe(false);

    // Amount out of range
    expect(
      zodSchema.safeParse({
        title: "Test",
        amount: -1,
        department: "dept_001",
      }).success,
    ).toBe(false);

    // Wrong type
    expect(
      zodSchema.safeParse({
        title: 123,
        amount: 500,
        department: "dept_001",
      }).success,
    ).toBe(false);
  });

  test("boolean, date, datetime, json field mappings work", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        active: { type: "boolean", required: true },
        start_date: { type: "date", required: true },
        created_at: { type: "datetime", required: true },
        metadata: { type: "json" },
      },
    };

    const zodSchema = generateZodSchema(schema);

    const result = zodSchema.safeParse({
      active: true,
      start_date: "2024-01-15",
      created_at: "2024-01-15T10:30:00Z",
    });
    expect(result.success).toBe(true);

    // Boolean rejects non-boolean
    expect(
      zodSchema.safeParse({
        active: "yes",
        start_date: "2024-01-15",
        created_at: "2024-01-15T10:30:00Z",
      }).success,
    ).toBe(false);

    // JSON accepts any value
    const withJson = zodSchema.safeParse({
      active: false,
      start_date: "2024-01-15",
      created_at: "2024-01-15T10:30:00Z",
      metadata: { key: "value", nested: [1, 2, 3] },
    });
    expect(withJson.success).toBe(true);
  });

  test("includeSystemFields adds optional system fields", () => {
    const schema: SchemaDefinition = {
      name: "test",
      fields: {
        title: { type: "string", required: true },
      },
    };

    const zodSchema = generateZodSchema(schema, { includeSystemFields: true });
    const shape = zodSchema.shape;

    expect(shape.id).toBeDefined();
    expect(shape.tenant_id).toBeDefined();
    expect(shape.created_at).toBeDefined();
    expect(shape.updated_at).toBeDefined();
    expect(shape.created_by).toBeDefined();
    expect(shape.updated_by).toBeDefined();
    expect(shape._version).toBeDefined();

    // System fields should be optional
    const result = zodSchema.safeParse({ title: "Hello" });
    expect(result.success).toBe(true);
  });
});
