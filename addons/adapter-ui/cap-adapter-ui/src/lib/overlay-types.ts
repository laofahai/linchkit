/**
 * Local overlay type definitions for the UI package.
 *
 * These mirror the types from @linchkit/core/types/overlay.ts.
 * Defined locally to avoid build dependency on unreleased core types.
 * When core is rebuilt with overlay support, these can be replaced with
 * imports from @linchkit/core/types.
 */

/** Supported overlay field types (subset of core field types) */
export type OverlayFieldType = "string" | "number" | "boolean" | "date" | "enum" | "json";

/** Configuration for an overlay field */
export interface OverlayFieldConfig {
  /** i18n labels keyed by locale, e.g. { en: "Color", "zh-CN": "颜色" } */
  label?: Record<string, string>;
  /** Human-readable description */
  description?: string;
  /** Whether the field is required */
  required?: boolean;
  /** Default value for the field */
  defaultValue?: unknown;
  /** Allowed values for enum-type fields */
  enumValues?: string[];
  /** Minimum value for number-type fields */
  min?: number;
  /** Maximum value for number-type fields */
  max?: number;
  /** Maximum character length for string-type fields */
  maxLength?: number;
}

/** Persisted overlay record (from GET /api/overlays/:entityName) */
export interface FieldOverlayRecord {
  id: string;
  entityName: string;
  fieldName: string;
  fieldType: OverlayFieldType;
  config: OverlayFieldConfig;
  proposalId?: string;
  status: "active" | "deprecated" | "promoted";
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}
