/**
 * SchemaListPage — Dynamic schema view with List/Calendar toggle.
 *
 * Fetches schema + view definitions from server. Shows error states
 * when API is unavailable — no silent demo data fallback.
 * When the schema has date/datetime fields, a calendar view toggle appears.
 */

import type { ViewDefinition } from "@linchkit/core/types";
import { Button, Skeleton, toast } from "@linchkit/ui-kit/components";

import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { startOfMonth } from "date-fns";
import { Calendar, Kanban, List, ListTree, RefreshCw, ServerCrash } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AutoCalendar, CalendarNavControls } from "../components/auto-calendar";
import { AutoKanban } from "../components/auto-kanban";
import { buildFilterColumns } from "../components/auto-list/filter-columns";
import type { AutoListViewDefinition } from "../components/auto-list/types";
import { AutoTree } from "../components/auto-tree";
import { ConfirmDialog } from "../components/confirm-dialog";
import { useDataTableFilters } from "../components/data-table-filter";
import type { FiltersState } from "../components/data-table-filter/core/types";
import { EmptyState } from "../components/empty-state";
import { ListView } from "../components/list-view";
import { isNaturalLanguageQuery, useAISearch } from "../hooks/use-ai-search";
import { pushNotification } from "../hooks/use-notifications";
import type { SavedViewFilter } from "../hooks/use-saved-views";
import { useSavedViews } from "../hooks/use-saved-views";
import { useSchemaBundle } from "../hooks/use-schema-bundle";
import { buildSchemaSubscriptionQuery, useSubscription } from "../hooks/use-subscription";
import { useSchemaLabel } from "../i18n/use-schema-label";
import { bulkDeleteRecords, deleteRecord, queryList } from "../lib/api";

type ActiveView = "list" | "calendar" | "kanban" | "tree";

/** Relationship field types that require subfield selection in GraphQL. */
const RELATION_FIELD_TYPES = new Set(["ref", "has_many", "many_to_many"]);

/**
 * Build a set of GraphQL field names that are link-generated resolvers
 * and therefore require subfield selection `{ id }`.
 *
 * Link resolver naming convention (see link-resolvers.ts):
 * - many_to_one from-side:   fieldName = link.to          (singular)
 * - many_to_one to-side:     fieldName = `${link.from}s`  (plural)
 * - one_to_many from-side:   fieldName = `${link.to}s`    (plural)
 * - one_to_many to-side:     fieldName = link.from         (singular)
 * - one_to_one:              fieldName = link.to / link.from
 * - many_to_many:            fieldName = `${otherSchema}s` (plural)
 */
function buildLinkFieldNames(
  links: Array<{ from: string; to: string; cardinality: string }>,
  schemaName?: string,
): Set<string> {
  const names = new Set<string>();
  for (const link of links) {
    const isFrom = link.from === schemaName;
    const isTo = link.to === schemaName;

    switch (link.cardinality) {
      case "many_to_one":
        if (isFrom) names.add(link.to); // singular
        if (isTo) names.add(`${link.from}s`); // plural
        break;
      case "one_to_many":
        if (isFrom) names.add(`${link.to}s`); // plural
        if (isTo) names.add(link.from); // singular
        break;
      case "one_to_one":
        if (isFrom) names.add(link.to);
        if (isTo) names.add(link.from);
        break;
      case "many_to_many":
        if (isFrom) names.add(`${link.to}s`);
        if (isTo) names.add(`${link.from}s`);
        break;
      default:
        // Fallback: add both sides
        names.add(link.to);
        names.add(link.from);
        names.add(`${link.to}s`);
        names.add(`${link.from}s`);
    }
  }
  return names;
}

/** Extract GraphQL field names from the view definition. */
function getQueryFields(
  view: AutoListViewDefinition,
  schemaFields?: Record<string, { type?: string; target?: string }>,
  links?: Array<{ from: string; to: string; cardinality: string }>,
  schemaName?: string,
): string[] {
  const fields = new Set<string>(["id"]);

  // Build a set of field names that are link-generated resolvers
  const linkFieldNames = links ? buildLinkFieldNames(links, schemaName) : new Set<string>();

  for (const f of view.fields) {
    if (f.field.includes(".")) continue;

    const fieldDef = schemaFields?.[f.field];

    // Determine if this field is a relationship that needs subfield selection:
    // 1. Schema field with relationship type (ref, has_many, many_to_many)
    // 2. Field name matches a link-generated resolver name
    // 3. Field not in schema AND not a system field (likely a link resolver)
    const isRelation =
      (fieldDef && RELATION_FIELD_TYPES.has(fieldDef.type ?? "")) ||
      linkFieldNames.has(f.field) ||
      (!fieldDef && !SYSTEM_FIELDS.has(f.field));

    if (isRelation) {
      // Request id subfield for object/list types
      fields.add(`${f.field} { id }`);
    } else {
      fields.add(f.field);
    }
  }
  return Array.from(fields);
}

/** System fields that are always scalar — never need subfield selection. */
const SYSTEM_FIELDS = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "_version",
]);

function getPrimaryView<TView extends { type: string }>(
  views: Record<string, TView> | undefined,
  type: TView["type"],
): TView | undefined {
  return Object.values(views ?? {}).find((view) => view.type === type);
}

/**
 * Generate a fallback list view from schema fields when no explicit list view is defined.
 * Shows up to 6 fields in definition order with basic CRUD actions.
 */
function generateFallbackListView(schema: {
  name: string;
  label?: string;
  fields: Record<string, unknown>;
}): AutoListViewDefinition {
  const fieldNames = Object.keys(schema.fields).slice(0, 6);
  return {
    name: `${schema.name}_list_auto`,
    schema: schema.name,
    type: "list",
    label: schema.label ?? schema.name,
    fields: fieldNames.map((field) => ({ field, sortable: true })),
    defaultSort: fieldNames[0] ? { field: fieldNames[0], order: "asc" as const } : undefined,
    pageSize: 20,
    actions: [
      {
        action: "create",
        label: "t:common.new",
        position: "toolbar" as const,
        variant: "default" as const,
      },
      { action: "edit", label: "t:common.edit", position: "row" as const },
      { action: "duplicate", label: "t:common.duplicate", position: "row" as const },
      {
        action: "delete",
        label: "t:common.delete",
        position: "row" as const,
        variant: "destructive" as const,
        confirm: "t:confirm.deleteDescription",
      },
    ],
  };
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
  const preferred = [
    "due_date",
    "date",
    "scheduled_at",
    "submitted_at",
    "requested_at",
    "created_at",
  ];
  for (const p of preferred) {
    if (dateFieldNames.includes(p)) return p;
  }
  return dateFieldNames[0] ?? null;
}

/**
 * Find a self-referencing ref field in the schema (e.g. parent_id pointing to same schema).
 * Returns the field name if found, or null.
 */
function findSelfRefField(
  schemaName: string,
  schemaFields: Record<string, { type?: string; target?: string }>,
): string | null {
  for (const [fieldName, def] of Object.entries(schemaFields)) {
    if (def.type === "ref" && def.target === schemaName) {
      return fieldName;
    }
  }
  return null;
}

export function SchemaListPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { resolveLabel } = useSchemaLabel();
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
  const explicitListView = getPrimaryView(bundle?.views, "list") as
    | AutoListViewDefinition
    | undefined;
  // Fallback: auto-generate a list view from schema fields when none is defined.
  // Memoize to avoid creating a new object reference on every render.
  const listView = useMemo(
    () => explicitListView ?? (schema ? generateFallbackListView(schema) : undefined),
    [explicitListView, schema],
  );
  const calendarViewDef = getPrimaryView(bundle?.views, "calendar") as ViewDefinition | undefined;

  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<ActiveView>("list");
  const [calendarMonth, setCalendarMonth] = useState(() => startOfMonth(new Date()));
  // Track whether at least one successful fetch has been completed, to distinguish
  // "no records exist" from "data not yet loaded" for the empty state message.
  const [_hasLoadedOnce, setHasLoadedOnce] = useState(false);

  // ── Saved views (localStorage-backed) ──────────────────────────
  const { views: savedViews, createView, renameView, deleteView } = useSavedViews(schemaName ?? "");
  const searchParams = useSearch({ strict: false }) as { view?: string };
  const [activeSavedViewId, setActiveSavedViewId] = useState<string | null>(
    () => searchParams.view ?? null,
  );

  // Sync URL when saved view changes
  const handleSelectSavedView = useCallback((viewId: string | null) => {
    setActiveSavedViewId(viewId);
    // Update URL query param without full navigation
    const url = new URL(window.location.href);
    if (viewId) {
      url.searchParams.set("view", viewId);
    } else {
      url.searchParams.delete("view");
    }
    window.history.replaceState({}, "", url.toString());
  }, []);

  // Resolve the currently active saved view object
  const activeSavedView = useMemo(
    () => (activeSavedViewId ? (savedViews.find((v) => v.id === activeSavedViewId) ?? null) : null),
    [activeSavedViewId, savedViews],
  );

  // Track bazza filter state from AutoList for save-view functionality
  const [currentBazzaFilters, setCurrentBazzaFilters] = useState<SavedViewFilter[]>([]);
  const hasActiveListFilters = currentBazzaFilters.length > 0;

  // ── Page-level filter state (shared between list and alternate views) ──
  const [globalFilter, setGlobalFilter] = useState("");
  const [bazzaFilters, setBazzaFilters] = useState<FiltersState>([]);

  // AI search (schema mode)
  const { aiSearch: aiSearchState, triggerAISearch, clearAISearch } = useAISearch(schema);

  const handleSearchSubmit = useCallback(
    (query: string) => {
      if (schema && isNaturalLanguageQuery(query)) {
        triggerAISearch(query);
      }
    },
    [schema, triggerAISearch],
  );

  // Single delete confirmation dialog state
  const [singleDeleteOpen, setSingleDeleteOpen] = useState(false);
  const [singleDeleting, setSingleDeleting] = useState(false);
  const pendingSingleDeleteId = useRef<string>("");

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

  // Detect if kanban view is available (schema has state definitions)
  const primaryStateDef = useMemo(
    () => (bundle?.states && bundle.states.length > 0 ? bundle.states[0] : null),
    [bundle?.states],
  );
  const hasKanbanOption = primaryStateDef !== null;

  // Detect if tree view is available (schema has self-referencing ref field)
  const selfRefField = useMemo(
    () =>
      schema
        ? findSelfRefField(
            schema.name,
            schema.fields as Record<string, { type?: string; target?: string }>,
          )
        : null,
    [schema],
  );
  const hasTreeOption = selfRefField !== null;

  // Resolve tree label field from presentation or first string field
  const treeLabelField = useMemo(() => {
    if (!schema) return "name";
    const pres = schema.presentation as { titleField?: string } | undefined;
    if (pres?.titleField) return pres.titleField;
    // Fallback: find first string field
    for (const [fieldName, def] of Object.entries(schema.fields)) {
      if ((def as { type?: string }).type === "string") return fieldName;
    }
    return "name";
  }, [schema]);

  // Resolve tree summary fields from presentation
  const treeSummaryFields = useMemo(() => {
    if (!schema) return undefined;
    const pres = schema.presentation as { summaryFields?: string[] } | undefined;
    return pres?.summaryFields?.slice(0, 2);
  }, [schema]);

  // ── Bazza filter columns + hook (page-level, shared across views) ──────
  const filterColumnsConfig = useMemo(
    () => (schema ? buildFilterColumns(schema, data, undefined, resolveLabel) : []),
    [schema, data, resolveLabel],
  );

  const {
    columns: bazzaColumns,
    filters: bazzaFilterState,
    actions: bazzaActions,
    strategy: bazzaStrategy,
  } = useDataTableFilters({
    strategy: "client",
    data,
    columnsConfig: filterColumnsConfig,
    filters: bazzaFilters,
    onFiltersChange: setBazzaFilters,
  });

  const hasPageLevelFilters =
    globalFilter !== "" || bazzaFilterState.length > 0 || !!aiSearchState.result;

  const handleClearAllFilters = useCallback(() => {
    setBazzaFilters([]);
    setGlobalFilter("");
    clearAISearch();
  }, [clearAISearch]);

  /**
   * Apply page-level filters (text search + bazza + AI) to data.
   * Used by alternate views (calendar, kanban, tree) that don't have AutoList's
   * built-in filtering. The list view passes this state to AutoList as controlled props.
   */
  const pageFilteredData = useMemo(() => {
    let result = data;

    // Global text filter
    if (globalFilter) {
      const lower = globalFilter.toLowerCase();
      result = result.filter((row) =>
        Object.values(row).some((v) =>
          String(v ?? "")
            .toLowerCase()
            .includes(lower),
        ),
      );
    }

    // Bazza filters
    if (bazzaFilterState.length > 0) {
      result = result.filter((row) =>
        bazzaFilterState.every((f) => {
          const val = row[f.field];
          const fv = f.values;
          if (fv.length === 0) return true;
          switch (f.operator) {
            case "eq":
            case "in":
              return fv.includes(val as string);
            case "neq":
            case "not_in":
              return !fv.includes(val as string);
            case "contains":
              return String(val ?? "")
                .toLowerCase()
                .includes(String(fv[0] ?? "").toLowerCase());
            case "gt":
              return Number(val) > Number(fv[0]);
            case "gte":
              return Number(val) >= Number(fv[0]);
            case "lt":
              return Number(val) < Number(fv[0]);
            case "lte":
              return Number(val) <= Number(fv[0]);
            case "between":
              return Number(val) >= Number(fv[0]) && Number(val) <= Number(fv[1]);
            default:
              return true;
          }
        }),
      );
    }

    // AI search filter
    if (aiSearchState.result?.filter) {
      const aiFilter = aiSearchState.result.filter as Record<string, unknown>;
      const op = (aiFilter.operator as string) ?? "";
      // Simple condition evaluation for AI filter
      if (op === "contains" || op === "eq" || op === "neq" || op === "in" || op === "not_in") {
        const field = aiFilter.field as string;
        const value = aiFilter.value;
        if (field) {
          result = result.filter((row) => {
            const rv = row[field];
            switch (op) {
              case "contains":
                return String(rv ?? "")
                  .toLowerCase()
                  .includes(String(value ?? "").toLowerCase());
              case "eq":
                return rv === value || String(rv) === String(value);
              case "neq":
                return rv !== value && String(rv) !== String(value);
              case "in":
                return Array.isArray(value)
                  ? value.some((v: unknown) => String(rv) === String(v))
                  : false;
              case "not_in":
                return Array.isArray(value)
                  ? !value.some((v: unknown) => String(rv) === String(v))
                  : true;
              default:
                return true;
            }
          });
        }
      }
    }

    return result;
  }, [data, globalFilter, bazzaFilterState, aiSearchState.result]);

  // Use refs for values needed inside fetchData to keep its identity stable.
  // This prevents the useCallback from changing on every render, which would
  // cascade into the useEffect and subscription handler causing infinite loops.
  const listViewRef = useRef(listView);
  listViewRef.current = listView;
  const schemaFieldsRef = useRef(schema?.fields);
  schemaFieldsRef.current = schema?.fields;
  const bundleLinksRef = useRef(bundle?.links);
  bundleLinksRef.current = bundle?.links;
  const calendarDateFieldRef = useRef(calendarDateField);
  calendarDateFieldRef.current = calendarDateField;
  const primaryStateDefRef = useRef(primaryStateDef);
  primaryStateDefRef.current = primaryStateDef;
  const schemaPresentationRef = useRef(schema?.presentation);
  schemaPresentationRef.current = schema?.presentation;
  const selfRefFieldRef = useRef(selfRefField);
  selfRefFieldRef.current = selfRefField;
  const treeLabelFieldRef = useRef(treeLabelField);
  treeLabelFieldRef.current = treeLabelField;
  const treeSummaryFieldsRef = useRef(treeSummaryFields);
  treeSummaryFieldsRef.current = treeSummaryFields;

  // Reset data when navigating to a different schema to avoid stale results
  useEffect(() => {
    setData([]);
    setDataError(null);
    setLoading(true);
    setActiveSavedViewId(null);
    setCurrentBazzaFilters([]);
    // Reset page-level filters
    setGlobalFilter("");
    setBazzaFilters([]);
    clearAISearch();
    // Reset view type and calendar position so a previously selected calendar
    // view does not persist when navigating to a different schema.
    setActiveView("list");
    setCalendarMonth(startOfMonth(new Date()));
  }, [clearAISearch]);

  const fetchData = useCallback(
    async (options?: { background?: boolean }) => {
      const currentListView = listViewRef.current;
      if (!currentListView || !schemaName) {
        setLoading(false);
        return;
      }
      // Guard: ensure the listView belongs to the current schema to prevent
      // querying with stale fields from a previously visited schema (e.g.
      // purchase_item fields being sent in a department query).
      if (currentListView.schema !== schemaName) {
        // Don't clear loading — the correct listView will arrive and re-trigger fetch
        return;
      }
      // Only show full loading skeleton for initial loads, not background refreshes.
      // Background refreshes keep existing data visible while fetching.
      if (!options?.background) {
        setLoading(true);
      }
      setDataError(null);
      try {
        const fields = getQueryFields(
          currentListView,
          schemaFieldsRef.current,
          bundleLinksRef.current,
          schemaName,
        );
        // Ensure the date field is included in the query for calendar view
        const dateField = calendarDateFieldRef.current;
        if (dateField && !fields.some((f) => f === dateField)) {
          fields.push(dateField);
        }
        // Ensure state field + presentation fields are included for kanban view
        const stateDef = primaryStateDefRef.current;
        if (stateDef) {
          if (!fields.includes(stateDef.field)) fields.push(stateDef.field);
        }
        const pres = schemaPresentationRef.current;
        if (pres) {
          if (pres.titleField && !fields.includes(pres.titleField)) fields.push(pres.titleField);
          if (pres.badgeField && !fields.includes(pres.badgeField)) fields.push(pres.badgeField);
          for (const sf of pres.summaryFields ?? []) {
            if (!fields.includes(sf)) fields.push(sf);
          }
        }
        if (!fields.includes("created_at")) fields.push("created_at");
        // Ensure self-referencing parent field is included for tree view
        const srf = selfRefFieldRef.current;
        if (srf && !fields.includes(srf)) fields.push(srf);
        // Ensure tree label + summary fields are included
        const tlf = treeLabelFieldRef.current;
        if (tlf && !fields.includes(tlf)) fields.push(tlf);
        for (const sf of treeSummaryFieldsRef.current ?? []) {
          if (!fields.includes(sf)) fields.push(sf);
        }
        const result = await queryList({
          schema: schemaName,
          fields,
          pageSize: currentListView.pageSize ?? 50,
        });
        setData(result.items);
        setHasLoadedOnce(true);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : t("errors.failedToLoadData", "Failed to load data");
        if (options?.background) {
          // Background refresh: keep existing data visible, show toast instead
          toast.error(message);
        } else {
          setDataError(message);
          setData([]);
        }
      } finally {
        setLoading(false);
      }
    },
    [schemaName, t],
  );

  // ── Real-time subscription via SSE ──────────────────────
  const [hasNewData, setHasNewData] = useState(false);

  const subscriptionQuery = useMemo(
    () => (schemaName ? buildSchemaSubscriptionQuery(schemaName) : ""),
    [schemaName],
  );

  // Debounced refresh on subscription events to avoid rapid-fire fetches
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSubscriptionData = useCallback(
    (data: unknown) => {
      // Push notification for the SSE event
      if (schemaName && data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        const label = bundle?.schema?.label ?? schemaName;
        if (d.created) {
          pushNotification({
            type: "created",
            message: `${label} record created`,
            schema: schemaName,
          });
        } else if (d.updated) {
          pushNotification({
            type: "updated",
            message: `${label} record updated`,
            schema: schemaName,
          });
        } else if (d.deleted) {
          pushNotification({
            type: "deleted",
            message: `${label} record deleted`,
            schema: schemaName,
          });
        }
      }

      // Debounce: wait 500ms before refreshing, merge multiple events
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      setHasNewData(true);
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        fetchData({ background: true }).then(() => setHasNewData(false));
      }, 500);
    },
    [fetchData, schemaName, bundle?.schema?.label],
  );

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  useSubscription({
    query: subscriptionQuery,
    enabled: !!schemaName && !bundleLoading && !!bundle,
    onData: handleSubscriptionData,
  });

  // Initial data fetch — depends on schemaName, bundle readiness, and bundle identity.
  // bundleSchemaName ensures re-fetch when navigating between cached schemas
  // (bundleReady stays true→true but the bundle itself changes).
  const bundleReady = !bundleLoading && !!bundle;
  const _bundleSchemaName = bundle?.schema?.name;
  useEffect(() => {
    if (bundleReady) {
      fetchData();
    } else if (!bundleLoading && !bundle) {
      setLoading(false);
    }
  }, [fetchData, bundleReady, bundle, bundleLoading]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchData({ background: true });
    } finally {
      setRefreshing(false);
    }
  }, [fetchData]);

  async function handleAction(actionName: string, recordId: string) {
    if (!schemaName) return;
    switch (actionName) {
      case "create":
        navigate({ to: "/schemas/$name/new", params: { name: schemaName } });
        break;
      case "edit": {
        const editRoute = listView?.rowActionRoute;
        if (editRoute) {
          const url = editRoute.replace("{id}", recordId).replace("{name}", schemaName);
          navigate({ to: url as "/" });
        } else {
          navigate({ to: "/schemas/$name/$id", params: { name: schemaName, id: recordId } });
        }
        break;
      }
      case "duplicate":
        navigate({
          to: "/schemas/$name/new",
          params: { name: schemaName },
          search: { clone: recordId },
        });
        break;
      case "delete":
        pendingSingleDeleteId.current = recordId;
        setSingleDeleteOpen(true);
        break;
      default:
        console.log(`Action: ${actionName}, Record: ${recordId}`);
    }
  }

  function handleRowClick(recordId: string) {
    if (!schemaName) return;
    // Check if list view has custom detail route
    const customRoute = listView?.rowActionRoute;
    if (customRoute) {
      const url = customRoute.replace("{id}", recordId).replace("{name}", schemaName);
      navigate({ to: url as "/" });
    } else {
      navigate({ to: "/schemas/$name/$id", params: { name: schemaName, id: recordId } });
    }
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

  async function executeSingleDelete() {
    if (!schemaName || !pendingSingleDeleteId.current) return;
    setSingleDeleting(true);
    try {
      await deleteRecord(schemaName, pendingSingleDeleteId.current);
      toast.success(t("toast.recordDeleted", "Record deleted successfully"));
      await fetchData({ background: true });
    } catch (_err) {
      toast.error(t("toast.deleteFailed", "Failed to delete record"));
    } finally {
      setSingleDeleting(false);
      setSingleDeleteOpen(false);
      pendingSingleDeleteId.current = "";
    }
  }

  async function executeBulkDelete() {
    if (!schemaName || pendingBulkIds.current.length === 0) return;
    const count = pendingBulkIds.current.length;
    setBulkDeleting(true);
    try {
      await bulkDeleteRecords(schemaName, pendingBulkIds.current);
      toast.success(t("toast.bulkDeleted", "{{count}} record(s) deleted successfully", { count }));
      await fetchData({ background: true });
    } catch (_err) {
      toast.error(t("toast.bulkDeleteFailed", "Failed to delete records"));
    } finally {
      setBulkDeleting(false);
      setBulkDeleteOpen(false);
      pendingBulkIds.current = [];
    }
  }

  // ── Saved view: filter data when a saved view is active ──────
  // (hooks must be called before any early returns to satisfy React rules)
  const viewFilteredData = useMemo(() => {
    if (!activeSavedView || activeSavedView.filters.length === 0) return data;
    return data.filter((row) =>
      activeSavedView.filters.every((f) => {
        const val = row[f.field];
        const fv = f.values;
        if (fv.length === 0) return true;
        switch (f.operator) {
          case "eq":
          case "in":
            return fv.includes(val as string);
          case "neq":
          case "not_in":
            return !fv.includes(val as string);
          case "contains":
            return String(val ?? "")
              .toLowerCase()
              .includes(String(fv[0] ?? "").toLowerCase());
          case "gt":
            return Number(val) > Number(fv[0]);
          case "gte":
            return Number(val) >= Number(fv[0]);
          case "lt":
            return Number(val) < Number(fv[0]);
          case "lte":
            return Number(val) <= Number(fv[0]);
          case "between":
            return Number(val) >= Number(fv[0]) && Number(val) <= Number(fv[1]);
          default:
            return true;
        }
      }),
    );
  }, [data, activeSavedView]);

  // Determine the effective view with saved view sort override
  const effectiveListView = useMemo(() => {
    if (!listView) return listView;
    if (!activeSavedView?.sort) return listView;
    return { ...listView, defaultSort: activeSavedView.sort };
  }, [listView, activeSavedView]);

  const handleCreateSavedView = useCallback(
    (name: string) => {
      const newView = createView(name, currentBazzaFilters);
      handleSelectSavedView(newView.id);
    },
    [createView, currentBazzaFilters, handleSelectSavedView],
  );

  const handleDeleteSavedView = useCallback(
    (viewId: string) => {
      deleteView(viewId);
      if (activeSavedViewId === viewId) {
        handleSelectSavedView(null);
      }
    },
    [deleteView, activeSavedViewId, handleSelectSavedView],
  );

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

  // Loading bundle — show table skeleton matching final layout
  if (bundleLoading) {
    return (
      <div className="p-4 space-y-4">
        {/* Toolbar skeleton: search bar + action button */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-9 w-20" />
        </div>
        {/* Table skeleton: header + rows */}
        <div className="rounded border border-border">
          {/* Header row */}
          <div className="flex items-center gap-4 border-b border-border bg-muted/50 px-3 py-2.5">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-20" />
          </div>
          {/* Data rows */}
          {Array.from({ length: 5 }, (_, i) => `skel-row-${i}`).map((key) => (
            <div
              key={key}
              className="flex items-center gap-4 border-b border-border last:border-0 px-3 py-2.5"
            >
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Bundle fetch error
  if (bundleError || !schema || !listView) {
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

  // Data fetch error (bundle loaded fine, but data query failed)
  if (dataError && data.length === 0) {
    return (
      <div className="p-4">
        <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
          <ServerCrash className="size-10" />
          <p className="text-sm font-medium">
            {t("errors.dataLoadFailed", "Failed to load records.")}
          </p>
          <p className="text-xs text-destructive">{dataError}</p>
          <Button variant="outline" size="sm" onClick={() => fetchData()}>
            <RefreshCw className="mr-1.5 size-3.5" />
            {t("common.retry", "Retry")}
          </Button>
        </div>
      </div>
    );
  }

  // Empty state — no records and not loading
  if (!loading && data.length === 0 && !dataError) {
    return (
      <div className="p-4">
        <EmptyState
          schemaName={schemaName}
          schemaLabel={resolveLabel(schema.label, schemaName)}
          hideAction={!!bundle?.internal}
        />
      </div>
    );
  }

  // View toggle options
  const hasViewToggle = hasCalendarOption || hasKanbanOption || hasTreeOption;
  const viewToggleExtraControls =
    activeView === "calendar" ? (
      <CalendarNavControls currentMonth={calendarMonth} onMonthChange={setCalendarMonth} />
    ) : undefined;
  const viewToggleOptions = [
    {
      key: "list",
      icon: <List className="size-3.5" />,
      label: t("calendar.listView", "List view"),
    },
    ...(hasTreeOption
      ? [
          {
            key: "tree",
            icon: <ListTree className="size-3.5" />,
            label: t("tree.treeView", "Tree view"),
          },
        ]
      : []),
    ...(hasKanbanOption
      ? [
          {
            key: "kanban",
            icon: <Kanban className="size-3.5" />,
            label: t("kanban.kanbanView", "Kanban view"),
          },
        ]
      : []),
    ...(hasCalendarOption
      ? [
          {
            key: "calendar",
            icon: <Calendar className="size-3.5" />,
            label: t("calendar.calendarView", "Calendar view"),
          },
        ]
      : []),
  ];

  // Real-time refresh indicator shown briefly when subscription triggers a reload
  const refreshIndicator = hasNewData ? (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground animate-pulse">
      <RefreshCw className="size-3 animate-spin" />
      {t("list.refreshing", "Refreshing...")}
    </span>
  ) : null;

  // Primary action button for non-list views (hidden for internal/system schemas)
  const primaryActionButton = (() => {
    if (bundle?.internal) return null;
    const primary = (listView.actions ?? []).find((a) => a.position === "toolbar");
    if (!primary) return null;
    return (
      <Button
        size="sm"
        variant={primary.variant === "destructive" ? "destructive" : "default"}
        onClick={() => handleAction(primary.action, "")}
      >
        {resolveLabel(primary.label, primary.action)}
      </Button>
    );
  })();

  // Alternate view content (kanban, tree, calendar)
  // The toolbar (primary action + SearchBar + refresh indicator + ViewToggle)
  // is rendered by ListView, so alternate views only provide their content.
  // Uses pageFilteredData so that search/filter state applies to all views.
  const alternateViewContent =
    activeView !== "list"
      ? (() => {
          if (activeView === "kanban" && primaryStateDef) {
            return (
              <AutoKanban
                schema={schema}
                stateDefinition={primaryStateDef}
                data={pageFilteredData}
                loading={loading}
                onRecordClick={handleRowClick}
                onTransitioned={handleRefresh}
                queryFields={listView.fields
                  .map((f) => f.field)
                  .concat(["id", primaryStateDef.field, "created_at"])}
              />
            );
          }

          if (activeView === "tree" && selfRefField) {
            return (
              <AutoTree
                schemaName={schemaName}
                parentField={selfRefField}
                records={pageFilteredData}
                labelField={treeLabelField}
                summaryFields={treeSummaryFields}
                onRecordClick={handleRowClick}
              />
            );
          }

          // Calendar view (fallback)
          return (
            <AutoCalendar
              schema={schema}
              dateField={calendarDateField ?? ""}
              titleField={calendarViewDef?.titleField}
              colorField={calendarViewDef?.colorField}
              data={pageFilteredData}
              onRecordClick={handleRowClick}
              loading={loading}
              currentMonth={calendarMonth}
              onMonthChange={setCalendarMonth}
            />
          );
        })()
      : undefined;

  // SearchBar props for alternate views (calendar/kanban/tree)
  const searchBarPropsForAlternate = alternateViewContent
    ? {
        schema,
        globalFilter,
        onGlobalFilterChange: setGlobalFilter,
        onClearAll: hasPageLevelFilters ? handleClearAllFilters : undefined,
        bazzaColumns,
        bazzaFilters: bazzaFilterState,
        bazzaActions,
        bazzaStrategy,
        aiSearchState,
        onClearAISearch: clearAISearch,
        onSubmit: handleSearchSubmit,
      }
    : undefined;

  return (
    <ListView
      schema={schema}
      // biome-ignore lint/style/noNonNullAssertion: effectiveListView is guaranteed by listView being defined earlier
      view={effectiveListView!}
      data={viewFilteredData}
      loading={loading}
      selectable={!bundle?.internal}
      onAction={bundle?.internal ? undefined : handleAction}
      onBulkAction={bundle?.internal ? undefined : handleBulkAction}
      onRowClick={handleRowClick}
      onFiltersChange={setCurrentBazzaFilters}
      onRefresh={handleRefresh}
      refreshing={refreshing}
      globalFilter={globalFilter}
      onGlobalFilterChange={setGlobalFilter}
      savedViews={{
        views: savedViews,
        activeViewId: activeSavedViewId,
        onSelectView: handleSelectSavedView,
        onCreateView: handleCreateSavedView,
        onRenameView: renameView,
        onDeleteView: handleDeleteSavedView,
        hasActiveFilters: hasActiveListFilters,
      }}
      viewToggle={
        hasViewToggle
          ? {
              options: viewToggleOptions,
              activeView,
              onViewChange: setActiveView as (v: string) => void,
              extraControls: viewToggleExtraControls,
            }
          : undefined
      }
      refreshIndicator={refreshIndicator}
      primaryActionSlot={alternateViewContent ? primaryActionButton : undefined}
      alternateViewContent={alternateViewContent}
      searchBarProps={searchBarPropsForAlternate}
      afterContent={
        <>
          <ConfirmDialog
            open={singleDeleteOpen}
            onOpenChange={setSingleDeleteOpen}
            title={t("confirm.deleteTitle", "Delete record")}
            description={t(
              "confirm.deleteDescription",
              "Are you sure you want to delete this record? This action cannot be undone.",
            )}
            onConfirm={executeSingleDelete}
            loading={singleDeleting}
          />
          <ConfirmDialog
            open={bulkDeleteOpen}
            onOpenChange={setBulkDeleteOpen}
            title={t("bulk.deleteTitle", "Delete records")}
            description={t(
              "bulk.deleteConfirm",
              "Are you sure you want to delete {{count}} record(s)? This action cannot be undone.",
              { count: pendingBulkIds.current.length },
            )}
            onConfirm={executeBulkDelete}
            loading={bulkDeleting}
          />
        </>
      }
    />
  );
}
