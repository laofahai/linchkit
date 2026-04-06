/**
 * Runtime Entity Overlay types
 *
 * Defines the type contracts for field overlays — dynamic fields added
 * to entities at runtime without modifying the base EntityDefinition.
 * Overlay fields are stored in the `_linchkit.field_overlays` system table
 * and their data lives in the `_extensions` JSONB column on each entity table.
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

/** Field overlay definition — what gets submitted when creating/updating */
export interface FieldOverlayDefinition {
  fieldName: string;
  fieldType: OverlayFieldType;
  config: OverlayFieldConfig;
}

/** Overlay lifecycle status */
export type OverlayStatus = "active" | "deprecated" | "promoted";

/** Persisted overlay record (stored in _linchkit.field_overlays table) */
export interface FieldOverlayRecord extends FieldOverlayDefinition {
  id: string;
  entityName: string;
  proposalId?: string;
  status: OverlayStatus;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Store interface for managing overlay records */
export interface OverlayStore {
  /** Get all active overlays for a specific entity */
  getOverlays(entityName: string): Promise<FieldOverlayRecord[]>;
  /** Get all overlays across all entities */
  getAllOverlays(): Promise<FieldOverlayRecord[]>;
  /** Create a new overlay record */
  addOverlay(
    overlay: Omit<FieldOverlayRecord, "id" | "createdAt" | "updatedAt">,
  ): Promise<FieldOverlayRecord>;
  /** Update an existing overlay */
  updateOverlay(
    id: string,
    updates: Partial<FieldOverlayDefinition & { status: OverlayStatus }>,
  ): Promise<FieldOverlayRecord>;
  /** Remove an overlay by ID */
  removeOverlay(id: string): Promise<void>;
}
