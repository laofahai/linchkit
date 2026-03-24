/**
 * Widget type definitions
 *
 * A Widget is a reusable rendering unit for a field value.
 * Each field type has a default widget pair (display + input).
 * Widgets can be overridden at field, view, or capability level.
 */

import type { FieldType } from "./schema";

// ── Widget mode ──────────────────────────────────────

export type WidgetMode = "display" | "input";

// ── Widget definition ──────────────────────────────────────

export interface WidgetDefinition {
  /** Unique widget ID: e.g., "string", "number-currency", "enum-radio" */
  id: string;

  /** Human-readable name */
  name?: string;

  /** Field type(s) this widget can handle */
  fieldTypes: FieldType | FieldType[];

  /** Which mode(s) this widget supports */
  modes: WidgetMode[];

  /** If true, this is the default widget for its field type(s) */
  isDefault?: boolean;

  /**
   * Format hints this widget is designed for.
   * Matches FieldUIHints.format. Omit to match any format.
   */
  supportedFormats?: string[];
}

// ── Widget resolution ──────────────────────────────────────

/**
 * Resolution priority (highest to lowest):
 * 1. ViewFieldConfig.widget or FormFieldNode.widget (view-level override)
 * 2. FieldDefinition.widget (schema-level override)
 * 3. Format-based matching (FieldUIHints.format → supportedFormats)
 * 4. Default widget for field type
 */
export interface WidgetResolutionContext {
  /** The field type being rendered */
  fieldType: FieldType;

  /** Widget mode */
  mode: WidgetMode;

  /** Explicit widget override from view/form node (highest priority) */
  widgetOverride?: string;

  /** Format hint from field UI config */
  format?: string;
}
