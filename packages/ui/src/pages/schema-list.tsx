/**
 * SchemaListPage — Dynamic list view powered by schema bundle from API.
 *
 * Fetches schema + view definitions from server, falls back to demo data
 * if API unavailable. Fully schema-driven — no hardcoded field references.
 */

import type { SchemaDefinition } from "@linchkit/core";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AutoList } from "../components/auto-list";
import type { AutoListViewDefinition } from "../components/auto-list/types";
import { useSchemaBundle } from "../hooks/use-schema-bundle";
import { useSchemaLabel } from "../i18n/use-schema-label";
import { deleteRecord, queryList } from "../lib/api";
import { demoData, demoListView, demoSchema, demoStateMachine } from "./schema-demo-data";

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
  const params = useParams({ strict: false }) as { name?: string };
  const schemaName = params.name ?? demoSchema.name;
  const { resolveLabel } = useSchemaLabel();

  // Fetch schema bundle from API
  const { bundle, loading: bundleLoading, error: bundleError } = useSchemaBundle(schemaName);

  // Resolve schema + view from bundle or fallback to demo
  const schema: SchemaDefinition = bundle?.schema ?? demoSchema;
  const listView: AutoListViewDefinition =
    (getPrimaryView(bundle?.views, "list") as AutoListViewDefinition | undefined) ?? demoListView;
  const stateMeta = bundle ? undefined : demoStateMachine.meta;
  // TODO: load state machine from bundle when server supports it
  // TODO: load state machine from server when available

  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [usingApi, setUsingApi] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const fields = getQueryFields(listView);
      const result = await queryList({
        schema: schemaName,
        fields,
        pageSize: listView.pageSize ?? 50,
      });
      setData(result.items);
      setUsingApi(true);
    } catch {
      // API unavailable — fall back to demo data
      setData(bundleError ? demoData : []);
      setUsingApi(false);
    } finally {
      setLoading(false);
    }
  }, [schemaName, listView, bundleError]);

  useEffect(() => {
    if (!bundleLoading) {
      fetchData();
    }
  }, [fetchData, bundleLoading]);

  async function handleAction(actionName: string, recordId: string) {
    switch (actionName) {
      case "create":
        navigate({ to: "/schemas/$name/new", params: { name: schemaName } });
        break;
      case "edit":
        navigate({ to: "/schemas/$name/$id", params: { name: schemaName, id: recordId } });
        break;
      case "delete":
        if (usingApi) {
          try {
            await deleteRecord(schemaName, recordId);
            await fetchData();
          } catch (err) {
            console.error("Delete failed:", err);
          }
        }
        break;
      default:
        console.log(`Action: ${actionName}, Record: ${recordId}`);
    }
  }

  function handleRowClick(recordId: string) {
    navigate({ to: "/schemas/$name/$id", params: { name: schemaName, id: recordId } });
  }

  if (bundleLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
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
        stateMeta={stateMeta}
        selectable
        onAction={handleAction}
        onBulkAction={(action, ids) => console.log(`Bulk ${action}:`, ids)}
        onRowClick={handleRowClick}
      />
    </div>
  );
}
