/**
 * RuntimeConfigRegistry — dynamic key-value config store.
 *
 * Provides registration of ConfigDefinitions, and get/set of individual
 * field values with validation against field definitions.
 *
 * Storage: in-memory Map. DB persistence will be added in a later milestone.
 */

import { ValidationError } from "../errors";
import type {
  ConfigDefinition,
  ConfigFieldDefinition,
  ConfigFieldType,
} from "../types/runtime-config";

/** Error thrown when config validation fails */
export class ConfigValidationError extends ValidationError {
  constructor(
    public readonly configName: string,
    public readonly fieldName: string,
    public readonly reason: string,
  ) {
    super({
      message: `Config "${configName}.${fieldName}": ${reason}`,
      code: "config.validation.failed",
      fields: [{ field: `${configName}.${fieldName}`, message: reason }],
    });
    this.name = "ConfigValidationError";
  }
}

/**
 * Validate a value against a ConfigFieldDefinition.
 * Returns an error message string on failure, or null on success.
 */
function validateField(
  fieldName: string,
  value: unknown,
  field: ConfigFieldDefinition,
): string | null {
  // Required check
  if (field.required && (value === undefined || value === null)) {
    return `field "${fieldName}" is required`;
  }

  // Allow undefined/null for optional fields
  if (value === undefined || value === null) {
    return null;
  }

  // Type check
  if (!matchesType(value, field.type)) {
    return `field "${fieldName}" expected type "${field.type}", got "${typeof value}"`;
  }

  // Validation constraints
  if (field.validation) {
    const v = field.validation;

    if (field.type === "number" && typeof value === "number") {
      if (v.min !== undefined && value < v.min) {
        return `field "${fieldName}" must be >= ${v.min}`;
      }
      if (v.max !== undefined && value > v.max) {
        return `field "${fieldName}" must be <= ${v.max}`;
      }
    }

    if (field.type === "string" && typeof value === "string") {
      if (v.min !== undefined && value.length < v.min) {
        return `field "${fieldName}" length must be >= ${v.min}`;
      }
      if (v.max !== undefined && value.length > v.max) {
        return `field "${fieldName}" length must be <= ${v.max}`;
      }
      if (v.pattern) {
        try {
          const regex = new RegExp(v.pattern);
          if (!regex.test(value)) {
            return `field "${fieldName}" must match pattern "${v.pattern}"`;
          }
        } catch {
          return `field "${fieldName}" has invalid validation pattern "${v.pattern}"`;
        }
      }
    }
  }

  return null;
}

/** Check if a value matches the expected ConfigFieldType */
function matchesType(value: unknown, type: ConfigFieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && !Number.isNaN(value);
    case "boolean":
      return typeof value === "boolean";
    case "json":
      // Any non-primitive is valid JSON (objects, arrays), plus primitives
      return true;
    default:
      return false;
  }
}

/** A single version history entry for a config field change */
export interface ConfigValueHistoryEntry {
  configName: string;
  fieldName: string;
  oldValue: unknown;
  newValue: unknown;
  changedAt: string;
  changedBy?: string;
}

export class RuntimeConfigRegistry {
  /** Registered config definitions */
  private readonly definitions = new Map<string, ConfigDefinition>();

  /** In-memory value store: configName -> fieldName -> value */
  private readonly store = new Map<string, Map<string, unknown>>();

  /** Version history: configName -> list of change entries (newest first) */
  private readonly history = new Map<string, ConfigValueHistoryEntry[]>();

  /** Register a config definition. Throws if name is already registered. */
  register(config: ConfigDefinition): void {
    if (this.definitions.has(config.name)) {
      throw new Error(`Config "${config.name}" is already registered`);
    }
    this.definitions.set(config.name, config);
    // Initialize store with defaults
    const values = new Map<string, unknown>();
    for (const [fieldName, field] of Object.entries(config.fields)) {
      // Field-level default takes precedence; fall back to top-level defaults
      const defaultValue = field.default !== undefined ? field.default : config.defaults[fieldName];
      if (defaultValue !== undefined) {
        values.set(fieldName, defaultValue);
      }
    }
    this.store.set(config.name, values);
  }

  /** Get a config definition by name, or undefined if not registered */
  get(name: string): ConfigDefinition | undefined {
    return this.definitions.get(name);
  }

  /** List all registered config definitions */
  list(): ConfigDefinition[] {
    return Array.from(this.definitions.values());
  }

  /** Get all config definitions owned by a specific schema/capability */
  configsFor(schema: string): ConfigDefinition[] {
    return Array.from(this.definitions.values()).filter((c) => c.entity === schema);
  }

  /**
   * Get a field value, resolving with defaults if not explicitly set.
   *
   * Resolution order:
   * 1. Explicitly set value (via setValue)
   * 2. Field-level default
   * 3. Top-level defaults
   * 4. undefined
   */
  getValue(configName: string, fieldName: string): unknown {
    const def = this.definitions.get(configName);
    if (!def) {
      throw new Error(`Config "${configName}" is not registered`);
    }
    const field = def.fields[fieldName];
    if (!field) {
      throw new Error(`Config "${configName}" has no field "${fieldName}"`);
    }

    const values = this.store.get(configName);
    if (values?.has(fieldName)) {
      return values.get(fieldName);
    }

    // Fall back to defaults
    if (field.default !== undefined) return field.default;
    if (def.defaults[fieldName] !== undefined) return def.defaults[fieldName];
    return undefined;
  }

  /**
   * Get all resolved values for a config definition as a plain object.
   * Each field is resolved via getValue (explicit value -> default -> undefined).
   */
  getValues(configName: string): Record<string, unknown> {
    const def = this.definitions.get(configName);
    if (!def) {
      throw new Error(`Config "${configName}" is not registered`);
    }
    const result: Record<string, unknown> = {};
    for (const fieldName of Object.keys(def.fields)) {
      result[fieldName] = this.getValue(configName, fieldName);
    }
    return result;
  }

  /**
   * Set a field value. Validates the value against the field definition.
   * Records the change in version history.
   * Throws ConfigValidationError on validation failure.
   */
  setValue(configName: string, fieldName: string, value: unknown, changedBy?: string): void {
    const def = this.definitions.get(configName);
    if (!def) {
      throw new Error(`Config "${configName}" is not registered`);
    }
    const field = def.fields[fieldName];
    if (!field) {
      throw new Error(`Config "${configName}" has no field "${fieldName}"`);
    }

    const error = validateField(fieldName, value, field);
    if (error) {
      throw new ConfigValidationError(configName, fieldName, error);
    }

    const oldValue = this.store.get(configName)?.get(fieldName);

    let values = this.store.get(configName);
    if (!values) {
      values = new Map();
      this.store.set(configName, values);
    }
    values.set(fieldName, value);

    // Record history entry
    const entries = this.history.get(configName) ?? [];
    entries.unshift({
      configName,
      fieldName,
      oldValue,
      newValue: value,
      changedAt: new Date().toISOString(),
      changedBy,
    });
    // Keep last 100 entries per config to prevent unbounded growth
    if (entries.length > 100) entries.length = 100;
    this.history.set(configName, entries);
  }

  /**
   * Get version history for a config namespace.
   * Returns entries newest-first, optionally filtered by fieldName.
   */
  getHistory(configName: string, fieldName?: string): ConfigValueHistoryEntry[] {
    if (!this.definitions.has(configName)) {
      throw new Error(`Config "${configName}" is not registered`);
    }
    const entries = this.history.get(configName) ?? [];
    return fieldName ? entries.filter((e) => e.fieldName === fieldName) : entries;
  }
}
