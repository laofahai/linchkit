/**
 * RelatedRecordsPanel — Displays linked records in tabs below the form.
 *
 * For each link relationship, shows a tab with a simple table of related records.
 * Clicking a record navigates to its detail page.
 */

import type { LinkDefinition } from "@linchkit/core/types";
import { Badge, Tabs, TabsContent, TabsList, TabsTrigger } from "@linchkit/ui-kit/components";
import { ExternalLink, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { graphql } from "../lib/api";

interface RelatedRecordsPanelProps {
  schemaName: string;
  recordId: string;
  links: LinkDefinition[];
  /** When true, renders without the outer card wrapper (for embedding in parent tabs). */
  bare?: boolean;
}

interface LinkTab {
  key: string;
  label: string;
  relatedSchema: string;
  fieldName: string;
  isList: boolean;
}

/** Derive tab definitions from link definitions for a given schema */
function deriveLinkTabs(schemaName: string, links: LinkDefinition[]): LinkTab[] {
  const tabs: LinkTab[] = [];

  for (const link of links) {
    const isFrom = link.from === schemaName;
    const isTo = link.to === schemaName;

    switch (link.cardinality) {
      case "many_to_one": {
        if (isFrom) {
          // From side: singular related record (the "to" schema)
          tabs.push({
            key: `${link.name}-from`,
            label: link.label?.from ?? link.to,
            relatedSchema: link.to,
            fieldName: link.to,
            isList: false,
          });
        }
        if (isTo) {
          // To side: list of records from "from" schema
          tabs.push({
            key: `${link.name}-to`,
            label: link.label?.to ?? `${link.from}s`,
            relatedSchema: link.from,
            fieldName: `${link.from}s`,
            isList: true,
          });
        }
        break;
      }
      case "one_to_many": {
        if (isFrom) {
          tabs.push({
            key: `${link.name}-from`,
            label: link.label?.from ?? `${link.to}s`,
            relatedSchema: link.to,
            fieldName: `${link.to}s`,
            isList: true,
          });
        }
        if (isTo) {
          tabs.push({
            key: `${link.name}-to`,
            label: link.label?.to ?? link.from,
            relatedSchema: link.from,
            fieldName: link.from,
            isList: false,
          });
        }
        break;
      }
      case "one_to_one": {
        const otherSchema = isFrom ? link.to : link.from;
        const label = isFrom ? link.label?.from : link.label?.to;
        tabs.push({
          key: `${link.name}-${isFrom ? "from" : "to"}`,
          label: label ?? otherSchema,
          relatedSchema: otherSchema,
          fieldName: otherSchema,
          isList: false,
        });
        break;
      }
      case "many_to_many": {
        const otherSchema = isFrom ? link.to : link.from;
        const label = isFrom ? link.label?.from : link.label?.to;
        tabs.push({
          key: `${link.name}-${isFrom ? "from" : "to"}`,
          label: label ?? `${otherSchema}s`,
          relatedSchema: otherSchema,
          fieldName: `${otherSchema}s`,
          isList: true,
        });
        break;
      }
    }
  }

  return tabs;
}

/** Convert snake_case to camelCase for GraphQL query names */
function toCamelCase(name: string): string {
  const parts = name.split(/[_-]/);
  return (
    parts[0] +
    parts
      .slice(1)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("")
  );
}

export function RelatedRecordsPanel({
  schemaName,
  recordId,
  links,
  bare = false,
}: RelatedRecordsPanelProps) {
  const { t } = useTranslation();
  const tabs = deriveLinkTabs(schemaName, links);

  if (tabs.length === 0) return null;

  const firstTab = tabs[0];
  if (!firstTab) return null;
  const defaultTab = firstTab.key;

  const content = (
    <Tabs defaultValue={defaultTab}>
      <TabsList variant="line">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.key} value={tab.key}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.key} value={tab.key}>
          <RelatedRecordsList schemaName={schemaName} recordId={recordId} tab={tab} />
        </TabsContent>
      ))}
    </Tabs>
  );

  if (bare) {
    return content;
  }

  return (
    <div className="bg-background rounded shadow-sm border border-border/50 px-6 py-4">
      <h2 className="text-sm font-semibold text-muted-foreground mb-3">
        {t("detail.relatedRecords", "Related Records")}
      </h2>
      {content}
    </div>
  );
}

// ── Individual tab content ──────────────────────────────

function RelatedRecordsList({
  schemaName,
  recordId,
  tab,
}: {
  schemaName: string;
  recordId: string;
  tab: LinkTab;
}) {
  const { t } = useTranslation();
  const [records, setRecords] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRelated = useCallback(async () => {
    setLoading(true);
    try {
      // Query the main record with the link field resolved
      const queryName = toCamelCase(schemaName);
      const fieldName = tab.fieldName;

      const query = tab.isList
        ? `query ($id: ID!) { ${queryName}(id: $id) { ${fieldName} { id ${getDisplayFields()} } } }`
        : `query ($id: ID!) { ${queryName}(id: $id) { ${fieldName} { id ${getDisplayFields()} } } }`;

      const res = await graphql<Record<string, Record<string, unknown>>>(query, { id: recordId });
      if (res.errors?.length) {
        setRecords([]);
        return;
      }
      const root = res.data?.[queryName];
      if (!root) {
        setRecords([]);
        return;
      }

      const related = root[fieldName];
      if (Array.isArray(related)) {
        setRecords(related);
      } else if (related && typeof related === "object") {
        setRecords([related as Record<string, unknown>]);
      } else {
        setRecords([]);
      }
    } catch {
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, [schemaName, recordId, tab]);

  useEffect(() => {
    fetchRelated();
  }, [fetchRelated]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        {t("list.noRecords", "No records found")}
      </div>
    );
  }

  const firstRecord = records[0] ?? {};
  const columns = getColumnHeaders(firstRecord);

  return (
    <div className="mt-2">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            {columns.map((col) => (
              <th key={col} className="p-2 text-left font-medium text-muted-foreground">
                {col}
              </th>
            ))}
            <th className="p-2 w-10" />
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={String(record.id)} className="border-b hover:bg-muted/30 transition-colors">
              {columns.map((col) => (
                <td key={col} className="p-2">
                  {formatCellValue(record[col])}
                </td>
              ))}
              <td className="p-2">
                <a
                  href={`/schemas/${tab.relatedSchema}/${record.id}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="size-3.5" />
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {records.length > 0 && (
        <div className="mt-2 text-xs text-muted-foreground">
          {t("detail.recordCount", { count: records.length })}
        </div>
      )}
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────

/** Common display fields to fetch for linked records */
function getDisplayFields(): string {
  return "title name label status created_at";
}

/** Extract column headers from a record, filtering out internal fields */
function getColumnHeaders(record: Record<string, unknown>): string[] {
  const skip = new Set(["__typename"]);
  return Object.keys(record).filter((k) => !skip.has(k) && !k.startsWith("_"));
}

/** Format a cell value for display */
function formatCellValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined)
    return <span className="text-muted-foreground">-</span>;
  if (typeof value === "boolean") return <BooleanCell value={value} />;
  if (typeof value === "object")
    return <span className="font-mono text-xs">{JSON.stringify(value)}</span>;
  return String(value);
}

/** Boolean cell with i18n */
function BooleanCell({ value }: { value: boolean }) {
  const { t } = useTranslation();
  return <Badge variant="outline">{value ? t("common.yes", "Yes") : t("common.no", "No")}</Badge>;
}
