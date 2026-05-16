/**
 * KanbanBoard — root component of cap-view-kanban.
 *
 * Renders one column per declared state of the entity's state machine,
 * groups `data` into those columns by `stateField`, and wires accessible
 * drag-and-drop (via @dnd-kit) to a transition action.
 *
 * Side-effect model:
 *  - Drag end → validate the drop against the state machine's transitions.
 *  - If valid → call `transition` (defaults to the GraphQL mutation in
 *    cap-adapter-ui). The state field is NEVER mutated directly — every
 *    move flows through an Action, satisfying the "Action as Sole Write
 *    Entry" core principle.
 *  - If invalid → onTransitionError fires with a synthetic error; no
 *    network request happens.
 */

import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { type JSX, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { KanbanColumn } from "./KanbanColumn";
import type { KanbanBoardProps, KanbanRecord } from "./types";
import {
  defaultTransition,
  indexTransitions,
  useKanbanData,
  validateDrop,
} from "./use-kanban-data";

function resolveLabel(stateValue: string, stateDefinition: KanbanBoardProps["stateDefinition"]) {
  const meta = stateDefinition.meta?.[stateValue];
  if (meta?.label) return meta.label;
  return stateValue.charAt(0).toUpperCase() + stateValue.slice(1);
}

export function KanbanBoard({
  entity,
  schema,
  stateDefinition,
  stateField,
  data,
  cardFields,
  loading = false,
  error = null,
  onCardClick,
  onTransitioned,
  onTransitionError,
  queryFields,
  transition = defaultTransition,
  className,
}: KanbanBoardProps): JSX.Element {
  const { t } = useTranslation();
  const effectiveStateField = stateField ?? stateDefinition.field;
  const effectiveCardFields = useMemo<ReadonlyArray<string>>(
    () =>
      cardFields ??
      (schema.presentation?.summaryFields as ReadonlyArray<string> | undefined) ??
      Object.keys(schema.fields).slice(0, 3),
    [cardFields, schema],
  );
  const effectiveQueryFields = useMemo<ReadonlyArray<string>>(
    () => queryFields ?? ["id", effectiveStateField],
    [queryFields, effectiveStateField],
  );

  const { columnOrder, groups } = useKanbanData(data, stateDefinition, effectiveStateField);
  // Pre-compute the static transition index alongside the memoised groups
  // so the drop validator runs synchronously inside the dnd-kit callbacks.
  const transitionsIndex = useMemo(
    () => indexTransitions(stateDefinition.transitions),
    [stateDefinition.transitions],
  );

  const [activeRecordId, setActiveRecordId] = useState<string | null>(null);
  const [pendingRecordId, setPendingRecordId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  // Resolve the source state for the currently dragged card so the UI
  // can grey out invalid drop targets while the drag is in flight.
  const activeFromState = useMemo<string | undefined>(() => {
    if (!activeRecordId) return undefined;
    for (const [stateValue, records] of groups) {
      if (records.some((r) => r.id === activeRecordId)) return stateValue;
    }
    return undefined;
  }, [activeRecordId, groups]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveRecordId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const recordId = String(event.active.id);
      const toState = event.over ? String(event.over.id) : null;
      setActiveRecordId(null);
      if (!toState) return;

      const fromState = activeFromState;
      const validation = validateDrop({ fromState, toState, transitionsIndex });
      if (!validation.allowed) {
        // Same-column drops are a no-op (the user dropped where they picked
        // up). Other failures surface to the host so it can show a toast.
        if (validation.reason !== "same-column") {
          onTransitionError?.({
            recordId,
            to: toState,
            error: new Error(
              validation.reason === "no-transition"
                ? t("kanban.board.error.description", {
                    from: fromState ?? "",
                    to: toState,
                  })
                : t("kanban.board.error.unknownSource"),
            ),
          });
        }
        return;
      }

      setPendingRecordId(recordId);
      try {
        await transition({
          entity,
          recordId,
          to: toState,
          fields: [...effectiveQueryFields],
        });
        onTransitioned?.({ recordId, from: fromState ?? "", to: toState });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        onTransitionError?.({ recordId, to: toState, error });
      } finally {
        setPendingRecordId(null);
      }
    },
    [
      activeFromState,
      effectiveQueryFields,
      entity,
      onTransitionError,
      onTransitioned,
      t,
      transition,
      transitionsIndex,
    ],
  );

  if (error) {
    return (
      <div
        role="alert"
        className={`rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive ${className ?? ""}`}
      >
        {error}
      </div>
    );
  }

  if (loading) {
    return (
      <div aria-busy="true" className={`flex gap-4 overflow-x-auto pb-2 ${className ?? ""}`}>
        {stateDefinition.states.map((stateValue) => (
          <div
            key={stateValue}
            className="flex w-72 shrink-0 flex-col gap-2 rounded-lg border border-border/40 bg-muted/30 p-3"
          >
            <div className="h-5 w-24 animate-pulse rounded bg-muted" />
            <div className="h-20 w-full animate-pulse rounded bg-muted" />
            <div className="h-20 w-full animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  if (data.length === 0) {
    // Empty boards still render the column headers so the user understands
    // the workflow shape — only the cards area shows the empty message.
    return (
      <DndContext sensors={sensors}>
        <div className={`flex gap-4 overflow-x-auto pb-2 ${className ?? ""}`}>
          {columnOrder.map((stateValue) => (
            <KanbanColumn
              key={stateValue}
              stateValue={stateValue}
              label={resolveLabel(stateValue, stateDefinition)}
              records={[]}
              schema={schema}
              cardFields={effectiveCardFields}
              isInvalidTarget={false}
              onCardClick={onCardClick}
              pendingRecordId={null}
            />
          ))}
        </div>
      </DndContext>
    );
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className={`flex gap-4 overflow-x-auto pb-2 ${className ?? ""}`}>
        {columnOrder.map((stateValue) => {
          const records: ReadonlyArray<KanbanRecord> = groups.get(stateValue) ?? [];
          const validation = activeFromState
            ? validateDrop({ fromState: activeFromState, toState: stateValue, transitionsIndex })
            : { allowed: true as const };
          const isInvalidTarget =
            activeRecordId !== null && stateValue !== activeFromState && !validation.allowed;

          return (
            <KanbanColumn
              key={stateValue}
              stateValue={stateValue}
              label={resolveLabel(stateValue, stateDefinition)}
              records={records}
              schema={schema}
              cardFields={effectiveCardFields}
              isInvalidTarget={isInvalidTarget}
              onCardClick={onCardClick}
              pendingRecordId={pendingRecordId}
            />
          );
        })}
      </div>
    </DndContext>
  );
}
