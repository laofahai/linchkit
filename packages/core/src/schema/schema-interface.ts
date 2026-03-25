/**
 * Schema Interface Registry
 *
 * Manages InterfaceDefinitions — contracts that multiple schemas can implement.
 * Provides validation, field injection, and bidirectional lookup
 * (interface -> implementors, schema -> interfaces).
 *
 * See spec: docs/specs/47_schema_interface.md
 */

import type { FieldDefinition, InterfaceDefinition, SchemaDefinition } from "../types/schema";

// ── InterfaceRegistry ──────────────────────────────────────────

export class InterfaceRegistry {
  private interfaces = new Map<string, InterfaceDefinition>();
  /** schema name -> set of interface names */
  private schemaToInterfaces = new Map<string, Set<string>>();
  /** interface name -> set of schema names */
  private interfaceToSchemas = new Map<string, Set<string>>();

  /**
   * Register an interface definition.
   * Throws if an interface with the same name is already registered.
   */
  register(iface: InterfaceDefinition): void {
    if (!iface.name) {
      throw new Error("Interface must have a name");
    }
    if (!iface.label) {
      throw new Error(`Interface "${iface.name}" must have a label`);
    }
    if (!iface.fields || Object.keys(iface.fields).length === 0) {
      throw new Error(`Interface "${iface.name}" must have at least one field`);
    }
    if (this.interfaces.has(iface.name)) {
      throw new Error(`Interface "${iface.name}" is already registered`);
    }
    this.interfaces.set(iface.name, iface);
    // Initialize implementor set
    if (!this.interfaceToSchemas.has(iface.name)) {
      this.interfaceToSchemas.set(iface.name, new Set());
    }
  }

  /** Get an interface definition by name */
  get(name: string): InterfaceDefinition | undefined {
    return this.interfaces.get(name);
  }

  /** Check if an interface is registered */
  has(name: string): boolean {
    return this.interfaces.has(name);
  }

  /** List all registered interfaces */
  list(): InterfaceDefinition[] {
    return Array.from(this.interfaces.values());
  }

  /**
   * Register that a schema implements certain interfaces.
   * Called by SchemaRegistry during schema registration.
   */
  registerImplementor(schemaName: string, interfaceNames: string[]): void {
    for (const ifaceName of interfaceNames) {
      // Track schema -> interfaces
      let schemaSet = this.schemaToInterfaces.get(schemaName);
      if (!schemaSet) {
        schemaSet = new Set();
        this.schemaToInterfaces.set(schemaName, schemaSet);
      }
      schemaSet.add(ifaceName);

      // Track interface -> schemas
      let ifaceSet = this.interfaceToSchemas.get(ifaceName);
      if (!ifaceSet) {
        ifaceSet = new Set();
        this.interfaceToSchemas.set(ifaceName, ifaceSet);
      }
      ifaceSet.add(schemaName);
    }
  }

  /** Get all interfaces a schema implements */
  interfacesOf(schemaName: string): InterfaceDefinition[] {
    const names = this.schemaToInterfaces.get(schemaName);
    if (!names) return [];
    return Array.from(names)
      .map((n) => this.interfaces.get(n))
      .filter((v): v is InterfaceDefinition => v != null);
  }

  /** Get all schema names that implement a given interface */
  implementors(interfaceName: string): string[] {
    const set = this.interfaceToSchemas.get(interfaceName);
    return set ? Array.from(set) : [];
  }

  /** Check if a schema implements a specific interface */
  implements(schemaName: string, interfaceName: string): boolean {
    const set = this.schemaToInterfaces.get(schemaName);
    return set?.has(interfaceName) ?? false;
  }

  /**
   * Validate that a schema correctly implements its declared interfaces.
   * Returns an array of error messages (empty if valid).
   *
   * Checks:
   * - All declared interfaces exist
   * - If schema has a field with same name as interface field, types must match
   * - Multiple interfaces with same field name must have compatible types
   */
  validateImplementation(schema: SchemaDefinition): string[] {
    const errors: string[] = [];
    const interfaceNames = schema.implements ?? [];
    if (interfaceNames.length === 0) return errors;

    // Collect all interface fields to detect cross-interface conflicts
    const seenFields = new Map<string, { type: string; fromInterface: string }>();

    for (const ifaceName of interfaceNames) {
      const iface = this.interfaces.get(ifaceName);
      if (!iface) {
        errors.push(
          `Schema "${schema.name}" declares implements "${ifaceName}" but interface "${ifaceName}" is not registered`,
        );
        continue;
      }

      for (const [fieldName, ifaceField] of Object.entries(iface.fields)) {
        // Check cross-interface field conflicts
        const seen = seenFields.get(fieldName);
        if (seen && seen.type !== ifaceField.type) {
          errors.push(
            `Schema "${schema.name}": interfaces "${seen.fromInterface}" and "${ifaceName}" both define field "${fieldName}" with incompatible types ("${seen.type}" vs "${ifaceField.type}")`,
          );
        } else if (!seen) {
          seenFields.set(fieldName, { type: ifaceField.type, fromInterface: ifaceName });
        }

        // Check schema field type compatibility (if schema already defines the field)
        const schemaField = schema.fields[fieldName] as FieldDefinition | undefined;
        if (schemaField && schemaField.type !== ifaceField.type) {
          errors.push(
            `Schema "${schema.name}": field "${fieldName}" has type "${schemaField.type}" but interface "${ifaceName}" requires type "${ifaceField.type}"`,
          );
        }
      }
    }

    return errors;
  }

  /**
   * Get the merged interface fields for a schema's declared interfaces.
   * Schema's own fields take priority (they can override defaults but not types).
   * Returns fields that should be injected (not already in schema).
   */
  getInjectedFields(schema: SchemaDefinition): Record<string, FieldDefinition> {
    const interfaceNames = schema.implements ?? [];
    const injected: Record<string, FieldDefinition> = {};

    for (const ifaceName of interfaceNames) {
      const iface = this.interfaces.get(ifaceName);
      if (!iface) continue;

      for (const [fieldName, ifaceField] of Object.entries(iface.fields)) {
        // Only inject if schema does not already define this field
        if (!(fieldName in schema.fields)) {
          // Later interface wins if multiple define the same field (already validated compatible)
          injected[fieldName] = ifaceField;
        }
      }
    }

    return injected;
  }
}

// ── Factory ─────────────────────────────────────────────────────

/** Create a new InterfaceRegistry instance */
export function createInterfaceRegistry(): InterfaceRegistry {
  return new InterfaceRegistry();
}
