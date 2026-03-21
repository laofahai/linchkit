/**
 * Schema-to-Zod generator
 *
 * Converts a LinchKit SchemaDefinition into a Zod object schema
 * for runtime input validation in Action Engine.
 */

import { z } from "zod";
import type { FieldDefinition, SchemaDefinition } from "../types/schema";

export interface ZodGeneratorOptions {
  /** Resolve state machine states for 'state' type fields */
  stateResolver?: (machineName: string) => string[];
  /** Whether to include system fields in the schema */
  includeSystemFields?: boolean;
}

// Field types that are virtual / computed and should be skipped in input schemas
const SKIPPED_FIELD_TYPES = new Set(["computed", "has_many", "many_to_many"]);

/**
 * Generate a Zod schema from a LinchKit SchemaDefinition.
 * Used for runtime input validation in Action Engine.
 */
export function generateZodSchema(
  schema: SchemaDefinition,
  options?: ZodGeneratorOptions,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};

  if (options?.includeSystemFields) {
    shape.id = z.string().optional();
    shape.tenant_id = z.string().optional();
    shape.created_at = z.string().optional();
    shape.updated_at = z.string().optional();
    shape.created_by = z.string().optional();
    shape.updated_by = z.string().optional();
    shape._version = z.number().optional();
  }

  for (const [fieldName, field] of Object.entries(schema.fields)) {
    if (SKIPPED_FIELD_TYPES.has(field.type)) {
      continue;
    }

    let zodType = buildFieldZod(field, options);

    // Apply optional/required
    if (!field.required) {
      zodType = zodType.optional();
    }

    shape[fieldName] = zodType;
  }

  return z.object(shape);
}

/**
 * Build a Zod type for a single field definition (before optional wrapping).
 */
function buildFieldZod(field: FieldDefinition, options?: ZodGeneratorOptions): z.ZodTypeAny {
  switch (field.type) {
    case "string":
      return applyStringConstraints(z.string(), field);

    case "text":
      return applyStringConstraints(z.string(), field);

    case "number":
      return applyNumberConstraints(z.number(), field);

    case "boolean":
      return z.boolean();

    case "date":
      return z.string();

    case "datetime":
      return z.string();

    case "enum":
      return z.enum(field.options.map((o) => o.value) as [string, ...string[]]);

    case "json":
      return z.unknown();

    case "ref":
      return z.string();

    case "state":
      return buildStateZod(field.machine, options);

    default:
      return z.unknown();
  }
}

/**
 * Apply string constraints: min, max, format.
 */
function applyStringConstraints(schema: z.ZodString, field: FieldDefinition): z.ZodString {
  let result = schema;

  if (field.min != null) {
    result = result.min(field.min);
  }
  if (field.max != null) {
    result = result.max(field.max);
  }
  if (field.format === "email") {
    result = result.email();
  }
  if (field.format === "url") {
    result = result.url();
  }

  return result;
}

/**
 * Apply number constraints: min, max.
 */
function applyNumberConstraints(schema: z.ZodNumber, field: FieldDefinition): z.ZodNumber {
  let result = schema;

  if (field.min != null) {
    result = result.min(field.min);
  }
  if (field.max != null) {
    result = result.max(field.max);
  }

  return result;
}

/**
 * Build Zod type for a state field — enum if resolver is available, else string.
 */
function buildStateZod(machineName: string, options?: ZodGeneratorOptions): z.ZodTypeAny {
  if (options?.stateResolver) {
    const states = options.stateResolver(machineName);
    if (states.length > 0) {
      return z.enum(states as [string, ...string[]]);
    }
  }
  return z.string();
}
