/**
 * CalendarGrid — pure presentation of the bucketed day cells.
 *
 * Mode controls layout:
 * - month: 7-column grid with full week padding.
 * - week:  7-column single-row grid.
 * - day:   single tall column.
 *
 * Each day cell is a droppable target so events can be re-parented onto it
 * via drag-and-drop. Click on empty space inside a cell is a no-op (matches
 * Spec 54 — click handlers live on the events themselves).
 */

import { useDroppable } from "@dnd-kit/core";
import { format, isToday } from "date-fns";
import { CalendarEvent } from "./CalendarEvent";
import type { CalendarDayCell, CalendarEventChip, CalendarViewMode } from "./types";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface CalendarGridProps {
  cells: CalendarDayCell[];
  mode: CalendarViewMode;
  draggable: boolean;
  onEventClick?: (chip: CalendarEventChip) => void;
}

interface DayCellProps {
  cell: CalendarDayCell;
  mode: CalendarViewMode;
  draggable: boolean;
  onEventClick?: (chip: CalendarEventChip) => void;
}

function DayCell({ cell, mode, draggable, onEventClick }: DayCellProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${cell.key}` });
  const today = isToday(cell.date);
  const muted = mode === "month" && !cell.inFocalMonth;

  const baseClass = "flex flex-col gap-1 border border-border p-1 text-left";
  const sizeClass = mode === "day" ? "min-h-[400px]" : "min-h-[90px]";
  const stateClass = [
    muted ? "bg-muted/20 text-muted-foreground/60" : "",
    isOver ? "ring-2 ring-primary/60" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={setNodeRef}
      data-testid="calendar-day-cell"
      data-day={cell.key}
      className={`${baseClass} ${sizeClass} ${stateClass}`.trim()}
    >
      <div className="flex items-center justify-between text-[11px]">
        <span
          className={
            today
              ? "inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground"
              : ""
          }
        >
          {format(cell.date, "d")}
        </span>
        {cell.events.length > 0 && (
          <span className="text-muted-foreground">{cell.events.length}</span>
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        {cell.events.map((chip) => (
          <CalendarEvent
            key={`${cell.key}:${chip.id}`}
            chip={chip}
            draggable={draggable}
            onClick={onEventClick}
          />
        ))}
      </div>
    </div>
  );
}

export function CalendarGrid({ cells, mode, draggable, onEventClick }: CalendarGridProps) {
  const columns = mode === "day" ? 1 : 7;
  const showWeekdayHeader = mode !== "day";

  return (
    <div data-testid="calendar-grid" data-mode={mode}>
      {showWeekdayHeader && (
        <div
          className="grid border-b border-border bg-muted/40 text-center text-[11px] font-medium text-muted-foreground"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {WEEKDAY_LABELS.map((label) => (
            <div key={label} className="py-1">
              {label}
            </div>
          ))}
        </div>
      )}
      <div className="grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {cells.map((cell) => (
          <DayCell
            key={cell.key}
            cell={cell}
            mode={mode}
            draggable={draggable}
            onEventClick={onEventClick}
          />
        ))}
      </div>
    </div>
  );
}
