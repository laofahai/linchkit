/**
 * SchemaFormPage — Dynamic record view powered by schema bundle from API.
 *
 * Fetches schema + view definitions from server, falls back to demo data
 * if API unavailable. Control panel with business actions + edit/save.
 *
 * Control panel: [← back] ............... [business actions | edit/save]
 * Sheet card:    [Record Title]  [Status Bar]
 *                form fields...
 */

import type { SchemaDefinition, ViewAction, ViewDefinition } from "@linchkit/core";
import { Button, Separator } from "@linchkit/ui-kit/components";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Loader2, Pencil } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AutoForm } from "../components/auto-form";
import type { ViewDefinitionWithStateActions } from "../components/auto-form/types";
import { StatusBar, type StatusBarStep } from "../components/status-bar";
import { useSchemaBundle } from "../hooks/use-schema-bundle";
import { useSchemaLabel } from "../i18n/use-schema-label";
import { createRecord, executeAction, queryRecord, updateRecord } from "../lib/api";
import { demoData, demoFormView, demoSchema, demoStateMachine } from "./schema-demo-data";

/** Derive StatusBar steps from state machine meta in schema presentation */
function deriveStatusSteps(schema: SchemaDefinition): StatusBarStep[] | null {
  // Look for a state field and its meta info in presentation
  const stateField = Object.entries(schema.fields).find(([, f]) => f.type === "state");
  if (!stateField) return null;
  // For now we don't have state machine info in schema bundle — return null
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
  const params = useParams({ strict: false }) as { name?: string; id?: string };
  const schemaName = params.name ?? demoSchema.name;
  const { resolveLabel } = useSchemaLabel();

  // Fetch schema bundle from API
  const { bundle, loading: bundleLoading, error: bundleError } = useSchemaBundle(schemaName);

  // Resolve schema + view from bundle or fallback to demo
  const schema: SchemaDefinition = bundle?.schema ?? demoSchema;
  const formView: ViewDefinition = getPrimaryView(bundle?.views, "form") ?? demoFormView;
  const usingDemoFallback = !bundle || bundleError;

  // Status bar steps: from demo state machine when using fallback
  const statusSteps = useMemo((): StatusBarStep[] | null => {
    if (usingDemoFallback) {
      return demoStateMachine.states.map((state) => {
        const meta = demoStateMachine.meta?.[state];
        return {
          value: state,
          label: resolveLabel(meta?.label, state.charAt(0).toUpperCase() + state.slice(1)),
          color: meta?.color,
        };
      });
    }
    return deriveStatusSteps(schema);
  }, [schema, usingDemoFallback, resolveLabel]);

  const isCreate = !params.id || params.id === "new";
  const [formMode, setFormMode] = useState<"create" | "edit" | "view">(
    isCreate ? "create" : "view",
  );
  const [record, setRecord] = useState<Record<string, unknown> | undefined>(undefined);
  const [loading, setLoading] = useState(!isCreate);
  const [saving, setSaving] = useState(false);
  const [usingApi, setUsingApi] = useState(false);

  const recordFields = useMemo(() => getRecordFields(formView), [formView]);

  const fetchRecord = useCallback(async () => {
    if (isCreate || !params.id) return;
    setLoading(true);
    try {
      const result = await queryRecord(schemaName, params.id, recordFields);
      if (result) {
        setRecord(result as Record<string, unknown>);
        setUsingApi(true);
      } else {
        const demo = demoData.find((r) => r.id === params.id);
        setRecord(demo);
        setUsingApi(false);
      }
    } catch {
      const demo = demoData.find((r) => r.id === params.id);
      setRecord(demo);
      setUsingApi(false);
    } finally {
      setLoading(false);
    }
  }, [isCreate, params.id, schemaName, recordFields]);

  useEffect(() => {
    if (!bundleLoading) {
      fetchRecord();
    }
  }, [fetchRecord, bundleLoading]);

  // Resolve business actions from view's stateActions mapping
  const recordStatus = record ? String(record.status ?? "") : undefined;
  const businessActions = useMemo(() => {
    const viewWithState = formView as ViewDefinitionWithStateActions;
    const allActions = formView.actions ?? [];
    const headerActions = allActions.filter((a: ViewAction) => a.position === "form-header");

    if (viewWithState.stateActions && recordStatus && recordStatus in viewWithState.stateActions) {
      const available = viewWithState.stateActions[recordStatus] ?? [];
      return headerActions.filter((a) => available.includes(a.action));
    }
    return headerActions;
  }, [formView, recordStatus]);

  const isEditing = formMode === "edit" || formMode === "create";

  async function handleSubmit(data: Record<string, unknown>) {
    setSaving(true);
    try {
      if (usingApi || isCreate) {
        if (isCreate) {
          await createRecord(schemaName, data, recordFields);
        } else if (params.id) {
          await updateRecord(schemaName, params.id, data, recordFields);
        }
      }
      if (isCreate) {
        navigate({ to: "/schemas/$name", params: { name: schemaName } });
      } else {
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
    if (isCreate) {
      navigate({ to: "/schemas/$name", params: { name: schemaName } });
    } else {
      setFormMode("view");
    }
  }

  async function handleAction(actionName: string) {
    setSaving(true);
    try {
      if (usingApi && params.id) {
        const result = await executeAction(actionName, { id: params.id });
        if (result.success) {
          await fetchRecord();
        } else {
          console.error("Action failed:", result.error);
        }
      } else {
        console.log(`Action: ${actionName}`, { recordId: params.id, mode: "demo" });
      }
    } catch (err) {
      console.error("Action failed:", err);
    } finally {
      setSaving(false);
    }
  }

  function handleBack() {
    navigate({ to: "/schemas/$name", params: { name: schemaName } });
  }

  if (bundleLoading || loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Resolve record title from schema's presentation.titleField
  const titleField = schema.presentation?.titleField as string | undefined;
  const recordTitle = isCreate
    ? "New"
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
                Edit
              </Button>
            )}
            {isEditing && (
              <>
                <Button variant="ghost" size="sm" onClick={handleCancel} disabled={saving}>
                  Cancel
                </Button>
                <Button size="sm" type="submit" form="auto-form" disabled={saving}>
                  {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                  Save
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
