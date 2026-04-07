import { describe, expect, test } from "bun:test";
import type { FieldDefinition } from "@linchkit/core";
import { fieldsToJsonSchema, fieldToJsonSchema } from "../src/field-to-json-schema";

describe("fieldToJsonSchema", () => {
  test("converts string field", () => {
    const field: FieldDefinition = { type: "string", label: "Name" };
    const result = fieldToJsonSchema(field);
    expect(result).toEqual({ type: "string", title: "Name" });
  });

  test("converts string field with format and constraints", () => {
    const field: FieldDefinition = {
      type: "string",
      format: "email",
      min: 5,
      max: 100,
    };
    const result = fieldToJsonSchema(field);
    expect(result).toEqual({
      type: "string",
      format: "email",
      minLength: 5,
      maxLength: 100,
    });
  });

  test("converts text field", () => {
    const field: FieldDefinition = { type: "text" };
    const result = fieldToJsonSchema(field);
    expect(result).toEqual({ type: "string" });
  });

  test("converts number field with min/max", () => {
    const field: FieldDefinition = { type: "number", min: 0, max: 100 };
    const result = fieldToJsonSchema(field);
    expect(result).toEqual({ type: "number", minimum: 0, maximum: 100 });
  });

  test("converts boolean field", () => {
    const field: FieldDefinition = { type: "boolean" };
    const result = fieldToJsonSchema(field);
    expect(result).toEqual({ type: "boolean" });
  });

  test("converts date field", () => {
    const field: FieldDefinition = { type: "date" };
    const result = fieldToJsonSchema(field);
    expect(result).toEqual({ type: "string", format: "date" });
  });

  test("converts datetime field", () => {
    const field: FieldDefinition = { type: "datetime" };
    const result = fieldToJsonSchema(field);
    expect(result).toEqual({ type: "string", format: "date-time" });
  });

  test("converts enum field", () => {
    const field: FieldDefinition = {
      type: "enum",
      options: [
        { value: "draft", label: "Draft" },
        { value: "published", label: "Published" },
      ],
    };
    const result = fieldToJsonSchema(field);
    expect(result).toEqual({
      type: "string",
      enum: ["draft", "published"],
    });
  });

  test("converts json field", () => {
    const field: FieldDefinition = { type: "json" };
    const result = fieldToJsonSchema(field);
    expect(result).toEqual({ type: "object" });
  });

  test("converts state field", () => {
    const field: FieldDefinition = { type: "state", machine: "order_flow" };
    const result = fieldToJsonSchema(field);
    expect(result).toEqual({
      type: "string",
      description: "State value (machine: order_flow)",
    });
  });

  test("returns null for computed field", () => {
    const field: FieldDefinition = {
      type: "computed",
      compute: () => "test",
    };
    expect(fieldToJsonSchema(field)).toBeNull();
  });

  test("returns null for secret field", () => {
    const field: FieldDefinition = { type: "string", secret: true };
    expect(fieldToJsonSchema(field)).toBeNull();
  });

  test("marks sensitive field in description", () => {
    const field: FieldDefinition = { type: "string", sensitive: true };
    const result = fieldToJsonSchema(field);
    expect(result?.description).toBe("Sensitive field");
  });

  test("appends sensitive marker to existing description", () => {
    const field: FieldDefinition = {
      type: "string",
      sensitive: true,
      description: "User email",
    };
    const result = fieldToJsonSchema(field);
    expect(result?.description).toBe("User email (sensitive)");
  });

  test("includes field description", () => {
    const field: FieldDefinition = {
      type: "string",
      description: "Full name of the user",
    };
    const result = fieldToJsonSchema(field);
    expect(result?.description).toBe("Full name of the user");
  });
});

describe("fieldsToJsonSchema", () => {
  test("converts multiple fields to object schema", () => {
    const fields: Record<string, FieldDefinition> = {
      name: { type: "string", required: true },
      age: { type: "number" },
      active: { type: "boolean" },
    };

    const result = fieldsToJsonSchema(fields);
    expect(result.type).toBe("object");
    expect(result.properties).toHaveProperty("name");
    expect(result.properties).toHaveProperty("age");
    expect(result.properties).toHaveProperty("active");
    expect(result.required).toEqual(["name"]);
  });

  test("omits required array when no fields are required", () => {
    const fields: Record<string, FieldDefinition> = {
      name: { type: "string" },
    };

    const result = fieldsToJsonSchema(fields);
    expect(result.required).toBeUndefined();
  });

  test("skips secret and non-input fields", () => {
    const fields: Record<string, FieldDefinition> = {
      name: { type: "string" },
      password: { type: "string", secret: true },
      total: { type: "computed", compute: () => 0 },
    };

    const result = fieldsToJsonSchema(fields);
    expect(Object.keys(result.properties)).toEqual(["name"]);
  });

  test("includes FK string fields for relations", () => {
    const fields: Record<string, FieldDefinition> = {
      name: { type: "string" },
      department_id: { type: "string", required: true, description: "FK to department" },
    };

    const result = fieldsToJsonSchema(fields);
    expect(Object.keys(result.properties)).toEqual(["name", "department_id"]);
    expect(result.required).toEqual(["department_id"]);
    expect(result.properties.department_id).toEqual({
      type: "string",
      description: "FK to department",
    });
  });

  test("returns empty properties for empty fields", () => {
    const result = fieldsToJsonSchema({});
    expect(result).toEqual({ type: "object", properties: {} });
  });
});
