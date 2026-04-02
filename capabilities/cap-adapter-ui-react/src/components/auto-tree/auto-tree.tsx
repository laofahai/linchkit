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
 * - Inline action buttons on hover (edit, delete, add child, etc.)
 * - §3.2 Drag-and-Drop reparenting with visual drop indicators
 * - §3.3 Tree+List hybrid view (tree left, child records list right)
 * - §3.4 Search/filter within tree with ancestor chain preservation
 */

import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
} from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  GripVertical,
  Inbox,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  buildTree,
  collectAllIds,
  filterTree,
  getSearchExpandIds,
  reparentRecord,
  type TreeNode,
  wouldCreateCycle,
} from "./tree-utils";

/** An action that can be performed on a tree node. */
export interface TreeNodeAction {
  /** Action identifier (e.g. "edit", "delete", "add_child") */
  action: string;
  /** Display label */
  label: string;
  /** Lucide icon element to render */
  icon?: React.ReactNode;
  /** Only show for nodes matching this condition */
  visibleWhen?: (record: Record<string, unknown>) => boolean;
}

/** Drop position relative to a target node */
type DropPosition = "before" | "after" | "inside";

interface DropTarget {
  nodeId: string;
  position: DropPosition;
}

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
  /** Inline actions shown on hover for each tree node */
  nodeActions?: TreeNodeAction[];
  /** Callback when a node action is triggered */
  onNodeAction?: (action: string, recordId: string) => void;

  // §3.2 DnD reparenting
  /** Enable drag-and-drop reparenting */
  enableDnD?: boolean;
  /**
   * Called when a node is reparented. The consumer should persist the change.
   * Return a rejected promise to signal failure (optimistic rollback will occur).
   */
  onReparent?: (draggedId: string, newParentId: string | null) => Promise<void>;

  // §3.3 Tree+List hybrid
  /**
   * When set, enables hybrid split view. On node selection, the right panel
   * shows child records from this schema filtered by `childListForeignKey`.
   */
  childListSchema?: string;
  /**
   * Foreign key field in the child schema that references the selected node id.
   * E.g. "department_id" if child records have a department_id field.
   */
  childListForeignKey?: string;
  /**
   * Records for the child list schema. Required when childListSchema is set.
   */
  childListRecords?: Record<string, unknown>[];
  /**
   * Label field for the child list records (defaults to labelField).
   */
  childListLabelField?: string;
  /**
   * Callback when a child list item is clicked.
   */
  onChildListRecordClick?: (recordId: string) => void;

  // §3.4 Search
  /** Show search bar for filtering nodes (default: true) */
  searchable?: boolean;
}

export function AutoTree({
  schemaName: _schemaName,
  parentField,
  records: externalRecords,
  labelField,
  summaryFields,
  onRecordClick,
  toolbarExtra,
  nodeActions,
  onNodeAction,
  enableDnD = false,
  onReparent,
  childListSchema,
  childListForeignKey,
  childListRecords = [],
  childListLabelField,
  onChildListRecordClick,
  searchable = true,
}: AutoTreeProps) {
  const { t } = useTranslation();

  // §3.2: Optimistic local records state for DnD
  const [localRecords, setLocalRecords] = useState<Record<string, unknown>[]>(externalRecords);
  useEffect(() => {
    setLocalRecords(externalRecords);
  }, [externalRecords]);

  // §3.4: Search state
  const [searchQuery, setSearchQuery] = useState("");

  // §3.3: Selected node for hybrid view
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const tree = useMemo(() => buildTree(localRecords, parentField), [localRecords, parentField]);

  // §3.4: Filter tree by search query
  const displayTree = useMemo(
    () => filterTree(tree, searchQuery, labelField),
    [tree, searchQuery, labelField],
  );

  const allExpandableIds = useMemo(() => collectAllIds(tree), [tree]);

  // When search is active, auto-expand ancestors of matching nodes
  const searchExpandIds = useMemo(
    () => getSearchExpandIds(tree, searchQuery, labelField),
    [tree, searchQuery, labelField],
  );

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(allExpandableIds));

  // Auto-expand ancestors when searching
  useEffect(() => {
    if (searchQuery.trim()) {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const id of searchExpandIds) {
          next.add(id);
        }
        return next;
      });
    }
  }, [searchQuery, searchExpandIds]);

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

  // §3.2: DnD state
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over, active } = event;
    if (!over) {
      setDropTarget(null);
      return;
    }

    const overId = String(over.id);
    const draggedId = String(active.id);

    // Determine position from over.id which encodes "nodeId:position"
    const colonIdx = overId.lastIndexOf(":");
    if (colonIdx === -1) {
      setDropTarget(null);
      return;
    }
    const nodeId = overId.slice(0, colonIdx);
    const posStr = overId.slice(colonIdx + 1) as DropPosition;

    if (nodeId === draggedId) {
      setDropTarget(null);
      return;
    }

    setDropTarget({ nodeId, position: posStr });
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveDragId(null);
      setDropTarget(null);

      if (!dropTarget || !event.over) return;

      const draggedId = String(event.active.id);
      const { nodeId: targetId, position } = dropTarget;

      if (draggedId === targetId) return;

      // Find the target node's parent
      let newParentId: string | null;
      if (position === "inside") {
        newParentId = targetId;
      } else {
        // before/after: same parent as target node
        const targetRecord = localRecords.find((r) => String(r.id) === targetId);
        const targetParent = targetRecord?.[parentField];
        newParentId = targetParent == null || targetParent === "" ? null : String(targetParent);
      }

      // Cycle check
      if (wouldCreateCycle(localRecords, draggedId, newParentId, parentField)) return;

      // Optimistic update
      const prevRecords = localRecords;
      setLocalRecords(reparentRecord(localRecords, draggedId, newParentId, parentField));

      // Server update with rollback on failure
      if (onReparent) {
        try {
          await onReparent(draggedId, newParentId);
        } catch {
          setLocalRecords(prevRecords);
        }
      }
    },
    [dropTarget, localRecords, parentField, onReparent],
  );

  // §3.3: Compute child list records for selected node
  const filteredChildList = useMemo(() => {
    if (!selectedNodeId || !childListForeignKey) return [];
    return childListRecords.filter((r) => String(r[childListForeignKey]) === selectedNodeId);
  }, [selectedNodeId, childListForeignKey, childListRecords]);

  const showHybrid = Boolean(childListSchema && childListForeignKey);
  const activeDragRecord = activeDragId
    ? localRecords.find((r) => String(r.id) === activeDragId)
    : null;

  const handleNodeClick = useCallback(
    (recordId: string) => {
      if (showHybrid) {
        setSelectedNodeId((prev) => (prev === recordId ? null : recordId));
      }
      onRecordClick?.(recordId);
    },
    [showHybrid, onRecordClick],
  );

  if (localRecords.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <Inbox className="mb-2 size-10" />
        <p className="text-sm">{t("tree.noRecords")}</p>
      </div>
    );
  }

  const treePanel = (
    <div className={cn("space-y-1", showHybrid && "min-w-0 flex-1")}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 pb-2 border-b mb-2">
        <span className="text-sm text-muted-foreground">
          {t("tree.rootNodes", { count: displayTree.length })}
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

      {/* §3.4 Search bar */}
      {searchable && (
        <div className="relative mb-2">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("tree.search", "Search...")}
            className="pl-7 h-7 text-sm"
          />
        </div>
      )}

      {/* §3.4 No results message */}
      {searchQuery.trim() && displayTree.length === 0 && (
        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
          <Search className="mb-2 size-8" />
          <p className="text-sm">{t("tree.noResults", "No results found")}</p>
        </div>
      )}

      {/* Tree */}
      <div role="tree" aria-label="tree-view">
        {displayTree.map((node, index) => (
          <TreeNodeRow
            key={String(node.record.id)}
            node={node}
            labelField={labelField}
            summaryFields={summaryFields}
            depth={0}
            expanded={expanded}
            onToggle={toggle}
            onRecordClick={handleNodeClick}
            isLast={index === displayTree.length - 1}
            nodeActions={nodeActions}
            onNodeAction={onNodeAction}
            enableDnD={enableDnD}
            dropTarget={dropTarget}
            activeDragId={activeDragId}
            selectedNodeId={selectedNodeId ?? undefined}
          />
        ))}
      </div>
    </div>
  );

  const treeContent = enableDnD ? (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      {treePanel}
      <DragOverlay>
        {activeDragRecord ? (
          <div className="flex items-center gap-2 px-2 py-1.5 bg-background border border-border rounded-md shadow-md text-sm font-medium opacity-90">
            <GripVertical className="size-3.5 text-muted-foreground" />
            {String(activeDragRecord[labelField] ?? activeDragRecord.name ?? activeDragRecord.id)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  ) : (
    treePanel
  );

  if (!showHybrid) {
    return treeContent;
  }

  // §3.3: Hybrid split view
  return (
    <div className="flex gap-0 border rounded-md overflow-hidden">
      <div className="flex-1 min-w-0 p-3 overflow-auto border-r">{treeContent}</div>
      <div className="flex-1 min-w-0 p-3 overflow-auto">
        {selectedNodeId && childListSchema ? (
          <ChildListPanel
            schemaName={childListSchema}
            records={filteredChildList}
            labelField={childListLabelField ?? labelField}
            summaryFields={summaryFields}
            onRecordClick={onChildListRecordClick}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 text-muted-foreground">
            <p className="text-sm">{t("tree.selectNodeHint", "Select a node to view children")}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── §3.3 Child List Panel ─────────────────────────────────

interface ChildListPanelProps {
  schemaName: string;
  records: Record<string, unknown>[];
  labelField: string;
  summaryFields?: string[];
  onRecordClick?: (recordId: string) => void;
}

function ChildListPanel({
  schemaName: _schemaName,
  records,
  labelField,
  summaryFields,
  onRecordClick,
}: ChildListPanelProps) {
  const { t } = useTranslation();

  if (records.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <Inbox className="mb-2 size-8" />
        <p className="text-sm">{t("tree.noChildren", "No child records")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground mb-2">
        {t("tree.childCount", { count: records.length, defaultValue: `${records.length} records` })}
      </p>
      {records.map((record) => {
        const id = String(record.id);
        const label = String(record[labelField] ?? record.name ?? id);
        const summaryParts = (summaryFields ?? [])
          .map((f) => formatSummaryValue(record[f]))
          .filter(Boolean);

        return (
          <button
            key={id}
            type="button"
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent cursor-pointer text-sm text-left"
            onClick={() => onRecordClick?.(id)}
          >
            <File className="size-4 text-muted-foreground shrink-0" />
            <span className="truncate font-medium">{label}</span>
            {summaryParts.length > 0 && (
              <span className="ml-2 text-xs text-muted-foreground truncate">
                {summaryParts.join(" · ")}
              </span>
            )}
          </button>
        );
      })}
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
  nodeActions?: TreeNodeAction[];
  onNodeAction?: (action: string, recordId: string) => void;
  enableDnD?: boolean;
  dropTarget?: DropTarget | null;
  activeDragId?: string | null;
  selectedNodeId?: string;
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
  nodeActions,
  onNodeAction,
  enableDnD,
  dropTarget,
  activeDragId,
  selectedNodeId,
}: TreeNodeRowProps) {
  const isSelected = selectedNodeId === String(node.record.id);
  const id = String(node.record.id);
  const label = String(node.record[labelField] ?? node.record.name ?? id);
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(id);
  const isDragging = activeDragId === id;

  // §3.2: Draggable
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    transform,
  } = useDraggable({
    id,
    disabled: !enableDnD,
  });

  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;

  // Drop indicators
  const isDropBeforeActive = dropTarget?.nodeId === id && dropTarget.position === "before";
  const isDropAfterActive = dropTarget?.nodeId === id && dropTarget.position === "after";
  const isDropInsideActive = dropTarget?.nodeId === id && dropTarget.position === "inside";

  // Droppable zones (before/after/inside) — only used when DnD is enabled
  const { setNodeRef: setBeforeRef } = useDroppable({ id: `${id}:before`, disabled: !enableDnD });
  const { setNodeRef: setAfterRef } = useDroppable({ id: `${id}:after`, disabled: !enableDnD });
  const { setNodeRef: setInsideRef } = useDroppable({ id: `${id}:inside`, disabled: !enableDnD });

  // Build summary text from fields
  const summaryParts = (summaryFields ?? [])
    .map((f) => formatSummaryValue(node.record[f]))
    .filter(Boolean);

  // Filter visible actions for this node
  const visibleActions = (nodeActions ?? []).filter(
    (a) => !a.visibleWhen || a.visibleWhen(node.record),
  );

  // Connector lines: vertical lines from ancestors, horizontal connector to this node
  const connectors =
    depth > 0 ? (
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

  const summaryBadges =
    summaryParts.length > 0 ? (
      <span className="ml-2 text-xs text-muted-foreground truncate">
        {summaryParts.join(" · ")}
      </span>
    ) : null;

  // Inline action buttons shown on hover
  const inlineActions =
    visibleActions.length > 0 ? (
      <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover/node:opacity-100 transition-opacity">
        {visibleActions.map((a) => (
          <button
            key={a.action}
            type="button"
            title={a.label}
            aria-label={a.label}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              onNodeAction?.(a.action, id);
            }}
          >
            {a.icon ?? <span className="text-xs">{a.label}</span>}
          </button>
        ))}
      </div>
    ) : null;

  // Drag handle
  const dragHandle = enableDnD ? (
    <button
      type="button"
      className="p-0.5 rounded cursor-grab active:cursor-grabbing shrink-0 text-muted-foreground hover:text-foreground opacity-0 group-hover/node:opacity-100 transition-opacity"
      {...listeners}
      {...attributes}
      aria-label="drag to reorder"
    >
      <GripVertical className="size-3.5" />
    </button>
  ) : null;

  const paddingLeft = depth > 0 ? `${depth * 24 + 8}px` : "8px";

  const nodeContent = (
    <div
      ref={setInsideRef}
      className={cn(
        "relative group/node flex items-center gap-1 py-1.5 px-2 rounded-md hover:bg-accent text-sm",
        isDragging && "opacity-30",
        isSelected && "bg-accent",
        isDropInsideActive && "ring-2 ring-primary ring-inset",
      )}
      style={{ paddingLeft }}
    >
      {connectors}
      {dragHandle}
      {hasChildren && (
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="p-0.5 rounded hover:bg-muted shrink-0"
            aria-label={isOpen ? "collapse" : "expand"}
          >
            {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        </CollapsibleTrigger>
      )}
      {!hasChildren && <File className="size-4 text-muted-foreground shrink-0" />}
      {hasChildren &&
        (isOpen ? (
          <FolderOpen className="size-4 text-muted-foreground shrink-0" />
        ) : (
          <Folder className="size-4 text-muted-foreground shrink-0" />
        ))}
      <button
        type="button"
        className={cn(
          "truncate cursor-pointer font-medium text-left",
          hasChildren && "hover:underline",
        )}
        onClick={() => onRecordClick?.(id)}
      >
        {label}
      </button>
      {hasChildren && (
        <span className="text-xs text-muted-foreground ml-1">({node.children.length})</span>
      )}
      {summaryBadges}
      {inlineActions}
    </div>
  );

  const rowContent = (
    <div
      ref={(el) => {
        setDragRef(el);
        // also attach before/after droppable to same element via data
      }}
      style={style}
      className="relative"
    >
      {/* Drop zone: before */}
      {enableDnD && (
        <div
          ref={setBeforeRef}
          className={cn(
            "h-1 mx-2 rounded-full transition-colors",
            isDropBeforeActive ? "bg-primary" : "bg-transparent",
          )}
        />
      )}

      {nodeContent}

      {/* Drop zone: after */}
      {enableDnD && (
        <div
          ref={setAfterRef}
          className={cn(
            "h-1 mx-2 rounded-full transition-colors",
            isDropAfterActive ? "bg-primary" : "bg-transparent",
          )}
        />
      )}
    </div>
  );

  if (!hasChildren) {
    return rowContent;
  }

  // Branch node — collapsible
  return (
    <div className="relative">
      <Collapsible open={isOpen} onOpenChange={() => onToggle(id)}>
        {rowContent}
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
                nodeActions={nodeActions}
                onNodeAction={onNodeAction}
                enableDnD={enableDnD}
                dropTarget={dropTarget}
                activeDragId={activeDragId}
                selectedNodeId={selectedNodeId}
              />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
