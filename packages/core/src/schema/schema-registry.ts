/**
 * Schema Registry
 *
 * Manages schema definitions, extensions, and overrides.
 * Resolves schemas by injecting system fields, merging extensions/overrides,
 * and wrapping each field with resolution metadata (storable flag, label).
 *
 * Supports single inheritance via `extends` and abstract schemas.
 */

import type {
  FieldDefinition,
  ResolvedField,
  ResolvedSchema,
  SchemaDefinition,
  SchemaExtension,
  SchemaOverride,
} from "../types/schema";
import type { InterfaceRegistry } from "./schema-interface";

// ── Non-storable field types ────────────────────────────────────

const NON_STORABLE_TYPES = new Set(["computed", "has_many", "many_to_many"]);

/** Maximum inheritance depth (A -> B -> C = depth 2, max allowed is 3 levels total) */
const MAX_INHERITANCE_DEPTH = 3;

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
  // Derived fields with "compute" strategy are not stored (spec 48)
  const isDerivedCompute = definition.derived?.strategy === "compute";
  return {
    definition,
    storable: !NON_STORABLE_TYPES.has(definition.type) && !isDerivedCompute,
    label: definition.label ?? labelFromName(name),
  };
}

// ── SchemaRegistry ──────────────────────────────────────────────

export class SchemaRegistry {
  private schemas = new Map<string, SchemaDefinition>();
  private extensions = new Map<string, SchemaExtension[]>();
  private overrides = new Map<string, SchemaOverride[]>();
  private _interfaceRegistry: InterfaceRegistry | null = null;

  /** Set the InterfaceRegistry for interface validation and field injection */
  setInterfaceRegistry(registry: InterfaceRegistry): void {
    this._interfaceRegistry = registry;
  }

  /** Get the associated InterfaceRegistry (if any) */
  getInterfaceRegistry(): InterfaceRegistry | null {
    return this._interfaceRegistry;
  }

  /**
   * Register a schema definition.
   * Throws if a schema with the same name is already registered.
   * Validates inheritance constraints (parent exists, no circular refs, depth limit).
   * Validates interface implementation if InterfaceRegistry is set.
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

    // Validate inheritance constraints
    if (schema.extends) {
      const parent = this.schemas.get(schema.extends);
      if (!parent) {
        throw new Error(
          `Schema "${schema.name}" extends unknown schema "${schema.extends}"`,
        );
      }

      // Check inheritance depth (walk up the chain)
      let depth = 1;
      let current: SchemaDefinition | undefined = parent;
      const visited = new Set<string>([schema.name]);
      while (current?.extends) {
        if (visited.has(current.extends)) {
          throw new Error(
            `Circular inheritance detected: "${schema.name}" -> "${current.extends}"`,
          );
        }
        visited.add(current.extends);
        depth++;
        current = this.schemas.get(current.extends);
      }

      if (depth >= MAX_INHERITANCE_DEPTH) {
        throw new Error(
          `Inheritance depth exceeds maximum of ${MAX_INHERITANCE_DEPTH} levels for schema "${schema.name}"`,
        );
      }
    }

    // Validate interface implementation
    if (schema.implements && schema.implements.length > 0 && this._interfaceRegistry) {
      const errors = this._interfaceRegistry.validateImplementation(schema);
      if (errors.length > 0) {
        throw new Error(errors[0]);
      }
      // Register the schema as an implementor
      this._interfaceRegistry.registerImplementor(schema.name, schema.implements);
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
   * Collect the full inheritance chain for a schema (from root ancestor to self).
   * Returns an array of schema names ordered from root to self.
   */
  private getInheritanceChain(name: string): string[] {
    const chain: string[] = [];
    let current = this.schemas.get(name);
    while (current) {
      chain.unshift(current.name);
      current = current.extends ? this.schemas.get(current.extends) : undefined;
    }
    return chain;
  }

  /**
   * Get direct children of a schema (schemas that extend it).
   */
  private getChildren(name: string): string[] {
    const children: string[] = [];
    for (const schema of this.schemas.values()) {
      if (schema.extends === name) {
        children.push(schema.name);
      }
    }
    return children;
  }

  /**
   * Resolve a schema: inject system fields, merge inherited fields,
   * merge extensions and overrides, and wrap each field in ResolvedField with metadata.
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

    // Merge inherited fields (from root ancestor down to parent)
    if (schema.extends) {
      const chain = this.getInheritanceChain(name);
      // Apply fields from each ancestor (excluding self, which is last in chain)
      for (let i = 0; i < chain.length - 1; i++) {
        const ancestor = this.schemas.get(chain[i]!);
        if (ancestor) {
          for (const [fname, fdef] of Object.entries(ancestor.fields)) {
            fields[fname] = resolveField(fname, fdef);
          }
        }
      }
    }

    // Add user-defined fields (child fields override parent fields of same name)
    for (const [fname, fdef] of Object.entries(schema.fields)) {
      // If this field exists in parent, allow override of non-structural properties
      // but the child must provide a valid FieldDefinition (type is required)
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
      abstract: schema.abstract,
      parent: schema.extends,
      children: this.getChildren(name),
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

  /**
   * Get all concrete (non-abstract) schema definitions.
   * Useful for table generation, action registration, etc.
   */
  getConcrete(): SchemaDefinition[] {
    return Array.from(this.schemas.values()).filter((s) => !s.abstract);
  }

  /** Check if a schema is registered */
  has(name: string): boolean {
    return this.schemas.has(name);
  }

  /**
   * Validate all inheritance constraints across all registered schemas.
   * Call after all schemas have been registered to catch issues early.
   * Returns an array of error messages (empty if valid).
   */
  validateInheritance(): string[] {
    const errors: string[] = [];

    for (const schema of this.schemas.values()) {
      if (!schema.extends) continue;

      // Parent must exist
      if (!this.schemas.has(schema.extends)) {
        errors.push(
          `Schema "${schema.name}" extends unknown schema "${schema.extends}"`,
        );
        continue;
      }

      // Check for circular inheritance
      const visited = new Set<string>();
      let current: SchemaDefinition | undefined = schema;
      while (current?.extends) {
        if (visited.has(current.name)) {
          errors.push(
            `Circular inheritance detected involving schema "${current.name}"`,
          );
          break;
        }
        visited.add(current.name);
        current = this.schemas.get(current.extends);
      }

      // Check depth (chain includes self, so ancestor count = chain.length - 1)
      const chain = this.getInheritanceChain(schema.name);
      const ancestorDepth = chain.length - 1;
      if (ancestorDepth >= MAX_INHERITANCE_DEPTH) {
        errors.push(
          `Inheritance depth ${ancestorDepth} exceeds maximum of ${MAX_INHERITANCE_DEPTH} for schema "${schema.name}"`,
        );
      }
    }

    return errors;
  }
}

// ── Factory ─────────────────────────────────────────────────────

/** Create a new SchemaRegistry instance */
export function createSchemaRegistry(): SchemaRegistry {
  return new SchemaRegistry();
}
