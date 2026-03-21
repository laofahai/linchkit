/**
 * SchemaFormPage — Record view with Sheet layout.
 *
 * Control panel: [← back] ............... [business actions | edit/save]
 * Sheet card:    [Record Title]  [Status Bar]
 *                form fields...
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Pencil } from "lucide-react";
import { useState } from "react";
import { AutoForm } from "../components/auto-form";
import { Separator } from "../components/ui/separator";
import { StatusBar, type StatusBarStep } from "../components/status-bar";
import { Button } from "../components/ui/button";
import { demoSchema, demoFormView, demoData } from "./schema-demo-data";

// TODO: derive from state machine definition
const purchaseStatusSteps: StatusBarStep[] = [
  { value: "draft", label: "Draft" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved", color: "success" },
  { value: "rejected", label: "Rejected", color: "danger" },
];

function getBusinessActions(status?: string) {
  if (!status) return [];
  const mapping: Record<string, { action: string; label: string; variant?: string }[]> = {
    draft: [
      { action: "submit_for_approval", label: "Submit for Approval" },
      { action: "cancel", label: "Cancel Request", variant: "ghost" },
    ],
    pending: [
      { action: "approve", label: "Approve" },
      { action: "reject", label: "Reject", variant: "destructive" },
    ],
    approved: [],
    rejected: [
      { action: "submit_for_approval", label: "Resubmit" },
    ],
  };
  return mapping[status] ?? [];
}

export function SchemaFormPage() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { name?: string; id?: string };

  const isCreate = !params.id || params.id === "new";
  const [formMode, setFormMode] = useState<"create" | "edit" | "view">(
    isCreate ? "create" : "view",
  );

  const existingRecord = isCreate
    ? undefined
    : demoData.find((r) => r.id === params.id);

  const recordStatus = existingRecord
    ? String(existingRecord.status ?? "")
    : undefined;

  const businessActions = getBusinessActions(recordStatus);
  const isEditing = formMode === "edit" || formMode === "create";

  function handleSubmit(data: Record<string, unknown>) {
    console.log(`${formMode === "create" ? "Create" : "Update"} record:`, data);
    if (isCreate) {
      navigate({ to: "/schemas/$name", params: { name: params.name ?? demoSchema.name } });
    } else {
      setFormMode("view");
    }
  }

  function handleCancel() {
    if (isCreate) {
      navigate({ to: "/schemas/$name", params: { name: params.name ?? demoSchema.name } });
    } else {
      setFormMode("view");
    }
  }

  function handleAction(actionName: string) {
    console.log(`Action: ${actionName}`, { recordId: params.id });
  }

  function handleBack() {
    navigate({ to: "/schemas/$name", params: { name: params.name ?? demoSchema.name } });
  }

  const recordTitle = isCreate
    ? "New"
    : String(existingRecord?.title ?? params.id ?? "");

  return (
    <div className="bg-muted/30 min-h-full">
      {/* Sticky control panel: back + action buttons only */}
      <div className="sticky top-0 z-10 bg-background border-b px-4 py-2">
        <div className="flex items-center justify-between">
          {/* Left: back button only */}
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>

          {/* Right: [business actions] | [edit/save/cancel] */}
          <div className="flex items-center gap-2">
            {businessActions.map((a) => (
              <Button
                key={a.action}
                size="sm"
                variant={a.variant === "destructive" ? "destructive" : a.variant === "ghost" ? "ghost" : "default"}
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
                <Button variant="ghost" size="sm" onClick={handleCancel}>
                  Cancel
                </Button>
                <Button size="sm" type="submit" form="auto-form">
                  Save
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Sheet card (full width) */}
      <div className="flex gap-6 my-4 px-4">
        <div className="flex-1 min-w-0">
          <div className="bg-background rounded shadow-sm border border-border/50 px-6 py-4">
            {/* Sheet header: title (left) + status bar (right) */}
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
              data={existingRecord}
              recordStatus={recordStatus}
              mode={formMode}
              onSubmit={handleSubmit}
              onCancel={handleCancel}
              onAction={handleAction}
              hideFooter
            />
          </div>
        </div>

        {/* Chatter slot — injected by cap-chatter */}
        {/* <div className="w-[400px] shrink-0">...</div> */}
      </div>
    </div>
  );
}
