/**
 * AutoKanban — Kanban board view for schemas with state fields.
 *
 * Groups records by state field value into draggable columns.
 * Drag-and-drop between columns triggers state transitions via GraphQL.
 * Uses native HTML drag-and-drop API (no external library).
 */

import type { EntityDefinition, StateDefinition, StateMeta } from "@linchkit/core/types";
import { Badge, Card, CardContent, CardHeader, Skeleton, toast } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import { Clock, GripVertical, Inbox, Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSchemaLabel } from "../../i18n/use-entity-label";
import { transitionRecord } from "../../lib/api";
import { getStateBadgeClass, resolveStateColor } from "../../lib/state-colors";

// ── Types ────────────────────────────────────────────────

export interface AutoKanbanProps {
  schema: EntityDefinition;
  stateDefinition: StateDefinition;
  data: Record<string, unknown>[];
  loading?: boolean;
  onRecordClick?: (recordId: string) => void;
  /** Called after a successful transition so the parent can refetch data. */
  onTransitioned?: () => void;
  /** Fields to return after transition mutation. */
  queryFields?: string[];
}

interface DragState {
  recordId: string;
  fromState: string;
}

// ── Helpers ──────────────────────────────────────────────

/** Format a date value for card display. */
function formatDate(value: unknown): string {
  if (!value) return "";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Get a display value for a record field (handles objects, arrays, nulls). */
function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (Array.isArray(value)) return `${value.length} items`;
    // Object with id — show id
    const obj = value as Record<string, unknown>;
    if ("name" in obj) return String(obj.name);
    if ("label" in obj) return String(obj.label);
    if ("id" in obj) return String(obj.id);
    return JSON.stringify(value);
  }
  return String(value);
}

// ── Column component ─────────────────────────────────────

interface KanbanColumnProps {
  stateValue: string;
  stateMeta?: StateMeta;
  records: Record<string, unknown>[];
  schema: EntityDefinition;
  isDragOver: boolean;
  isInvalidDrop: boolean;
  onDragStart: (recordId: string, fromState: string) => void;
  onDragOver: (e: React.DragEvent, stateValue: string) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent, toState: string) => void;
  onRecordClick?: (recordId: string) => void;
  transitioningId: string | null;
  resolveLabel: (label: string | undefined, fallback: string) => string;
}

function KanbanColumn({
  stateValue,
  stateMeta,
  records,
  schema,
  isDragOver,
  isInvalidDrop,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onRecordClick,
  transitioningId,
  resolveLabel,
}: KanbanColumnProps) {
  const { t } = useTranslation();

  const colorToken = resolveStateColor(
    stateValue,
    stateMeta ? { [stateValue]: stateMeta } : undefined,
  );
  const badgeClass = getStateBadgeClass(colorToken);

  // Resolve column header label
  const label = resolveLabel(
    stateMeta?.label,
    stateValue.charAt(0).toUpperCase() + stateValue.slice(1),
  );

  // Presentation fields for cards
  const titleField = schema.presentation?.titleField ?? Object.keys(schema.fields)[0] ?? "id";
  const summaryFields =
    schema.presentation?.summaryFields ?? Object.keys(schema.fields).slice(1, 4);
  const badgeField = schema.presentation?.badgeField;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop column uses drag events
    <div
      className={cn(
        "flex flex-col min-w-[280px] max-w-[320px] w-[280px] rounded-lg bg-muted/30 border transition-colors",
        isDragOver && !isInvalidDrop && "border-primary/50 bg-primary/5",
        isDragOver && isInvalidDrop && "border-destructive/50 bg-destructive/5",
        !isDragOver && "border-transparent",
      )}
      onDragOver={(e) => onDragOver(e, stateValue)}
      onDragLeave={onDragLeave}
      onDrop={(e) => onDrop(e, stateValue)}
    >
      {/* Column header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/50">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
              badgeClass,
            )}
          >
            {label}
          </span>
        </div>
        <Badge variant="secondary" className="text-[10px] h-5 min-w-[20px] justify-center">
          {records.length}
        </Badge>
      </div>

      {/* Cards container */}
      <div className="flex-1 p-2 space-y-2 min-h-[100px] overflow-y-auto max-h-[calc(100vh-250px)]">
        {records.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Inbox className="size-6 opacity-40 mb-1" />
            <p className="text-xs">{t("kanban.noRecords", "No records")}</p>
          </div>
        ) : (
          records.map((record) => {
            const id = String(record.id ?? "");
            const isTransitioning = transitioningId === id;

            return (
              <Card
                key={id}
                draggable={!isTransitioning}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", id);
                  onDragStart(id, stateValue);
                }}
                className={cn(
                  "cursor-grab active:cursor-grabbing transition-all hover:shadow-md border-border/60",
                  isTransitioning && "opacity-50 pointer-events-none",
                )}
                onClick={() => onRecordClick?.(id)}
              >
                <CardHeader className="p-3 pb-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      <GripVertical className="size-3.5 text-muted-foreground/50 shrink-0" />
                      <span className="text-sm font-medium truncate">
                        {displayValue(record[titleField]) || id}
                      </span>
                    </div>
                    {isTransitioning && (
                      <Loader2 className="size-3.5 animate-spin text-primary shrink-0" />
                    )}
                    {!isTransitioning && badgeField && Boolean(record[badgeField]) && (
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        {displayValue(record[badgeField])}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="p-3 pt-1">
                  {/* Summary fields */}
                  {summaryFields.length > 0 ? (
                    <div className="space-y-0.5">
                      {summaryFields.slice(0, 3).map((field) => {
                        const val = record[field];
                        if (val === null || val === undefined) return null;
                        const fieldDef = schema.fields[field];
                        const fieldLabel = resolveLabel(
                          fieldDef?.label,
                          field.charAt(0).toUpperCase() + field.slice(1).replace(/_/g, " "),
                        );
                        return (
                          <div
                            key={field}
                            className="flex items-center gap-1.5 text-xs text-muted-foreground"
                          >
                            <span className="shrink-0">{fieldLabel}:</span>
                            <span className="truncate text-foreground/80">{displayValue(val)}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                  {/* Created date */}
                  {record.created_at != null && (
                    <div className="flex items-center gap-1 mt-1.5 text-[10px] text-muted-foreground/70">
                      <Clock className="size-3" />
                      {formatDate(record.created_at)}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────

export function AutoKanban({
  schema,
  stateDefinition,
  data,
  loading = false,
  onRecordClick,
  onTransitioned,
  queryFields,
}: AutoKanbanProps) {
  const { t } = useTranslation();
  const { resolveLabel } = useSchemaLabel();

  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const [transitioningId, setTransitioningId] = useState<string | null>(null);

  const stateField = stateDefinition.field;
  const allStates = stateDefinition.states;

  // Group records by state value
  const columnData = useMemo(() => {
    const groups = new Map<string, Record<string, unknown>[]>();
    // Initialize all states (even empty ones)
    for (const state of allStates) {
      groups.set(state, []);
    }
    for (const record of data) {
      const stateValue = String(record[stateField] ?? stateDefinition.initial);
      const group = groups.get(stateValue);
      if (group) {
        group.push(record);
      } else {
        // Record has a state not in the definition — add it to its own column
        groups.set(stateValue, [record]);
      }
    }
    return groups;
  }, [data, allStates, stateField, stateDefinition.initial]);

  // Determine valid target states for a given source state from the transitions list
  const getValidTargets = useCallback(
    (fromState: string): Set<string> => {
      const targets = new Set<string>();
      for (const tr of stateDefinition.transitions) {
        const fromArr = Array.isArray(tr.from) ? tr.from : [tr.from];
        if (fromArr.includes(fromState)) {
          targets.add(tr.to);
        }
      }
      return targets;
    },
    [stateDefinition.transitions],
  );

  // Check if dropping to a state is valid based on state machine transitions
  const isValidDrop = useCallback(
    (toState: string): boolean => {
      if (!dragState) return false;
      if (toState === dragState.fromState) return false;
      const validTargets = getValidTargets(dragState.fromState);
      return validTargets.has(toState);
    },
    [dragState, getValidTargets],
  );

  const handleDragStart = useCallback((recordId: string, fromState: string) => {
    setDragState({ recordId, fromState });
  }, []);

  const handleDragOver = useCallback(
    (e: React.DragEvent, stateValue: string) => {
      e.preventDefault();
      // Set drag effect based on validity
      if (dragState && stateValue !== dragState.fromState) {
        const valid = isValidDrop(stateValue);
        e.dataTransfer.dropEffect = valid ? "move" : "none";
      }
      setDragOverColumn(stateValue);
    },
    [dragState, isValidDrop],
  );

  const handleDragLeave = useCallback(() => {
    setDragOverColumn(null);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent, toState: string) => {
      e.preventDefault();
      setDragOverColumn(null);

      if (!dragState) return;
      const { recordId, fromState } = dragState;
      setDragState(null);

      if (toState === fromState) return;

      // Validate transition
      if (!isValidDrop(toState)) {
        toast.error(
          t("kanban.invalidTransition", 'Cannot move to "{{state}}" from current state', {
            state: toState,
          }),
        );
        return;
      }

      // Execute transition
      setTransitioningId(recordId);
      try {
        const fields = queryFields ?? ["id", stateField];
        await transitionRecord(schema.name, recordId, toState, fields);
        toast.success(t("toast.transitionSuccess", "Status changed successfully"));
        onTransitioned?.();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : t("toast.transitionFailed", "Status change failed");
        toast.error(message);
      } finally {
        setTransitioningId(null);
      }
    },
    [dragState, isValidDrop, schema.name, stateField, queryFields, onTransitioned, t],
  );

  // End drag when leaving the board area
  const handleDragEnd = useCallback(() => {
    setDragState(null);
    setDragOverColumn(null);
  }, []);

  if (loading) {
    return (
      <div className="flex gap-4 overflow-x-auto pb-4">
        {Array.from({ length: 4 }, (_, i) => `skel-col-${i}`).map((key) => (
          <div
            key={key}
            className="min-w-[280px] w-[280px] rounded-lg bg-muted/30 border border-transparent p-3 space-y-3"
          >
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-5 w-6" />
            </div>
            {Array.from({ length: 3 }, (_, j) => `skel-card-${j}`).map((cardKey) => (
              <Skeleton key={cardKey} className="h-24 w-full rounded-lg" />
            ))}
          </div>
        ))}
      </div>
    );
  }

  // Build ordered list of columns — defined states first, then any extras
  const orderedStates = [...allStates];
  for (const key of columnData.keys()) {
    if (!orderedStates.includes(key)) {
      orderedStates.push(key);
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag container uses drag events
    <div className="flex gap-4 overflow-x-auto pb-4" onDragEnd={handleDragEnd}>
      {orderedStates.map((stateValue) => {
        const records = columnData.get(stateValue) ?? [];
        const meta = stateDefinition.meta?.[stateValue];
        const isDragOver = dragOverColumn === stateValue;
        const isInvalid = isDragOver && dragState !== null && !isValidDrop(stateValue);

        return (
          <KanbanColumn
            key={stateValue}
            stateValue={stateValue}
            stateMeta={meta}
            records={records}
            schema={schema}
            isDragOver={isDragOver}
            isInvalidDrop={isInvalid}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onRecordClick={onRecordClick}
            transitioningId={transitioningId}
            resolveLabel={resolveLabel}
          />
        );
      })}
    </div>
  );
}
