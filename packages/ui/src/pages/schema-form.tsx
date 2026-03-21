/**
 * SchemaFormPage — Record view with Sheet layout.
 *
 * Fetches record from GraphQL API, submits create/update mutations,
 * executes business actions via REST. Falls back to demo data if API unavailable.
 *
 * Control panel: [← back] ............... [business actions | edit/save]
 * Sheet card:    [Record Title]  [Status Bar]
 *                form fields...
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Loader2, Pencil } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AutoForm } from "../components/auto-form";
import { Separator } from "../components/ui/separator";
import { StatusBar, type StatusBarStep } from "../components/status-bar";
import { Button } from "../components/ui/button";
import { queryRecord, createRecord, updateRecord, executeAction } from "../lib/api";
import { demoSchema, demoFormView, demoData, demoStateMachine } from "./schema-demo-data";

// Derive StatusBar steps from state machine definition
const purchaseStatusSteps: StatusBarStep[] = demoStateMachine.states.map((state) => {
  const meta = demoStateMachine.meta?.[state];
  return {
    value: state,
    label: meta?.label ?? state.charAt(0).toUpperCase() + state.slice(1),
    color: meta?.color,
  };
});

/** GraphQL fields to fetch for the record */
const RECORD_FIELDS = ["id", "title", "amount", "department", "status", "priority", "description", "notes", "requester"];

function getBusinessActions(status?: string) {
  if (!status) return [];
  const mapping: Record<string, { action: string; label: string; variant?: string }[]> = {
    draft: [
      { action: "submit_purchase_request", label: "Submit for Approval" },
    ],
    pending: [
      { action: "approve_purchase_request", label: "Approve" },
    ],
    approved: [],
    rejected: [
      { action: "submit_purchase_request", label: "Resubmit" },
    ],
  };
  return mapping[status] ?? [];
}

export function SchemaFormPage() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { name?: string; id?: string };

  const schemaName = params.name ?? demoSchema.name;
  const isCreate = !params.id || params.id === "new";
  const [formMode, setFormMode] = useState<"create" | "edit" | "view">(
    isCreate ? "create" : "view",
  );
  const [record, setRecord] = useState<Record<string, unknown> | undefined>(undefined);
  const [loading, setLoading] = useState(!isCreate);
  const [saving, setSaving] = useState(false);
  const [usingApi, setUsingApi] = useState(false);

  const fetchRecord = useCallback(async () => {
    if (isCreate || !params.id) return;
    setLoading(true);
    try {
      const result = await queryRecord(schemaName, params.id, RECORD_FIELDS);
      if (result) {
        setRecord(result as Record<string, unknown>);
        setUsingApi(true);
      } else {
        // Fall back to demo data
        const demo = demoData.find((r) => r.id === params.id);
        setRecord(demo);
        setUsingApi(false);
      }
    } catch {
      // API unavailable — fall back to demo data
      const demo = demoData.find((r) => r.id === params.id);
      setRecord(demo);
      setUsingApi(false);
    } finally {
      setLoading(false);
    }
  }, [isCreate, params.id, schemaName]);

  useEffect(() => {
    fetchRecord();
  }, [fetchRecord]);

  const recordStatus = record ? String(record.status ?? "") : undefined;
  const businessActions = getBusinessActions(recordStatus);
  const isEditing = formMode === "edit" || formMode === "create";

  async function handleSubmit(data: Record<string, unknown>) {
    setSaving(true);
    try {
      if (usingApi || isCreate) {
        if (isCreate) {
          await createRecord(schemaName, data, RECORD_FIELDS);
        } else if (params.id) {
          await updateRecord(schemaName, params.id, data, RECORD_FIELDS);
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const recordTitle = isCreate
    ? "New"
    : String(record?.title ?? params.id ?? "");

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
                variant={a.variant === "destructive" ? "destructive" : a.variant === "ghost" ? "ghost" : "default"}
                disabled={saving}
                onClick={() => handleAction(a.action)}
              >
                {a.label}
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
              <h1 className="text-xl font-semibold text-foreground">
                {recordTitle}
              </h1>
              {!isCreate && recordStatus && (
                <StatusBar steps={purchaseStatusSteps} current={recordStatus} />
              )}
            </div>

            <AutoForm
              schema={demoSchema}
              view={demoFormView}
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
