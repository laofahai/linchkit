/**
 * BulkEditDialog — Apply field changes to multiple selected records at once.
 *
 * Features:
 * - Field selector: checkboxes to pick which fields to change
 * - Input widget per selected field (resolved via widget registry)
 * - "Apply to N records" button with count
 * - Progress indicator during bulk update
 * - Summary on completion: X updated, Y failed
 */

import type { EntityDefinition, FieldDefinition } from "@linchkit/core/types";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
} from "@linchkit/ui-kit/components";
import { AlertCircle, CheckCircle2, Pencil } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEntityLabel } from "../../i18n/use-entity-label";
import { updateRecord } from "../../lib/entity-api";
import { widgetRegistry } from "../../lib/widget-registry";

// ── Types ───────────────────────────────────────────────────

type BulkEditPhase = "select" | "applying" | "done";

interface BulkEditResult {
  updated: number;
  failed: number;
  errors: Array<{ id: string; error: string }>;
}

interface BulkEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schema: EntityDefinition;
  selectedIds: string[];
  /** Fields to return from the update mutation (for cache). */
  queryFields?: string[];
  /** Called after all updates complete (success or partial). */
  onCompleted?: () => void;
}

// ── Fields excluded from bulk edit ────────────────────────────

const EXCLUDED_FIELDS = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "_version",
  "is_deleted",
]);

/** Field types that cannot be bulk-edited. */
const EXCLUDED_FIELD_TYPES = new Set(["computed", "has_many", "many_to_many"]);

// ── Component ──────────────────────────────────────────────────

export function BulkEditDialog({
  open,
  onOpenChange,
  schema,
  selectedIds,
  queryFields,
  onCompleted,
}: BulkEditDialogProps) {
  const { t } = useTranslation();
  const { resolveLabel } = useEntityLabel();

  const [phase, setPhase] = useState<BulkEditPhase>("select");
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>({});
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<BulkEditResult | null>(null);

  // Editable fields (exclude system, derived, computed, relation fields)
  const editableFields = useMemo(() => {
    return Object.entries(schema.fields)
      .filter(([name, def]) => {
        if (EXCLUDED_FIELDS.has(name)) return false;
        const fieldDef = def as FieldDefinition;
        if (EXCLUDED_FIELD_TYPES.has(fieldDef.type)) return false;
        if (fieldDef.derived) return false;
        if (fieldDef.immutable) return false;
        return true;
      })
      .map(([name, def]) => ({
        name,
        def: def as FieldDefinition,
        label: resolveLabel((def as FieldDefinition).label, name),
      }));
  }, [schema.fields, resolveLabel]);

  const resetState = useCallback(() => {
    setPhase("select");
    setSelectedFields(new Set());
    setFieldValues({});
    setProgress(0);
    setResult(null);
  }, []);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) resetState();
      onOpenChange(open);
    },
    [onOpenChange, resetState],
  );

  const toggleField = useCallback((fieldName: string) => {
    setSelectedFields((prev) => {
      const next = new Set(prev);
      if (next.has(fieldName)) {
        next.delete(fieldName);
      } else {
        next.add(fieldName);
      }
      return next;
    });
  }, []);

  const updateFieldValue = useCallback((fieldName: string, value: unknown) => {
    setFieldValues((prev) => ({ ...prev, [fieldName]: value }));
  }, []);

  // Build the input data from selected fields
  const buildInput = useCallback(() => {
    const input: Record<string, unknown> = {};
    for (const fieldName of selectedFields) {
      input[fieldName] = fieldValues[fieldName] ?? null;
    }
    return input;
  }, [selectedFields, fieldValues]);

  // Execute bulk update
  const handleApply = useCallback(async () => {
    if (selectedFields.size === 0 || selectedIds.length === 0) return;

    setPhase("applying");
    setProgress(0);

    const input = buildInput();
    const fields = queryFields ?? ["id"];
    const total = selectedIds.length;
    let updated = 0;
    let failed = 0;
    const errors: Array<{ id: string; error: string }> = [];

    // Execute updates with Promise.allSettled for parallel execution
    const _results = await Promise.allSettled(
      selectedIds.map(async (id, index) => {
        try {
          await updateRecord(schema.name, id, input, fields);
          updated++;
        } catch (err) {
          failed++;
          errors.push({
            id,
            error: err instanceof Error ? err.message : "Update failed",
          });
        } finally {
          setProgress(Math.round(((index + 1) / total) * 100));
        }
      }),
    );

    // Ensure final counts are correct from settled results
    setResult({ updated, failed, errors });
    setPhase("done");
    setProgress(100);
  }, [selectedFields, selectedIds, buildInput, queryFields, schema.name]);

  // Resolve widget input component for a field
  const renderFieldInput = useCallback(
    (fieldName: string, fieldDef: FieldDefinition) => {
      const widgetId = widgetRegistry.resolve({
        fieldType: fieldDef.type,
        mode: "input",
        format: fieldDef.ui?.format,
      });

      const InputComponent = widgetId ? widgetRegistry.getInput(widgetId) : null;

      if (!InputComponent) {
        return (
          <input
            type="text"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={fieldValues[fieldName] != null ? String(fieldValues[fieldName]) : ""}
            onChange={(e) => updateFieldValue(fieldName, e.target.value)}
          />
        );
      }

      return (
        <InputComponent
          value={fieldValues[fieldName] ?? null}
          fieldDef={fieldDef}
          viewField={{ field: fieldName }}
          onChange={(value: unknown) => updateFieldValue(fieldName, value)}
        />
      );
    },
    [fieldValues, updateFieldValue],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="size-4" />
            {t("bulkEdit.title", "Bulk Edit")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "bulkEdit.description",
              "Select fields to update across {{count}} selected records.",
              {
                count: selectedIds.length,
              },
            )}
          </DialogDescription>
        </DialogHeader>

        {/* ── Field selection phase ───────────────────────────────────── */}
        {phase === "select" && (
          <div className="space-y-4">
            {/* Field selector */}
            <div>
              <h4 className="mb-2 text-sm font-medium">
                {t("bulkEdit.selectFields", "Select fields to update")}
              </h4>
              <div className="max-h-[50vh] overflow-y-auto">
                <div className="space-y-3">
                  {editableFields.map(({ name, def, label }) => (
                    <div key={name} className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`bulk-field-${name}`}
                          checked={selectedFields.has(name)}
                          onCheckedChange={() => toggleField(name)}
                        />
                        <Label
                          htmlFor={`bulk-field-${name}`}
                          className="text-sm font-medium cursor-pointer"
                        >
                          {label}
                        </Label>
                        <span className="text-xs text-muted-foreground">({def.type})</span>
                      </div>

                      {/* Show input when field is selected */}
                      {selectedFields.has(name) && (
                        <div className="ml-6">{renderFieldInput(name, def)}</div>
                      )}
                    </div>
                  ))}

                  {editableFields.length === 0 && (
                    <p className="text-sm text-muted-foreground py-4 text-center">
                      {t("bulkEdit.noEditableFields", "No editable fields available.")}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button disabled={selectedFields.size === 0} onClick={handleApply}>
                {t("bulkEdit.applyToCount", "Apply to {{count}} records", {
                  count: selectedIds.length,
                })}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* ── Applying phase ────────────────────────────────────────── */}
        {phase === "applying" && (
          <div className="space-y-4 py-6">
            <div className="text-center text-sm text-muted-foreground">
              {t("bulkEdit.applying", "Updating records...")}
            </div>
            {/* Progress bar */}
            <div className="mx-auto w-full max-w-md">
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="mt-2 text-center text-xs text-muted-foreground">{progress}%</p>
            </div>
          </div>
        )}

        {/* ── Done phase ────────────────────────────────────────────── */}
        {phase === "done" && result && (
          <div className="space-y-4">
            {/* Summary */}
            <div className="flex flex-col items-center gap-3 py-4">
              {result.updated > 0 && result.failed === 0 ? (
                <CheckCircle2 className="size-10 text-green-500" />
              ) : result.updated > 0 ? (
                <AlertCircle className="size-10 text-yellow-500" />
              ) : (
                <AlertCircle className="size-10 text-destructive" />
              )}
              <div className="text-center">
                <p className="text-sm font-medium">
                  {t("bulkEdit.summaryUpdated", "{{count}} record(s) updated successfully", {
                    count: result.updated,
                  })}
                </p>
                {result.failed > 0 && (
                  <p className="mt-1 text-sm text-destructive">
                    {t("bulkEdit.summaryFailed", "{{count}} record(s) failed", {
                      count: result.failed,
                    })}
                  </p>
                )}
              </div>
            </div>

            {/* Error details */}
            {result.errors.length > 0 && (
              <div className="rounded-md border border-destructive/20 bg-destructive/5 p-3">
                <h4 className="mb-2 text-sm font-medium text-destructive">
                  {t("bulkEdit.errorDetails", "Error details")}
                </h4>
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {result.errors.map(({ id, error }) => (
                    <p key={id} className="text-xs text-muted-foreground">
                      <span className="font-mono">{id}</span>: {error}
                    </p>
                  ))}
                </div>
              </div>
            )}

            <DialogFooter>
              <Button
                onClick={() => {
                  handleOpenChange(false);
                  onCompleted?.();
                }}
              >
                {t("common.close")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
