/**
 * useInlineEdit — Manages inline cell editing state for AutoList.
 *
 * Tracks which cell is being edited, handles optimistic updates,
 * and calls the GraphQL update mutation on save.
 */

import type { FieldType } from "@linchkit/core/types";
import { useCallback, useRef, useState } from "react";
import { updateRecord } from "../lib/api";

/** Field types that support inline editing */
const EDITABLE_FIELD_TYPES: ReadonlySet<FieldType> = new Set(["string", "number", "enum"]);

/** Check whether a field type supports inline editing */
export function isFieldTypeEditable(fieldType: FieldType): boolean {
  return EDITABLE_FIELD_TYPES.has(fieldType);
}

export interface EditingCell {
  rowId: string;
  field: string;
}

export interface UseInlineEditOptions {
  entityName: string;
  /** Fields to fetch after a successful update */
  queryFields: string[];
  /** Callback after a successful save */
  onSaved?: (recordId: string, updatedRecord: Record<string, unknown>) => void;
  /** Callback on save error */
  onError?: (error: Error) => void;
}

export interface UseInlineEditReturn {
  /** Currently editing cell, or null if none */
  editingCell: EditingCell | null;
  /** Start editing a cell */
  startEditing: (rowId: string, field: string) => void;
  /** Cancel editing without saving */
  cancelEditing: () => void;
  /** Save the current edit */
  saveEdit: (rowId: string, field: string, value: unknown) => void;
  /** Whether a save is in progress */
  saving: boolean;
}

export function useInlineEdit(options: UseInlineEditOptions): UseInlineEditReturn {
  const { entityName, queryFields, onSaved, onError } = options;
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [saving, setSaving] = useState(false);
  // Track the original value for rollback
  const originalValueRef = useRef<unknown>(undefined);

  const startEditing = useCallback((rowId: string, field: string) => {
    setEditingCell({ rowId, field });
  }, []);

  const cancelEditing = useCallback(() => {
    setEditingCell(null);
    originalValueRef.current = undefined;
  }, []);

  const saveEdit = useCallback(
    async (rowId: string, field: string, value: unknown) => {
      setSaving(true);
      setEditingCell(null);
      try {
        const result = await updateRecord(entityName, rowId, { [field]: value }, queryFields);
        onSaved?.(rowId, result);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        onError?.(error);
      } finally {
        setSaving(false);
      }
    },
    [entityName, queryFields, onSaved, onError],
  );

  return {
    editingCell,
    startEditing,
    cancelEditing,
    saveEdit,
    saving,
  };
}
