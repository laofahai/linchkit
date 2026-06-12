/**
 * RelatedRecordsTab — Odoo-style tab content for one_to_many relationships.
 */
import type { EntityDefinition, RelationDefinition } from "@linchkit/core/types";
import { Button, Skeleton } from "@linchkit/ui-kit/components";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEntityBundle } from "../hooks/use-entity-bundle";
import { queryList } from "../lib/entity-api";
import type { AutoListViewDefinition } from "./auto-list/types";
import { ListView } from "./list-view";

interface RelatedRecordsTabProps {
  parentSchema: string;
  parentId: string;
  link: RelationDefinition;
}

const SYSTEM_FIELDS = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "_version",
  "is_deleted",
]);

function deriveFkField(link: RelationDefinition, _parentSchema: string): string {
  if (link.cardinality === "one_to_many") return `${link.from}_id`;
  if (link.cardinality === "many_to_one") return `${link.to}_id`;
  return `${_parentSchema}_id`;
}

function deriveChildSchema(link: RelationDefinition, parentSchema: string): string {
  if (link.cardinality === "one_to_many" && link.from === parentSchema) return link.to;
  if (link.cardinality === "many_to_one" && link.to === parentSchema) return link.from;
  return link.from === parentSchema ? link.to : link.from;
}

function generateChildListView(schema: EntityDefinition, fkField: string): AutoListViewDefinition {
  const fieldNames = Object.keys(schema.fields)
    .filter((f) => !SYSTEM_FIELDS.has(f) && f !== fkField)
    .slice(0, 6);
  return {
    name: `${schema.name}_list_auto`,
    entity: schema.name,
    type: "list",
    label: schema.label ?? schema.name,
    fields: fieldNames.map((field) => ({ field, sortable: true })),
    defaultSort: fieldNames[0] ? { field: fieldNames[0], order: "asc" as const } : undefined,
    pageSize: 10,
    actions: [],
  };
}

export function RelatedRecordsTab({ parentSchema, parentId, link }: RelatedRecordsTabProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const childSchemaName = deriveChildSchema(link, parentSchema);
  const fkField = deriveFkField(link, parentSchema);
  const { bundle: childBundle, loading: bundleLoading } = useEntityBundle(childSchemaName);
  const childSchema = childBundle?.schema;

  const listView = useMemo((): AutoListViewDefinition | undefined => {
    if (!childSchema) return undefined;
    const explicitList = Object.values(childBundle?.views ?? {}).find((v) => v.type === "list") as
      | AutoListViewDefinition
      | undefined;
    if (explicitList)
      return {
        ...explicitList,
        fields: explicitList.fields.filter((f) => f.field !== fkField),
        pageSize: explicitList.pageSize ?? 10,
      };
    return generateChildListView(childSchema, fkField);
  }, [childSchema, childBundle?.views, fkField]);

  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const childRelations = childBundle?.relations;
  const relationFieldNames = useMemo(() => {
    if (!childRelations || !childSchema) return new Set<string>();
    const names = new Set<string>();
    for (const rel of childRelations) {
      if (rel.from === childSchema.name) names.add(rel.fromName);
      if (rel.to === childSchema.name) names.add(rel.toName);
    }
    return names;
  }, [childRelations, childSchema]);

  const queryFields = useMemo(() => {
    if (!listView) return ["id"];
    const fields = new Set<string>(["id"]);
    for (const f of listView.fields) {
      if (f.field.includes(".")) continue;
      const isRelation =
        relationFieldNames.has(f.field) ||
        (!childSchema?.fields[f.field] && !SYSTEM_FIELDS.has(f.field));
      fields.add(isRelation ? `${f.field} { id name }` : f.field);
    }
    return Array.from(fields);
  }, [listView, relationFieldNames, childSchema]);

  const queryFieldsRef = useRef(queryFields);
  queryFieldsRef.current = queryFields;

  const fetchData = useCallback(async () => {
    if (!childSchema || !listView) return;
    setLoading(true);
    try {
      const result = await queryList({
        schema: childSchemaName,
        fields: queryFieldsRef.current,
        filter: { [fkField]: { eq: parentId } },
        pageSize: listView.pageSize ?? 10,
      });
      setData(result.items);
    } catch (err) {
      console.error("Failed to fetch related records:", err);
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [childSchema, childSchemaName, fkField, parentId, listView]);

  useEffect(() => {
    if (childSchema && listView) fetchData();
  }, [childSchema, listView, fetchData]);

  function handleRowClick(recordId: string) {
    navigate({ to: "/entities/$name/$id", params: { name: childSchemaName, id: recordId } });
  }
  function handleCreateNew() {
    navigate({
      to: "/entities/$name/new",
      params: { name: childSchemaName },
      search: { [`default_${fkField}`]: parentId },
    });
  }

  if (bundleLoading)
    return (
      <div className="space-y-2 py-4">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  if (!childSchema || !listView) return null;

  const newButton = (
    <Button size="sm" variant="outline" onClick={handleCreateNew}>
      <Plus className="mr-1.5 size-3.5" />
      {t("common.new", "New")}
    </Button>
  );

  if (!loading && data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-sm text-muted-foreground mb-3">
          {t("emptyState.relatedRecords", "No records yet")}
        </p>
        <Button size="sm" variant="outline" onClick={handleCreateNew}>
          <Plus className="mr-1.5 size-3.5" />
          {t("common.new", "New")}
        </Button>
      </div>
    );
  }

  return (
    <ListView
      className="py-2"
      schema={childSchema}
      view={listView}
      data={data}
      loading={loading}
      onRowClick={handleRowClick}
      toolbarExtra={newButton}
    />
  );
}
