/**
 * SchemaFormPage — Dynamic record view powered by schema bundle from API.
 *
 * Fetches schema + view definitions from server. Shows error states
 * when API is unavailable — no silent demo data fallback.
 *
 * Control panel: [← back] ............... [business actions | edit/save]
 * Sheet card:    [Record Title]  [Status Bar]
 *                form fields...
 */

import type {
  SchemaDefinition,
  StateDefinition,
  StateMeta,
  ViewAction,
  ViewDefinition,
} from "@linchkit/core/types";
import { Button, Separator, Skeleton, toast } from "@linchkit/ui-kit/components";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ArrowLeft, Check, Copy, Loader2, Pencil, RefreshCw, ServerCrash, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityPanel } from "../components/activity-panel";
import { AutoForm } from "../components/auto-form";
import { ConfirmDialog } from "../components/confirm-dialog";
import { One2ManyField } from "../components/one2many-field";
import { RelatedRecordsPanel } from "../components/related-records-panel";
import { StatusBar, type StatusBarStep } from "../components/status-bar";
import { TransitionButtons } from "../components/transition-buttons";
import { useAiAutoFill } from "../hooks/use-ai-auto-fill";
import { useBreadcrumbTitle } from "../hooks/use-breadcrumb-title";
import { useSchemaBundle } from "../hooks/use-schema-bundle";
import { useSchemaLabel } from "../i18n/use-schema-label";
import { pushNotification } from "../hooks/use-notifications";
import { createRecord, deleteRecord, executeAction, isAiEnabled, queryRecord, updateRecord } from "../lib/api";

/** Derive StatusBar steps from state machine meta in schema presentation */
function deriveStatusSteps(
  schema: SchemaDefinition,
  states?: StateDefinition[],
  resolve?: (label: string | undefined, fallback: string) => string,
): StatusBarStep[] | null {
  // Look for a state field
  const stateFieldEntry = Object.entries(schema.fields).find(([, f]) => f.type === "state");
  if (!stateFieldEntry) return null;

  const [, stateField] = stateFieldEntry;
  if (!("machine" in stateField)) return null;

  // Find the corresponding state machine definition
  const machine = (states ?? []).find(
    (s) => s.name === stateField.machine && s.schema === schema.name,
  );
  if (!machine) return null;

  // Convert states to StatusBarStep array, resolving t: prefixed labels
  const steps: StatusBarStep[] = machine.states.map((stateValue) => {
    const meta: StateMeta | undefined = machine.meta?.[stateValue];
    const rawLabel = meta?.label ?? stateValue;
    const label = resolve ? resolve(rawLabel, stateValue) : rawLabel;
    return {
      value: stateValue,
      label,
      color: meta?.color,
    };
  });

  return steps.length > 0 ? steps : null;
}

/**
 * Get the set of action names that are valid transitions from the current state.
 * Lightweight client-side computation — no server round-trip needed.
 */
function getTransitionActionNames(
  schema: SchemaDefinition,
  states: StateDefinition[] | undefined,
  currentState: string,
): Set<string> | null {
  const stateFieldEntry = Object.entries(schema.fields).find(([, f]) => f.type === "state");
  if (!stateFieldEntry) return null;

  const [, stateField] = stateFieldEntry;
  if (!("machine" in stateField)) return null;

  const machine = (states ?? []).find(
    (s) => s.name === stateField.machine && s.schema === schema.name,
  );
  if (!machine) return null;

  const actionNames = new Set<string>();
  for (const t of machine.transitions) {
    const sources: string[] = Array.isArray(t.from) ? t.from : [t.from];
    if (sources.includes(currentState)) {
      actionNames.add(t.action);
    }
  }
  return actionNames;
}

/** Relationship field types that require subfield selection in GraphQL. */
const RELATION_FIELD_TYPES = new Set(["ref", "has_many", "many_to_many"]);

/** Extract GraphQL field names from view fields, always including the state field */
function getRecordFields(view: ViewDefinition, schema?: SchemaDefinition): string[] {
  const fields = new Set<string>(["id"]);
  for (const f of view.fields) {
    if (f.field.includes(".")) continue;

    const fieldDef = schema?.fields?.[f.field];

    // Relationship fields need subfield selection: `department { id }`
    if (fieldDef && RELATION_FIELD_TYPES.has(fieldDef.type ?? "")) {
      fields.add(`${f.field} { id }`);
    } else {
      fields.add(f.field);
    }
  }
  // Always include the state field so state-machine features work even if the view omits it
  if (schema) {
    const stateFieldName = Object.entries(schema.fields).find(([, f]) => f.type === "state")?.[0];
    if (stateFieldName) {
      fields.add(stateFieldName);
    }
  }
  return Array.from(fields);
}

function getPrimaryView<TView extends { type: string }>(
  views: Record<string, TView> | undefined,
  type: TView["type"],
): TView | undefined {
  return Object.values(views ?? {}).find((view) => view.type === type);
}

/** System-managed fields to exclude from auto-generated form views. */
const SYSTEM_FIELDS = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "_version",
  "is_deleted",
]);

/** Field types that benefit from full-width display (single column). */
const WIDE_FIELD_TYPES = new Set(["text", "json", "html", "richtext"]);

/** Generate a minimal form view from schema fields when no explicit form view is defined.
 *
 * Produces an Odoo-style two-column layout:
 * - Short fields (string, number, boolean, enum, state, date, ref) split into left/right groups
 * - Wide fields (text, json, html) placed full-width below the columns
 */
function generateFallbackFormView(
  schema: { name: string; label?: string; fields: Record<string, { label?: string; type?: string }> },
): ViewDefinition {
  const fieldNames = Object.keys(schema.fields).filter((f) => !SYSTEM_FIELDS.has(f));

  const fields = fieldNames.map((field) => ({
    field,
    label: schema.fields[field]?.label,
  }));

  // Partition fields into short (two-column) and wide (full-width)
  const shortFields: string[] = [];
  const wideFields: string[] = [];
  for (const name of fieldNames) {
    const fieldType = schema.fields[name]?.type;
    if (fieldType && WIDE_FIELD_TYPES.has(fieldType)) {
      wideFields.push(name);
    } else {
      shortFields.push(name);
    }
  }

  // Split short fields evenly into left and right columns
  const mid = Math.ceil(shortFields.length / 2);
  const leftFields = shortFields.slice(0, mid);
  const rightFields = shortFields.slice(mid);

  const layoutNodes: import("@linchkit/core/types").FormLayoutNode[] = [];

  // Top-level group with two inner groups for the two-column layout
  if (shortFields.length > 0) {
    layoutNodes.push({
      type: "group",
      children: [
        {
          type: "group",
          children: leftFields.map((f) => ({ type: "field" as const, field: f })),
        },
        {
          type: "group",
          children: rightFields.map((f) => ({ type: "field" as const, field: f })),
        },
      ],
    });
  }

  // Wide fields in a single-column group below
  if (wideFields.length > 0) {
    layoutNodes.push({
      type: "group",
      columns: 1,
      children: wideFields.map((f) => ({ type: "field" as const, field: f })),
    });
  }

  return {
    name: `${schema.name}_form_auto`,
    schema: schema.name,
    type: "form",
    label: schema.label ?? schema.name,
    fields,
    layout: layoutNodes.length > 0 ? { nodes: layoutNodes } : undefined,
    actions: [],
  };
}

export function SchemaFormPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const params = useParams({ strict: false }) as { name?: string; id?: string };
  const searchParams = useSearch({ strict: false }) as { clone?: string };
  const cloneId = searchParams.clone;
  const schemaName = params.name;
  const { resolveLabel } = useSchemaLabel();
  const { setBreadcrumbTitle } = useBreadcrumbTitle();

  // Fetch schema bundle from API
  const {
    bundle,
    loading: bundleLoading,
    error: bundleError,
    reload: reloadBundle,
  } = useSchemaBundle(schemaName ?? "");

  const schema = bundle?.schema;
  const formView = useMemo(
    () => getPrimaryView(bundle?.views, "form") ?? (schema ? generateFallbackFormView(schema) : undefined),
    [bundle?.views, schema],
  );

  // Status bar steps derived from schema, with i18n label resolution
  const statusSteps = useMemo((): StatusBarStep[] | null => {
    if (!schema) return null;
    return deriveStatusSteps(schema, bundle?.states, resolveLabel);
  }, [schema, bundle, resolveLabel]);

  const isCreate = !params.id || params.id === "new";
  const [formMode, setFormMode] = useState<"create" | "edit" | "view">(
    isCreate ? "create" : "view",
  );
  const [record, setRecord] = useState<Record<string, unknown> | undefined>(undefined);
  const [loading, setLoading] = useState(!isCreate || !!cloneId);
  const [saving, setSaving] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // AI auto-fill — always call hook (React rules), but only use when schema is loaded
  const aiEnabled = isAiEnabled();
  const formValuesRef = useRef<Record<string, unknown>>({});
  const autoFormSetFieldRef = useRef<((fieldName: string, value: unknown) => void) | null>(null);
  const dummySchema = useMemo(() => ({ name: "__dummy__", fields: {} }), []);
  const aiAutoFill = useAiAutoFill(
    (schema ?? dummySchema) as import("@linchkit/core/types").SchemaDefinition,
    (fieldName, value) => {
      // Apply value to AutoForm via the registered setter
      autoFormSetFieldRef.current?.(fieldName, value);
    },
  );
  const aiSuggestionCount = Object.keys(aiAutoFill.state.suggestions).length;

  /** Fields to strip when cloning a record — system-managed, not user data. */
  const CLONE_STRIP_FIELDS = useMemo(
    () => new Set(["id", "created_at", "updated_at", "created_by", "updated_by", "_version", "tenant_id", "is_deleted"]),
    [],
  );

  const recordFields = useMemo(() => (formView ? getRecordFields(formView, schema) : []), [formView, schema]);

  // Stabilize recordFields via ref so fetchRecord doesn't get recreated on every render
  const recordFieldsRef = useRef(recordFields);
  recordFieldsRef.current = recordFields;

  const fetchRecord = useCallback(async () => {
    if (isCreate || !params.id || !schemaName || !formView) return;
    setLoading(true);
    setRecordError(null);
    try {
      const result = await queryRecord(schemaName, params.id, recordFieldsRef.current);
      if (result) {
        setRecord(result as Record<string, unknown>);
      } else {
        setRecordError(t("errors.recordNotFound", 'Record "{{id}}" not found.', { id: params.id }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t("errors.recordLoadFailed", "Failed to load record.");
      setRecordError(message);
    } finally {
      setLoading(false);
    }
  }, [isCreate, params.id, schemaName, formView, t]);

  // Fetch source record for cloning
  const fetchCloneSource = useCallback(async () => {
    if (!cloneId || !schemaName || !formView) return;
    setLoading(true);
    setRecordError(null);
    try {
      const result = await queryRecord(schemaName, cloneId, recordFieldsRef.current);
      if (result) {
        // Strip system fields from cloned data
        const cloned = { ...(result as Record<string, unknown>) };
        for (const field of CLONE_STRIP_FIELDS) {
          delete cloned[field];
        }
        // Reset state fields to initial value (first state in the machine)
        if (schema) {
          for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
            if (fieldDef.type === "state" && "machine" in fieldDef) {
              const machine = (bundle?.states ?? []).find(
                (s) => s.name === fieldDef.machine && s.schema === schema.name,
              );
              if (machine && machine.states.length > 0) {
                cloned[fieldName] = machine.initial ?? machine.states[0];
              }
            }
          }
        }
        setRecord(cloned);
      } else {
        // Clone source not found — proceed with empty form
        console.warn(`Clone source record "${cloneId}" not found, starting with empty form.`);
      }
    } catch (err) {
      console.warn("Failed to load clone source:", err);
      toast.error(t("toast.cloneSourceFailed", "Failed to load clone source. You can fill the form manually."));
      // Non-fatal — user can still fill the form manually
    } finally {
      setLoading(false);
    }
  }, [cloneId, schemaName, formView, CLONE_STRIP_FIELDS, schema, bundle?.states]);

  // Sync form mode when navigating between create/edit via URL changes
  useEffect(() => setFormMode(isCreate ? "create" : "view"), [isCreate]);

  useEffect(() => {
    if (!bundleLoading && bundle) {
      if (isCreate && cloneId) {
        fetchCloneSource();
      } else {
        fetchRecord();
      }
    } else if (!bundleLoading && !bundle) {
      setLoading(false);
    }
  }, [fetchRecord, fetchCloneSource, bundleLoading, bundle, isCreate, cloneId]);

  // Update breadcrumb title with the record's display name
  useEffect(() => {
    if (isCreate) {
      setBreadcrumbTitle(null);
      return;
    }
    if (record && schema) {
      const titleFld = schema.presentation?.titleField as string | undefined;
      const title = String(
        (titleFld && record[titleFld]) ?? record.title ?? record.name ?? params.id ?? "",
      );
      setBreadcrumbTitle(title || null);
    }
    return () => setBreadcrumbTitle(null);
  }, [record, schema, isCreate, params.id, setBreadcrumbTitle]);

  // Dynamically find the state field name from the schema
  const stateFieldName = useMemo(
    () => schema ? Object.entries(schema.fields).find(([, f]) => f.type === "state")?.[0] : undefined,
    [schema],
  );

  // Resolve business actions from view's stateActions mapping or state machine transitions
  const recordStatus = record && stateFieldName ? String(record[stateFieldName] ?? "") : undefined;
  const businessActions = useMemo(() => {
    if (!formView) return [];
    const allActions = formView.actions ?? [];
    const headerActions = allActions.filter((a: ViewAction) => a.position === "form-header");

    // In create mode, hide all business actions — the form already provides Save/Cancel
    if (isCreate) {
      return [];
    }

    // Case 1: Explicit stateActions mapping on the view — use it
    if (formView.stateActions && recordStatus && recordStatus in formView.stateActions) {
      const available = formView.stateActions[recordStatus] ?? [];
      return headerActions.filter((a) => available.includes(a.action));
    }

    // Case 2: No stateActions but schema has state machine — derive from transitions
    if (!formView.stateActions && schema && recordStatus) {
      const validActions = getTransitionActionNames(schema, bundle?.states, recordStatus);
      if (validActions !== null) {
        // Keep actions that are either valid transitions or non-transition actions (e.g. create/update)
        const allTransitionActions = new Set<string>();
        for (const machine of bundle?.states ?? []) {
          if (machine.schema === schema.name) {
            for (const t of machine.transitions) {
              allTransitionActions.add(t.action);
            }
          }
        }
        return headerActions.filter(
          (a) => !allTransitionActions.has(a.action) || validActions.has(a.action),
        );
      }
    }

    // Case 3: No state machine — show all header actions
    return headerActions;
  }, [formView, recordStatus, isCreate, schema, bundle?.states]);

  const isEditing = formMode === "edit" || formMode === "create";

  /** Prepare mutation input by stripping non-input fields and converting ref values to FK columns. */
  function prepareMutationInput(data: Record<string, unknown>): Record<string, unknown> {
    if (!schema) return data;
    const input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const fieldDef = schema.fields[key];
      if (!fieldDef) continue;
      // Skip derived fields — they are computed, not user input
      if (fieldDef.derived) continue;
      // Convert ref field values to FK column format (e.g., department → department_id)
      if (fieldDef.type === "ref") {
        const target = (fieldDef as { target?: string }).target;
        if (target) {
          // Check bundle.links for actual FK column name, fall back to convention
          const link = bundle?.links?.find(
            (l) =>
              (l.from === schemaName && l.to === target && (l.cardinality === "many_to_one" || l.cardinality === "one_to_one")) ||
              (l.to === schemaName && l.from === target && l.cardinality === "one_to_many"),
          );
          const fkKey = link
            ? (link.from === schemaName ? `${link.to}_id` : `${link.from}_id`)
            : `${target}_id`;
          // Extract ID from expanded object or use raw value
          const refValue = typeof value === "object" && value !== null && "id" in value
            ? (value as { id: string }).id
            : value;
          // Only send if the value is not empty
          if (refValue != null && refValue !== "") {
            input[fkKey] = refValue;
          }
        }
        continue;
      }
      // Skip has_many and many_to_many — they are managed via junction tables, not direct input
      if (fieldDef.type === "has_many" || fieldDef.type === "many_to_many") continue;
      input[key] = value;
    }
    return input;
  }

  async function handleSubmit(data: Record<string, unknown>) {
    if (!schemaName) return;
    setSaving(true);
    const mutationInput = prepareMutationInput(data);
    try {
      if (isCreate) {
        await createRecord(schemaName, mutationInput, recordFields);
        toast.success(t("toast.recordCreated", "Record created successfully"));
        navigate({ to: "/schemas/$name", params: { name: schemaName } });
      } else if (params.id) {
        await updateRecord(schemaName, params.id, mutationInput, recordFields);
        toast.success(t("toast.recordUpdated", "Record updated successfully"));
        await fetchRecord();
        setFormMode("view");
      }
    } catch (err) {
      const msg = isCreate
        ? t("toast.createFailed", "Failed to create record")
        : t("toast.updateFailed", "Failed to update record");
      toast.error(msg);
      // Re-throw so AutoForm's built-in server error parser handles display
      throw err;
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    if (!schemaName) return;
    if (isCreate) {
      navigate({ to: "/schemas/$name", params: { name: schemaName } });
    } else {
      setFormMode("view");
    }
  }

  async function handleAction(actionName: string) {
    setSaving(true);
    try {
      if (params.id) {
        const result = await executeAction(actionName, { id: params.id });
        if (result.success) {
          toast.success(t("toast.actionSuccess", "Action executed successfully"));
          pushNotification({
            type: "action_success",
            message: t("notifications.actionSucceeded", { action: actionName }),
            schema: schemaName,
            recordId: params.id,
          });
          await fetchRecord();
        } else {
          toast.error(t("toast.actionFailed", "Action failed"));
          pushNotification({
            type: "action_failure",
            message: t("notifications.actionFailed", { action: actionName }),
            schema: schemaName,
            recordId: params.id,
          });
        }
      }
    } catch (err) {
      toast.error(t("toast.actionFailed", "Action failed"));
      pushNotification({
        type: "action_failure",
        message: t("notifications.actionFailed", { action: actionName }),
        schema: schemaName,
      });
    } finally {
      setSaving(false);
    }
  }

  async function executeDelete() {
    if (!schemaName || !params.id) return;
    setDeleting(true);
    try {
      await deleteRecord(schemaName, params.id);
      toast.success(t("toast.recordDeleted", "Record deleted successfully"));
      navigate({ to: "/schemas/$name", params: { name: schemaName } });
    } catch (err) {
      toast.error(t("toast.deleteFailed", "Failed to delete record"));
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  }

  function handleBack() {
    if (!schemaName) return;
    navigate({ to: "/schemas/$name", params: { name: schemaName } });
  }

  // Missing schema name in route
  if (!schemaName) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
        <ServerCrash className="size-10" />
        <p className="text-sm">
          {t("errors.missingSchemaName", "No schema specified in the URL.")}
        </p>
      </div>
    );
  }

  // Loading bundle or record — show form skeleton matching final layout
  if (bundleLoading || loading) {
    return (
      <div className="bg-muted/30 min-h-full">
        {/* Sticky control panel skeleton */}
        <div className="sticky top-0 z-10 bg-background border-b px-4 py-2">
          <div className="flex items-center justify-between">
            <Skeleton className="h-8 w-8 rounded" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-16" />
              <Skeleton className="h-8 w-16" />
            </div>
          </div>
        </div>
        {/* Sheet card skeleton */}
        <div className="flex gap-6 my-4 px-4">
          <div className="flex-1 min-w-0 space-y-4">
            <div className="bg-background rounded shadow-sm border border-border/50 px-6 py-4 space-y-6">
              {/* Title + status bar */}
              <div className="flex items-center justify-between">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-5 w-64" />
              </div>
              {/* Form field rows */}
              {Array.from({ length: 5 }, (_, i) => `skel-field-${i}`).map((key) => (
                <div key={key} className="space-y-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Bundle fetch error
  if (bundleError || !schema || !formView) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
        <ServerCrash className="size-10" />
        <p className="text-sm font-medium">
          {t("errors.schemaLoadFailed", 'Failed to load schema "{{name}}".', { name: schemaName })}
        </p>
        <p className="text-xs">
          {t(
            "errors.checkServer",
            "Check that the server is running and the schema is registered.",
          )}
        </p>
        <Button variant="outline" size="sm" onClick={reloadBundle}>
          <RefreshCw className="mr-1.5 size-3.5" />
          {t("common.retry", "Retry")}
        </Button>
      </div>
    );
  }

  // Record fetch error (not create mode)
  if (recordError && !isCreate) {
    return (
      <div className="bg-muted/30 min-h-full">
        <div className="sticky top-0 z-10 bg-background border-b px-4 py-2">
          <Button variant="ghost" size="icon" onClick={handleBack}>
            <ArrowLeft className="size-4" />
          </Button>
        </div>
        <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
          <ServerCrash className="size-10" />
          <p className="text-sm font-medium">
            {t("errors.recordLoadFailed", "Failed to load record.")}
          </p>
          <p className="text-xs text-destructive">{recordError}</p>
          <Button variant="outline" size="sm" onClick={fetchRecord}>
            <RefreshCw className="mr-1.5 size-3.5" />
            {t("common.retry", "Retry")}
          </Button>
        </div>
      </div>
    );
  }

  // Resolve record title from schema's presentation.titleField
  const titleField = schema.presentation?.titleField as string | undefined;
  const recordTitle = isCreate
    ? t("common.new", "New")
    : String((titleField && record?.[titleField]) ?? record?.title ?? params.id ?? "");

  // Whether schema has state machine
  const hasStateMachine = statusSteps !== null && statusSteps.length > 0;
  // Separate one2many links (inline in form) from other links (RelatedRecordsPanel)
  const allLinks = bundle?.links ?? [];
  const one2manyLinks = allLinks.filter(
    (l) =>
      (l.cardinality === "one_to_many" && l.from === schemaName) ||
      (l.cardinality === "many_to_one" && l.to === schemaName),
  );
  const otherLinks = allLinks.filter(
    (l) => !one2manyLinks.includes(l),
  );
  const hasOtherLinks = otherLinks.length > 0;

  return (
    <div className="bg-muted/30 min-h-full">
      {/* Sticky control panel */}
      <div className="sticky top-0 z-10 bg-background border-b px-4 py-2">
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="icon" className="shrink-0" onClick={handleBack}>
            <ArrowLeft className="size-4" />
          </Button>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* State transition buttons */}
            {!isCreate && hasStateMachine && params.id && (
              <TransitionButtons
                schemaName={schemaName}
                recordId={params.id}
                recordFields={recordFields}
                states={bundle?.states}
                onTransitioned={(updated) => {
                  setRecord(updated);
                }}
              />
            )}

            {!isCreate && hasStateMachine && (businessActions.length > 0 || !isEditing) && (
              <Separator orientation="vertical" className="h-5 mx-1 hidden md:block" />
            )}

            {businessActions.map((a) => (
              <Button
                key={a.action}
                size="sm"
                variant={
                  a.variant === "destructive"
                    ? "destructive"
                    : a.variant === "ghost"
                      ? "ghost"
                      : "default"
                }
                disabled={saving}
                onClick={() => handleAction(a.action)}
              >
                {resolveLabel(a.label, a.action)}
              </Button>
            ))}

            {businessActions.length > 0 && (
              <Separator orientation="vertical" className="h-5 mx-1 hidden md:block" />
            )}

            {!isCreate && !isEditing && (
              <>
                <Button size="sm" variant="outline" onClick={() => setFormMode("edit")}>
                  <Pencil className="mr-1.5 size-3.5" />
                  {t("common.edit", "Edit")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    navigate({
                      to: "/schemas/$name/new",
                      params: { name: schemaName },
                      search: { clone: params.id },
                    })
                  }
                >
                  <Copy className="mr-1.5 size-3.5" />
                  {t("common.duplicate", "Duplicate")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 className="mr-1.5 size-3.5" />
                  {t("common.delete", "Delete")}
                </Button>
              </>
            )}
            {isEditing && (
              <>
                {aiEnabled && schema && (
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    disabled={saving || aiAutoFill.state.loading}
                    onClick={() => aiAutoFill.requestSuggestions(formValuesRef.current)}
                    className="text-blue-600 border-blue-200 hover:bg-blue-50 dark:text-blue-400 dark:border-blue-800 dark:hover:bg-blue-950/50"
                  >
                    {aiAutoFill.state.loading ? (
                      <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="mr-1.5 size-3.5" />
                    )}
                    {t("ai.fill", "AI Fill")}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={handleCancel} disabled={saving}>
                  {t("common.cancel", "Cancel")}
                </Button>
                <Button size="sm" type="submit" form="auto-form" disabled={saving}>
                  {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                  {t("common.save", "Save")}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Sheet card */}
      <div className="flex gap-6 my-4 px-2 md:px-4">
        <div className="flex-1 min-w-0 space-y-4">
          <div className="bg-background rounded shadow-sm border border-border/50 px-3 py-3 md:px-6 md:py-4">
            <div className="flex flex-col gap-2 mb-4 md:flex-row md:items-center md:justify-between">
              <h1 className="text-xl font-semibold text-foreground truncate">{recordTitle}</h1>
              {!isCreate && recordStatus && statusSteps && (
                <StatusBar steps={statusSteps} current={recordStatus} />
              )}
            </div>

            {/* AI suggestions accept-all bar */}
            {aiSuggestionCount > 0 && (
              <div className="mb-3 flex items-center justify-between rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm dark:border-blue-800 dark:bg-blue-950/50 animate-in fade-in duration-200">
                <span className="text-blue-700 dark:text-blue-300">
                  <Sparkles className="inline-block size-3.5 mr-1.5 -mt-0.5" />
                  {t("ai.suggestionsAvailable", "{{count}} AI suggestion(s) available", { count: aiSuggestionCount })}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400"
                    onClick={() => aiAutoFill.clearSuggestions()}
                  >
                    {t("ai.dismissAll", "Dismiss All")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 text-xs bg-blue-600 hover:bg-blue-700 text-white"
                    onClick={() => aiAutoFill.acceptAll()}
                  >
                    <Check className="mr-1 size-3" />
                    {t("ai.acceptAll", "Accept All")}
                  </Button>
                </div>
              </div>
            )}

            {/* AI error display */}
            {aiAutoFill.state.error && (
              <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {aiAutoFill.state.error}
              </div>
            )}

            <AutoForm
              schema={schema}
              view={formView}
              data={record}
              recordStatus={recordStatus}
              mode={formMode}
              onSubmit={handleSubmit}
              onCancel={handleCancel}
              onAction={(name) => handleAction(name)}
              hideFooter
              aiSuggestions={aiAutoFill.state.suggestions}
              onAiAccept={(fieldName) => aiAutoFill.acceptSuggestion(fieldName)}
              onAiReject={(fieldName) => aiAutoFill.rejectSuggestion(fieldName)}
              onValuesChange={(values) => { formValuesRef.current = values; }}
              registerSetField={(setter) => { autoFormSetFieldRef.current = setter; }}
            />

            {/* One2Many inline tables — rendered inside the form card */}
            {!isCreate && params.id && one2manyLinks.map((link) => (
              <One2ManyField
                key={link.name}
                parentSchema={schemaName}
                parentId={params.id!}
                link={link}
                readonly={!isEditing}
              />
            ))}
          </div>

          {/* Related records panel — only for non-one2many links */}
          {!isCreate && hasOtherLinks && params.id && (
            <RelatedRecordsPanel
              schemaName={schemaName}
              recordId={params.id}
              links={otherLinks}
            />
          )}

          {/* Activity / execution log panel — only in view/edit mode */}
          {!isCreate && params.id && (
            <ActivityPanel
              schemaName={schemaName}
              recordId={params.id}
            />
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("confirm.deleteTitle", "Delete record")}
        description={t("confirm.deleteDescription", "Are you sure you want to delete this record? This action cannot be undone.")}
        onConfirm={executeDelete}
        loading={deleting}
      />
    </div>
  );
}
