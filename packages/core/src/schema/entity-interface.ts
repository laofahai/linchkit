/**
 * Schema Interface Registry
 *
 * Manages InterfaceDefinitions — contracts that multiple schemas can implement.
 * Provides validation, field injection, state machine merging, and bidirectional lookup
 * (interface -> implementors, schema -> interfaces).
 *
 * Validation chain (spec 47 §9):
 * 1. All declared interfaces must exist
 * 2. Field type compatibility (schema field vs interface field)
 * 3. Cross-interface field type conflicts
 * 4. Enum value compatibility (schema enum must be superset of interface enum)
 * 5. Required constraint compatibility (interface required=true cannot be weakened)
 * 6. Cross-interface state machine conflicts (initial state, transition overlap)
 * 7. Schema state machine must be superset of interface state machine (if both defined)
 *
 * See spec: docs/specs/47_schema_interface.md
 */

import type {
  FieldDefinition,
  InterfaceDefinition,
  InterfaceStateTemplate,
  EntityDefinition,
} from "../types/entity";
import type { StateDefinition } from "../types/state";

// ── Helpers ───────────────────────────────────────────────────

function transitionKey(t: { from: string; to: string; action: string }): string {
  return `${t.from}->${t.to}@${t.action}`;
}

/** Safely extract enum values from a field definition (may be a non-typed extra key) */
function getFieldEnum(field: FieldDefinition): unknown[] | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: field union types don't declare `enum`
  return (field as any).enum as unknown[] | undefined;
}

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
   * Called by EntityRegistry during schema registration.
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
   * 1. All declared interfaces exist
   * 2. If schema has a field with same name as interface field, types must match
   * 3. Multiple interfaces with same field name must have compatible types
   * 4. Enum values compatibility (schema enum must be superset of interface enum)
   * 5. Required constraint: interface required=true cannot be weakened to false
   * 6. Cross-interface state machine conflicts
   *
   * @param schema - The schema definition to validate
   * @param resolvedFields - Optional pre-resolved fields including inherited fields from parent schemas.
   *   When provided, these are used instead of `schema.fields` for field compatibility checks,
   *   ensuring that fields inherited via `extends` are considered during validation.
   */
  validateImplementation(
    schema: EntityDefinition,
    resolvedFields?: Record<string, FieldDefinition>,
  ): string[] {
    const errors: string[] = [];
    const interfaceNames = schema.implements ?? [];
    if (interfaceNames.length === 0) return errors;

    // Collect all interface fields to detect cross-interface conflicts
    const seenFields = new Map<
      string,
      { type: string; fromInterface: string; field: FieldDefinition }
    >();

    const resolvedInterfaces: InterfaceDefinition[] = [];
    const effectiveFields: Record<string, FieldDefinition> = resolvedFields ?? schema.fields;

    for (const ifaceName of interfaceNames) {
      const iface = this.interfaces.get(ifaceName);
      if (!iface) {
        errors.push(
          `Schema "${schema.name}" declares implements "${ifaceName}" but interface "${ifaceName}" is not registered`,
        );
        continue;
      }
      resolvedInterfaces.push(iface);

      for (const [fieldName, ifaceField] of Object.entries(iface.fields)) {
        // Check cross-interface field conflicts
        const seen = seenFields.get(fieldName);
        if (seen) {
          if (seen.type !== ifaceField.type) {
            errors.push(
              `Schema "${schema.name}": interfaces "${seen.fromInterface}" and "${ifaceName}" both define field "${fieldName}" with incompatible types ("${seen.type}" vs "${ifaceField.type}")`,
            );
          }
          // Check cross-interface enum conflicts
          const seenEnum = getFieldEnum(seen.field);
          const ifaceEnum = getFieldEnum(ifaceField);
          if (seenEnum && ifaceEnum) {
            const seenSet = new Set(seenEnum.map(String));
            const ifaceSet = new Set(ifaceEnum.map(String));
            // Enum values from two interfaces on the same field must be identical
            const symmetric =
              seenSet.size === ifaceSet.size && [...seenSet].every((v) => ifaceSet.has(v));
            if (!symmetric) {
              errors.push(
                `Schema "${schema.name}": interfaces "${seen.fromInterface}" and "${ifaceName}" define field "${fieldName}" with conflicting enum values`,
              );
            }
          }
        } else {
          seenFields.set(fieldName, {
            type: ifaceField.type,
            fromInterface: ifaceName,
            field: ifaceField,
          });
        }

        // Check schema field type compatibility (if schema already defines the field)
        // Use effectiveFields which includes inherited fields when resolvedFields is provided
        const schemaField = effectiveFields[fieldName] as FieldDefinition | undefined;
        if (schemaField) {
          // Type must match
          if (schemaField.type !== ifaceField.type) {
            errors.push(
              `Schema "${schema.name}": field "${fieldName}" has type "${schemaField.type}" but interface "${ifaceName}" requires type "${ifaceField.type}"`,
            );
          }

          // Enum compatibility: schema enum must be superset of interface enum
          const ifaceEnum = getFieldEnum(ifaceField);
          const schemaEnum = getFieldEnum(schemaField);
          if (ifaceEnum && ifaceEnum.length > 0) {
            if (!schemaEnum) {
              errors.push(
                `Schema "${schema.name}": field "${fieldName}" must define enum values required by interface "${ifaceName}"`,
              );
            } else {
              const schemaEnumSet = new Set(schemaEnum.map(String));
              for (const val of ifaceEnum) {
                if (!schemaEnumSet.has(String(val))) {
                  errors.push(
                    `Schema "${schema.name}": field "${fieldName}" enum is missing value "${val}" required by interface "${ifaceName}"`,
                  );
                }
              }
            }
          }

          // Required constraint: interface required=true cannot be weakened
          if (ifaceField.required === true && schemaField.required === false) {
            errors.push(
              `Schema "${schema.name}": field "${fieldName}" is required by interface "${ifaceName}" but schema declares it as not required`,
            );
          }
        }
      }
    }

    // Validate cross-interface state machine conflicts
    errors.push(...this.validateCrossInterfaceStateConflicts(schema.name, resolvedInterfaces));

    return errors;
  }

  /**
   * Validate that multiple interfaces' state machines do not conflict.
   * Conflicts: different initial states, or same transition key with different targets.
   */
  private validateCrossInterfaceStateConflicts(
    schemaName: string,
    interfaces: InterfaceDefinition[],
  ): string[] {
    const errors: string[] = [];
    const withState = interfaces.filter((i) => i.state);
    if (withState.length < 2) return errors;

    // Check initial state conflict
    const initials = new Map<string, string>();
    for (const iface of withState) {
      // biome-ignore lint/style/noNonNullAssertion: filtered above
      const state = iface.state!;
      const existing = initials.get(state.initial);
      if (existing === undefined) {
        initials.set(state.initial, iface.name);
      }
    }
    if (initials.size > 1) {
      const pairs = Array.from(initials.entries())
        .map(([initial, ifaceName]) => `"${ifaceName}" (initial="${initial}")`)
        .join(", ");
      errors.push(`Schema "${schemaName}": conflicting initial states from interfaces: ${pairs}`);
    }

    // Check transition conflicts (same from+action but different to)
    const transitionMap = new Map<string, { to: string; fromInterface: string }>();
    for (const iface of withState) {
      // biome-ignore lint/style/noNonNullAssertion: filtered above
      for (const t of iface.state!.transitions) {
        const key = `${t.from}@${t.action}`;
        const existing = transitionMap.get(key);
        if (existing && existing.to !== t.to) {
          errors.push(
            `Schema "${schemaName}": interfaces "${existing.fromInterface}" and "${iface.name}" define conflicting transition from "${t.from}" on action "${t.action}" (to "${existing.to}" vs "${t.to}")`,
          );
        } else if (!existing) {
          transitionMap.set(key, { to: t.to, fromInterface: iface.name });
        }
      }
    }

    return errors;
  }

  /**
   * Validate that a schema's state definition is a superset of all interface state templates.
   * Called after state definitions are available (e.g., during startup wiring).
   *
   * Per spec 47 §3.2:
   * - If interface has state and schema has custom state, schema must include
   *   all interface transitions (superset check).
   * - If interface has state and schema has no custom state, interface state is used as-is.
   */
  validateStateCompatibility(schemaName: string, schemaState: StateDefinition | null): string[] {
    const errors: string[] = [];
    const ifaceNames = this.schemaToInterfaces.get(schemaName);
    if (!ifaceNames) return errors;

    for (const ifaceName of ifaceNames) {
      const iface = this.interfaces.get(ifaceName);
      if (!iface?.state) continue;

      // If schema has no custom state, interface state will be used (no error)
      if (!schemaState) continue;

      // Schema state must be a superset of interface state template
      const ifaceState = iface.state;

      // Check that schema's initial state matches interface's initial state
      if (schemaState.initial !== ifaceState.initial) {
        errors.push(
          `Schema "${schemaName}": state initial "${schemaState.initial}" does not match interface "${ifaceName}" initial "${ifaceState.initial}"`,
        );
      }

      // Check that all interface transitions exist in schema state
      for (const it of ifaceState.transitions) {
        const found = schemaState.transitions.some((st) => {
          const fromMatches = Array.isArray(st.from)
            ? st.from.includes(it.from)
            : st.from === it.from;
          return fromMatches && st.to === it.to && st.action === it.action;
        });
        if (!found) {
          errors.push(
            `Schema "${schemaName}": state is missing transition "${it.from}" -> "${it.to}" (action: "${it.action}") required by interface "${ifaceName}"`,
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
   *
   * @param schema - The schema definition
   * @param resolvedFields - Optional pre-resolved fields including inherited fields
   */
  getInjectedFields(
    schema: EntityDefinition,
    resolvedFields?: Record<string, FieldDefinition>,
  ): Record<string, FieldDefinition> {
    const interfaceNames = schema.implements ?? [];
    const injected: Record<string, FieldDefinition> = {};
    const effectiveFields: Record<string, FieldDefinition> = resolvedFields ?? schema.fields;

    for (const ifaceName of interfaceNames) {
      const iface = this.interfaces.get(ifaceName);
      if (!iface) continue;

      for (const [fieldName, ifaceField] of Object.entries(iface.fields)) {
        // Only inject if schema does not already define this field (including inherited fields)
        if (!(fieldName in effectiveFields)) {
          // Later interface wins if multiple define the same field (already validated compatible)
          injected[fieldName] = ifaceField;
        }
      }
    }

    return injected;
  }

  /**
   * Get the merged state machine template from all interfaces a schema implements.
   * Returns null if no interface defines a state template.
   * Merges transitions from all interfaces (already validated for conflicts).
   */
  getMergedStateTemplate(schemaName: string): InterfaceStateTemplate | null {
    const ifaceNames = this.schemaToInterfaces.get(schemaName);
    if (!ifaceNames) return null;

    let merged: InterfaceStateTemplate | null = null;
    const seenTransitions = new Set<string>();

    for (const ifaceName of ifaceNames) {
      const iface = this.interfaces.get(ifaceName);
      if (!iface?.state) continue;

      if (!merged) {
        merged = {
          initial: iface.state.initial,
          transitions: [],
        };
      }

      for (const t of iface.state.transitions) {
        const key = transitionKey(t);
        if (!seenTransitions.has(key)) {
          seenTransitions.add(key);
          merged.transitions.push({ ...t });
        }
      }
    }

    return merged;
  }
}

// ── Factory ─────────────────────────────────────────────────────

/** Create a new InterfaceRegistry instance */
export function createInterfaceRegistry(): InterfaceRegistry {
  return new InterfaceRegistry();
}
