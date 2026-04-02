/**
 * SchemaFormPage — Dynamic record view powered by schema bundle from API.
 *
 * Control panel: [← back] ............... [business actions | edit/save]
 * Sheet card:    [Record Title]  [Status Bar]
 *                form fields...
 */

import type { ViewAction } from "@linchkit/core/types";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Separator,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  toast,
} from "@linchkit/ui-kit/components";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  Copy,
  Loader2,
  MoreHorizontal,
  Pencil,
  Printer,
  RefreshCw,
  ServerCrash,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AutoForm } from "../components/auto-form";
import type { EnrichedSubmitData } from "../components/auto-form/types";
import { ChatterPanel } from "../components/chatter-panel";
import { ConfirmDialog } from "../components/confirm-dialog";
import { RelatedRecordsPanel } from "../components/related-records-panel";
import { RelatedRecordsTab } from "../components/related-records-tab";
import { StatusBar, type StatusBarStep } from "../components/status-bar";
import { VersionHistoryPanel } from "../components/version-history-panel";
import { useAiAutoFill } from "../hooks/use-ai-auto-fill";
import { useBreadcrumbTitle } from "../hooks/use-breadcrumb-title";
import { pushNotification } from "../hooks/use-notifications";
import { useSchemaBundle } from "../hooks/use-schema-bundle";
import { useTransitionPermissions } from "../hooks/use-transition-permissions";
import { useSchemaLabel } from "../i18n/use-schema-label";
import {
  createRecord,
  deleteRecord,
  executeAction,
  isAiEnabled,
  queryRecord,
  transitionRecord,
  updateRecord,
} from "../lib/api";
import {
  CLONE_STRIP_FIELDS,
  deriveStatusSteps,
  generateFallbackFormView,
  getPrimaryView,
  getRecordFields,
  getTransitionActionNames,
} from "../lib/schema-form-utils";

export function SchemaFormPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const params = useParams({ strict: false }) as { name?: string; id?: string };
  const searchParams = useSearch({ strict: false }) as { clone?: string; parent?: string };
  const cloneId = searchParams.clone;
  const parentId = searchParams.parent;
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
    () =>
      getPrimaryView(bundle?.views, "form") ??
      (schema ? generateFallbackFormView(schema) : undefined),
    [bundle?.views, schema],
  );

  // Look up optional per-schema print layout (named '{schema}-print'); reserved for future use
  const _printView = useMemo(() => {
    if (!bundle?.views || !schemaName) return undefined;
    const printViewName = `${schemaName}-print`;
    return Object.values(bundle.views).find((v) => v.name === printViewName && v.type === "form");
  }, [bundle?.views, schemaName]);

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

  const recordFields = useMemo(
    () => (formView ? getRecordFields(formView, schema) : []),
    [formView, schema],
  );

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
      const message =
        err instanceof Error ? err.message : t("errors.recordLoadFailed", "Failed to load record.");
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
      toast.error(
        t(
          "toast.cloneSourceFailed",
          "Failed to load clone source. You can fill the form manually.",
        ),
      );
      // Non-fatal — user can still fill the form manually
    } finally {
      setLoading(false);
    }
  }, [cloneId, schemaName, formView, schema, bundle?.states, t]);

  // Sync form mode when navigating between create/edit via URL changes
  useEffect(() => setFormMode(isCreate ? "create" : "view"), [isCreate]);

  useEffect(() => {
    if (!bundleLoading && bundle) {
      if (isCreate && cloneId) {
        fetchCloneSource();
      } else if (isCreate && parentId && bundle.schema) {
        // Pre-fill the parent field when creating a child record
        const schemaFields = bundle.schema.fields as Record<
          string,
          { type?: string; target?: string }
        >;
        const selfRefField = Object.entries(schemaFields).find(
          ([, def]) => def.type === "ref" && def.target === bundle.schema?.name,
        )?.[0];
        if (selfRefField) {
          setRecord({ [selfRefField]: parentId });
        }
        setLoading(false);
      } else {
        fetchRecord();
      }
    } else if (!bundleLoading && !bundle) {
      setLoading(false);
    }
  }, [fetchRecord, fetchCloneSource, bundleLoading, bundle, isCreate, cloneId, parentId]);

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
    () =>
      schema ? Object.entries(schema.fields).find(([, f]) => f.type === "state")?.[0] : undefined,
    [schema],
  );

  // Whether schema has state machine
  const hasStateMachine = statusSteps !== null && statusSteps.length > 0;

  // Resolve business actions from view's stateActions mapping or state machine transitions
  const recordStatus = record && stateFieldName ? String(record[stateFieldName] ?? "") : undefined;

  // Fetch available transitions for permission pre-check
  const {
    transitions: availableTransitions,
    permMap: transitionPermMap,
    refetch: refetchTransitions,
  } = useTransitionPermissions(schemaName, params.id, hasStateMachine && !isCreate);

  // Collect ALL transition action names across the state machine (all states, not just current)
  const allTransitionActionNames = useMemo(() => {
    const names = new Set<string>();
    if (schema) {
      for (const machine of bundle?.states ?? []) {
        if (machine.schema === schema.name) {
          for (const t of machine.transitions) {
            names.add(t.action);
          }
        }
      }
    }
    return names;
  }, [schema, bundle?.states]);

  // Header actions filtered by current state — only show actions relevant to current state
  const businessActions = useMemo(() => {
    if (!formView || isCreate) return [];
    const allActions = formView.actions ?? [];
    const headerActions = allActions.filter((a: ViewAction) => a.position === "form-header");

    // Case 1: Explicit stateActions mapping on the view — use it
    if (formView.stateActions && recordStatus && recordStatus in formView.stateActions) {
      const available = formView.stateActions[recordStatus] ?? [];
      return headerActions.filter((a) => available.includes(a.action));
    }

    // Case 2: No stateActions but schema has state machine — derive from transitions
    if (!formView.stateActions && schema && recordStatus) {
      const validActions = getTransitionActionNames(schema, bundle?.states, recordStatus);
      if (validActions !== null) {
        return headerActions.filter(
          (a) => !allTransitionActionNames.has(a.action) || validActions.has(a.action),
        );
      }
    }

    // Case 3: No state machine — show all header actions
    return headerActions;
  }, [formView, recordStatus, isCreate, schema, bundle?.states, allTransitionActionNames]);

  // Determine if a business action button is enabled
  function isActionEnabled(actionName: string): { enabled: boolean; reason?: string } {
    // Non-transition actions are always enabled
    if (!allTransitionActionNames.has(actionName)) {
      return { enabled: true };
    }
    // Transition action: check permission from availableTransitions query
    const perm = transitionPermMap.get(actionName);
    if (!perm) {
      // Not in available transitions — either still loading or invalid transition
      // Disable while loading to prevent premature clicks
      return { enabled: false };
    }
    // Explicitly check for true — if server doesn't return `allowed`, treat as disabled
    if (perm.allowed !== true) {
      return { enabled: false, reason: perm.reason ?? undefined };
    }
    return { enabled: true };
  }

  const isInternal = !!bundle?.internal;
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
              (l.from === schemaName &&
                l.to === target &&
                (l.cardinality === "many_to_one" || l.cardinality === "one_to_one")) ||
              (l.to === schemaName && l.from === target && l.cardinality === "one_to_many"),
          );
          const fkKey = link
            ? link.from === schemaName
              ? `${link.to}_id`
              : `${link.from}_id`
            : `${target}_id`;
          // Extract ID from expanded object or use raw value
          const refValue =
            typeof value === "object" && value !== null && "id" in value
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

  async function handleSubmit(
    data: Record<string, unknown>,
    enriched?: EnrichedSubmitData,
  ): Promise<undefined> {
    if (!schemaName) return;
    setSaving(true);
    try {
      // Step 1: Create virtual ref records first (quick-created related records)
      const virtualRefIdMap = new Map<string, string>(); // tempId -> real ID
      if (enriched?.virtualRefs) {
        for (const [fieldName, virtualRecord] of Object.entries(enriched.virtualRefs)) {
          const fieldDef = schema?.fields[fieldName];
          if (!fieldDef || fieldDef.type !== "ref") continue;
          const targetSchema = (fieldDef as { target?: string }).target;
          if (!targetSchema) continue;

          // Build input from virtual record, stripping internal fields
          const refInput: Record<string, unknown> = {};
          for (const [key, val] of Object.entries(virtualRecord)) {
            if (key === "_virtual" || key === "_tempId" || key === "id") continue;
            refInput[key] = val;
          }

          const created = await createRecord<{ id: string }>(targetSchema, refInput, ["id"]);
          virtualRefIdMap.set(virtualRecord._tempId, created.id);
        }
      }

      // Step 2: Prepare mutation input, replacing virtual ref IDs with real ones
      const mutationData = { ...data };
      for (const [fieldName, virtualRecord] of Object.entries(enriched?.virtualRefs ?? {})) {
        const realId = virtualRefIdMap.get(virtualRecord._tempId);
        if (realId) {
          mutationData[fieldName] = realId;
        }
      }

      const mutationInput = prepareMutationInput(mutationData);

      // Step 3: Create/update parent record
      let parentId = params.id;
      if (isCreate) {
        const created = await createRecord<{ id: string }>(schemaName, mutationInput, [
          "id",
          ...recordFields,
        ]);
        parentId = created.id;
      } else if (parentId) {
        await updateRecord(schemaName, parentId, mutationInput, recordFields);
      }

      // Step 4: Process child commands (has_many inline records)
      if (enriched?.childCommands && parentId) {
        for (const [fieldName, commands] of Object.entries(enriched.childCommands)) {
          const fieldDef = schema?.fields[fieldName];
          if (!fieldDef || fieldDef.type !== "has_many") continue;
          const targetSchema = (fieldDef as { target?: string }).target;
          if (!targetSchema) continue;

          // Find the FK column name from links
          const link = bundle?.links?.find(
            (l) =>
              (l.cardinality === "one_to_many" && l.from === schemaName && l.to === targetSchema) ||
              (l.cardinality === "many_to_one" && l.to === schemaName && l.from === targetSchema),
          );
          const fkColumn = link ? `${schemaName}_id` : `${schemaName}_id`;

          for (const cmd of commands) {
            switch (cmd.type) {
              case "create": {
                const childInput = { ...cmd.values, [fkColumn]: parentId };
                await createRecord(targetSchema, childInput, ["id"]);
                break;
              }
              case "update": {
                await updateRecord(targetSchema, cmd.id, cmd.values, ["id"]);
                break;
              }
              case "delete": {
                await deleteRecord(targetSchema, cmd.id);
                break;
              }
            }
          }
        }
      }

      if (isCreate) {
        toast.success(t("toast.recordCreated", "Record created successfully"));
        navigate({ to: "/schemas/$name", params: { name: schemaName } });
      } else {
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
      if (!params.id) return;

      // If it's a transition action, use transitionRecord instead of executeAction
      const transition = availableTransitions.find((tr) => tr.action === actionName);
      if (transition) {
        const updated = await transitionRecord(
          schemaName ?? "",
          params.id,
          transition.to,
          recordFields,
        );
        toast.success(t("toast.transitionSuccess", "Status changed successfully"));
        setRecord(updated as Record<string, unknown>);
        await refetchTransitions();
        return;
      }

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
    } catch (_err) {
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
    } catch (_err) {
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

  function handlePrint() {
    window.print();
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

  // Separate one2many links (inline in form) from other links (RelatedRecordsPanel)
  const allLinks = bundle?.links ?? [];
  const one2manyLinks = allLinks.filter(
    (l) =>
      (l.cardinality === "one_to_many" && l.from === schemaName) ||
      (l.cardinality === "many_to_one" && l.to === schemaName),
  );
  const otherLinks = allLinks.filter((l) => !one2manyLinks.includes(l));
  const hasOtherLinks = otherLinks.length > 0;

  return (
    <div className="bg-muted/30 min-h-full">
      {/* Sticky control panel */}
      <div className="sticky top-0 z-10 bg-background border-b px-4 py-2">
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="icon" className="shrink-0" onClick={handleBack}>
            <ArrowLeft className="size-4" />
          </Button>

          <TooltipProvider delayDuration={300}>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {businessActions.map((a) => {
                const { enabled, reason } = isActionEnabled(a.action);
                const isDisabled = saving || !enabled;
                const btn = (
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
                    disabled={isDisabled}
                    onClick={() => handleAction(a.action)}
                  >
                    {resolveLabel(a.label, a.action)}
                  </Button>
                );
                if (isDisabled && reason) {
                  return (
                    <Tooltip key={a.action}>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">{btn}</span>
                      </TooltipTrigger>
                      <TooltipContent>{reason}</TooltipContent>
                    </Tooltip>
                  );
                }
                return btn;
              })}

              {!isCreate && !isEditing && businessActions.length > 0 && (
                <Separator orientation="vertical" className="!self-auto h-5 mx-1 hidden md:block" />
              )}

              {!isCreate && !isEditing && !isInternal && (
                <>
                  <Button size="sm" variant="outline" onClick={handlePrint}>
                    <Printer className="mr-1.5 size-3.5" />
                    {t("common.print", "Print")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setFormMode("edit")}>
                    <Pencil className="mr-1.5 size-3.5" />
                    {t("common.edit", "Edit")}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="ghost" className="size-8 p-0">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() =>
                          navigate({
                            to: "/schemas/$name/new",
                            params: { name: schemaName },
                            search: { clone: params.id },
                          })
                        }
                      >
                        <Copy className="mr-2 size-3.5" />
                        {t("common.duplicate", "Duplicate")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => setDeleteOpen(true)}
                      >
                        <Trash2 className="mr-2 size-3.5" />
                        {t("common.delete", "Delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
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
          </TooltipProvider>
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
                  {t("ai.suggestionsAvailable", "{{count}} AI suggestion(s) available", {
                    count: aiSuggestionCount,
                  })}
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
              onValuesChange={(values) => {
                formValuesRef.current = values;
              }}
              registerSetField={(setter) => {
                autoFormSetFieldRef.current = setter;
              }}
            />
          </div>

          {/* Bottom tabs: relation tabs + other panels */}
          {!isCreate && params.id && (
            <Tabs
              defaultValue={one2manyLinks.length > 0 ? `link-${one2manyLinks[0]?.name}` : "chatter"}
            >
              <TabsList variant="line">
                {/* One_to_many relationship tabs */}
                {one2manyLinks.map((link) => {
                  const rawLabel =
                    (link.cardinality === "one_to_many" ? link.label?.from : link.label?.to) ??
                    link.to;
                  const tabLabel = resolveLabel(rawLabel, link.to);
                  return (
                    <TabsTrigger key={`link-${link.name}`} value={`link-${link.name}`}>
                      {tabLabel}
                    </TabsTrigger>
                  );
                })}
                {/* Other links tab (many_to_many, etc.) */}
                {hasOtherLinks && (
                  <TabsTrigger value="related">
                    {t("detail.relatedRecords", "Related Records")}
                  </TabsTrigger>
                )}
                {/* Version history tab */}
                <TabsTrigger value="version-history">
                  {t("versionHistory.title", "Version History")}
                </TabsTrigger>
                {/* Chatter tab */}
                <TabsTrigger value="chatter">{t("chatter.title", "Chatter")}</TabsTrigger>
              </TabsList>

              {/* One_to_many tab content */}
              {one2manyLinks.map((link) => (
                <TabsContent key={`link-${link.name}`} value={`link-${link.name}`}>
                  <RelatedRecordsTab
                    parentSchema={schemaName}
                    parentId={params.id ?? ""}
                    link={link}
                  />
                </TabsContent>
              ))}

              {/* Other links tab content */}
              {hasOtherLinks && (
                <TabsContent value="related">
                  <RelatedRecordsPanel
                    schemaName={schemaName}
                    recordId={params.id ?? ""}
                    links={otherLinks}
                    bare
                  />
                </TabsContent>
              )}

              {/* Version history tab content */}
              <TabsContent value="version-history">
                <VersionHistoryPanel
                  schemaName={schemaName}
                  recordId={params.id ?? ""}
                  currentRecord={record}
                  fields={schema.fields}
                  recordFields={recordFields}
                  onRestore={() => {
                    fetchRecord();
                    toast.success(
                      t("versionHistory.restoreSuccess", "Record restored to selected version"),
                    );
                  }}
                />
              </TabsContent>

              {/* Chatter tab content */}
              <TabsContent value="chatter">
                <ChatterPanel schemaName={schemaName} recordId={params.id ?? ""} />
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("confirm.deleteTitle", "Delete record")}
        description={t(
          "confirm.deleteDescription",
          "Are you sure you want to delete this record? This action cannot be undone.",
        )}
        onConfirm={executeDelete}
        loading={deleting}
      />
    </div>
  );
}
