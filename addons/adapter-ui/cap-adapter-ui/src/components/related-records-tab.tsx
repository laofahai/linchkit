/**
 * RelatedRecordsTab — Odoo-style tab content for one_to_many relationships.
 *
 * Renders a full list view (AutoList) of child records filtered by parent FK.
 * Supports sorting, pagination, row click navigation, and a "New" button
 * that navigates to create form with FK pre-filled.
 */

import type { RelationDefinition, EntityDefinition } from "@linchkit/core/types";
import { Button, Skeleton } from "@linchkit/ui-kit/components";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEntityBundle } from "../hooks/use-entity-bundle";
import { queryList } from "../lib/api";
import type { AutoListViewDefinition } from "./auto-list/types";
import { ListView } from "./list-view";

// ── Types ────────────────────────────────────────────────

interface RelatedRecordsTabProps {
  /** Parent schema name */
  parentSchema: string;
  /** Parent record ID */
  parentId: string;
  /** Link definition describing the one_to_many relationship */
  link: RelationDefinition;
}

// ── Helpers ──────────────────────────────────────────────

/** System fields to exclude from auto-generated list columns */
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

/**
 * Derive the FK column name on the child table pointing to parent.
 * Convention matches schema-to-drizzle.ts generateRelationColumns():
 * - one_to_many: FK = `{from}_id` on the `to` (child) table
 * - many_to_one: FK = `{to}_id` on the `from` (child) table
 */
function deriveFkField(link: RelationDefinition, _parentSchema: string): string {
  if (link.cardinality === "one_to_many") {
    return `${link.from}_id`;
  }
  if (link.cardinality === "many_to_one") {
    return `${link.to}_id`;
  }
  return `${_parentSchema}_id`;
}

/** Derive the child schema name from the link */
function deriveChildSchema(link: RelationDefinition, parentSchema: string): string {
  if (link.cardinality === "one_to_many" && link.from === parentSchema) {
    return link.to;
  }
  if (link.cardinality === "many_to_one" && link.to === parentSchema) {
    return link.from;
  }
  // Fallback
  return link.from === parentSchema ? link.to : link.from;
}

/**
 * Generate a list view from child schema fields when no explicit list view is defined.
 * Shows up to 6 fields excluding system and FK fields.
 */
function generateChildListView(schema: EntityDefinition, fkField: string): AutoListViewDefinition {
  const fieldNames = Object.keys(schema.fields)
    .filter((f) => !SYSTEM_FIELDS.has(f) && f !== fkField)
    .slice(0, 6);

  return {
    name: `${schema.name}_list_auto`,
    schema: schema.name,
    type: "list",
    label: schema.label ?? schema.name,
    fields: fieldNames.map((field) => ({ field, sortable: true })),
    defaultSort: fieldNames[0] ? { field: fieldNames[0], order: "asc" as const } : undefined,
    pageSize: 10,
    actions: [],
  };
}

// ── Component ────────────────────────────────────────────

export function RelatedRecordsTab({ parentSchema, parentId, link }: RelatedRecordsTabProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const childSchemaName = deriveChildSchema(link, parentSchema);
  const fkField = deriveFkField(link, parentSchema);

  const { bundle: childBundle, loading: bundleLoading } = useEntityBundle(childSchemaName);
  const childSchema = childBundle?.schema;

  // Build or use existing list view
  const listView = useMemo((): AutoListViewDefinition | undefined => {
    if (!childSchema) return undefined;

    // Try to find an explicit list view from the child bundle
    const explicitList = Object.values(childBundle?.views ?? {}).find((v) => v.type === "list") as
      | AutoListViewDefinition
      | undefined;

    if (explicitList) {
      // Filter out the FK field from columns so it's not shown
      return {
        ...explicitList,
        fields: explicitList.fields.filter((f) => f.field !== fkField),
        pageSize: explicitList.pageSize ?? 10,
      };
    }

    return generateChildListView(childSchema, fkField);
  }, [childSchema, childBundle?.views, fkField]);

  // Data state
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);

  // Build query fields from view
  const queryFields = useMemo(() => {
    if (!listView) return ["id"];
    const fields = new Set<string>(["id"]);
    for (const f of listView.fields) {
      if (f.field.includes(".")) continue;
      fields.add(f.field);
    }
    return Array.from(fields);
  }, [listView]);

  // Stable ref for query fields
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
    if (childSchema && listView) {
      fetchData();
    }
  }, [childSchema, listView, fetchData]);

  // Navigation handlers
  function handleRowClick(recordId: string) {
    navigate({
      to: "/schemas/$name/$id",
      params: { name: childSchemaName, id: recordId },
    });
  }

  function handleCreateNew() {
    // Navigate to create form — the FK field will need to be set
    // We pass the parent FK as a search param so the form can pre-fill it
    navigate({
      to: "/schemas/$name/new",
      params: { name: childSchemaName },
      search: { [`default_${fkField}`]: parentId },
    });
  }

  // Loading skeleton
  if (bundleLoading) {
    return (
      <div className="space-y-2 py-4">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (!childSchema || !listView) {
    return null;
  }

  // "New" button for creating related records
  const newButton = (
    <Button size="sm" variant="outline" onClick={handleCreateNew}>
      <Plus className="mr-1.5 size-3.5" />
      {t("common.new", "New")}
    </Button>
  );

  // Show empty state with create button when no records exist
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
