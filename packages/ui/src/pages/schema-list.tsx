/**
 * SchemaListPage — Dynamic list view powered by schema bundle from API.
 *
 * Fetches schema + view definitions from server. Shows error states
 * when API is unavailable — no silent demo data fallback.
 */

import { Button } from "@linchkit/ui-kit/components";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Loader2, RefreshCw, ServerCrash } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AutoList } from "../components/auto-list";
import type { AutoListViewDefinition } from "../components/auto-list/types";
import { useSchemaBundle } from "../hooks/use-schema-bundle";
import { useSchemaLabel } from "../i18n/use-schema-label";
import { deleteRecord, queryList } from "../lib/api";

/** Extract GraphQL field names from the view definition. */
function getQueryFields(view: AutoListViewDefinition): string[] {
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

export function SchemaListPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const params = useParams({ strict: false }) as { name?: string };
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
  const listView = getPrimaryView(bundle?.views, "list") as AutoListViewDefinition | undefined;

  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!listView || !schemaName) return;
    setLoading(true);
    setDataError(null);
    try {
      const fields = getQueryFields(listView);
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
  }, [schemaName, listView]);

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
          {t("errors.checkServer", "Check that the server is running and the schema is registered.")}
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

  const title = resolveLabel(listView.label ?? schema.label, schema.name);

  return (
    <div className="p-4">
      <AutoList
        schema={schema}
        view={listView}
        data={data}
        loading={loading}
        title={title}
        selectable
        onAction={handleAction}
        onBulkAction={(action, ids) => console.log(`Bulk ${action}:`, ids)}
        onRowClick={handleRowClick}
      />
    </div>
  );
}
