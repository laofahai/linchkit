/**
 * AutoTree — Schema-driven collapsible tree view for hierarchical records.
 *
 * Renders records with parent-child relationships as an indented,
 * expandable/collapsible tree. Each node shows its label and allows
 * navigation to the record detail.
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
  /** Callback when a record node is clicked */
  onRecordClick?: (recordId: string) => void;
}

export function AutoTree({
  schemaName: _schemaName,
  parentField,
  records,
  labelField,
  onRecordClick,
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
        <Inbox className="h-10 w-10 mb-2" />
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
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="sm" onClick={expandAll}>
            {t("tree.expandAll")}
          </Button>
          <Button variant="ghost" size="sm" onClick={collapseAll}>
            {t("tree.collapseAll")}
          </Button>
        </div>
      </div>

      {/* Tree */}
      <div role="tree" aria-label="tree-view">
        {tree.map((node) => (
          <TreeNodeRow
            key={String(node.record.id)}
            node={node}
            labelField={labelField}
            depth={0}
            expanded={expanded}
            onToggle={toggle}
            onRecordClick={onRecordClick}
          />
        ))}
      </div>
    </div>
  );
}

// ── Internal TreeNodeRow ────────────────────────────────

interface TreeNodeRowProps {
  node: TreeNode;
  labelField: string;
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onRecordClick?: (recordId: string) => void;
}

function TreeNodeRow({
  node,
  labelField,
  depth,
  expanded,
  onToggle,
  onRecordClick,
}: TreeNodeRowProps) {
  const id = String(node.record.id);
  const label = String(node.record[labelField] ?? node.record.name ?? id);
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(id);

  if (!hasChildren) {
    // Leaf node — simple row
    return (
      <div
        role="treeitem"
        className={cn(
          "flex items-center gap-2 py-1 px-2 rounded-md hover:bg-accent cursor-pointer text-sm",
        )}
        style={{ paddingLeft: `${depth * 24 + 32}px` }}
        onClick={() => onRecordClick?.(id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onRecordClick?.(id);
        }}
        tabIndex={0}
      >
        <File className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="truncate">{label}</span>
      </div>
    );
  }

  // Branch node — collapsible
  return (
    <Collapsible open={isOpen} onOpenChange={() => onToggle(id)}>
      <div
        role="treeitem"
        aria-expanded={isOpen}
        className="flex items-center gap-1 py-1 px-2 rounded-md hover:bg-accent text-sm"
        style={{ paddingLeft: `${depth * 24 + 8}px` }}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="p-0.5 rounded hover:bg-muted shrink-0"
            aria-label={isOpen ? "collapse" : "expand"}
          >
            {isOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        </CollapsibleTrigger>
        {isOpen ? (
          <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
        <span
          className="truncate cursor-pointer hover:underline"
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
      </div>
      <CollapsibleContent>
        {node.children.map((child) => (
          <TreeNodeRow
            key={String(child.record.id)}
            node={child}
            labelField={labelField}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            onRecordClick={onRecordClick}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
