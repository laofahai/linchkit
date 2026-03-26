/**
 * FormField — Single field row with label + value.
 *
 * Uses display:contents to participate in parent grid layout.
 * Label auto-sizes; all labels in the same group align to the widest one.
 * Required fields get a subtle slate background on the input (no asterisk).
 * Edit mode uses standard bordered inputs (shadcn Input).
 */

import type { FieldDefinition, FormFieldNode, ViewFieldConfig } from "@linchkit/core/types";
import { cn } from "@linchkit/ui-kit/lib/utils";
import { useSchemaLabel } from "../../i18n/use-schema-label";
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
  const { resolveLabel } = useSchemaLabel();
  const rawLabel = node.label ?? viewField?.label ?? fieldDef.label ?? node.field;
  const label = resolveLabel(rawLabel, node.field);
  const colspan = node.colspan ?? 1;

  // For nolabel fields, span both label + value columns
  if (node.nolabel) {
    return (
      <div
        className={cn("py-2 text-sm leading-9 min-h-[36px]", node.className)}
        style={{ gridColumn: `span ${colspan * 2}` }}
      >
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
            required={required}
          />
        )}
        {/* Error messages are rendered by individual widget components */}
      </div>
    );
  }

  // Normal field: label in col 1, value in col 2 (via contents)
  return (
    <>
      {/* Label cell — auto width, right-aligned, all labels in group align */}
      <Label
        className={cn(
          "justify-end text-sm text-muted-foreground leading-9 whitespace-nowrap pr-3",
          "py-1",
          "max-md:justify-start max-md:text-xs max-md:pb-0",
          node.className,
        )}
      >
        {label}
      </Label>

      {/* Value cell */}
      <div
        className={cn("text-sm leading-9 min-h-[36px] min-w-0", "py-1", "max-md:pt-0")}
        style={colspan > 1 ? { gridColumn: `span ${colspan * 2 - 1}` } : undefined}
      >
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
            required={required}
          />
        )}
        {/* Error messages are rendered by individual widget components */}
      </div>
    </>
  );
}
