/**
 * CalendarBoard — top-level view component.
 *
 * Renders a header (mode toggle + date navigation) and delegates the cell
 * grid to CalendarGrid. Drag-and-drop lives at this level so the host's
 * `onMoveEvent` callback receives the resolved target date.
 *
 * The component is *headless* in the sense that it carries no API
 * dependencies — callers pass `data` directly. This keeps the capability
 * independent of cap-adapter-ui's data fetching layer.
 */

import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { addDays, addMonths, format, parse, startOfDay, subDays, subMonths } from "date-fns";
import { useCallback, useMemo, useState } from "react";
import { CalendarGrid } from "./CalendarGrid";
import type { CalendarBoardProps, CalendarRecord, CalendarViewMode } from "./types";
import { useCalendarData } from "./use-calendar-data";

const MODE_OPTIONS: readonly CalendarViewMode[] = ["month", "week", "day"] as const;

function formatHeader(date: Date, mode: CalendarViewMode): string {
  if (mode === "month") return format(date, "MMMM yyyy");
  if (mode === "day") return format(date, "EEEE, MMMM d, yyyy");
  return format(date, "'Week of' MMM d, yyyy");
}

/**
 * Top-level calendar capability surface. See README for the prop contract.
 */
export function CalendarBoard(props: CalendarBoardProps) {
  const {
    entity,
    dateField,
    endDateField,
    titleField,
    data,
    initialMode = "month",
    currentDate: controlledDate,
    onDateChange,
    loading = false,
    error = null,
    onEventClick,
    onMoveEvent,
  } = props;

  const [mode, setMode] = useState<CalendarViewMode>(initialMode);
  const [internalDate, setInternalDate] = useState<Date>(() => startOfDay(new Date()));
  const currentDate = controlledDate ?? internalDate;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const { cells } = useCalendarData({
    records: data,
    dateField,
    endDateField,
    titleField,
    currentDate,
    mode,
  });

  const setCurrentDate = useCallback(
    (next: Date) => {
      if (controlledDate === undefined) setInternalDate(next);
      onDateChange?.(next);
    },
    [controlledDate, onDateChange],
  );

  const handlePrev = useCallback(() => {
    if (mode === "month") setCurrentDate(subMonths(currentDate, 1));
    else if (mode === "week") setCurrentDate(subDays(currentDate, 7));
    else setCurrentDate(subDays(currentDate, 1));
  }, [mode, currentDate, setCurrentDate]);

  const handleNext = useCallback(() => {
    if (mode === "month") setCurrentDate(addMonths(currentDate, 1));
    else if (mode === "week") setCurrentDate(addDays(currentDate, 7));
    else setCurrentDate(addDays(currentDate, 1));
  }, [mode, currentDate, setCurrentDate]);

  const handleToday = useCallback(() => {
    setCurrentDate(startOfDay(new Date()));
  }, [setCurrentDate]);

  // Map drag end to the host's onMoveEvent callback.
  const chipsById = useMemo(() => {
    const map = new Map<string, CalendarRecord>();
    for (const cell of cells) {
      for (const chip of cell.events) {
        map.set(chip.id, chip.record);
      }
    }
    return map;
  }, [cells]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!onMoveEvent || !event.over) return;
      const overId = String(event.over.id);
      if (!overId.startsWith("day:")) return;
      const dayKey = overId.slice("day:".length);
      const record = chipsById.get(String(event.active.id));
      if (!record) return;
      const targetDate = parse(dayKey, "yyyy-MM-dd", new Date());
      if (Number.isNaN(targetDate.getTime())) return;
      onMoveEvent(record, startOfDay(targetDate));
    },
    [chipsById, onMoveEvent],
  );

  // ── State branches ────────────────────────────────────────

  if (error) {
    return (
      <div
        data-testid="calendar-error"
        className="rounded border border-destructive bg-destructive/5 p-4 text-sm text-destructive"
      >
        {error.message || "Failed to load calendar"}
      </div>
    );
  }

  if (loading) {
    return (
      <div
        data-testid="calendar-loading"
        className="flex items-center justify-center py-16 text-sm text-muted-foreground"
      >
        Loading calendar…
      </div>
    );
  }

  const isEmpty = cells.every((cell) => cell.events.length === 0);

  return (
    <div data-testid="calendar-board" data-entity={entity} className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 rounded border border-border bg-muted/30 p-0.5">
          {MODE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              data-testid={`mode-${option}`}
              onClick={() => setMode(option)}
              className={`rounded px-2 py-1 text-xs capitalize ${
                mode === option ? "bg-background shadow-sm" : "text-muted-foreground"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleToday}
            className="rounded border border-border px-2 py-1 text-xs hover:bg-muted/50"
          >
            Today
          </button>
          <button
            type="button"
            aria-label="Previous"
            onClick={handlePrev}
            className="rounded border border-border px-2 py-1 text-xs hover:bg-muted/50"
          >
            ‹
          </button>
          <span className="min-w-[180px] text-center text-sm font-medium">
            {formatHeader(currentDate, mode)}
          </span>
          <button
            type="button"
            aria-label="Next"
            onClick={handleNext}
            className="rounded border border-border px-2 py-1 text-xs hover:bg-muted/50"
          >
            ›
          </button>
        </div>
      </header>

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <CalendarGrid
          cells={cells}
          mode={mode}
          draggable={Boolean(onMoveEvent)}
          onEventClick={(chip) => onEventClick?.(chip.record)}
        />
      </DndContext>

      {isEmpty && (
        <div data-testid="calendar-empty" className="text-center text-xs text-muted-foreground">
          No events in this range.
        </div>
      )}
    </div>
  );
}
