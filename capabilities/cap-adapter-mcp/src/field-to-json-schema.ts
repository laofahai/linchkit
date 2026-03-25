/**
 * FieldDefinition to JSON Schema conversion
 *
 * Converts LinchKit FieldDefinition types to JSON Schema objects
 * for use in MCP tool inputSchema definitions.
 */

import type { FieldDefinition } from "@linchkit/core";

/** Convert a single FieldDefinition to a JSON Schema property */
export function fieldToJsonSchema(field: FieldDefinition): Record<string, unknown> | null {
  // Skip non-input field types
  if (field.type === "computed") {
    return null;
  }

  // has_many and many_to_many are virtual relationship fields — they have no physical FK column
  // on this table. The relationship is resolved via the target table's FK or a junction table.
  if (field.type === "has_many" || field.type === "many_to_many") {
    return null;
  }

  // Skip secret fields
  if (field.secret) {
    return null;
  }

  const schema: Record<string, unknown> = {};

  switch (field.type) {
    case "string":
      schema.type = "string";
      if (field.format) schema.format = field.format;
      if (field.min !== undefined) schema.minLength = field.min;
      if (field.max !== undefined) schema.maxLength = field.max;
      break;

    case "text":
      schema.type = "string";
      break;

    case "number":
      schema.type = "number";
      if (field.min !== undefined) schema.minimum = field.min;
      if (field.max !== undefined) schema.maximum = field.max;
      break;

    case "boolean":
      schema.type = "boolean";
      break;

    case "date":
      schema.type = "string";
      schema.format = "date";
      break;

    case "datetime":
      schema.type = "string";
      schema.format = "date-time";
      break;

    case "enum":
      schema.type = "string";
      schema.enum = field.options.map((o) => o.value);
      break;

    case "ref":
      // ref fields have a physical FK column storing the referenced record's ID
      schema.type = "string";
      if (!field.description) {
        schema.description = `Reference to ${field.target}`;
      }
      break;

    case "json":
      schema.type = "object";
      break;

    case "state":
      schema.type = "string";
      schema.description = `State value (machine: ${field.machine})`;
      break;
  }

  // Add description from field definition
  if (field.description && !schema.description) {
    schema.description = field.description;
  }

  // For ref fields, append target info to user-provided descriptions
  if (field.type === "ref" && field.description && schema.description) {
    schema.description = `${schema.description} (references ${field.target})`;
  }

  // Mark sensitive fields
  if (field.sensitive) {
    schema.description = schema.description
      ? `${schema.description} (sensitive)`
      : "Sensitive field";
  }

  // Add label as title
  if (field.label) {
    schema.title = field.label;
  }

  return schema;
}

/** Convert a record of FieldDefinitions to a JSON Schema object */
export function fieldsToJsonSchema(fields: Record<string, FieldDefinition>): {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, field] of Object.entries(fields)) {
    const schema = fieldToJsonSchema(field);
    if (schema === null) continue;

    properties[name] = schema;

    if (field.required) {
      required.push(name);
    }
  }

  const result: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  } = {
    type: "object",
    properties,
  };

  if (required.length > 0) {
    result.required = required;
  }

  return result;
}
