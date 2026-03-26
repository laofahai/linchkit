/**
 * FieldDisplay / FieldInput — Registry-driven field rendering.
 *
 * Delegates to the widget registry to find the right component
 * for each field type + mode combination. Supports widget override
 * via ViewFieldConfig.widget or FormFieldNode.widget.
 */

import type { FieldDefinition, ViewFieldConfig } from "@linchkit/core/types";
import { Input, Label } from "@linchkit/ui-kit/components";
import { isMaskedValue } from "../lib/masking";
import type { WidgetDisplayProps, WidgetInputProps } from "../lib/widget-registry";
import { widgetRegistry } from "../lib/widget-registry";
import { MaskedValue } from "./masked-value";

// ── Display component ─────────────────────────────────────

interface FieldDisplayProps {
  field: ViewFieldConfig;
  value: unknown;
  fieldDef: FieldDefinition;
}

export function FieldDisplay({ field: viewField, value, fieldDef }: FieldDisplayProps) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">&mdash;</span>;
  }

  // Detect masked values and render with lock indicator
  if (isMaskedValue(value)) {
    return <MaskedValue value={String(value)} />;
  }

  const widgetId = widgetRegistry.resolve({
    fieldType: fieldDef.type,
    mode: "display",
    widgetOverride: viewField.widget,
    format: fieldDef.ui?.format,
  });

  const Component = widgetId ? widgetRegistry.getDisplay(widgetId) : null;
  if (Component) {
    return <Component value={value} fieldDef={fieldDef} viewField={viewField} />;
  }

  // Fallback
  return <span>{String(value)}</span>;
}

// ── Input component ────────────────────────────────────────

export interface FieldInputProps {
  field: ViewFieldConfig;
  value: unknown;
  fieldDef: FieldDefinition;
  onChange: (value: unknown) => void;
  onBlur?: () => void;
  readonly?: boolean;
  error?: string;
  dirty?: boolean;
  required?: boolean;
}

export function FieldInput({
  field: viewField,
  value,
  fieldDef,
  onChange,
  onBlur,
  readonly,
  error,
  dirty,
  required,
}: FieldInputProps) {
  // Masked values are always read-only — show masked display instead of input
  if (isMaskedValue(value)) {
    return <MaskedValue value={String(value)} />;
  }

  const widgetId = widgetRegistry.resolve({
    fieldType: fieldDef.type,
    mode: "input",
    widgetOverride: viewField.widget,
    format: fieldDef.ui?.format,
  });

  const Component = widgetId ? widgetRegistry.getInput(widgetId) : null;
  if (Component) {
    return (
      <Component
        value={value}
        fieldDef={fieldDef}
        viewField={viewField}
        onChange={onChange}
        onBlur={onBlur}
        readonly={readonly}
        error={error}
        dirty={dirty}
        required={required}
      />
    );
  }

  // Fallback: basic text input
  return (
    <div className="space-y-1">
      <Input
        type="text"
        value={value != null ? String(value) : ""}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        disabled={readonly}
        aria-invalid={!!error}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export type { WidgetDisplayProps, WidgetInputProps };
// Re-export for use in AutoForm
export { Label };
