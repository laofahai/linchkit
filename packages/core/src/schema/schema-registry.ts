/**
 * Schema Registry
 *
 * Manages schema definitions, extensions, and overrides.
 * Resolves schemas by injecting system fields, merging extensions/overrides,
 * and wrapping each field with resolution metadata (storable flag, label).
 */

import type {
  FieldDefinition,
  ResolvedField,
  ResolvedSchema,
  SchemaDefinition,
  SchemaExtension,
  SchemaOverride,
  SchemaRelation,
} from "../types/schema";

// ── Non-storable field types ────────────────────────────────────

const NON_STORABLE_TYPES = new Set(["computed", "has_many", "many_to_many"]);

// ── Relation field types ────────────────────────────────────────

const RELATION_TYPES = new Set(["ref", "has_many", "many_to_many"]);

// ── System field definitions ────────────────────────────────────

const SYSTEM_FIELDS: Record<string, FieldDefinition> = {
  id: { type: "string", required: true, label: "ID" },
  tenant_id: { type: "string", label: "Tenant ID" },
  created_at: { type: "datetime", default: "now", label: "Created At" },
  updated_at: { type: "datetime", default: "now", label: "Updated At" },
  created_by: { type: "string", label: "Created By" },
  updated_by: { type: "string", label: "Updated By" },
  _version: { type: "number", default: 1, label: "Version" },
};

// ── Helpers ─────────────────────────────────────────────────────

/** Generate a human-readable label from a snake_case field name */
function labelFromName(name: string): string {
  return name
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Wrap a field definition into a ResolvedField */
function resolveField(name: string, definition: FieldDefinition): ResolvedField {
  return {
    definition,
    storable: !NON_STORABLE_TYPES.has(definition.type),
    label: definition.label ?? labelFromName(name),
  };
}

// ── SchemaRegistry ──────────────────────────────────────────────

export class SchemaRegistry {
  private schemas = new Map<string, SchemaDefinition>();
  private extensions = new Map<string, SchemaExtension[]>();
  private overrides = new Map<string, SchemaOverride[]>();

  /**
   * Register a schema definition.
   * Throws if a schema with the same name is already registered.
   */
  register(schema: SchemaDefinition): void {
    if (!schema.name) {
      throw new Error("Schema must have a name");
    }
    if (!schema.fields || Object.keys(schema.fields).length === 0) {
      throw new Error(`Schema "${schema.name}" must have at least one field`);
    }
    if (this.schemas.has(schema.name)) {
      throw new Error(`Schema "${schema.name}" is already registered`);
    }
    this.schemas.set(schema.name, schema);
  }

  /**
   * Apply an extension to a registered schema (adds new fields).
   * The extension is stored and merged at resolve time.
   */
  applyExtension(name: string, extension: SchemaExtension): void {
    if (!this.schemas.has(name)) {
      throw new Error(`Cannot extend unknown schema "${name}"`);
    }
    const list = this.extensions.get(name) ?? [];
    list.push(extension);
    this.extensions.set(name, list);
  }

  /**
   * Apply an override to a registered schema (modifies field constraints).
   * The override is stored and applied at resolve time.
   */
  applyOverride(name: string, override: SchemaOverride): void {
    if (!this.schemas.has(name)) {
      throw new Error(`Cannot override unknown schema "${name}"`);
    }
    this.overrides.set(name, [...(this.overrides.get(name) ?? []), override]);
  }

  /**
   * Resolve a schema: inject system fields, merge extensions and overrides,
   * and wrap each field in ResolvedField with metadata.
   */
  resolve(name: string): ResolvedSchema {
    const schema = this.schemas.get(name);
    if (!schema) {
      throw new Error(`Schema "${name}" is not registered`);
    }

    // Start with system fields
    const fields: Record<string, ResolvedField> = {};
    for (const [fname, fdef] of Object.entries(SYSTEM_FIELDS)) {
      fields[fname] = resolveField(fname, fdef);
    }

    // Add user-defined fields
    for (const [fname, fdef] of Object.entries(schema.fields)) {
      fields[fname] = resolveField(fname, fdef);
    }

    // Merge extensions
    const exts = this.extensions.get(name) ?? [];
    for (const ext of exts) {
      for (const [fname, fdef] of Object.entries(ext.fields)) {
        fields[fname] = resolveField(fname, fdef);
      }
    }

    // Apply overrides (modify constraints only, not type)
    const ovrs = this.overrides.get(name) ?? [];
    for (const ovr of ovrs) {
      for (const [fname, constraints] of Object.entries(ovr.fields)) {
        const existing = fields[fname];
        if (!existing) {
          throw new Error(`Override references unknown field "${fname}" on schema "${name}"`);
        }

        // Type change is not allowed
        if ("type" in constraints) {
          throw new Error(
            `Override cannot change the type of field "${fname}" on schema "${name}"`,
          );
        }

        // Merge constraints into the existing definition
        const merged = { ...existing.definition, ...constraints } as FieldDefinition;
        fields[fname] = resolveField(fname, merged);
      }
    }

    return {
      name: schema.name,
      label: schema.label,
      presentation: schema.presentation,
      fields,
      source: schema,
    };
  }

  /** Get the raw schema definition by name */
  get(name: string): SchemaDefinition | undefined {
    return this.schemas.get(name);
  }

  /** Get all registered schema definitions */
  getAll(): SchemaDefinition[] {
    return Array.from(this.schemas.values());
  }

  /** Check if a schema is registered */
  has(name: string): boolean {
    return this.schemas.has(name);
  }

  /**
   * Get all relations (ref, has_many, many_to_many) for a schema.
   * Returns relations from the resolved schema (includes extensions).
   */
  getRelations(name: string): SchemaRelation[] {
    const resolved = this.resolve(name);
    const relations: SchemaRelation[] = [];

    for (const [fieldName, resolvedField] of Object.entries(resolved.fields)) {
      const def = resolvedField.definition;
      if (RELATION_TYPES.has(def.type)) {
        relations.push({
          fieldName,
          type: def.type as SchemaRelation["type"],
          target: (def as { target: string }).target,
        });
      }
    }

    return relations;
  }
}

// ── Factory ─────────────────────────────────────────────────────

/** Create a new SchemaRegistry instance */
export function createSchemaRegistry(): SchemaRegistry {
  return new SchemaRegistry();
}
