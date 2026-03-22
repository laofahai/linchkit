/**
 * Widget Registry — Resolves and manages field rendering widgets.
 *
 * Each widget provides a display component (read-only) and/or an input component (editable).
 * Display and input can be registered and overridden independently.
 *
 * Resolution priority:
 * 1. Explicit widget override (from view/form node)
 * 2. Format-based matching (FieldUIHints.format → supportedFormats)
 * 3. Default widget for field type
 */

import type {
  FieldDefinition,
  FieldType,
  ViewFieldConfig,
  WidgetDefinition,
  WidgetMode,
  WidgetResolutionContext,
} from "@linchkit/core";

// ── Component types ──────────────────────────────────────

/** Props shared by all widget components */
export interface WidgetBaseProps {
  value: unknown;
  fieldDef: FieldDefinition;
  viewField: ViewFieldConfig;
}

/** Props for display-mode widgets */
export interface WidgetDisplayProps extends WidgetBaseProps {}

/** Props for input-mode widgets */
export interface WidgetInputProps extends WidgetBaseProps {
  onChange: (value: unknown) => void;
  onBlur?: () => void;
  readonly?: boolean;
  error?: string;
  dirty?: boolean;
  required?: boolean;
}

export type WidgetDisplayComponent = React.ComponentType<WidgetDisplayProps>;
export type WidgetInputComponent = React.ComponentType<WidgetInputProps>;

// ── Registry entry ──────────────────────────────────────

interface WidgetEntry {
  definition: WidgetDefinition;
  display?: WidgetDisplayComponent;
  input?: WidgetInputComponent;
}

// ── Registry ──────────────────────────────────────

export interface WidgetRegistry {
  /** Register a widget with its display and/or input component */
  register(opts: {
    definition: WidgetDefinition;
    display?: WidgetDisplayComponent;
    input?: WidgetInputComponent;
  }): void;

  /** Override only the display component of an existing widget */
  overrideDisplay(widgetId: string, component: WidgetDisplayComponent): void;

  /** Override only the input component of an existing widget */
  overrideInput(widgetId: string, component: WidgetInputComponent): void;

  /** Resolve the best widget ID for a given context */
  resolve(context: WidgetResolutionContext): string | null;

  /** Get display component by widget ID */
  getDisplay(widgetId: string): WidgetDisplayComponent | null;

  /** Get input component by widget ID */
  getInput(widgetId: string): WidgetInputComponent | null;

  /** List all registered widget definitions */
  list(): WidgetDefinition[];
}

export function createWidgetRegistry(): WidgetRegistry {
  const widgets = new Map<string, WidgetEntry>();

  // Index: fieldType+mode → default widget ID
  const defaults = new Map<string, string>();

  function defaultKey(fieldType: FieldType, mode: WidgetMode): string {
    return `${fieldType}:${mode}`;
  }

  function register(opts: {
    definition: WidgetDefinition;
    display?: WidgetDisplayComponent;
    input?: WidgetInputComponent;
  }): void {
    const { definition, display, input } = opts;
    widgets.set(definition.id, { definition, display, input });

    // Register as default for field type(s)
    if (definition.isDefault) {
      const types = Array.isArray(definition.fieldTypes)
        ? definition.fieldTypes
        : [definition.fieldTypes];
      for (const ft of types) {
        for (const mode of definition.modes) {
          defaults.set(defaultKey(ft, mode), definition.id);
        }
      }
    }
  }

  function overrideDisplay(widgetId: string, component: WidgetDisplayComponent): void {
    const entry = widgets.get(widgetId);
    if (entry) {
      entry.display = component;
    }
  }

  function overrideInput(widgetId: string, component: WidgetInputComponent): void {
    const entry = widgets.get(widgetId);
    if (entry) {
      entry.input = component;
    }
  }

  function resolve(context: WidgetResolutionContext): string | null {
    const { fieldType, mode, widgetOverride, format } = context;

    // 1. Explicit override
    if (widgetOverride && widgets.has(widgetOverride)) {
      return widgetOverride;
    }

    // 2. Format-based matching
    if (format) {
      for (const [id, entry] of widgets) {
        const def = entry.definition;
        if (def.supportedFormats?.includes(format) && def.modes.includes(mode)) {
          const types = Array.isArray(def.fieldTypes) ? def.fieldTypes : [def.fieldTypes];
          if (types.includes(fieldType)) {
            return id;
          }
        }
      }
    }

    // 3. Default for field type
    return defaults.get(defaultKey(fieldType, mode)) ?? null;
  }

  function getDisplay(widgetId: string): WidgetDisplayComponent | null {
    return widgets.get(widgetId)?.display ?? null;
  }

  function getInput(widgetId: string): WidgetInputComponent | null {
    return widgets.get(widgetId)?.input ?? null;
  }

  function list(): WidgetDefinition[] {
    return Array.from(widgets.values()).map((e) => e.definition);
  }

  return {
    register,
    overrideDisplay,
    overrideInput,
    resolve,
    getDisplay,
    getInput,
    list,
  };
}

/** Global widget registry singleton */
export const widgetRegistry = createWidgetRegistry();
