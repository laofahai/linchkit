/**
 * AutoTree — Schema-driven collapsible tree view for hierarchical records.
 *
 * Renders records with parent-child relationships as an indented,
 * expandable/collapsible tree. Each node shows its label, optional summary
 * fields, and allows navigation to the record detail.
 *
 * Features:
 * - Expand/collapse individual nodes or all at once
 * - Visual indent connectors (vertical/horizontal lines)
 * - Summary fields rendered inline after the label
 * - Folder/File icons for branch/leaf nodes
 */

import { Button } from "@linchkit/ui-kit/components";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Inbox } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type TreeNode, buildTree, collectAllIds } from "./tree-utils";

export interface AutoTreeProps {
  /** Schema name (for context / key namespacing) */
  schemaName: string;
  /** Field referencing the parent record (e.g. "parent_id") */
  parentField: string;
  /** Flat list of records */
  records: Record<string, unknown>[];
  /** Field used as display label for each node (e.g. "name") */
  labelField: string;
  /** Optional fields to show as summary text after the label (max 2-3) */
  summaryFields?: string[];
  /** Callback when a record node is clicked */
  onRecordClick?: (recordId: string) => void;
  /** Extra content to render in the toolbar (e.g. view toggle, refresh) */
  toolbarExtra?: React.ReactNode;
}

export function AutoTree({
  schemaName: _schemaName,
  parentField,
  records,
  labelField,
  summaryFields,
  onRecordClick,
  toolbarExtra,
}: AutoTreeProps) {
  const { t } = useTranslation();
  const tree = useMemo(() => buildTree(records, parentField), [records, parentField]);
  const allExpandableIds = useMemo(() => collectAllIds(tree), [tree]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(allExpandableIds));

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setExpanded(new Set(allExpandableIds));
  }, [allExpandableIds]);

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
  }, []);

  if (records.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Inbox className="mb-2 size-10" />
        <p className="text-sm">{t("tree.noRecords")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {/* Toolbar */}
      <div className="flex items-center gap-2 pb-2 border-b mb-2">
        <span className="text-sm text-muted-foreground">
          {t("tree.rootNodes", { count: tree.length })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={expandAll}>
            {t("tree.expandAll")}
          </Button>
          <Button variant="ghost" size="sm" onClick={collapseAll}>
            {t("tree.collapseAll")}
          </Button>
          {toolbarExtra}
        </div>
      </div>

      {/* Tree */}
      <div role="tree" aria-label="tree-view">
        {tree.map((node, index) => (
          <TreeNodeRow
            key={String(node.record.id)}
            node={node}
            labelField={labelField}
            summaryFields={summaryFields}
            depth={0}
            expanded={expanded}
            onToggle={toggle}
            onRecordClick={onRecordClick}
            isLast={index === tree.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

// ── Summary value formatter ──────────────────────────────

/** Format a record value for summary display. */
function formatSummaryValue(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value instanceof Date) return value.toLocaleDateString();
  if (typeof value === "object") return "";
  return String(value);
}

// ── Internal TreeNodeRow ────────────────────────────────

interface TreeNodeRowProps {
  node: TreeNode;
  labelField: string;
  summaryFields?: string[];
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onRecordClick?: (recordId: string) => void;
  isLast: boolean;
}

function TreeNodeRow({
  node,
  labelField,
  summaryFields,
  depth,
  expanded,
  onToggle,
  onRecordClick,
  isLast,
}: TreeNodeRowProps) {
  const id = String(node.record.id);
  const label = String(node.record[labelField] ?? node.record.name ?? id);
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(id);

  // Build summary text from fields
  const summaryParts = (summaryFields ?? [])
    .map((f) => formatSummaryValue(node.record[f]))
    .filter(Boolean);

  // Connector lines: vertical lines from ancestors, horizontal connector to this node
  const connectors = depth > 0 ? (
    <div className="relative shrink-0" style={{ width: `${depth * 24}px`, height: "100%" }}>
      {/* Horizontal connector line */}
      <div
        className="absolute border-t border-border"
        style={{
          top: "50%",
          left: `${(depth - 1) * 24 + 12}px`,
          width: "12px",
        }}
      />
      {/* Vertical connector line (from parent) */}
      <div
        className={cn("absolute border-l border-border")}
        style={{
          left: `${(depth - 1) * 24 + 12}px`,
          top: 0,
          height: isLast ? "50%" : "100%",
        }}
      />
    </div>
  ) : null;

  const summaryBadges = summaryParts.length > 0 ? (
    <span className="ml-2 text-xs text-muted-foreground truncate">
      {summaryParts.join(" · ")}
    </span>
  ) : null;

  if (!hasChildren) {
    // Leaf node — simple row
    return (
      <div className="relative">
        <div
          role="treeitem"
          className={cn(
            "flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-accent cursor-pointer text-sm",
          )}
          style={{ paddingLeft: depth > 0 ? `${depth * 24 + 8}px` : "8px" }}
          onClick={() => onRecordClick?.(id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") onRecordClick?.(id);
          }}
          tabIndex={0}
        >
          {connectors}
          <File className="size-4 text-muted-foreground shrink-0" />
          <span className="truncate font-medium">{label}</span>
          {summaryBadges}
        </div>
      </div>
    );
  }

  // Branch node — collapsible
  return (
    <div className="relative">
      <Collapsible open={isOpen} onOpenChange={() => onToggle(id)}>
        <div
          role="treeitem"
          aria-expanded={isOpen}
          className="flex items-center gap-1 py-1.5 px-2 rounded-md hover:bg-accent text-sm"
          style={{ paddingLeft: depth > 0 ? `${depth * 24 + 8}px` : "8px" }}
        >
          {connectors}
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="p-0.5 rounded hover:bg-muted shrink-0"
              aria-label={isOpen ? "collapse" : "expand"}
            >
              {isOpen ? (
                <ChevronDown className="size-4" />
              ) : (
                <ChevronRight className="size-4" />
              )}
            </button>
          </CollapsibleTrigger>
          {isOpen ? (
            <FolderOpen className="size-4 text-muted-foreground shrink-0" />
          ) : (
            <Folder className="size-4 text-muted-foreground shrink-0" />
          )}
          <span
            className="truncate cursor-pointer font-medium hover:underline"
            onClick={() => onRecordClick?.(id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onRecordClick?.(id);
            }}
            tabIndex={0}
            role="link"
          >
            {label}
          </span>
          <span className="text-xs text-muted-foreground ml-1">
            ({node.children.length})
          </span>
          {summaryBadges}
        </div>
        <CollapsibleContent>
          <div className="relative">
            {/* Vertical continuation line for expanded children */}
            <div
              className="absolute border-l border-border"
              style={{
                left: `${depth * 24 + 20}px`,
                top: 0,
                bottom: 0,
              }}
            />
            {node.children.map((child, index) => (
              <TreeNodeRow
                key={String(child.record.id)}
                node={child}
                labelField={labelField}
                summaryFields={summaryFields}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                onRecordClick={onRecordClick}
                isLast={index === node.children.length - 1}
              />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
