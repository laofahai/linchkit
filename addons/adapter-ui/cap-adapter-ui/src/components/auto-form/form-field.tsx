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
import { useEntityLabel } from "../../i18n/use-entity-label";
import type { FieldLockReason } from "../../lib/field-lock-state";
import { FieldLockBadge } from "../field-lock-badge";
import { FieldDisplay, FieldInput, Label } from "../field-renderer";
import { OverlayFieldBadge } from "../overlay-field-badge";

/** Props for a single form field row with label and value cells in a grid layout. */
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
  /** Show a visual indicator that this is a runtime overlay (custom) field */
  overlayIndicator?: boolean;
  /**
   * When set, the field is locked by an entity lock rule (Spec 63 §5.1). Drives
   * a lock indicator next to the label. The field's `readonly` prop is set by
   * the caller; this only controls the visual badge.
   */
  lock?: { reason: FieldLockReason; status?: string };
}

/** Renders a single form field row with label alignment and overlay badge support. */
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
  overlayIndicator,
  lock,
}: FormFieldRowProps) {
  const { t } = useTranslation();
  const { resolveLabel } = useEntityLabel();
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
        data-form-field
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
        <span className="inline-flex items-center gap-1">
          {label}
          {overlayIndicator && <OverlayFieldBadge />}
          {lock && <FieldLockBadge reason={lock.reason} status={lock.status} />}
        </span>
      </Label>

      {/* Value cell */}
      <div
        className={cn("text-sm min-h-[36px] min-w-0", "py-1", "max-md:pt-0")}
        style={colspan > 1 ? { gridColumn: `span ${colspan * 2 - 1}` } : undefined}
        data-field={node.field}
        data-form-field
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
