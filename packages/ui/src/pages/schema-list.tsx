/**
 * SchemaListPage — Demo page showing an AutoList for the purchase_request schema.
 */

import { useNavigate } from "@tanstack/react-router";
import { AutoList } from "../components/auto-list";
import { demoSchema, demoListView, demoData } from "./schema-demo-data";

/** List view page for a schema (currently uses demo data). */
export function SchemaListPage() {
  const navigate = useNavigate();

  function handleAction(actionName: string, recordId: string) {
    switch (actionName) {
      case "create":
        navigate({ to: "/schemas/$name/new", params: { name: demoSchema.name } });
        break;
      case "edit":
        navigate({ to: "/schemas/$name/$id", params: { name: demoSchema.name, id: recordId } });
        break;
      case "delete":
        // In a real app this would call an API action
        console.log(`Delete record: ${recordId}`);
        break;
      default:
        console.log(`Action: ${actionName}, Record: ${recordId}`);
    }
  }

  function handleRowClick(recordId: string) {
    navigate({ to: "/schemas/$name/$id", params: { name: demoSchema.name, id: recordId } });
  }

  const title = demoListView.label ?? demoSchema.label ?? demoSchema.name;

  return (
    <div className="p-4">
      <AutoList
        schema={demoSchema}
        view={demoListView}
        data={demoData}
        title={title}
        onAction={handleAction}
        onRowClick={handleRowClick}
      />
    </div>
  );
}
