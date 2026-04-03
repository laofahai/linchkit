/**
 * InlineEditCell — Renders either a display or input widget for a table cell.
 *
 * When the cell is in editing mode, it shows the input widget from the widget registry.
 * Enter or blur saves the value, Escape cancels editing.
 */

import type { FieldDefinition, StateMeta, ViewFieldConfig } from "@linchkit/core/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FieldDisplay, FieldInput } from "../field-renderer";
import { StatusBadge } from "./status-badge";

export interface InlineEditCellProps {
  field: ViewFieldConfig;
  fieldDef: FieldDefinition;
  value: unknown;
  rowId: string;
  isEditing: boolean;
  stateMeta?: Partial<Record<string, StateMeta>>;
  onDoubleClick: () => void;
  onSave: (value: unknown) => void;
  onCancel: () => void;
}

export function InlineEditCell({
  field,
  fieldDef,
  value,
  isEditing,
  stateMeta,
  onDoubleClick,
  onSave,
  onCancel,
}: InlineEditCellProps) {
  const { t } = useTranslation();
  const [editValue, setEditValue] = useState<unknown>(value);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasCommittedRef = useRef(false);

  // Reset edit value when entering edit mode
  useEffect(() => {
    if (isEditing) {
      setEditValue(value);
      hasCommittedRef.current = false;
    }
  }, [isEditing, value]);

  // Auto-focus input when entering edit mode
  useEffect(() => {
    if (isEditing && containerRef.current) {
      const input = containerRef.current.querySelector("input, select, [role='combobox']");
      if (input instanceof HTMLElement) {
        // Small delay to allow the component to render
        requestAnimationFrame(() => input.focus());
      }
    }
  }, [isEditing]);

  const commitSave = useCallback(() => {
    if (hasCommittedRef.current) return;
    hasCommittedRef.current = true;
    // Only save if value actually changed
    if (editValue !== value) {
      onSave(editValue);
    } else {
      onCancel();
    }
  }, [editValue, value, onSave, onCancel]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitSave();
      } else if (e.key === "Escape") {
        e.preventDefault();
        hasCommittedRef.current = true;
        onCancel();
      }
    },
    [commitSave, onCancel],
  );

  // Display mode
  if (!isEditing) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: double-click to edit is intentional UX pattern
      <div
        className="cursor-text min-h-[1.5rem] rounded px-0.5 -mx-0.5 hover:bg-muted/60 transition-colors"
        onDoubleClick={(e) => {
          e.stopPropagation();
          onDoubleClick();
        }}
        title={t("list.doubleClickToEdit", "Double-click to edit")}
      >
        {fieldDef.type === "state" && typeof value === "string" ? (
          <StatusBadge value={value} meta={stateMeta} />
        ) : (
          <FieldDisplay field={field} value={value} fieldDef={fieldDef} />
        )}
      </div>
    );
  }

  // Edit mode
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: edit container handles keyboard via onKeyDown
    <div
      ref={containerRef}
      className="inline-edit-cell -mx-1"
      onKeyDown={handleKeyDown}
      onBlur={(e) => {
        // Only commit if focus is leaving the container entirely
        if (!containerRef.current?.contains(e.relatedTarget as Node)) {
          commitSave();
        }
      }}
    >
      <FieldInput
        field={field}
        value={editValue}
        fieldDef={fieldDef}
        onChange={setEditValue}
        onBlur={() => {
          // Handled by container onBlur instead
        }}
      />
    </div>
  );
}
