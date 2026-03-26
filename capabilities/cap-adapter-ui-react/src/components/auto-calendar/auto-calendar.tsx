/**
 * AutoCalendar — Schema-driven month-view calendar.
 *
 * Renders records in a 7-column month grid based on a configurable date field.
 * Clicking a day shows the records for that day. Clicking a record navigates to it.
 */

import type { SchemaDefinition } from "@linchkit/core/types";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { Calendar, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { detectTitleField, groupRecordsByDate } from "./calendar-utils";

// ── Types ────────────────────────────────────────────

export interface AutoCalendarProps {
  schema: SchemaDefinition;
  /** The date/datetime field to use for placing records on the calendar */
  dateField: string;
  /** Field used as display title for each record */
  titleField?: string;
  /** Field used for color-coding entries */
  colorField?: string;
  /** Record data */
  data: Record<string, unknown>[];
  /** Called when a record is clicked */
  onRecordClick?: (recordId: string) => void;
  /** Title shown above the calendar */
  title?: string;
  /** Loading state */
  loading?: boolean;
}

// ── Color mapping for field values ───────────────────

const COLOR_PALETTE = [
  "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200",
  "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
  "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
] as const;

function getColorForValue(value: string, colorMap: Map<string, string>): string {
  if (colorMap.has(value)) return colorMap.get(value)!;
  const idx = colorMap.size % COLOR_PALETTE.length;
  const color = COLOR_PALETTE[idx]!;
  colorMap.set(value, color);
  return color;
}

// ── Weekday headers ──────────────────────────────────

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

// ── Component ────────────────────────────────────────

export function AutoCalendar({
  schema,
  dateField,
  titleField,
  colorField,
  data,
  onRecordClick,
  title,
  loading = false,
}: AutoCalendarProps) {
  const { t } = useTranslation();
  const [currentMonth, setCurrentMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);

  const resolvedTitleField = titleField ?? detectTitleField(schema);

  // Build a map of date -> records
  const recordsByDate = useMemo(() => groupRecordsByDate(data, dateField), [data, dateField]);

  // Color map for colorField values (stable across renders via useMemo)
  const colorMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!colorField) return map;
    for (const record of data) {
      const val = String(record[colorField] ?? "");
      if (val) getColorForValue(val, map);
    }
    return map;
  }, [data, colorField]);

  // Build calendar grid days
  const calendarDays = useMemo(() => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(currentMonth);
    const calStart = startOfWeek(monthStart, { weekStartsOn: 0 });
    const calEnd = endOfWeek(monthEnd, { weekStartsOn: 0 });
    return eachDayOfInterval({ start: calStart, end: calEnd });
  }, [currentMonth]);

  // Records for the selected day
  const selectedDayRecords = useMemo(() => {
    if (!selectedDay) return [];
    const key = format(selectedDay, "yyyy-MM-dd");
    return recordsByDate.get(key) ?? [];
  }, [selectedDay, recordsByDate]);

  function handlePrevMonth() {
    setCurrentMonth((prev) => subMonths(prev, 1));
    setSelectedDay(null);
  }

  function handleNextMonth() {
    setCurrentMonth((prev) => addMonths(prev, 1));
    setSelectedDay(null);
  }

  function handleToday() {
    setCurrentMonth(startOfMonth(new Date()));
    setSelectedDay(new Date());
  }

  function handleDayClick(day: Date) {
    setSelectedDay((prev) => (prev && isSameDay(prev, day) ? null : day));
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header: title + navigation */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-muted-foreground" />
          {title && <h2 className="text-lg font-semibold">{title}</h2>}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={handleToday}>
            {t("calendar.today", "Today")}
          </Button>
          <Button variant="ghost" size="icon" onClick={handlePrevMonth}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-[140px] text-center text-sm font-medium">
            {format(currentMonth, "MMMM yyyy")}
          </span>
          <Button variant="ghost" size="icon" onClick={handleNextMonth}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      {/* Calendar grid */}
      <div className="rounded border border-border">
        {/* Weekday headers */}
        <div className="grid grid-cols-7 border-b border-border bg-muted/50">
          {WEEKDAY_KEYS.map((key) => (
            <div
              key={key}
              className="px-2 py-1.5 text-center text-xs font-medium text-muted-foreground"
            >
              {t(`calendar.weekdays.${key}`, key.charAt(0).toUpperCase() + key.slice(1))}
            </div>
          ))}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7">
          {calendarDays.map((day) => {
            const key = format(day, "yyyy-MM-dd");
            const dayRecords = recordsByDate.get(key) ?? [];
            const inCurrentMonth = isSameMonth(day, currentMonth);
            const isSelected = selectedDay ? isSameDay(day, selectedDay) : false;
            const today = isToday(day);

            return (
              <button
                key={key}
                type="button"
                className={cn(
                  "relative min-h-[80px] border-b border-r border-border p-1 text-left transition-colors",
                  "hover:bg-muted/30 focus:outline-none focus:ring-1 focus:ring-ring focus:ring-inset",
                  !inCurrentMonth && "bg-muted/20 text-muted-foreground/50",
                  isSelected && "bg-accent/50 ring-1 ring-ring",
                )}
                onClick={() => handleDayClick(day)}
              >
                {/* Day number */}
                <span
                  className={cn(
                    "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs",
                    today && "bg-primary text-primary-foreground font-bold",
                  )}
                >
                  {format(day, "d")}
                </span>

                {/* Record indicators */}
                {dayRecords.length > 0 && (
                  <div className="mt-0.5 space-y-0.5">
                    {dayRecords.slice(0, 3).map((record) => {
                      const recordTitle = String(record[resolvedTitleField] ?? record.id ?? "");
                      const colorVal = colorField ? String(record[colorField] ?? "") : "";
                      const colorClass = colorVal
                        ? getColorForValue(colorVal, colorMap)
                        : "bg-primary/10 text-primary";

                      return (
                        <div
                          key={String(record.id)}
                          className={cn(
                            "truncate rounded px-1 py-0.5 text-[10px] leading-tight cursor-pointer",
                            colorClass,
                          )}
                          onClick={(e) => {
                            e.stopPropagation();
                            onRecordClick?.(String(record.id));
                          }}
                          title={recordTitle}
                        >
                          {recordTitle}
                        </div>
                      );
                    })}
                    {dayRecords.length > 3 && (
                      <div className="text-[10px] text-muted-foreground pl-1">
                        +{dayRecords.length - 3} {t("calendar.more", "more")}
                      </div>
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected day detail panel */}
      {selectedDay && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">
                {format(selectedDay, "EEEE, MMMM d, yyyy")}
                {selectedDayRecords.length > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {selectedDayRecords.length}
                  </Badge>
                )}
              </CardTitle>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setSelectedDay(null)}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {selectedDayRecords.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("calendar.noEvents", "No records on this day.")}
              </p>
            ) : (
              <div className="space-y-2">
                {selectedDayRecords.map((record) => {
                  const recordTitle = String(record[resolvedTitleField] ?? record.id ?? "");
                  const colorVal = colorField ? String(record[colorField] ?? "") : "";
                  const colorClass = colorVal
                    ? getColorForValue(colorVal, colorMap)
                    : "bg-primary/10 text-primary";

                  return (
                    <div
                      key={String(record.id)}
                      className={cn(
                        "flex items-center justify-between rounded-md border p-2 cursor-pointer",
                        "hover:bg-muted/50 transition-colors",
                      )}
                      onClick={() => onRecordClick?.(String(record.id))}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <div className={cn("h-2 w-2 rounded-full shrink-0", colorClass.split(" ")[0])} />
                        <span className="text-sm truncate">{recordTitle}</span>
                      </div>
                      {colorVal && (
                        <Badge variant="outline" className="text-[10px] shrink-0 ml-2">
                          {colorVal}
                        </Badge>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
