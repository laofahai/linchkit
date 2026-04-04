/**
 * Entity Registry
 *
 * Manages entity definitions, extensions, and overrides.
 * Resolves entities by injecting system fields, merging extensions/overrides,
 * and wrapping each field with resolution metadata (storable flag, label).
 *
 * Supports single inheritance via `extends` and abstract entities.
 */

import type {
  FieldDefinition,
  ResolvedField,
  ResolvedSchema,
  EntityDefinition,
  EntityExtension,
  EntityOverride,
} from "../types/entity";
import type { InterfaceRegistry } from "./entity-interface";

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

// ── EntityRegistry ──────────────────────────────────────────────

export class EntityRegistry {
  private entities = new Map<string, EntityDefinition>();
  private extensions = new Map<string, EntityExtension[]>();
  private overrides = new Map<string, EntityOverride[]>();
  private _interfaceRegistry: InterfaceRegistry | null = null;
  /** Entity names registered via registerInternal() — system-managed, read-only in UI */
  private _internalEntities = new Set<string>();

  /** Set the InterfaceRegistry for interface validation and field injection */
  setInterfaceRegistry(registry: InterfaceRegistry): void {
    this._interfaceRegistry = registry;
  }

  /** Get the associated InterfaceRegistry (if any) */
  getInterfaceRegistry(): InterfaceRegistry | null {
    return this._interfaceRegistry;
  }

  /**
   * Register an entity definition.
   * Throws if an entity with the same name is already registered.
   * Validates inheritance constraints (parent exists, no circular refs, depth limit).
   * Validates interface implementation if InterfaceRegistry is set.
   */
  register(schema: EntityDefinition): void {
    if (!schema.name) {
      throw new Error("Entity must have a name");
    }
    if (!schema.fields || Object.keys(schema.fields).length === 0) {
      throw new Error(`Entity "${schema.name}" must have at least one field`);
    }
    if (this.entities.has(schema.name)) {
      throw new Error(`Entity "${schema.name}" is already registered`);
    }

    // Validate inheritance constraints
    if (schema.extends) {
      const parent = this.entities.get(schema.extends);
      if (!parent) {
        throw new Error(`Entity "${schema.name}" extends unknown entity "${schema.extends}"`);
      }

      // Check inheritance depth (walk up the chain)
      let depth = 1;
      let current: EntityDefinition | undefined = parent;
      const visited = new Set<string>([schema.name]);
      while (current?.extends) {
        if (visited.has(current.extends)) {
          throw new Error(
            `Circular inheritance detected: "${schema.name}" -> "${current.extends}"`,
          );
        }
        visited.add(current.extends);
        depth++;
        current = this.entities.get(current.extends);
      }

      if (depth >= MAX_INHERITANCE_DEPTH) {
        throw new Error(
          `Inheritance depth exceeds maximum of ${MAX_INHERITANCE_DEPTH} levels for entity "${schema.name}"`,
        );
      }

      // Validate field type conflicts: child cannot change parent field's type
      const parentFields = this.collectInheritedFields(schema.extends);
      for (const [fname, fdef] of Object.entries(schema.fields)) {
        const parentField = parentFields[fname];
        if (parentField && fdef.type !== parentField.type) {
          throw new Error(
            `Entity "${schema.name}" cannot change type of inherited field "${fname}" ` +
              `from "${parentField.type}" to "${fdef.type}"`,
          );
        }
      }
    }

    // Validate interface implementation
    if (schema.implements && schema.implements.length > 0 && this._interfaceRegistry) {
      // Build resolved fields including inherited ones for interface validation
      const resolvedFields = schema.extends
        ? { ...this.collectInheritedFields(schema.extends), ...schema.fields }
        : undefined;
      const errors = this._interfaceRegistry.validateImplementation(schema, resolvedFields);
      if (errors.length > 0) {
        throw new Error(errors[0]);
      }
      // Register the entity as an implementor
      this._interfaceRegistry.registerImplementor(schema.name, schema.implements);
    }

    this.entities.set(schema.name, schema);
  }

  /**
   * Register a system-internal entity (e.g. execution_log, approval).
   *
   * Only the core system should call this — capability authors use `register()`.
   * Internal entities:
   * - Use system tables or in-memory registries as data source
   * - Are read-only in the UI (no create/update/delete)
   * - Skip inheritance and interface validation (they are standalone)
   * - Do NOT get standard system fields injected (they define their own)
   */
  registerInternal(schema: EntityDefinition): void {
    if (!schema.name) {
      throw new Error("Entity must have a name");
    }
    if (!schema.fields || Object.keys(schema.fields).length === 0) {
      throw new Error(`Entity "${schema.name}" must have at least one field`);
    }
    if (this.entities.has(schema.name)) {
      throw new Error(`Entity "${schema.name}" is already registered`);
    }
    this.entities.set(schema.name, schema);
    this._internalEntities.add(schema.name);
  }

  /** Check if an entity was registered as internal (system-managed) */
  isInternal(name: string): boolean {
    return this._internalEntities.has(name);
  }

  /** Get all internal entity names */
  getInternalNames(): string[] {
    return Array.from(this._internalEntities);
  }

  /**
   * Apply an extension to a registered entity (adds new fields).
   * The extension is stored and merged at resolve time.
   */
  applyExtension(name: string, extension: EntityExtension): void {
    if (!this.entities.has(name)) {
      throw new Error(`Cannot extend unknown entity "${name}"`);
    }
    const list = this.extensions.get(name) ?? [];
    list.push(extension);
    this.extensions.set(name, list);
  }

  /**
   * Apply an override to a registered entity (modifies field constraints).
   * The override is stored and applied at resolve time.
   */
  applyOverride(name: string, override: EntityOverride): void {
    if (!this.entities.has(name)) {
      throw new Error(`Cannot override unknown entity "${name}"`);
    }
    this.overrides.set(name, [...(this.overrides.get(name) ?? []), override]);
  }

  /**
   * Collect all inherited fields from the full ancestor chain for an entity.
   * Used for field type conflict validation at registration time.
   */
  private collectInheritedFields(name: string): Record<string, FieldDefinition> {
    const fields: Record<string, FieldDefinition> = {};
    const chain = this.getInheritanceChain(name);
    // chain includes `name` itself as last element; iterate all
    for (const schemaName of chain) {
      const schema = this.entities.get(schemaName);
      if (schema) {
        Object.assign(fields, schema.fields);
      }
    }
    return fields;
  }

  /**
   * Collect the full inheritance chain for an entity (from root ancestor to self).
   * Returns an array of entity names ordered from root to self.
   */
  getInheritanceChain(name: string): string[] {
    const chain: string[] = [];
    let current = this.entities.get(name);
    while (current) {
      chain.unshift(current.name);
      current = current.extends ? this.entities.get(current.extends) : undefined;
    }
    return chain;
  }

  /**
   * Get direct children of an entity (entities that extend it).
   */
  getChildren(name: string): string[] {
    const children: string[] = [];
    for (const schema of this.entities.values()) {
      if (schema.extends === name) {
        children.push(schema.name);
      }
    }
    return children;
  }

  /**
   * Get all descendants of an entity recursively (children, grandchildren, etc.).
   */
  getAllDescendants(name: string): string[] {
    const descendants: string[] = [];
    const queue = this.getChildren(name);
    while (queue.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: length checked above
      const child = queue.shift()!;
      descendants.push(child);
      queue.push(...this.getChildren(child));
    }
    return descendants;
  }

  /**
   * Resolve an entity: inject system fields, merge inherited fields,
   * merge extensions and overrides, and wrap each field in ResolvedField with metadata.
   */
  resolve(name: string): ResolvedSchema {
    const schema = this.entities.get(name);
    if (!schema) {
      throw new Error(`Entity "${name}" is not registered`);
    }

    const fields: Record<string, ResolvedField> = {};
    const isInternal = this._internalEntities.has(name);

    // Internal entities define their own fields — skip system field injection
    if (!isInternal) {
      // Start with system fields
      for (const [fname, fdef] of Object.entries(SYSTEM_FIELDS)) {
        fields[fname] = resolveField(fname, fdef);
      }
    }

    // Inject interface fields (before inherited + own fields, so they can be overridden)
    if (schema.implements && schema.implements.length > 0 && this._interfaceRegistry) {
      const injected = this._interfaceRegistry.getInjectedFields(schema);
      for (const [fname, fdef] of Object.entries(injected)) {
        fields[fname] = resolveField(fname, fdef);
      }
    }

    // Merge inherited fields (from root ancestor down to parent)
    if (schema.extends) {
      const chain = this.getInheritanceChain(name);
      // Apply fields from each ancestor (excluding self, which is last in chain)
      for (let i = 0; i < chain.length - 1; i++) {
        // biome-ignore lint/style/noNonNullAssertion: index is within bounds
        const ancestor = this.entities.get(chain[i]!);
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
      internal: isInternal || undefined,
      parent: schema.extends,
      children: this.getChildren(name),
      implements: schema.implements,
      presentation: schema.presentation,
      fields,
      source: schema,
    };
  }

  /** Get the raw entity definition by name */
  get(name: string): EntityDefinition | undefined {
    return this.entities.get(name);
  }

  /** Get all registered entity definitions */
  getAll(): EntityDefinition[] {
    return Array.from(this.entities.values());
  }

  /**
   * Get all concrete (non-abstract) entity definitions.
   * Useful for table generation, action registration, etc.
   */
  getConcrete(): EntityDefinition[] {
    return Array.from(this.entities.values()).filter((s) => !s.abstract);
  }

  /** Check if an entity is registered */
  has(name: string): boolean {
    return this.entities.has(name);
  }

  /**
   * Validate all inheritance constraints across all registered entities.
   * Call after all entities have been registered to catch issues early.
   * Returns an array of error messages (empty if valid).
   */
  validateInheritance(): string[] {
    const errors: string[] = [];

    for (const schema of this.entities.values()) {
      if (!schema.extends) continue;

      // Parent must exist
      if (!this.entities.has(schema.extends)) {
        errors.push(`Entity "${schema.name}" extends unknown entity "${schema.extends}"`);
        continue;
      }

      // Check for circular inheritance
      const visited = new Set<string>();
      let current: EntityDefinition | undefined = schema;
      while (current?.extends) {
        if (visited.has(current.name)) {
          errors.push(`Circular inheritance detected involving schema "${current.name}"`);
          break;
        }
        visited.add(current.name);
        current = this.entities.get(current.extends);
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

/** Create a new EntityRegistry instance */
export function createEntityRegistry(): EntityRegistry {
  return new EntityRegistry();
}
