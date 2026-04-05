/**
 * Schema Mapper
 *
 * Maps external data structures to LinchKit EntityDefinitions.
 * Provides field-level mapping with built-in transforms.
 */

import type { EntityDefinition, FieldDefinition } from "@linchkit/core";

// ── Types ──────────────────────────────────────────────────

/** Built-in transform functions for field value conversion */
export type BuiltInTransform =
  | { type: "trim" }
  | { type: "lowercase" }
  | { type: "uppercase" }
  | { type: "toNumber" }
  | { type: "toBoolean"; truthy?: string[] }
  | { type: "toDate"; format?: string }
  | { type: "enumMap"; mapping: Record<string, string> }
  | { type: "default"; value: unknown };

/** A single field mapping: source field → target field with optional transforms */
export interface FieldMapping {
  /** Source field name (dot-notation supported for nested access) */
  source: string;
  /** Target LinchKit field name */
  target: string;
  /** Optional transform to apply. Can be a built-in transform, a custom function, or a pipeline of transforms. */
  transform?: BuiltInTransform | BuiltInTransform[] | ((value: unknown) => unknown);
}

/** Result of mapping a single record */
export interface MappedRecord {
  data: Record<string, unknown>;
  errors: Array<{ field: string; message: string }>;
}

/** Result of validating mappings against a target schema */
export interface MappingValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ── Built-in transform executors ────────────────────────────

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function applyBuiltInTransform(value: unknown, transform: BuiltInTransform): unknown {
  switch (transform.type) {
    case "trim":
      return typeof value === "string" ? value.trim() : value;

    case "lowercase":
      return typeof value === "string" ? value.toLowerCase() : value;

    case "uppercase":
      return typeof value === "string" ? value.toUpperCase() : value;

    case "toNumber": {
      if (value == null || value === "") return null;
      const num = Number(value);
      return Number.isNaN(num) ? null : num;
    }

    case "toBoolean": {
      if (typeof value === "boolean") return value;
      const str = String(value).toLowerCase().trim();
      const truthy = transform.truthy ?? ["true", "1", "yes", "y"];
      return truthy.includes(str);
    }

    case "toDate": {
      if (value == null || value === "") return null;
      if (value instanceof Date) return value;
      const d = new Date(String(value));
      return Number.isNaN(d.getTime()) ? null : d;
    }

    case "enumMap":
      return transform.mapping[String(value)] ?? null;

    case "default":
      return value == null || value === "" ? transform.value : value;
  }
}

// ── SchemaMapper class ──────────────────────────────────────

export class SchemaMapper {
  private readonly mappings: FieldMapping[];
  private readonly targetSchema: EntityDefinition;

  constructor(options: { mappings: FieldMapping[]; targetSchema: EntityDefinition }) {
    this.mappings = options.mappings;
    this.targetSchema = options.targetSchema;
  }

  /** Validate that all mappings point to valid target fields */
  validate(): MappingValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const targetFields = Object.keys(this.targetSchema.fields);

    for (const mapping of this.mappings) {
      if (!targetFields.includes(mapping.target)) {
        errors.push(
          `Target field "${mapping.target}" does not exist in schema "${this.targetSchema.name}"`,
        );
      }
    }

    // Check for required fields without mappings
    const mappedTargets = new Set(this.mappings.map((m) => m.target));
    for (const [name, field] of Object.entries(this.targetSchema.fields)) {
      const fd = field as FieldDefinition;
      if (fd.required && !mappedTargets.has(name)) {
        warnings.push(`Required field "${name}" has no mapping`);
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /** Map a single source record to a target record */
  mapRecord(source: Record<string, unknown>): MappedRecord {
    const data: Record<string, unknown> = {};
    const errors: Array<{ field: string; message: string }> = [];

    for (const mapping of this.mappings) {
      try {
        let value = getNestedValue(source, mapping.source);
        value = this.applyTransform(value, mapping.transform);
        data[mapping.target] = value;
      } catch (err) {
        errors.push({
          field: mapping.target,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { data, errors };
  }

  /** Map an array of source records */
  mapRecords(sources: Record<string, unknown>[]): MappedRecord[] {
    return sources.map((s) => this.mapRecord(s));
  }

  private applyTransform(
    value: unknown,
    transform?: BuiltInTransform | BuiltInTransform[] | ((value: unknown) => unknown),
  ): unknown {
    if (!transform) return value;

    if (typeof transform === "function") {
      return transform(value);
    }

    if (Array.isArray(transform)) {
      let result = value;
      for (const t of transform) {
        result = applyBuiltInTransform(result, t);
      }
      return result;
    }

    return applyBuiltInTransform(value, transform);
  }
}
