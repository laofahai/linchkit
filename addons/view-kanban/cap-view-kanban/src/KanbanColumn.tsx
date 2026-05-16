/**
 * KanbanColumn — vertical lane of KanbanCards, droppable via @dnd-kit.
 *
 * Each column corresponds to one declared state. When dragging, columns
 * that are not valid transition destinations from the dragged card's
 * source column get a visually distinct "deny" border so the user can
 * see immediately which moves the state machine permits.
 */

import { useDroppable } from "@dnd-kit/core";
import type { JSX } from "react";
import { KanbanCard } from "./KanbanCard";
import type { KanbanColumnProps } from "./types";

export function KanbanColumn({
  stateValue,
  label,
  records,
  schema,
  cardFields,
  isInvalidTarget,
  onCardClick,
  pendingRecordId,
}: KanbanColumnProps): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({
    id: stateValue,
    data: { stateValue },
  });

  const borderClass = isOver
    ? isInvalidTarget
      ? "border-destructive/60 bg-destructive/5"
      : "border-primary/60 bg-primary/5"
    : "border-border/60";

  return (
    <section
      ref={setNodeRef}
      aria-label={`Column ${label}`}
      data-column-id={stateValue}
      data-over={isOver ? "true" : "false"}
      data-invalid-target={isInvalidTarget ? "true" : "false"}
      className={`flex w-72 shrink-0 flex-col rounded-lg border-2 bg-muted/30 transition-colors ${borderClass}`}
    >
      <header className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </h3>
        <span
          title={`${records.length} records`}
          className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-background px-1.5 text-[10px] font-medium text-muted-foreground"
        >
          <span className="sr-only">{`${records.length} records`}</span>
          <span aria-hidden="true">{records.length}</span>
        </span>
      </header>
      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {records.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">No records</p>
        ) : (
          records.map((record) => (
            <KanbanCard
              key={record.id}
              record={record}
              schema={schema}
              cardFields={cardFields}
              onClick={onCardClick}
              isPending={pendingRecordId === record.id}
            />
          ))
        )}
      </div>
    </section>
  );
}
