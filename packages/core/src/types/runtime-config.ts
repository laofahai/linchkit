/**
 * Runtime configuration types — dynamic KV config managed at runtime.
 *
 * These complement the static ConfigRegistry (Zod-based, startup-time)
 * with a runtime-mutable config layer stored in-memory (DB persistence later).
 *
 * See spec 42 section 9.1 for the full design.
 */

/** Scalar types supported by runtime config fields */
export type ConfigFieldType = "string" | "number" | "boolean" | "json";

/** Validation constraints for a config field */
export interface ConfigFieldValidation {
  /** Minimum value (for number fields) or minimum length (for string fields) */
  min?: number;
  /** Maximum value (for number fields) or maximum length (for string fields) */
  max?: number;
  /** Regex pattern (for string fields) */
  pattern?: string;
}

/** Definition of a single config field */
export interface ConfigFieldDefinition {
  /** Field data type */
  type: ConfigFieldType;
  /** Human-readable label */
  label?: string;
  /** Description for documentation / UI tooltips */
  description?: string;
  /** Whether the field must have a value */
  required?: boolean;
  /** Default value when not explicitly set */
  default?: unknown;
  /** Whether the value is sensitive (stored encrypted, masked in UI) */
  secret?: boolean;
  /** Validation constraints */
  validation?: ConfigFieldValidation;
}

/**
 * A runtime config definition — declares a named config namespace
 * with typed fields and default values.
 */
export interface ConfigDefinition {
  /** Unique config namespace name (e.g. 'approval-settings') */
  name: string;
  /** Which capability or entity owns this config */
  entity: string;
  /** Human-readable label */
  label?: string;
  /** Field definitions keyed by field name */
  fields: Record<string, ConfigFieldDefinition>;
  /** Default values for all fields (convenience — overlaps with field-level defaults) */
  defaults: Record<string, unknown>;
}
