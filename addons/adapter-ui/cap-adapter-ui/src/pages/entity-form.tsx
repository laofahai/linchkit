/**
 * EntityFormPage — Dynamic record view powered by schema bundle from API.
 *
 * Control panel: [← back] ............... [business actions | edit/save]
 * Sheet card:    [Record Title]  [Status Bar]
 *                form fields...
 */

import type { ViewAction } from "@linchkit/core/types";
import {
  Button,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from "@linchkit/ui-kit/components";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Check, Sparkles } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AutoForm } from "../components/auto-form";
import { ConfirmDialog } from "../components/confirm-dialog";
import { RelatedRecordsPanel } from "../components/related-records-panel";
import { RelatedRecordsTab } from "../components/related-records-tab";
import { type StateTransitionInfo, StatusBar, type StatusBarStep } from "../components/status-bar";
import { useAiAutoFill } from "../hooks/use-ai-auto-fill";
import { useBreadcrumbTitle } from "../hooks/use-breadcrumb-title";
import { useEntityBundle } from "../hooks/use-entity-bundle";
import { useOverlayFields } from "../hooks/use-overlay-fields";
import { useTransitionPermissions } from "../hooks/use-transition-permissions";
import { useEntityLabel } from "../i18n/use-entity-label";
import { getActiveCapabilities, isAiEnabled } from "../lib/app-config";
import { queryRecord } from "../lib/entity-api";
import {
  deriveStatusSteps,
  generateFallbackFormView,
  getPrimaryView,
  getRecordFields,
  getTransitionActionNames,
} from "../lib/entity-form-utils";
import { getRecordPanels } from "../lib/panel-registry";
import { useFormActions } from "./entity-form-actions";
import { EntityFormHeader } from "./entity-form-header";
import {
  BundleErrorState,
  FormLoadingSkeleton,
  MissingSchemaState,
  RecordErrorState,
} from "./entity-form-states";

/** Page component for creating, viewing, and editing entity records with schema-driven form, status bar, and AI auto-fill. */
export function EntityFormPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const params = useParams({ strict: false }) as { name?: string; id?: string };
  const searchParams = useSearch({ strict: false }) as { clone?: string; parent?: string };
  const cloneId = searchParams.clone;
  const parentId = searchParams.parent;
  const entityName = params.name;
  const { resolveLabel } = useEntityLabel();
  const { setBreadcrumbTitle } = useBreadcrumbTitle();

  // Fetch schema bundle from API
  const {
    bundle,
    loading: bundleLoading,
    error: bundleError,
    reload: reloadBundle,
  } = useEntityBundle(entityName ?? "");

  const schema = bundle?.schema;

  // Fetch runtime overlay fields for this entity
  const { overlayFields } = useOverlayFields(entityName);

  const formView = useMemo(
    () =>
      getPrimaryView(bundle?.views, "form") ??
      (schema ? generateFallbackFormView(schema) : undefined),
    [bundle?.views, schema],
  );

  // Look up optional per-schema print layout (named '{schema}-print'); reserved for future use
  const _printView = useMemo(() => {
    if (!bundle?.views || !entityName) return undefined;
    const printViewName = `${entityName}-print`;
    return Object.values(bundle.views).find((v) => v.name === printViewName && v.type === "form");
  }, [bundle?.views, entityName]);

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
  const [recordError, setRecordError] = useState<string | null>(null);
  const [stateTransitions, setStateTransitions] = useState<StateTransitionInfo[]>([]);

  // AI auto-fill — always call hook (React rules), but only use when schema is loaded
  const aiEnabled = isAiEnabled();
  const formValuesRef = useRef<Record<string, unknown>>({});
  const autoFormSetFieldRef = useRef<((fieldName: string, value: unknown) => void) | null>(null);
  const dummySchema = useMemo(() => ({ name: "__dummy__", fields: {} }), []);
  const aiAutoFill = useAiAutoFill(
    (schema ?? dummySchema) as import("@linchkit/core/types").EntityDefinition,
    (fieldName, value) => {
      autoFormSetFieldRef.current?.(fieldName, value);
    },
  );
  const aiSuggestionCount = Object.keys(aiAutoFill.state.suggestions).length;

  const entityRelations = bundle?.relations;
  const recordFields = useMemo(() => {
    if (!formView) return [];
    const fields = getRecordFields(formView, schema, entityRelations);
    // Include _extensions when overlay fields exist (contains overlay field values)
    if (overlayFields.length > 0 && !fields.includes("_extensions")) {
      fields.push("_extensions");
    }
    return fields;
  }, [formView, schema, entityRelations, overlayFields]);

  // Stabilize recordFields via ref so fetchRecord doesn't get recreated on every render
  const recordFieldsRef = useRef(recordFields);
  recordFieldsRef.current = recordFields;

  const fetchRecord = useCallback(async () => {
    if (isCreate || !params.id || !entityName || !formView) return;
    setLoading(true);
    setRecordError(null);
    try {
      const result = await queryRecord(entityName, params.id, recordFieldsRef.current);
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
  }, [isCreate, params.id, entityName, formView, t]);

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
  } = useTransitionPermissions(entityName, params.id, hasStateMachine && !isCreate);

  // Collect ALL transition action names across the state machine (all states, not just current)
  const allTransitionActionNames = useMemo(() => {
    const names = new Set<string>();
    if (schema) {
      for (const machine of bundle?.states ?? []) {
        if (machine.entity === schema.name) {
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
      return { enabled: false };
    }
    if (perm.allowed !== true) {
      return { enabled: false, reason: perm.reason ?? undefined };
    }
    return { enabled: true };
  }

  const isInternal = !!bundle?.internal;
  const isEditing = formMode === "edit" || formMode === "create";

  // --- Actions hook ---
  const actions = useFormActions({
    entityName: entityName,
    recordId: params.id,
    isCreate,
    schema,
    bundle,
    recordFields,
    recordFieldsRef,
    availableTransitions,
    navigate,
    fetchRecord,
    refetchTransitions,
    t,
  });

  // Wrap handleAction to update local record state on transition
  const handleAction = useCallback(
    async (actionName: string) => {
      const result = await actions.handleAction(actionName);
      if (result) {
        setRecord(result);
        await refetchTransitions();
      }
    },
    [actions, refetchTransitions],
  );

  // Wrap handleSubmit to set formMode on update success
  const handleSubmit = useCallback(
    async (
      data: Record<string, unknown>,
      enriched?: import("../components/auto-form/types").EnrichedSubmitData,
    ): Promise<undefined> => {
      await actions.handleSubmit(data, enriched);
      if (!isCreate) {
        await fetchRecord();
        setFormMode("view");
      }
      return undefined;
    },
    [actions, isCreate, fetchRecord],
  );

  // Wrap handleCancel to also set formMode
  const handleCancel = useCallback(() => {
    actions.handleCancel();
    if (!isCreate) {
      setFormMode("view");
    }
  }, [actions, isCreate]);

  // Sync form mode when navigating between create/edit via URL changes
  useEffect(() => setFormMode(isCreate ? "create" : "view"), [isCreate]);

  // Stabilize actions via ref to prevent infinite effect re-runs
  // (useFormActions returns a new object reference on each render)
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  // Data loading effects
  useEffect(() => {
    if (!bundleLoading && bundle) {
      if (isCreate && cloneId) {
        setLoading(true);
        actionsRef.current.fetchCloneSource(cloneId, formView).then((cloned) => {
          if (cloned) setRecord(cloned);
          setLoading(false);
        });
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
        fetchRecord().then(() => {
          // Fetch state transitions after record loads (non-blocking)
          if (!isCreate && params.id) {
            actionsRef.current.fetchStateTransitions(params.id).then(setStateTransitions);
          }
        });
      }
    } else if (!bundleLoading && !bundle) {
      setLoading(false);
    }
  }, [fetchRecord, bundleLoading, bundle, isCreate, cloneId, parentId, formView, params.id]);

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

  // --- Early returns for loading/error states ---

  if (!entityName) {
    return <MissingSchemaState t={t} />;
  }

  if (bundleLoading || loading) {
    return <FormLoadingSkeleton />;
  }

  if (bundleError || !schema || !formView) {
    return <BundleErrorState t={t} entityName={entityName} onRetry={reloadBundle} />;
  }

  if (recordError && !isCreate) {
    return (
      <RecordErrorState
        t={t}
        error={recordError}
        onBack={actions.handleBack}
        onRetry={fetchRecord}
      />
    );
  }

  // Resolve record title from schema's presentation.titleField
  const titleField = schema.presentation?.titleField as string | undefined;
  const recordTitle = isCreate
    ? t("common.new", "New")
    : String((titleField && record?.[titleField]) ?? record?.title ?? params.id ?? "");

  // Separate one2many relations (inline in form) from other relations (RelatedRecordsPanel)
  const allRelations = bundle?.relations ?? [];
  const one2manyRelations = allRelations.filter(
    (l) =>
      (l.cardinality === "one_to_many" && l.from === entityName) ||
      (l.cardinality === "many_to_one" && l.to === entityName),
  );
  const otherRelations = allRelations.filter((l) => !one2manyRelations.includes(l));
  const hasOtherRelations = otherRelations.length > 0;

  return (
    <div className="bg-muted/30 min-h-full">
      {/* Sticky control panel */}
      <EntityFormHeader
        t={t}
        entityName={entityName}
        recordId={params.id}
        isCreate={isCreate}
        isEditing={isEditing}
        isInternal={isInternal}
        saving={actions.saving}
        businessActions={businessActions}
        isActionEnabled={isActionEnabled}
        resolveLabel={resolveLabel}
        onBack={actions.handleBack}
        onAction={handleAction}
        onEdit={() => setFormMode("edit")}
        onCancel={handleCancel}
        onPrint={actions.handlePrint}
        onDuplicate={() =>
          navigate({
            to: "/entities/$name/new",
            params: { name: entityName },
            search: { clone: params.id },
          })
        }
        onDeleteOpen={() => actions.setDeleteOpen(true)}
        aiEnabled={aiEnabled && !!schema}
        aiLoading={aiAutoFill.state.loading}
        onAiFill={() => aiAutoFill.requestSuggestions(formValuesRef.current)}
      />

      {/* Sheet card */}
      <div className="flex gap-6 my-4 px-2 md:px-4">
        <div className="flex-1 min-w-0 space-y-4">
          <div className="bg-background rounded shadow-sm border border-border/50 px-3 py-3 md:px-6 md:py-4">
            <div className="flex flex-col gap-2 mb-4 md:flex-row md:items-center md:justify-between">
              <h1 className="text-xl font-semibold text-foreground truncate">{recordTitle}</h1>
              {!isCreate && recordStatus && statusSteps && (
                <StatusBar
                  steps={statusSteps}
                  current={recordStatus}
                  transitions={stateTransitions}
                />
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
              overlayFields={overlayFields.length > 0 ? overlayFields : undefined}
              relations={entityRelations}
            />
          </div>

          {/* Bottom tabs: relation tabs + registered panels */}
          {!isCreate &&
            params.id &&
            (() => {
              const activeCapabilities = getActiveCapabilities();
              const recordPanels = getRecordPanels();
              const activePanels = recordPanels.filter(
                (p) => p.capability === "__builtin__" || activeCapabilities.includes(p.capability),
              );
              return (
                <Tabs
                  defaultValue={
                    one2manyRelations.length > 0
                      ? `link-${one2manyRelations[0]?.name}`
                      : (activePanels[0]?.id ?? "version-history")
                  }
                >
                  <TabsList variant="line">
                    {/* One_to_many relationship tabs */}
                    {one2manyRelations.map((link) => {
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
                    {/* Other relations tab (many_to_many, etc.) */}
                    {hasOtherRelations && (
                      <TabsTrigger value="related">
                        {t("detail.relatedRecords", "Related Records")}
                      </TabsTrigger>
                    )}
                    {/* Registered panels (version history, chatter, etc.) */}
                    {activePanels.map((panel) => (
                      <TabsTrigger key={panel.id} value={panel.id}>
                        {t(panel.label, panel.label)}
                      </TabsTrigger>
                    ))}
                  </TabsList>

                  {/* One_to_many tab content */}
                  {one2manyRelations.map((link) => (
                    <TabsContent key={`link-${link.name}`} value={`link-${link.name}`}>
                      <RelatedRecordsTab
                        parentSchema={entityName}
                        parentId={params.id ?? ""}
                        link={link}
                      />
                    </TabsContent>
                  ))}

                  {/* Other relations tab content */}
                  {hasOtherRelations && (
                    <TabsContent value="related">
                      <RelatedRecordsPanel
                        entityName={entityName}
                        recordId={params.id ?? ""}
                        relations={otherRelations}
                        bare
                      />
                    </TabsContent>
                  )}

                  {/* Registered panel content (lazy-loaded) */}
                  {activePanels.map((panel) => {
                    const LazyPanel = lazy(panel.component);
                    return (
                      <TabsContent key={panel.id} value={panel.id}>
                        <Suspense
                          fallback={
                            <div className="p-4 text-muted-foreground">
                              {t("common.loading", "Loading...")}
                            </div>
                          }
                        >
                          <LazyPanel
                            entityName={entityName}
                            recordId={params.id ?? ""}
                            record={record}
                            fields={schema.fields}
                            recordFields={recordFields}
                            onRestore={() => {
                              fetchRecord();
                              toast.success(
                                t(
                                  "versionHistory.restoreSuccess",
                                  "Record restored to selected version",
                                ),
                              );
                            }}
                          />
                        </Suspense>
                      </TabsContent>
                    );
                  })}
                </Tabs>
              );
            })()}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={actions.deleteOpen}
        onOpenChange={actions.setDeleteOpen}
        title={t("confirm.deleteTitle", "Delete record")}
        description={t(
          "confirm.deleteDescription",
          "Are you sure you want to delete this record? This action cannot be undone.",
        )}
        onConfirm={actions.executeDelete}
        loading={actions.deleting}
      />
    </div>
  );
}
