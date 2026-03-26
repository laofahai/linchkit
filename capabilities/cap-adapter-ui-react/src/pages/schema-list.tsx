/**
 * SchemaListPage — Dynamic schema view with List/Calendar toggle.
 *
 * Fetches schema + view definitions from server. Shows error states
 * when API is unavailable — no silent demo data fallback.
 * When the schema has date/datetime fields, a calendar view toggle appears.
 */

import type { ViewDefinition } from "@linchkit/core/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from "@linchkit/ui-kit/components";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Calendar, List, Loader2, RefreshCw, ServerCrash } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AutoCalendar } from "../components/auto-calendar";
import { AutoList } from "../components/auto-list";
import type { AutoListViewDefinition } from "../components/auto-list/types";
import { useSchemaBundle } from "../hooks/use-schema-bundle";
import { bulkDeleteRecords, deleteRecord, queryList } from "../lib/api";

type ActiveView = "list" | "calendar";

/** Extract GraphQL field names from the view definition. */
function getQueryFields(
  view: AutoListViewDefinition,
  schemaFields?: Record<string, { type?: string; target?: string }>,
): string[] {
  const fields = new Set<string>(["id"]);
  for (const f of view.fields) {
    if (f.field.includes(".")) continue;

    // Use view field name directly - GraphQL generates resolver using Link target name
    const fieldDef = schemaFields?.[f.field];
    // If field is a ref type in schema OR view field matches a ref target, expand
    const isRef =
      fieldDef?.type === "ref" ||
      Object.values(schemaFields ?? {}).some((def) => def.type === "ref" && def.target === f.field);

    if (isRef) {
      // Only query id for refs - display logic will handle label
      fields.add(`${f.field} { id }`);
    } else {
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

/** Find the first date/datetime field in schema for calendar view fallback. */
function findDateField(
  schemaFields: Record<string, { type?: string }>,
  calendarView?: ViewDefinition,
): string | null {
  // If a calendar view is defined, use its dateField
  if (calendarView?.dateField) return calendarView.dateField;

  // Auto-detect: find first date or datetime field
  const dateFieldNames = Object.entries(schemaFields)
    .filter(([, def]) => def.type === "date" || def.type === "datetime")
    .map(([name]) => name);

  // Prefer fields with meaningful names
  const preferred = ["due_date", "date", "scheduled_at", "submitted_at", "requested_at", "created_at"];
  for (const p of preferred) {
    if (dateFieldNames.includes(p)) return p;
  }
  return dateFieldNames[0] ?? null;
}

export function SchemaListPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const params = useParams({ strict: false }) as { name?: string };
  const schemaName = params.name;
  // Fetch schema bundle from API
  const {
    bundle,
    loading: bundleLoading,
    error: bundleError,
    reload: reloadBundle,
  } = useSchemaBundle(schemaName ?? "");

  const schema = bundle?.schema;
  const listView = getPrimaryView(bundle?.views, "list") as AutoListViewDefinition | undefined;
  const calendarViewDef = getPrimaryView(bundle?.views, "calendar") as ViewDefinition | undefined;

  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<ActiveView>("list");

  // Bulk delete confirmation dialog state
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const pendingBulkIds = useRef<string[]>([]);

  // Detect if calendar view is available (schema has date fields)
  const calendarDateField = useMemo(
    () => (schema ? findDateField(schema.fields, calendarViewDef) : null),
    [schema, calendarViewDef],
  );
  const hasCalendarOption = calendarDateField !== null;

  const fetchData = useCallback(async () => {
    if (!listView || !schemaName) return;
    setLoading(true);
    setDataError(null);
    try {
      const fields = getQueryFields(listView, schema?.fields);
      // Ensure the date field is included in the query for calendar view
      if (calendarDateField && !fields.some((f) => f === calendarDateField)) {
        fields.push(calendarDateField);
      }
      const result = await queryList({
        schema: schemaName,
        fields,
        pageSize: listView.pageSize ?? 50,
      });
      setData(result.items);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load data";
      setDataError(message);
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [schemaName, listView, schema?.fields, calendarDateField]);

  useEffect(() => {
    if (!bundleLoading && bundle) {
      fetchData();
    } else if (!bundleLoading && !bundle) {
      setLoading(false);
    }
  }, [fetchData, bundleLoading, bundle]);

  async function handleAction(actionName: string, recordId: string) {
    if (!schemaName) return;
    switch (actionName) {
      case "create":
        navigate({ to: "/schemas/$name/new", params: { name: schemaName } });
        break;
      case "edit":
        navigate({ to: "/schemas/$name/$id", params: { name: schemaName, id: recordId } });
        break;
      case "delete":
        try {
          await deleteRecord(schemaName, recordId);
          await fetchData();
        } catch (err) {
          console.error("Delete failed:", err);
        }
        break;
      default:
        console.log(`Action: ${actionName}, Record: ${recordId}`);
    }
  }

  function handleRowClick(recordId: string) {
    if (!schemaName) return;
    navigate({ to: "/schemas/$name/$id", params: { name: schemaName, id: recordId } });
  }

  function handleBulkAction(action: string, ids: string[]) {
    if (!schemaName || ids.length === 0) return;
    switch (action) {
      case "delete":
        pendingBulkIds.current = ids;
        setBulkDeleteOpen(true);
        break;
      default:
        console.log(`Bulk ${action}:`, ids);
    }
  }

  async function executeBulkDelete() {
    if (!schemaName || pendingBulkIds.current.length === 0) return;
    setBulkDeleting(true);
    try {
      await bulkDeleteRecords(schemaName, pendingBulkIds.current);
      await fetchData();
    } catch (err) {
      console.error("Bulk delete failed:", err);
    } finally {
      setBulkDeleting(false);
      setBulkDeleteOpen(false);
      pendingBulkIds.current = [];
    }
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

  // Loading bundle
  if (bundleLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Bundle fetch error
  if (bundleError || !schema || !listView) {
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

  // Data fetch error (bundle loaded fine, but data query failed)
  if (dataError && data.length === 0) {
    return (
      <div className="p-4">
        <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
          <ServerCrash className="h-10 w-10" />
          <p className="text-sm font-medium">
            {t("errors.dataLoadFailed", "Failed to load records.")}
          </p>
          <p className="text-xs text-destructive">{dataError}</p>
          <Button variant="outline" size="sm" onClick={fetchData}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            {t("common.retry", "Retry")}
          </Button>
        </div>
      </div>
    );
  }

  // View toggle buttons (icon-only, shown when calendar is available)
  // Uses size="sm" with fixed dimensions to match the primary action button height
  const viewToggle = hasCalendarOption ? (
    <div className="flex items-center rounded-md border border-border">
      <Button
        variant={activeView === "list" ? "default" : "ghost"}
        size="sm"
        className="size-9 p-0 rounded-r-none"
        onClick={() => setActiveView("list")}
        title={t("calendar.listView", "List view")}
      >
        <List className="h-4 w-4" />
      </Button>
      <Button
        variant={activeView === "calendar" ? "default" : "ghost"}
        size="sm"
        className="size-9 p-0 rounded-l-none border-l border-border"
        onClick={() => setActiveView("calendar")}
        title={t("calendar.calendarView", "Calendar view")}
      >
        <Calendar className="h-4 w-4" />
      </Button>
    </div>
  ) : null;

  return (
    <div className="p-4">
      {/* Active view content */}
      {activeView === "list" ? (
        <AutoList
          schema={schema}
          view={listView}
          data={data}
          loading={loading}
          selectable
          onAction={handleAction}
          onBulkAction={handleBulkAction}
          onRowClick={handleRowClick}
          toolbarExtra={viewToggle}
        />
      ) : (
        <div className="space-y-4">
          {/* Unified toolbar for calendar view */}
          <div className="flex items-center gap-3">
            <div className="flex-1" />
            <div className="flex shrink-0 items-center gap-2">
              {/* Primary action button — mirrors list toolbar */}
              {(() => {
                const primary = (listView.actions ?? []).find((a) => a.position === "toolbar");
                if (!primary) return null;
                return (
                  <Button
                    size="sm"
                    variant={primary.variant === "destructive" ? "destructive" : "default"}
                    onClick={() => handleAction(primary.action, "")}
                  >
                    {primary.label
                      ? t(primary.label, primary.label)
                      : t(`actions.${primary.action}`, primary.action)}
                  </Button>
                );
              })()}
              {viewToggle}
            </div>
          </div>
          <AutoCalendar
            schema={schema}
            dateField={calendarDateField!}
            titleField={calendarViewDef?.titleField}
            colorField={calendarViewDef?.colorField}
            data={data}
            onRecordClick={handleRowClick}
            loading={loading}
          />
        </div>
      )}

      {/* Bulk delete confirmation dialog */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("bulk.deleteTitle", "Delete records")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("bulk.deleteConfirm", "Are you sure you want to delete {{count}} record(s)? This action cannot be undone.", { count: pendingBulkIds.current.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleting}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={executeBulkDelete}
              disabled={bulkDeleting}
            >
              {bulkDeleting ? t("common.loading") : t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
