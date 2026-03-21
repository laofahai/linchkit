/**
 * FormField — Single field row with label + value, Odoo-style layout.
 *
 * Layout: fixed-width right-aligned label | flexible value area.
 * Required fields get a subtle blue background (no asterisk).
 * Edit mode inputs use bottom-underline style (no border box).
 */

import type { FieldDefinition, FormFieldNode, ViewFieldConfig } from "@linchkit/core";
import { cn } from "../../lib/utils";
import { FieldDisplay, FieldInput, Label } from "../field-renderer";

export interface FormFieldRowProps {
  node: FormFieldNode;
  fieldDef: FieldDefinition;
  viewField: ViewFieldConfig;
  value: unknown;
  isViewMode: boolean;
  required: boolean;
  readonly: boolean;
  error?: string;
  isDirty: boolean;
  onChange: (value: unknown) => void;
  onBlur: () => void;
}

export function FormFieldRow({
  node,
  fieldDef,
  viewField,
  value,
  isViewMode,
  required,
  readonly,
  error,
  isDirty,
  onChange,
  onBlur,
}: FormFieldRowProps) {
  const label = node.label ?? viewField?.label ?? fieldDef.label ?? node.field;
  const colspan = node.colspan ?? 1;

  return (
    <div
      className={cn(
        // Field row: horizontal layout with bottom border
        "flex items-center gap-x-3 py-2 border-b border-border/20 last:border-b-0 min-h-[36px]",
        // Responsive: stack on mobile
        "max-md:flex-col max-md:items-start max-md:gap-0",
        // Required field background highlight (no asterisk)
        required && !isViewMode && "bg-blue-50/30 dark:bg-blue-950/10",
        node.className,
      )}
      style={colspan > 1 ? { gridColumn: `span ${colspan}` } : undefined}
    >
      {/* Label column — fixed width, right-aligned (Odoo style) */}
      {!node.nolabel && (
        <Label
          className={cn(
            "w-[150px] shrink-0 text-right text-sm text-muted-foreground leading-9 truncate",
            // Mobile: full width, left-aligned
            "max-md:w-full max-md:text-left max-md:text-xs",
          )}
        >
          {label}
        </Label>
      )}

      {/* Value column — stretches to fill */}
      <div className={cn("flex-1 min-w-0 text-sm leading-9", node.nolabel && "w-full")}>
        {isViewMode || readonly ? (
          <div className="text-foreground leading-9">
            <FieldDisplay
              field={viewField ?? { field: node.field }}
              value={value}
              fieldDef={fieldDef}
            />
          </div>
        ) : (
          <FieldInput
            field={viewField ?? { field: node.field }}
            value={value}
            fieldDef={fieldDef}
            onChange={onChange}
            onBlur={onBlur}
            readonly={readonly}
            error={error}
            dirty={isDirty}
          />
        )}
        {error && !isViewMode && !readonly && (
          <p className="mt-1 text-xs text-destructive">{error}</p>
        )}
      </div>
    </div>
  );
}
