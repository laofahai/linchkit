/**
 * Shared serialization helpers for MCP Dev Server.
 */

import type { FieldDefinition, RelationDefinition } from "@linchkit/core";

/** Serialize fields to a JSON-safe representation */
export function serializeFields(fields: Record<string, FieldDefinition>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    const serialized: Record<string, unknown> = {
      type: field.type,
      label: field.label,
    };
    if (field.description) serialized.description = field.description;
    if (field.required) serialized.required = true;
    if (field.unique) serialized.unique = true;
    if (field.default !== undefined) serialized.default = field.default;
    if (field.min !== undefined) serialized.min = field.min;
    if (field.max !== undefined) serialized.max = field.max;
    if (field.format) serialized.format = field.format;
    if (field.pattern) serialized.pattern = field.pattern;
    if (field.immutable) serialized.immutable = true;
    // Type-specific properties
    if (field.type === "enum") {
      serialized.options = field.options;
    }
    if (field.type === "state") {
      serialized.machine = field.machine;
    }
    result[name] = serialized;
  }
  return result;
}

/** Serialize a relation definition */
export function serializeRelation(r: RelationDefinition): Record<string, unknown> {
  return {
    name: r.name,
    from: r.from,
    to: r.to,
    cardinality: r.cardinality,
    label: r.label,
    description: r.description,
    required: r.required,
    cascade: r.cascade,
  };
}
