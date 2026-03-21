/**
 * SchemaListPage — List view for a schema, powered by real GraphQL API.
 *
 * Fetches data from server via GraphQL, falls back to demo data if API unavailable.
 */

import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AutoList } from "../components/auto-list";
import { queryList, deleteRecord } from "../lib/api";
import { demoSchema, demoListView, demoData, demoStateMachine } from "./schema-demo-data";

/** Extract GraphQL field names from the view definition. */
function getQueryFields(view: typeof demoListView): string[] {
  const fields = new Set<string>(["id"])
  for (const f of view.fields) {
    // Skip dotted paths (e.g. "department.name") — not supported in flat schema
    if (!f.field.includes(".")) {
      fields.add(f.field)
    }
  }
  return Array.from(fields)
}

export function SchemaListPage() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { name?: string };
  const schemaName = params.name ?? demoSchema.name;

  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [usingApi, setUsingApi] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const fields = getQueryFields(demoListView);
      const result = await queryList({
        schema: schemaName,
        fields,
        pageSize: 50,
      });
      setData(result.items);
      setUsingApi(true);
    } catch {
      // API unavailable — fall back to demo data
      setData(demoData);
      setUsingApi(false);
    } finally {
      setLoading(false);
    }
  }, [schemaName]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

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
        } else {
          console.log(`Delete record: ${recordId} (demo mode)`);
        }
        break;
      default:
        console.log(`Action: ${actionName}, Record: ${recordId}`);
    }
  }

  function handleRowClick(recordId: string) {
    navigate({ to: "/schemas/$name/$id", params: { name: schemaName, id: recordId } });
  }

  const title = demoListView.label ?? demoSchema.label ?? demoSchema.name;

  return (
    <div className="p-4">
      <AutoList
        schema={demoSchema}
        view={demoListView}
        data={data}
        loading={loading}
        title={title}
        stateMeta={demoStateMachine.meta}
        selectable
        onAction={handleAction}
        onBulkAction={(action, ids) => console.log(`Bulk ${action}:`, ids)}
        onRowClick={handleRowClick}
      />
    </div>
  );
}
