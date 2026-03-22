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

import type { SchemaDefinition, ViewAction, ViewDefinition } from "@linchkit/core/types";
import { Button, Separator } from "@linchkit/ui-kit/components";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Loader2, Pencil, RefreshCw, ServerCrash } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AutoForm } from "../components/auto-form";
import { StatusBar, type StatusBarStep } from "../components/status-bar";
import { useSchemaBundle } from "../hooks/use-schema-bundle";
import { useSchemaLabel } from "../i18n/use-schema-label";
import { createRecord, executeAction, queryRecord, updateRecord } from "../lib/api";

/** Derive StatusBar steps from state machine meta in schema presentation */
function deriveStatusSteps(schema: SchemaDefinition): StatusBarStep[] | null {
  // Look for a state field and its meta info in presentation
  const stateField = Object.entries(schema.fields).find(([, f]) => f.type === "state");
  if (!stateField) return null;
  // TODO: load state machine from server when available
  return null;
}

/** Extract GraphQL field names from view fields */
function getRecordFields(view: ViewDefinition): string[] {
  const fields = new Set<string>(["id"]);
  for (const f of view.fields) {
    if (!f.field.includes(".")) {
      fields.add(f.field);
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

export function SchemaFormPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const params = useParams({ strict: false }) as { name?: string; id?: string };
  const schemaName = params.name;
  const { resolveLabel } = useSchemaLabel();

  // Fetch schema bundle from API
  const {
    bundle,
    loading: bundleLoading,
    error: bundleError,
    reload: reloadBundle,
  } = useSchemaBundle(schemaName ?? "");

  const schema = bundle?.schema;
  const formView = getPrimaryView(bundle?.views, "form");

  // Status bar steps derived from schema
  const statusSteps = useMemo((): StatusBarStep[] | null => {
    if (!schema) return null;
    return deriveStatusSteps(schema);
  }, [schema]);

  const isCreate = !params.id || params.id === "new";
  const [formMode, setFormMode] = useState<"create" | "edit" | "view">(
    isCreate ? "create" : "view",
  );
  const [record, setRecord] = useState<Record<string, unknown> | undefined>(undefined);
  const [loading, setLoading] = useState(!isCreate);
  const [saving, setSaving] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);

  const recordFields = useMemo(() => (formView ? getRecordFields(formView) : []), [formView]);

  const fetchRecord = useCallback(async () => {
    if (isCreate || !params.id || !schemaName || !formView) return;
    setLoading(true);
    setRecordError(null);
    try {
      const result = await queryRecord(schemaName, params.id, recordFields);
      if (result) {
        setRecord(result as Record<string, unknown>);
      } else {
        setRecordError(t("errors.recordNotFound", 'Record "{{id}}" not found.', { id: params.id }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load record";
      setRecordError(message);
    } finally {
      setLoading(false);
    }
  }, [isCreate, params.id, schemaName, recordFields, formView, t]);

  useEffect(() => {
    if (!bundleLoading && bundle) {
      fetchRecord();
    } else if (!bundleLoading && !bundle) {
      setLoading(false);
    }
  }, [fetchRecord, bundleLoading, bundle]);

  // Resolve business actions from view's stateActions mapping
  const recordStatus = record ? String(record.status ?? "") : undefined;
  const businessActions = useMemo(() => {
    if (!formView) return [];
    const allActions = formView.actions ?? [];
    const headerActions = allActions.filter((a: ViewAction) => a.position === "form-header");

    if (formView.stateActions && recordStatus && recordStatus in formView.stateActions) {
      const available = formView.stateActions[recordStatus] ?? [];
      return headerActions.filter((a) => available.includes(a.action));
    }
    return headerActions;
  }, [formView, recordStatus]);

  const isEditing = formMode === "edit" || formMode === "create";

  async function handleSubmit(data: Record<string, unknown>) {
    if (!schemaName) return;
    setSaving(true);
    try {
      if (isCreate) {
        await createRecord(schemaName, data, recordFields);
        navigate({ to: "/schemas/$name", params: { name: schemaName } });
      } else if (params.id) {
        await updateRecord(schemaName, params.id, data, recordFields);
        await fetchRecord();
        setFormMode("view");
      }
    } catch (err) {
      console.error("Save failed:", err);
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
          await fetchRecord();
        } else {
          console.error("Action failed:", result.error);
        }
      }
    } catch (err) {
      console.error("Action failed:", err);
    } finally {
      setSaving(false);
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
        <ServerCrash className="h-10 w-10" />
        <p className="text-sm">
          {t("errors.missingSchemaName", "No schema specified in the URL.")}
        </p>
      </div>
    );
  }

  // Loading bundle or record
  if (bundleLoading || loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Bundle fetch error
  if (bundleError || !schema || !formView) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
        <ServerCrash className="h-10 w-10" />
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
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
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
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
          <ServerCrash className="h-10 w-10" />
          <p className="text-sm font-medium">
            {t("errors.recordLoadFailed", "Failed to load record.")}
          </p>
          <p className="text-xs text-destructive">{recordError}</p>
          <Button variant="outline" size="sm" onClick={fetchRecord}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
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

  return (
    <div className="bg-muted/30 min-h-full">
      {/* Sticky control panel */}
      <div className="sticky top-0 z-10 bg-background border-b px-4 py-2">
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>

          <div className="flex items-center gap-2">
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
              <Separator orientation="vertical" className="h-5 mx-1" />
            )}

            {!isCreate && !isEditing && (
              <Button size="sm" variant="outline" onClick={() => setFormMode("edit")}>
                <Pencil className="h-3.5 w-3.5 mr-1.5" />
                {t("common.edit", "Edit")}
              </Button>
            )}
            {isEditing && (
              <>
                <Button variant="ghost" size="sm" onClick={handleCancel} disabled={saving}>
                  {t("common.cancel", "Cancel")}
                </Button>
                <Button size="sm" type="submit" form="auto-form" disabled={saving}>
                  {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                  {t("common.save", "Save")}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Sheet card */}
      <div className="flex gap-6 my-4 px-4">
        <div className="flex-1 min-w-0">
          <div className="bg-background rounded shadow-sm border border-border/50 px-6 py-4">
            <div className="flex items-center justify-between mb-4">
              <h1 className="text-xl font-semibold text-foreground">{recordTitle}</h1>
              {!isCreate && recordStatus && statusSteps && (
                <StatusBar steps={statusSteps} current={recordStatus} />
              )}
            </div>

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
            />
          </div>
        </div>
      </div>
    </div>
  );
}
