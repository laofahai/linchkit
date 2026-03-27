/**
 * FormField — Single field row with label + value.
 *
 * Uses display:contents to participate in parent grid layout.
 * Label auto-sizes; all labels in the same group align to the widest one.
 * Required fields distinguished by input background color.
 * Unique fields show a hint note below the input.
 * Edit mode uses standard bordered inputs (shadcn Input).
 */

import type { FieldDefinition, FormFieldNode, ViewFieldConfig } from "@linchkit/core/types";
import { cn } from "@linchkit/ui-kit/lib/utils";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const { resolveLabel } = useSchemaLabel();
  const rawLabel = node.label ?? viewField?.label ?? fieldDef.label ?? node.field;
  const label = resolveLabel(rawLabel, node.field);
  const colspan = node.colspan ?? 1;
  const showUnique = !!fieldDef.unique && !isViewMode && !readonly;

  // Unique hint displayed below input for fields with unique constraint
  const uniqueHint = showUnique ? (
    <p className="mt-0.5 text-xs text-muted-foreground italic">
      {t("form.validation.uniqueHint", "Must be unique — validated on save")}
    </p>
  ) : null;

  // For nolabel fields, span both label + value columns
  if (node.nolabel) {
    return (
      <div
        className={cn("py-2 text-sm min-h-[36px]", node.className)}
        style={{ gridColumn: `span ${colspan * 2}` }}
        data-field={node.field}
      >
        {isViewMode || readonly ? (
          <FieldDisplay
            field={viewField ?? { field: node.field }}
            value={value}
            fieldDef={fieldDef}
          />
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
        {uniqueHint}
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
        className={cn("text-sm min-h-[36px] min-w-0", "py-1", "max-md:pt-0")}
        style={colspan > 1 ? { gridColumn: `span ${colspan * 2 - 1}` } : undefined}
        data-field={node.field}
      >
        {isViewMode || readonly ? (
          <FieldDisplay
            field={viewField ?? { field: node.field }}
            value={value}
            fieldDef={fieldDef}
          />
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
        {uniqueHint}
      </div>
    </>
  );
}
